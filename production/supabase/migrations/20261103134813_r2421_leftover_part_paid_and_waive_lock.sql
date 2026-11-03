-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.write_off_small_invoice_balance(text,text)') and prosrc like '%R-2421%') and exists(select 1 from pg_trigger where tgname = 'trg_books_lock' and tgrelid = to_regclass('public.invoices') and pg_get_triggerdef(oid) like '%online_fee_waive_reason%')
-- deploy-key: r2421leftoverpartpaidwaivelock
--
-- R-2421 (independent money review, 3 Nov 2026 — Anutech-HQ/drafts/REVIEWS/2026-11-03-money-cards.md):
--
-- 1. write_off_small_invoice_balance (R-2410, 20261103123242) checked only "balance ≤ ₹500", so a
--    WHOLE unpaid ₹354 hosting bill could be written off as "dust". A small leftover is what is
--    LEFT after a payment: the function now refuses an invoice with paid_amount < ₹1 (same rule as
--    lib/collections/small-leftovers.ts, which no longer folds such a bill away). Redefined from
--    its LATEST body (20261103123242); the only change is that check (+ this comment). Race with a
--    payment: the invoice row is read with FOR UPDATE, so the balance and paid_amount checked are
--    the ones after any payment that committed first (READ COMMITTED re-reads the locked row).
-- 2. trg_books_lock on invoices (latest: 20261023184545_r1635_write_off_invoices, free columns
--    written_off_at,write_off_reason) refused R-2416's "Waive online fee" on an invoice dated in a
--    locked month. online_fee_waived + online_fee_waive_reason are a collection choice, not a book
--    value (no amount, GST or date changes), so they join the free-column list. Every other change
--    to a locked-month invoice is refused exactly as before; tg_books_locked itself is unchanged.
--
-- Test: supabase/tests/r2421_leftover_part_paid_and_waive_lock.test.sql (rolled back).

begin;

-- 1. ─────────────────────────────────────────────────────────────────────────────────────────
create or replace function public.write_off_small_invoice_balance(
  p_invoice_id text,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2410: write off the small balance left on ONE invoice (≤ ₹500) — stamp only, no money column.
   R-2421: only a PART-PAID invoice's remainder (paid_amount ≥ ₹1); a whole unpaid bill is chased. */
declare
  c_limit   constant integer := 500;
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
  v_reason  text := left(nullif(trim(coalesce(p_reason, '')), ''), 500);
  v_now     timestamptz := now();
  v_inv     record;
  v_due     integer;
  v_days    integer;
  v_note    text;
  v_draft   uuid;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company context — sign in again, then write the balance off.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can write off a small balance. Ask one of them to do it from Payment Follow-up.'
      using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why this balance is written off (for example "Customer paid ₹1 short — round-off"). The reason is kept on the invoice.'
      using errcode = '22023';
  end if;

  select i.id, i.tenant_id, i.status::text as status, i.amount, i.net_payable, i.paid_amount,
         i.due_date, i.invoice_date, i.written_off_at
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'Invoice % was not found in your company. Refresh the page and try again.', p_invoice_id
      using errcode = '42501';
  end if;
  if v_inv.written_off_at is not null then
    raise exception 'Invoice % was already written off on %. Refresh the page.', v_inv.id,
      to_char(v_inv.written_off_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')
      using errcode = '22023';
  end if;
  if v_inv.status not in ('pending', 'overdue') then
    raise exception 'Invoice % is %, so there is nothing to write off.', v_inv.id, v_inv.status
      using errcode = '22023';
  end if;

  v_due := greatest(0, round(coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0)))::int;
  if v_due <= 0 then
    raise exception 'Invoice % has nothing left to pay, so there is nothing to write off.', v_inv.id
      using errcode = '22023';
  end if;
  /* R-2421: a whole unpaid bill is real money owed, not a leftover. */
  if round(coalesce(v_inv.paid_amount, 0)) < 1 then
    raise exception 'Invoice % has no payment yet — the whole ₹% is still owed. Only what is left after a part payment can be written off here; follow this bill up instead.',
      v_inv.id, v_due
      using errcode = '22023';
  end if;
  if v_due > c_limit then
    raise exception 'Invoice % still has ₹% due — only balances up to ₹% can be written off here. Follow it up, or issue a credit note if the price changed.',
      v_inv.id, v_due, c_limit
      using errcode = '22023';
  end if;

  v_days := greatest(0, (now() at time zone 'Asia/Kolkata')::date - coalesce(v_inv.due_date, v_inv.invoice_date, (now() at time zone 'Asia/Kolkata')::date));
  v_note := format('Small balance ₹%s written off: %s', v_due, v_reason);

  update public.invoices i
     set written_off_at   = v_now,
         write_off_reason = v_note
   where i.id = v_inv.id and i.tenant_id = v_tenant;

  /* The audit record Accounting > Aging already reads: an open draft for this invoice is
     confirmed by this write-off; otherwise a confirmed row is added. */
  update public.invoice_write_off_drafts d
     set status = 'confirmed', decided_by = auth.uid(), decided_at = v_now,
         amount = v_due, reason = v_note
   where d.tenant_id = v_tenant and d.invoice_id = v_inv.id and d.status = 'draft'
  returning d.id into v_draft;
  if v_draft is null then
    insert into public.invoice_write_off_drafts
      (tenant_id, invoice_id, amount, days_overdue, reason, status, created_by, decided_by, decided_at)
    values
      (v_tenant, v_inv.id, v_due, v_days, v_note, 'confirmed', auth.uid(), auth.uid(), v_now)
    returning id into v_draft;
  end if;

  return jsonb_build_object(
    'invoice_id',     v_inv.id,
    'amount',         v_due,
    'written_off_at', v_now,
    'record_id',      v_draft);
end;
$function$;

revoke all on function public.write_off_small_invoice_balance(text, text) from public, anon;
grant execute on function public.write_off_small_invoice_balance(text, text) to authenticated, service_role;

comment on function public.write_off_small_invoice_balance(text, text) is
  'R-2410/R-2421: Payment Follow-up "Write off small balance" — stamps ONE part-paid invoice written off (paid ≥ ₹1, balance ₹1–₹500, reason required) and records a confirmed invoice_write_off_drafts row, in one transaction. Owner/accountant; tenant fail-closed; no money column, GST or subscription change.';

-- 2. ─────────────────────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_books_lock on public.invoices;
create trigger trg_books_lock
  before insert or update or delete on public.invoices
  for each row execute function public.tg_books_locked(
    'invoice_date', '', 'written_off_at,write_off_reason,online_fee_waived,online_fee_waive_reason');

commit;

notify pgrst, 'reload schema';
