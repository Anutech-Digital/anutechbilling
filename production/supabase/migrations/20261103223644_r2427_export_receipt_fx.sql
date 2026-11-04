-- deploy-peek: to_regprocedure('public.reconcile_bank_credit_fx_invoice(uuid,text,text,numeric,numeric,boolean,date)') is not null and to_regprocedure('public.reconcile_bank_credit_new_sale_fx(uuid,uuid,jsonb,boolean,date,date,text,text,text,numeric,numeric,numeric)') is not null
-- deploy-key: r2427exportreceiptfx
--
-- R-2427 (3 Nov 2026, p1 money; split from R-2425) — export receipts that R-2425 left for a person:
--
--   (1) An inward remittance ("INW … USD1000.0@84.5") that pays an invoice ALREADY in the app in that
--       currency at another rate ($1,000 at ₹83 = ₹83,000 due, the bank credited ₹84,500). The
--       customer owed $1,000 and paid $1,000: the invoice is settled in full, and the ₹ difference is
--       an exchange difference (AS-11) — a gain here (₹1,500), a loss when the rupee rose.
--   (2) A short remittance: the remitting bank kept its charges abroad (Zoho / the invoice: $1,024;
--       the bank got $1,000 @ 93.6). The short part × the bank's rate (₹2,246) is a Bank Charges
--       expense — never TDS (a foreign customer deducts no Indian TDS) — and the invoice is settled
--       in full.
--
-- ─── HOW IT IS BOOKED ─────────────────────────────────────────────────────────────────────────
--   The app has no ledger of its own: the P&L reads expenses by category (report_pnl's `exps`), the
--   balance sheet leaves out an expense that is paid AND tied to a bank line (reconciled_txn_id).
--   So, in ONE transaction:
--     receipt   = the invoice's whole ₹ due (bank_credit_pay_item → record_desk_payment /
--                 record_instalment_payment, as "This money is for" does) → invoice paid;
--     the line  is matched to that receipt, and the receipt carries payments.bank_txn_id (R-2098) so
--                 report_settlement_shortfalls does not ALSO read the gap as a settlement shortfall
--                 and the balance sheet counts the receipt as banked;
--     charges   = round(short foreign × bank rate) → expense 'Bank Charges' (EXP-FXC-<line id>);
--     forex     = ₹ due − charges − bank credit → expense 'Foreign Exchange Gain / Loss'
--                 (EXP-FXD-<line id>; < 0 = a gain, as the P&L already shows a round-off gain as a
--                 negative Bank Charges). Both paid, dated the bank line's date, tied to the line.
--   Un-reconciling the line removes both (tg_bank_fx_line_unmatched); R-2098's trigger already
--   takes the receipt off the line.
--
-- ─── NEW / CHANGED ────────────────────────────────────────────────────────────────────────────
--   bank_fx_narration(text)              the narration's {currency, amount, rate} — the rule of
--                                        src/lib/banking/inward-remittance.ts and of R-2440.
--   bank_fx_book_differences(...)        the two expense rows + receipt → line link (service_role).
--   reconcile_bank_credit_fx_invoice     (1)+(2) on an existing foreign invoice. SECURITY DEFINER,
--                                        tenant fail-closed, money roles, line + invoice row locks,
--                                        books lock. Refused: figures that are not the narration's;
--                                        a ₹ invoice / another currency; more than 5% short (a part
--                                        payment, not charges); more received than due; a bank rate
--                                        more than 25% off the invoice's (a wrong match).
--   reconcile_bank_credit_new_sale_fx    a 12-argument overload with p_foreign_billed (Zoho's
--     (…, p_foreign_billed)              amount): equal / null → the R-2440 11-argument function
--                                        unchanged; more than received (≤ 5%) → the sale at the
--                                        BILLED amount, paid in full, invoice stamped in the
--                                        currency at the bank's rate, the short part → Bank Charges.
--                                        Same guards as R-2440 (narration, outside India, LUT).
--   tg_bank_fx_line_unmatched            the line un-reconciled (or deleted) → its two expense rows go.
--   Not changed: reconcile_bank_credit_new_sale_fx (11 args, R-2440), report_pnl,
--   report_settlement_shortfalls, report_balance_sheet. The invoice's ₹ value stays at the rate it
--   was issued at (point 4 — FBIL reference rate vs bank rate — waits on the CA; R-2427
--   needsDecision). Receipt reference: bank_line_payment_reference (R-2430).
-- Test: supabase/tests/r2427_export_receipt_fx.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. The narration (same pattern as parseInwardRemittance / R-2440) ──────────────────────────
create or replace function public.bank_fx_narration(p_description text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_m text[];
  v_amt numeric;
  v_rate numeric;
begin
  /* R-2427: R-2440's rule — the codes of inward-remittance.ts, "USD1024.0@93.6", case ignored. */
  v_m := regexp_match(upper(coalesce(p_description, '')),
           '(?:^|[^A-Z])(USD|EUR|GBP|AED|SGD|AUD|CAD|CHF|JPY|NZD|HKD|SAR)\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*@\s*([0-9]+(?:\.[0-9]+)?)');
  if v_m is null then return null; end if;
  v_amt := replace(v_m[2], ',', '')::numeric;
  v_rate := v_m[3]::numeric;
  if coalesce(v_amt, 0) <= 0 or coalesce(v_rate, 0) <= 0 then return null; end if;
  return jsonb_build_object('currency', v_m[1], 'amount', v_amt, 'rate', v_rate);
end;
$$;
revoke all on function public.bank_fx_narration(text) from public, anon;
grant execute on function public.bank_fx_narration(text) to authenticated, service_role;

-- ── 2. The two expense rows + the receipt on the line ─────────────────────────────────────────
create or replace function public.bank_fx_book_differences(
  p_txn_id     uuid,
  p_payment_id uuid,
  p_charges    integer,
  p_forex      integer,
  p_what       text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn record;
begin
  /* R-2427: called by the export-receipt RPCs after the line is matched to the receipt. */
  select t.id, t.tenant_id, t.txn_date, t.bank_account_id into v_txn from public.bank_transactions t where t.id = p_txn_id;
  update public.payments set bank_txn_id = p_txn_id where id = p_payment_id and tenant_id = v_txn.tenant_id;
  if coalesce(p_charges, 0) <> 0 then
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
       paid, paid_date, bank_account_id, reconciled_txn_id)
    values
      ('EXP-FXC-' || p_txn_id::text, v_txn.tenant_id, 'Bank Charges', null, v_txn.txn_date, p_charges, 0, 'none', 'bank',
       'Remitting bank''s charges kept abroad — ' || p_what, true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  end if;
  if coalesce(p_forex, 0) <> 0 then
    insert into public.expenses
      (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
       paid, paid_date, bank_account_id, reconciled_txn_id)
    values
      ('EXP-FXD-' || p_txn_id::text, v_txn.tenant_id, 'Foreign Exchange Gain / Loss', null, v_txn.txn_date, p_forex, 0, 'none', 'bank',
       case when p_forex < 0 then 'Exchange gain' else 'Exchange loss' end || ' on realisation — ' || p_what,
       true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  end if;
end;
$$;
revoke all on function public.bank_fx_book_differences(uuid, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.bank_fx_book_differences(uuid, uuid, integer, integer, text) to service_role;

-- ── 3. (1) + (2) on an existing foreign-currency invoice ─────────────────────────────────────
create or replace function public.reconcile_bank_credit_fx_invoice(
  p_txn_id         uuid,
  p_invoice_id     text,
  p_currency       text,
  p_fx_rate        numeric,
  p_foreign_amount numeric,
  p_create_subscription boolean default null,   -- the plan's choice for a new-subscription quote (false = no subscription)
  p_sub_start      date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid;
  v_trusted  boolean;
  v_cur      text := upper(btrim(coalesce(p_currency, '')));
  v_txn      record;
  v_inv      record;
  v_n        jsonb;
  v_lock     date;
  v_inv_cur  text;
  v_inv_rate numeric;
  v_due      integer;
  v_fdue     numeric;
  v_short    numeric;
  v_charges  integer;
  v_forex    integer;
  v_ref      text;
  v_core     jsonb;
  v_pay_id   uuid;
  v_what     text;
begin
  /* §17c fail-closed + R-718 money roles (as reconcile_bank_credit_to_item). */
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
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'An export receipt needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay an invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* The bank's own words (R-2440): currency, foreign amount and rate as the narration says. */
  v_n := public.bank_fx_narration(v_txn.description);
  if v_n is null then
    raise exception 'This bank line''s narration has no foreign amount and rate (like "USD1024.0@93.6"), so it cannot be booked as an export receipt. Reconcile it by hand.'
      using errcode = 'check_violation';
  end if;
  if v_n->>'currency' <> v_cur or abs((v_n->>'amount')::numeric - p_foreign_amount) > 0.005
     or abs((v_n->>'rate')::numeric - p_fx_rate) > 0.00005 then
    raise exception 'The bank narration says % % @ ₹%, but this receipt was sent as % % @ ₹%. Reload the page and try again.',
      v_n->>'currency', trim_scale((v_n->>'amount')::numeric), trim_scale((v_n->>'rate')::numeric), v_cur, p_foreign_amount, p_fx_rate
      using errcode = 'check_violation';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - v_txn.credit) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Reconcile this line by hand.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  select tn.books_locked_until into v_lock from public.tenants tn where tn.id = v_txn.tenant_id;
  if v_lock is not null and v_txn.txn_date <= v_lock then
    raise exception 'The books are locked up to %, and this bank line is dated % — unlock the books first.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  /* The invoice — locked; this company's; open; in the remittance's currency. */
  select i.id, i.tenant_id, i.status, i.currency, i.fx_rate, i.quote_id, i.amount, i.net_payable, i.paid_amount,
         q.currency as q_currency, q.exchange_rate as q_rate
    into v_inv
    from public.invoices i left join public.quotes q on q.id = i.quote_id and q.tenant_id = i.tenant_id
   where i.id = p_invoice_id
     for update of i;
  if not found or v_inv.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Invoice % not found in your company', p_invoice_id using errcode = 'no_data_found';
  end if;
  if v_inv.status not in ('pending', 'overdue') then
    raise exception 'Invoice % is %, so there is nothing left to pay on it.', p_invoice_id, v_inv.status using errcode = 'check_violation';
  end if;
  v_inv_cur := upper(coalesce(nullif(btrim(v_inv.currency), ''), nullif(btrim(v_inv.q_currency), ''), 'INR'));
  v_inv_rate := coalesce(v_inv.fx_rate, case when upper(coalesce(v_inv.q_currency, '')) = v_inv_cur then v_inv.q_rate end);
  if v_inv_cur = 'INR' or coalesce(v_inv_rate, 0) <= 0 then
    raise exception 'Invoice % is in ₹, but this money came in % — pay it with "This money is for" in ₹, or reconcile this line by hand.', p_invoice_id, v_cur
      using errcode = 'check_violation';
  end if;
  if v_inv_cur <> v_cur then
    raise exception 'Invoice % is in %, but this money came in %. Reconcile this line by hand.', p_invoice_id, v_inv_cur, v_cur
      using errcode = 'check_violation';
  end if;
  if abs(p_fx_rate / v_inv_rate - 1) > 0.25 then
    raise exception 'The bank''s rate (₹%) is more than 25%% away from invoice %''s rate (₹%) — this money is probably for something else. Reconcile this line by hand.',
      p_fx_rate, p_invoice_id, v_inv_rate using errcode = 'check_violation';
  end if;

  /* What is still due, in ₹ and in the invoice's currency at its own rate. */
  v_due := greatest(0, round(coalesce(v_inv.net_payable, v_inv.amount, 0) - coalesce(v_inv.paid_amount, 0)))::int;
  if v_due <= 0 then
    raise exception 'Invoice % has nothing left to pay.', p_invoice_id using errcode = 'check_violation';
  end if;
  v_fdue := round(v_due / v_inv_rate, 2);
  v_short := v_fdue - p_foreign_amount;
  /* Rounding noise: the ₹ due is whole rupees, so its foreign value can be off by a cent or two —
     never "charges kept abroad". */
  if abs(v_short) <= 0.02 then v_short := 0; end if;
  if v_short < -0.01 then
    raise exception 'The bank got % % but invoice % has only % % due — reconcile this line by hand (the extra is an advance).',
      v_cur, trim_scale(p_foreign_amount), p_invoice_id, v_cur, v_fdue using errcode = 'check_violation';
  end if;
  if v_short > v_fdue * 0.05 then
    raise exception 'The bank got % % but invoice % has % % due — % short is more than bank charges (5%%). Record it as a part payment with "This money is for", or reconcile this line by hand.',
      v_cur, trim_scale(p_foreign_amount), p_invoice_id, v_cur, v_fdue, trim_scale(v_short) using errcode = 'check_violation';
  end if;
  v_charges := greatest(0, round(greatest(v_short, 0) * p_fx_rate))::int;
  v_forex := round(v_due - v_charges - v_txn.credit)::int;

  /* The receipt: the whole ₹ due settles the invoice (R-2430 reference rule). */
  v_ref := public.bank_line_payment_reference(v_txn.reference, v_txn.id);
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_due, v_ref, null, p_invoice_id, 0, null, null, p_create_subscription, p_sub_start, null);
  v_pay_id := (v_core->>'payment_id')::uuid;
  if coalesce((v_core->>'replay')::boolean, false) then
    raise exception 'A receipt with reference % is already recorded on invoice %. Nothing was changed — match the line to it by hand.', v_ref, p_invoice_id
      using errcode = 'unique_violation';
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  v_what := 'invoice ' || p_invoice_id || ': ' || v_cur || ' ' || trim_scale(p_foreign_amount) || ' @ ₹' || trim_scale(p_fx_rate)
            || ' received, ' || v_cur || ' ' || trim_scale(v_fdue) || ' due @ ₹' || trim_scale(v_inv_rate);
  perform public.bank_fx_book_differences(p_txn_id, v_pay_id, v_charges, v_forex, v_what);

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, p_invoice_id, v_due, 0)
         || jsonb_build_object('currency', v_cur, 'fx_rate', p_fx_rate, 'foreign_amount', p_foreign_amount,
                               'invoice_rate', v_inv_rate, 'foreign_due', v_fdue,
                               'bank_charges', v_charges, 'forex_difference', v_forex);
end;
$$;
revoke all on function public.reconcile_bank_credit_fx_invoice(uuid, text, text, numeric, numeric, boolean, date) from public, anon;
grant execute on function public.reconcile_bank_credit_fx_invoice(uuid, text, text, numeric, numeric, boolean, date) to authenticated, service_role;
comment on function public.reconcile_bank_credit_fx_invoice(uuid, text, text, numeric, numeric, boolean, date) is
  'R-2427: a foreign inward remittance paying an existing invoice in that currency — the invoice''s whole ₹ due as the receipt (paid in full), the line matched to it, the short part × the bank''s rate → Bank Charges and the rest of the ₹ gap → Foreign Exchange Gain / Loss (paid expense rows tied to the line). One transaction; tenant fail-closed; money roles; line + invoice locked; books lock; the narration''s own figures only.';

-- ── 4. (2) on a new sale: Zoho billed more than the bank got ─────────────────────────────────
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
  p_foreign_amount      numeric,
  p_foreign_billed      numeric      -- R-2427: Zoho's amount; more than p_foreign_amount = charges kept abroad
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid;
  v_trusted  boolean;
  v_cur      text := upper(btrim(coalesce(p_currency, '')));
  v_txn      record;
  v_n        jsonb;
  v_country  text;
  v_lut      text;
  v_lut_upto date;
  v_fy_end   date;
  v_lock     date;
  v_short    numeric;
  v_sale     jsonb;
  v_total    integer;
  v_charges  integer;
  v_ref      text;
  v_core     jsonb;
  v_pay_id   uuid;
  v_quote    text;
  v_inv      text;
  v_invs     int := 0;
  v_num      text;
  v_saved    boolean := false;
begin
  /* No short (or not given): exactly R-2440's 11-argument function. */
  if p_foreign_billed is null or abs(p_foreign_billed - coalesce(p_foreign_amount, 0)) <= 0.005 then
    return public.reconcile_bank_credit_new_sale_fx(p_txn_id, p_customer_id, p_lines, p_create_subscription,
             p_sub_start, p_sub_renewal, p_billing_cycle, p_external_number, p_currency, p_fx_rate, p_foreign_amount);
  end if;

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
  if v_cur not in ('USD', 'EUR', 'GBP', 'AED', 'SGD', 'AUD', 'CAD', 'CHF', 'JPY', 'NZD', 'HKD', 'SAR') then
    raise exception 'A foreign-currency sale needs one of USD, EUR, GBP, AED, SGD, AUD, CAD, CHF, JPY, NZD, HKD, SAR (got "%").', coalesce(p_currency, '') using errcode = '22023';
  end if;
  if coalesce(p_fx_rate, 0) <= 0 or coalesce(p_foreign_amount, 0) <= 0 then
    raise exception 'A foreign-currency sale needs the foreign amount and the bank''s rate.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  v_n := public.bank_fx_narration(v_txn.description);
  if v_n is null then
    raise exception 'This bank line''s narration has no foreign amount and rate (like "USD1024.0@93.6"), so it cannot be booked in %. Reconcile it by hand as a ₹ sale.', v_cur
      using errcode = 'check_violation';
  end if;
  if v_n->>'currency' <> v_cur or abs((v_n->>'amount')::numeric - p_foreign_amount) > 0.005
     or abs((v_n->>'rate')::numeric - p_fx_rate) > 0.00005 then
    raise exception 'The bank narration says % % @ ₹%, but this sale was sent as % % @ ₹%. Reload the page and try again.',
      v_n->>'currency', trim_scale((v_n->>'amount')::numeric), trim_scale((v_n->>'rate')::numeric), v_cur, p_foreign_amount, p_fx_rate
      using errcode = 'check_violation';
  end if;
  if abs(round(p_foreign_amount * p_fx_rate, 2) - coalesce(v_txn.credit, 0)) > 1 then
    raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Check the amount and rate in the bank narration.',
      v_txn.credit, v_cur, p_foreign_amount, p_fx_rate, round(p_foreign_amount * p_fx_rate, 2)
      using errcode = 'check_violation';
  end if;

  v_short := p_foreign_billed - p_foreign_amount;
  if v_short < 0 then
    raise exception 'Zoho billed % % but the bank got % % — more came in than was billed. Reconcile this line by hand.',
      v_cur, trim_scale(p_foreign_billed), v_cur, trim_scale(p_foreign_amount) using errcode = 'check_violation';
  end if;
  if v_short > p_foreign_billed * 0.05 then
    raise exception 'Zoho billed % % but the bank got % % — % short is more than bank charges (5%%). Reconcile this line by hand.',
      v_cur, trim_scale(p_foreign_billed), v_cur, trim_scale(p_foreign_amount), trim_scale(v_short) using errcode = 'check_violation';
  end if;

  select c.country into v_country from public.customers c
   where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id;
  if not found then raise exception 'Customer not found in this company' using errcode = '42501'; end if;
  if coalesce(nullif(lower(btrim(v_country)), ''), 'india') in ('india', 'in', 'ind', 'bharat') then
    raise exception 'Money in % is booked as an export sale, but this customer is in India. Set the customer''s country, or reconcile this line by hand.', v_cur
      using errcode = 'check_violation';
  end if;

  select nullif(btrim(coalesce(tn.lut_number, '')), ''), tn.lut_valid_upto, tn.books_locked_until into v_lut, v_lut_upto, v_lock
    from public.tenants tn where tn.id = v_txn.tenant_id;
  v_fy_end := make_date(extract(year from v_txn.txn_date)::int + case when extract(month from v_txn.txn_date) >= 4 then 1 else 0 end, 3, 31);
  if v_lut is null or v_lut_upto is null or v_lut_upto < v_txn.txn_date or v_lut_upto > v_fy_end then
    raise exception 'No LUT for FY %-% on file. An export sale at 0%% GST needs your Letter of Undertaking: add its ARN as "LUT number" with "Valid up to" in Settings → Company, then try again.',
      extract(year from v_fy_end)::int - 1, lpad(((extract(year from v_fy_end)::int) % 100)::text, 2, '0')
      using errcode = 'check_violation';
  end if;
  if v_lock is not null and v_txn.txn_date <= v_lock then
    raise exception 'The books are locked up to %, and this bank line is dated % — unlock the books first.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  if public.bank_sale_lines_below_cost(p_lines) then
    raise exception 'This sale is priced below cost and needs approval first — with charges kept abroad it cannot wait for approval here. Reconcile this line by hand.'
      using errcode = 'check_violation';
  end if;

  /* The sale at the BILLED amount, paid in full. */
  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);
  v_quote := v_sale->>'quote_id';
  v_total := (v_sale->>'quote_total')::int;
  if abs(v_total - round(p_foreign_billed * p_fx_rate)) > 1 then
    raise exception 'The sale comes to ₹%, but % % billed at the bank''s rate ₹% is ₹%. Reconcile this line by hand.',
      v_total, v_cur, trim_scale(p_foreign_billed), p_fx_rate, round(p_foreign_billed * p_fx_rate)
      using errcode = 'check_violation';
  end if;
  v_charges := v_total - round(v_txn.credit)::int;
  if v_charges <= 0 then
    raise exception 'Nothing is short on this line — book it without the billed amount.' using errcode = 'check_violation';
  end if;

  v_ref := public.bank_line_payment_reference(v_txn.reference, v_txn.id);
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_total, v_ref, v_quote, null, 0, null, null, p_create_subscription, p_sub_start, p_sub_renewal);
  v_pay_id := (v_core->>'payment_id')::uuid;
  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  update public.quotes
     set currency = v_cur, exchange_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where id = v_quote and tenant_id = v_txn.tenant_id;
  update public.invoices
     set currency = v_cur, fx_rate = p_fx_rate, fx_source = 'manual', fx_date = v_txn.txn_date
   where quote_id = v_quote and tenant_id = v_txn.tenant_id and fx_rate is null;
  get diagnostics v_invs = row_count;
  select q.invoice_id into v_inv from public.quotes q where q.id = v_quote;

  perform public.bank_fx_book_differences(p_txn_id, v_pay_id, v_charges, 0,
    'sale ' || v_quote || ': ' || v_cur || ' ' || trim_scale(p_foreign_billed) || ' billed, ' || v_cur || ' '
    || trim_scale(p_foreign_amount) || ' @ ₹' || trim_scale(p_fx_rate) || ' received');

  v_num := public.zoho_external_number_clean(p_external_number);
  if v_num is not null then
    v_saved := public.bank_sale_keep_external_number(p_txn_id, v_inv, v_num);
  end if;

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, null, v_total, 0)
         || jsonb_build_object('new_quote', true, 'quote_total', v_total, 'tax_rate', (v_sale->>'tax_rate')::int,
                               'currency', v_cur, 'fx_rate', p_fx_rate, 'foreign_amount', p_foreign_amount,
                               'foreign_billed', p_foreign_billed, 'bank_charges', v_charges, 'forex_difference', 0,
                               'fx_invoices', v_invs, 'external_number', v_num, 'external_number_saved', v_saved);
end;
$$;
revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) to authenticated, service_role;
comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric, numeric) is
  'R-2427: an export receipt booked as a new sale when Zoho billed more than the bank got (charges kept abroad, ≤ 5%): the sale at the billed amount paid in full, quote + invoice in the currency at the bank''s rate, the short part → Bank Charges (a paid expense tied to the line). No short → R-2440''s 11-argument function. One transaction; tenant fail-closed; money roles; line lock; books lock; narration, outside-India and LUT checks as R-2440.';

-- ── 5. Un-reconciled → the forex / charges rows go ────────────────────────────────────────────
create or replace function public.tg_bank_fx_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2427: the line no longer carries its export receipt — its exchange difference and the
     remitting bank's charges are no longer this line's. The line deleted (expenses.reconciled_txn_id
     would only be set null) → the same: they must not stay behind as paid, unbanked expenses. */
  if tg_op = 'UPDATE'
     and old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  delete from public.expenses
   where tenant_id = old.tenant_id
     and id in ('EXP-FXC-' || old.id::text, 'EXP-FXD-' || old.id::text);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.tg_bank_fx_line_unmatched() from public, anon, authenticated;

drop trigger if exists trg_bank_fx_line_unmatched on public.bank_transactions;
create trigger trg_bank_fx_line_unmatched
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bank_fx_line_unmatched();
drop trigger if exists trg_bank_fx_line_deleted on public.bank_transactions;
create trigger trg_bank_fx_line_deleted
  before delete on public.bank_transactions
  for each row execute function public.tg_bank_fx_line_unmatched();

commit;

notify pgrst, 'reload schema';
