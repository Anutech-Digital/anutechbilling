-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_quotes_part_request_tds_invoice' and tgrelid = to_regclass('public.quotes'))
-- deploy-key: r2045parttdslateinvoice
-- 20261028084724_r2045_part_tds_late_invoice.sql
--
-- R-2045 follow-up (28 Oct 2026, localhost check of 6a539f0ae): a part payment request paid in
-- full with TDS whose tax invoice could NOT be raised at payment — the customer had no state, so
-- raise_subscription_billing refused and tg_payments_part_request_invoice left it to "the next
-- billing run" — kept its TDS receivable with invoice_id NULL for good: record_payment_with_tds
-- (20261028082218) links the invoice only when it exists at payment time, and the later billing
-- run (bill_subscription_instalment → quotes.invoice_id) never looked at tds_receivable.
--
-- Now: when a part request (quotes.subscription_billing_id set) gets its tax invoice
-- (quotes.invoice_id NULL → set, by whichever path raises it), the TDS receivable rows of THAT
-- request's own payments that name no invoice get it. Rows already naming an invoice, and other
-- quotes' rows, are not touched. Existing rows left NULL before this migration are not repaired
-- here (data repair = Pardeep's call).
-- A trigger rather than a change to bill_subscription_instalment: every path that sets the
-- request's invoice (billing run, the payment trigger, a later fix) links it the same way.
-- Test: supabase/tests/r2045_part_tds_late_invoice.test.sql

begin;

create or replace function public.tg_quotes_part_request_tds_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2045: a part request's TDS receivable names the part's tax invoice once it is raised. */
begin
  update public.tds_receivable t
     set invoice_id = new.invoice_id, updated_at = now()
   where t.tenant_id = new.tenant_id
     and t.invoice_id is null
     and t.payment_id in (select p.id from public.payments p
                           where p.quote_id = new.id and p.tenant_id = new.tenant_id);
  return new;
end;
$$;
revoke all on function public.tg_quotes_part_request_tds_invoice() from public, anon, authenticated;

drop trigger if exists trg_quotes_part_request_tds_invoice on public.quotes;
create trigger trg_quotes_part_request_tds_invoice
  after update of invoice_id on public.quotes
  for each row
  when (new.subscription_billing_id is not null and old.invoice_id is null and new.invoice_id is not null)
  execute function public.tg_quotes_part_request_tds_invoice();

commit;
