-- deploy-peek: exists (select 1 from pg_proc where proname = 'reconcile_bank_credit_new_sale_fx' and prosrc like '%R-2440%')
-- R-2440 (3 Nov 2026) — independent money review 2 of R-2425 (Anutech-HQ/drafts/REVIEWS/2026-11-03-money-cards-2.md,
-- R-2425 should-fix 1-2, minor 6). Redefines reconcile_bank_credit_new_sale_fx from its only body
-- (20261103153553_r2425_bank_sale_foreign_currency); everything else in it is unchanged.
--
--   1. The bank narration is the truth, not the client. The function now reads the bank line's own
--      narration with the same rule as src/lib/banking/inward-remittance.ts ("USD1024.0@93.6") and
--      refuses a currency / foreign amount / rate that differs from it. Before: only
--      |foreign × rate − credit| ≤ ₹1 was checked, so "USD 1 @ 95846.4" (or a made-up "XYZ") was
--      accepted and the invoice was frozen at $1 for good (tg_invoice_fx_freeze). A line whose
--      narration has no remittance is refused (book it by hand in ₹). The currency must be one of
--      the codes the parser reads.
--   2. Export at 0% only under an LUT (tax memo 3 Nov §1: "the app blocks saving the invoice if the
--      entity has no LUT ARN for that FY"). tenants.lut_number must be set and tenants.lut_valid_upto
--      must fall in the bank line's financial year (1 Apr – 31 Mar) on or after the line's date.
--      The refusal names the FY and the Settings step.
--   3. An already-recorded call (the line was booked before) returns fx_invoices 0 and no currency /
--      rate, so a screen cannot say "Booked in USD" for a call that stamped nothing.
-- Test: supabase/tests/r2440_fx_sale_trusts_bank.test.sql (begin … rollback); R-2425's test sets an LUT.

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
  v_m       text[];
  v_n_amt   numeric;
  v_n_rate  numeric;
  v_lut     text;
  v_lut_upto date;
  v_fy_end  date;
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

  /* R-2440: the codes inward-remittance.ts reads (its CODES list) — never INR, never a made-up one. */
  if v_cur not in ('USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'HKD', 'SAR') then
    raise exception 'A foreign-currency sale needs one of USD, EUR, GBP, AED, SGD, AUD, CAD, CHF, JPY, NZD, HKD, SAR (got "%").', coalesce(p_currency, '') using errcode = '22023';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'A foreign-currency sale needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.id, t.tenant_id, t.credit, t.txn_date, t.description into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - coalesce(v_txn.credit, 0)) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Check the amount and rate in the bank narration.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  /* R-2440: the bank's own words. Same pattern as parseInwardRemittance (case ignored: upper()). */
  v_m := regexp_match(upper(coalesce(v_txn.description, '')),
           '(?:^|[^A-Z])(USD|EUR|GBP|AED|SGD|AUD|CAD|CHF|JPY|NZD|HKD|SAR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*@\s*([0-9]+(?:\.[0-9]+)?)');
  if v_m is not null then
    v_n_amt := replace(v_m[2], ',', '')::numeric;
    v_n_rate := v_m[3]::numeric;
  end if;
  if v_m is null or coalesce(v_n_amt, 0) <= 0 or coalesce(v_n_rate, 0) <= 0 then
    raise exception 'This bank line''s narration has no foreign amount and rate (like "USD1024.0@93.6"), so it cannot be booked in %. Reconcile it by hand as a ₹ sale.', v_cur
      using errcode = 'check_violation';
  end if;
  if v_m[1] <> v_cur or abs(v_n_amt - p_foreign_amount) > 0.005 or abs(v_n_rate - p_fx_rate) > 0.00005 then
    raise exception 'The bank narration says % % @ ₹%, but this sale was sent as % % @ ₹%. Reload the page and try again.',
      v_m[1], trim_scale(v_n_amt), trim_scale(v_n_rate), v_cur, p_foreign_amount, p_fx_rate
      using errcode = 'check_violation';
  end if;

  select c.country into v_country from public.customers c
   where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'Customer not found in this company' using errcode = '42501'; end if;
  if coalesce(nullif(lower(btrim(v_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat') then
    raise exception 'Money in % is booked as an export sale, but this customer is in India. Set the customer''s country, or reconcile this line by hand.', v_cur
      using errcode = 'check_violation';
  end if;

  /* R-2440: 0% export only under an LUT for the bank line's financial year (tax memo §1). */
  select nullif(btrim(coalesce(tn.lut_number, '')), ''), tn.lut_valid_upto into v_lut, v_lut_upto
    from public.tenants tn where tn.id = v_txn.tenant_id;
  v_fy_end := make_date(extract(year from v_txn.txn_date)::int + case when extract(month from v_txn.txn_date) >= 4 then 1 else 0 end, 3, 31);
  if v_lut is null or v_lut_upto is null or v_lut_upto < v_txn.txn_date or v_lut_upto > v_fy_end then
    raise exception 'No LUT for FY %-% on file. An export sale at 0%% GST needs your Letter of Undertaking: add its ARN as "LUT number" with "Valid up to" in Settings → Company, then try again. Without an LUT, reconcile this line by hand with IGST.',
      extract(year from v_fy_end)::int - 1, lpad(((extract(year from v_fy_end)::int) % 100)::text, 2, '0')
      using errcode = 'check_violation';
  end if;

  v_res := public.reconcile_bank_credit_new_sale(
             p_txn_id, p_customer_id, p_lines, p_create_subscription, p_sub_start, p_sub_renewal,
             0, null, null, p_billing_cycle, p_external_number);

  v_quote := nullif(v_res->>'quote_id', '');
  if v_quote is null or coalesce((v_res->>'already_recorded')::boolean, false) then
    /* R-2440 (review minor 6): nothing was stamped — say so, no currency. */
    return v_res || jsonb_build_object('fx_invoices', 0);
  end if;

  update public.quotes
     set currency = v_cur, exchange_rate = v_n_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where id = v_quote and tenant_id = v_txn.tenant_id;
  /* The invoice raised in this same call was snapshotted from the still-INR quote: give it the
     currency now (trg_invoice_fx_freeze allows null → value). */
  update public.invoices
     set currency = v_cur, fx_rate = v_n_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where quote_id = v_quote and tenant_id = v_txn.tenant_id and fx_rate is null;
  get diagnostics v_invs = row_count;

  return v_res || jsonb_build_object(
    'currency', v_cur, 'fx_rate', v_n_rate, 'foreign_amount', v_n_amt, 'fx_invoices', v_invs);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) to authenticated, service_role;

comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) is
  'R-2425/R-2440: an export receipt (foreign inward remittance) booked as a new sale — reconcile_bank_credit_new_sale (11 args, no TDS) + the quote and its invoice stamped with the currency and the bank''s rate, in one transaction. Refused unless the currency, foreign amount and rate are the ones in the bank line''s narration, foreign amount × rate = the bank credit (±₹1), the customer is outside India and the company has an LUT for the line''s financial year.';
