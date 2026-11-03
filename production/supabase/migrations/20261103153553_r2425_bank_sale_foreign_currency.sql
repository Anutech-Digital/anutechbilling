-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_new_sale_fx(uuid,uuid,jsonb,boolean,date,date,text,text,text,numeric,numeric)') is not null
-- R-2425 (3 Nov 2026) — an export receipt (foreign inward remittance) booked as a sale IN THE
-- CUSTOMER'S CURRENCY, with the rupees = the bank credit.
--
-- Pardeep (staging HDFC 4523): "INW 070826I049902623 USD1024.0@93.6" ₹95,846.40 is Zoho payment
-- $1,024 — Reconcile from Zoho could not book it (everything was compared in ₹). The app already
-- bills in a foreign currency as a display layer (R-045): quotes.currency / exchange_rate, and an
-- invoice snapshots them at insert (trg_invoice_fx_snapshot); the books stay in whole ₹.
--
-- reconcile_bank_credit_new_sale_fx = the R-2360 11-argument reconcile_bank_credit_new_sale (all its
-- guards: role, own company, below-cost approval, Zoho-number duplicate check) + in the SAME
-- transaction:
--   * the money really is the remittance: |foreign amount × bank rate − bank credit| ≤ ₹1;
--   * the customer is outside India (export — the sale is at 0% GST, zero-rated under LUT);
--   * the sale's quote and its invoice(s) carry the currency, the bank's rate (fx_source 'manual',
--     fx_date = the bank line's date). A quote waiting for approval keeps them too, so its invoice
--     takes them when it is booked later.
-- No TDS (a foreign customer does not deduct Indian TDS). Nothing else changes; the ₹ amounts are
-- exactly what the 11-argument function books.
-- Test: supabase/tests/r2425_bank_sale_foreign_currency.test.sql (begin … rollback).

create or replace function public.reconcile_bank_credit_new_sale_fx(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean,
  p_sub_start           date,
  p_sub_renewal         date,
  p_billing_cycle       text,
  p_external_number     text,
  p_currency            text,
  p_fx_rate             numeric,
  p_foreign_amount      numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
  v_cur     text := upper(btrim(coalesce(p_currency, '')));
  v_txn     record;
  v_country text;
  v_res     jsonb;
  v_quote   text;
  v_invs    int := 0;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  if v_cur !~ '^[A-Z]{3}$' or v_cur = 'INR' then
    raise exception 'A foreign-currency sale needs a currency other than INR (got "%").', coalesce(p_currency, '') using errcode = '22023';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'A foreign-currency sale needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.id, t.tenant_id, t.credit, t.txn_date into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - coalesce(v_txn.credit, 0)) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Check the amount and rate in the bank narration.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  select c.country into v_country from public.customers c
   where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'Customer not found in this company' using errcode = '42501'; end if;
  if coalesce(nullif(lower(btrim(v_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat') then
    raise exception 'Money in % is booked as an export sale, but this customer is in India. Set the customer''s country, or reconcile this line by hand.', v_cur
      using errcode = 'check_violation';
  end if;

  v_res := public.reconcile_bank_credit_new_sale(
             p_txn_id, p_customer_id, p_lines, p_create_subscription, p_sub_start, p_sub_renewal,
             0, null, null, p_billing_cycle, p_external_number);

  v_quote := nullif(v_res->>'quote_id', '');
  if v_quote is not null and not coalesce((v_res->>'already_recorded')::boolean, false) then
    update public.quotes
       set currency = v_cur, exchange_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
     where id = v_quote and tenant_id = v_txn.tenant_id;
    /* The invoice raised in this same call was snapshotted from the still-INR quote: give it the
       currency now (trg_invoice_fx_freeze allows null → value). */
    update public.invoices
       set currency = v_cur, fx_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
     where quote_id = v_quote and tenant_id = v_txn.tenant_id and fx_rate is null;
    get diagnostics v_invs = row_count;
  end if;

  return v_res || jsonb_build_object(
    'currency', v_cur, 'fx_rate', p_fx_rate, 'foreign_amount', p_foreign_amount, 'fx_invoices', v_invs);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) to authenticated, service_role;

comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) is
  'R-2425: an export receipt (foreign inward remittance) booked as a new sale — reconcile_bank_credit_new_sale (11 args, no TDS) + the quote and its invoice stamped with the currency and the bank''s rate, in one transaction. Refused unless foreign amount × rate = the bank credit (±₹1) and the customer is outside India.';
