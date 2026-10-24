-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'written_off_at') and to_regprocedure('public.write_off_subscription(uuid,text)') is not null
-- deploy-key: r1635writeoffinvoices
--
-- R-1635 (weekly audit 19 Oct 2026): "Write off" on /payments cancelled the subscription and
-- stamped subscriptions.written_off_at — and nothing else. The subscription's unpaid invoices
-- stayed `pending` / `overdue`, so the customer was still on Payment Follow-up (/collections),
-- in the Overdue list and the /invoices Outstanding total, and the dunning cron and the
-- reminder emails kept chasing money the owner had decided not to collect.
--
-- Decision (Pardeep delegates — recorded on the card): a write-off is a LATER EVENT on the
-- invoice, not a change to it. The invoice stays issued exactly as it is — same status, same
-- amount, same paid_amount, still in GSTR-1 and every sales report (a bad debt does not cancel
-- the supply; a credit note is for a value change, CGST s.34, not for non-payment). It gets
-- `written_off_at` (+ the reason), and every "what is still owed" reader leaves it out —
-- the TS rule is invoiceAmountDue / invoiceBalance / invoiceIsOverdue (written off → 0), the
-- SQL readers below add `written_off_at is null`.
--
--   1. invoices.written_off_at / write_off_reason — null on every existing row. NO backfill:
--      invoices of subscriptions already written off stay open until the owner decides
--      (needsDecision on R-1635).
--   2. trg_books_lock on invoices: those two columns are the write-off's own (a later event,
--      dated today), so a write-off of an invoice from a locked month is not refused. Every
--      other change to such an invoice is refused exactly as before (R-1584's free-column
--      argument; the trigger function is unchanged).
--   3. write_off_subscription(subscription, reason) — the /payments button, in ONE
--      transaction: the subscription is cancelled + stamped as before, and its open invoices
--      (its own quote's, its renewal quote's, its instalments) are stamped. An invoice whose
--      quote another live subscription also bills is left open and named in the result — it
--      also asks for that subscription's money. Owner / manager / accountant / billing;
--      tenant fail-closed; a reason is required.
--   4. nav_badges() and today_inbox() skip written-off invoices — in the next migration,
--      20261023184546_r1635_badges_inbox_written_off (both SECURITY INVOKER; kept apart from
--      the DEFINER function above, nav-badge-parity.test.ts reads that file on its own).
--
-- Not changed: the money columns of any invoice, payments, credit notes, GST reports, the
-- Balance Sheet / P&L (a bad-debt expense line is a separate decision — on the card).
-- Test: supabase/tests/r1635_write_off_subscription.test.sql (rolled back).

begin;

-- 1. ─────────────────────────────────────────────────────────────────────────────────────
alter table public.invoices add column if not exists written_off_at   timestamptz;
alter table public.invoices add column if not exists write_off_reason text;

comment on column public.invoices.written_off_at is
  'R-1635: when the owner wrote this invoice off (bad debt). Not a payment and not a cancellation — the invoice stays issued; every "still owed" reader (collections, aging, dunning, reminders, /invoices Outstanding, nav badge, today inbox) leaves it out. null = not written off.';
comment on column public.invoices.write_off_reason is
  'R-1635: why it was written off (from write_off_subscription).';

-- 2. ─────────────────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_books_lock on public.invoices;
create trigger trg_books_lock
  before insert or update or delete on public.invoices
  for each row execute function public.tg_books_locked('invoice_date', '', 'written_off_at,write_off_reason');

-- 3. ─────────────────────────────────────────────────────────────────────────────────────
create or replace function public.write_off_subscription(
  p_subscription_id uuid,
  p_reason          text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1635: write a subscription's dues off — the subscription AND its open invoices, together. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
  v_reason  text := left(nullif(trim(coalesce(p_reason, '')), ''), 500);
  v_now     timestamptz := now();
  v_sub     record;
  v_inv     record;
  v_done    text[]  := '{}';
  v_shared  text[]  := '{}';
  v_amount  integer := 0;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company context — sign in again, then write the dues off.' using errcode = '28000';
  end if;
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can write dues off. Ask one of them.'
      using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Write why these dues are being written off (for example "Customer closed the business"). The reason is kept on the subscription and its invoices.'
      using errcode = '22023';
  end if;

  select s.id, s.tenant_id, s.quote_id, s.renewal_quote_id, s.outstanding_amount, s.written_off_at
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found or v_sub.tenant_id <> v_tenant then
    raise exception 'That subscription was not found in your company. Refresh the page and try again.'
      using errcode = '42501';
  end if;
  if v_sub.written_off_at is not null then
    raise exception 'These dues were already written off on %. Refresh the page.',
      to_char(v_sub.written_off_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')
      using errcode = '22023';
  end if;

  for v_inv in
    select i.id, i.quote_id,
           greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) as due
      from public.invoices i
     where i.tenant_id = v_tenant
       and i.status::text in ('pending', 'overdue')
       and i.written_off_at is null
       and greatest(0, coalesce(i.net_payable, i.amount, 0) - coalesce(i.paid_amount, 0)) > 0
       and (   (v_sub.quote_id is not null and i.quote_id = v_sub.quote_id)
            or (v_sub.renewal_quote_id is not null and i.quote_id = v_sub.renewal_quote_id)
            or exists (select 1 from public.subscription_billings b
                        where b.subscription_id = v_sub.id and b.tenant_id = v_tenant and b.invoice_id = i.id))
     order by i.id
     for update of i
  loop
    /* A quote can sell several subscriptions; its invoice then asks for the others' money too. */
    if v_inv.quote_id is not null and exists (
         select 1 from public.subscriptions s2
          where s2.tenant_id = v_tenant and s2.id <> v_sub.id
            and (s2.quote_id = v_inv.quote_id or s2.renewal_quote_id = v_inv.quote_id)
            and s2.written_off_at is null and s2.status::text <> 'cancelled') then
      v_shared := v_shared || v_inv.id;
      continue;
    end if;
    update public.invoices i
       set written_off_at   = v_now,
           write_off_reason = v_reason
     where i.id = v_inv.id and i.tenant_id = v_tenant;
    v_done   := v_done || v_inv.id;
    v_amount := v_amount + v_inv.due;
  end loop;

  update public.subscriptions s
     set status           = 'cancelled',
         write_off_reason = v_reason,
         written_off_at   = v_now
   where s.id = v_sub.id and s.tenant_id = v_tenant;

  return jsonb_build_object(
    'subscription_id',      v_sub.id,
    'outstanding_amount',   coalesce(v_sub.outstanding_amount, 0),
    'invoices_written_off', to_jsonb(v_done),
    'invoice_amount',       v_amount,
    'invoices_left_open',   to_jsonb(v_shared));
end;
$function$;

revoke all on function public.write_off_subscription(uuid, text) from public, anon;
grant execute on function public.write_off_subscription(uuid, text) to authenticated, service_role;

comment on function public.write_off_subscription(uuid, text) is
  'R-1635: /payments "Write off" — cancels the subscription, stamps it and its open invoices (own quote, renewal quote, instalments) written off in one transaction; an invoice shared with another live subscription is left open and listed. Owner/manager/accountant/billing; tenant fail-closed; reason required.';


commit;
