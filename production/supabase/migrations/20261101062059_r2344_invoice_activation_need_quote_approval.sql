-- deploy-peek: to_regprocedure('public.quote_waits_cost_approval(text)') is not null and exists(select 1 from pg_trigger where tgname = 'trg_invoices_quote_approval' and tgrelid = to_regclass('public.invoices')) and exists(select 1 from pg_trigger where tgname = 'trg_subscriptions_quote_approval' and tgrelid = to_regclass('public.subscriptions')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_payments_quote_approval()') and prosrc like '%R-2344%')
-- deploy-key: r2344belowcostinvoice
--
-- R-2344 (1 Nov 2026) — a BELOW-COST quote waiting for the owner's approval can no longer be
-- invoiced or switched on on credit.
--
-- WHY
--   R-2334 check on localhost: Q-F588-27-0070 (below cost, approval pending) → Mark accepted, and
--   the quote page offered "Invoice now" and "Activate now, pay later". R-2213 refused only the
--   payment (tg_payments_quote_approval), so generate_invoice / activate_quote_on_credit raised the
--   invoice and the subscriptions on credit at a below-cost price — the margin control bypassed.
--
-- WHAT
--   1. ONE rule, public.quote_waits_cost_approval(quote id): below_cost AND approval_status is not
--      'approved' AND not a part payment request (R-2054, subscription_billing_id set — it has no
--      approval step). The R-2213 payments trigger now reads it too (same refusal text).
--   2. BEFORE INSERT triggers on invoices and subscriptions linked to such a quote (quote_id) refuse,
--      same wording: "… then raise the invoice." / "… then activate it.". Every path that invoices
--      or activates a quote ends in one of those rows (generate_invoice → Invoice now / Generate
--      GST Invoice, activate_quote_on_credit → Activate now, pay later, file_invoiced_quote_
--      subscriptions, record_payment / bank-credit paths, website checkout), so two triggers cover
--      them all without copying those RPCs.
--   3. Never refused: an invoice or subscription for a quote that already has money RECEIVED on it.
--      Non-Razorpay money cannot come in while the quote waits (R-2213), so that money is Razorpay
--      (gateway already took it — R-2213 records it) or older than the block; its invoice is due on
--      receipt and its subscriptions are paid for. The quote stays pending for the owner.
--   4. Mark accepted is untouched (it writes neither row). Renewals that only extend an existing
--      subscription insert no subscription row; their invoice (Invoice now) is refused like any other.
--   5. Billing / renewal crons call these RPCs per item inside their own try/catch (cron billing
--      sync-instalments.server.ts) — a refused quote is logged in that run's errors and skipped.
--
-- Test: supabase/tests/r2344_invoice_activation_need_quote_approval.test.sql

begin;

create or replace function public.quote_waits_cost_approval(p_quote_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  /* R-2344: the one rule (R-2213's) — below cost, not approved, not a part payment request. */
  select coalesce((
    select q.below_cost
           and q.approval_status::text is distinct from 'approved'
           and q.subscription_billing_id is null
      from public.quotes q
     where q.id = p_quote_id
  ), false);
$$;

revoke all on function public.quote_waits_cost_approval(text) from public, anon;
grant execute on function public.quote_waits_cost_approval(text) to authenticated, service_role;

create or replace function public.quote_cost_approval_refusal(p_quote_id text, p_then text)
returns text
language sql
immutable
set search_path = public
as $$
  select 'This quote is below cost and waits for the owner''s approval. Approve it first (Quotes → '
         || p_quote_id || ' → Approve), then ' || p_then || '.';
$$;

revoke all on function public.quote_cost_approval_refusal(text, text) from public, anon;
grant execute on function public.quote_cost_approval_refusal(text, text) to authenticated, service_role;

/* R-2213's payments guard, now on the shared rule (R-2344). Same refusal, word for word. */
create or replace function public.tg_payments_quote_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2213: one guard for every money path on a quote. R-2344: the rule is quote_waits_cost_approval. */
begin
  if new.quote_id is null or new.status is distinct from 'received' then
    return new;
  end if;
  /* Gateway money is already taken — record it, never refuse it (the quote stays pending). */
  if new.method = 'razorpay' then
    return new;
  end if;
  if public.quote_waits_cost_approval(new.quote_id) then
    raise exception '%', public.quote_cost_approval_refusal(new.quote_id, 'record the payment')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.tg_payments_quote_approval() from public, anon, authenticated;

/* R-2344: an invoice / subscription on a quote that waits — refused unless money is already in. */
create or replace function public.tg_quote_rows_need_cost_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.quote_id is null or not public.quote_waits_cost_approval(new.quote_id) then
    return new;
  end if;
  if exists (select 1 from public.payments p
              where p.quote_id = new.quote_id and p.status = 'received' and p.amount > 0) then
    return new;
  end if;
  raise exception '%', public.quote_cost_approval_refusal(new.quote_id,
      case when tg_table_name = 'invoices' then 'raise the invoice' else 'activate it' end)
    using errcode = 'check_violation';
end;
$$;

revoke all on function public.tg_quote_rows_need_cost_approval() from public, anon, authenticated;

drop trigger if exists trg_invoices_quote_approval on public.invoices;
create trigger trg_invoices_quote_approval
  before insert on public.invoices
  for each row execute function public.tg_quote_rows_need_cost_approval();

drop trigger if exists trg_subscriptions_quote_approval on public.subscriptions;
create trigger trg_subscriptions_quote_approval
  before insert on public.subscriptions
  for each row execute function public.tg_quote_rows_need_cost_approval();

commit;
