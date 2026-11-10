-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') and prosrc like '%R-1678%') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'export_inward_ref')
-- deploy-key: r1678forexreceipts
--
-- R-1678 (+ R-2171's export-invoice-from-USD-receipt part), 5 Nov 2026, p1 money (G-ZOHO, sales.md
-- rows 25 + 28). Owner: Excel's banking reconcile first.
--
-- THE GAPS (R-2094 #7, #10, #17, #27, #41 — real USD receipts):
--   (1) A ₹ receipt for a foreign-currency invoice — Peak Performance: USD 139 @ 95.007 = ₹13,206 in the
--       books, ₹12,976 reached the bank (Razorpay / NEFT, no "USD…@" in the narration). R-2427's
--       reconcile_bank_credit_fx_invoice needs an inward-remittance narration, so the line could only
--       be booked as ₹12,976 → ₹230 left "due" (or, at 1/2/10%, guessed as TDS). The customer paid
--       the whole USD 139: the ₹230 is an exchange loss (AS-11), not a due and not TDS.
--   (2) Several USD invoices paid by ONE inward credit (Bot Workshop: INV-0372..0376 = USD 3,922 in
--       one INW line). "Several quotes / invoices" (reconcile_bank_credit_split) booked ₹ only and the
--       sheet refused foreign items (R-2466 splitFxProblem).
--   (3) The ledger: the owner names it "Exchange gain / loss (realised)" (CA Hitesh to confirm — R-1678
--       needsDecision); R-2427 called it "Foreign Exchange Gain / Loss".
--   (4) An export invoice realised by an inward remittance did not record the remittance's reference
--       (the INW number the bank's FIRA / e-BRC carries).
--
-- WHAT THIS DOES (no parallel model — R-2427's books as they are):
--   * reconcile_bank_credit_split (5 args, latest body R-2430 20261103200938) takes p_rest = 'fx': every
--     item is an open invoice / quote in ONE foreign currency with a rate, each settled in FULL (its
--     ₹ due at its own frozen rate — the invoice keeps its rate), no new sale. Then:
--       - narration has a remittance ("INW … USD1500.0@95"): its currency must be the items'; USD
--         received vs USD due → the short part (≤ 5%) × the bank's rate is Bank Charges (charges kept
--         abroad, never TDS); more USD than due is refused (advance); bank rate within 25% of the
--         invoices' (R-2427's rule);
--       - no remittance (a ₹ credit): the ₹ gap must be within 10% of the items' ₹ due;
--       - exchange difference = Σ ₹ due − charges − bank credit → ONE paid expense row
--         "Exchange gain / loss (realised)" tied to the line (bank_fx_book_differences, EXP-FXD-<line>;
--         < 0 = a gain), removed on un-reconcile by R-2427's tg_bank_fx_line_unmatched.
--       - split by each item's foreign amount: its share of the bank credit = credit × its USD ÷ all USD
--         (last item takes the rounding), charges likewise; per item forex = ₹ due − share − charges
--         (result fx_parts).
--   * bank_fx_book_differences: the ledger name above; then stamps the inward reference.
--   * invoices.export_inward_ref (new, lifecycle column like paid_date — not frozen): the INW reference of
--     the remittance that realised an export invoice; filled once (bank_fx_stamp_export_ref) by every
--     remittance path: split 'fx', R-2427 fx_invoice, the 11- and 12-argument new_sale_fx.
--   * reconcile_bank_credit_new_sale_fx (11 args, latest body R-2444 20261104023601): + the stamp. The
--     invoice was already dated the bank line's date, overseas, POS 96, 0% under the FY's LUT (R-2440 /
--     R-2444) → GSTR-1 table 6A (WOPAY) via lib/gst/gstr1.ts isExportDoc.
--   * tg_bank_fx_line_unmatched (R-2427's trigger): un-reconciling the line also clears the inward
--     reference it stamped, so a re-match records the right remittance.
--   * Existing "Foreign Exchange Gain / Loss" rows (R-2427, from 4 Nov) are renamed to the new ledger —
--     the same ledger under its new name (amounts, dates and periods untouched), also inside locked
--     books: one ledger, one name on every P&L.
-- Not changed: report_pnl (reads expenses by category), report_balance_sheet, R-2427's fx_invoice and
-- 12-arg bodies (they reach the new ledger + stamp through bank_fx_book_differences).
-- Test: supabase/tests/r1678_forex_receipts.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. The inward reference on an export invoice ────────────────────────────────────────────────
alter table public.invoices add column if not exists export_inward_ref text;
comment on column public.invoices.export_inward_ref is
  'R-1678: the bank''s inward remittance reference (the INW number on the FIRA / e-BRC) of the receipt that realised this export invoice. Filled once by the remittance reconcile paths; lifecycle data, not frozen.';

-- ── 2. The INW number in a narration ("INW 070826I049902623 USD1024.0@93.6") ──────────────────────
create or replace function public.bank_inward_ref(p_description text)
returns text
language sql
immutable
set search_path = public
as $$
  /* R-1678: HDFC writes "INW <reference> <CUR><amount>@<rate>"; the reference is what the FIRA carries. */
  /* At least one digit: "INW TRANSFER …" is a word, not a reference. */
  select (regexp_match(upper(coalesce(p_description, '')), '(?:^|[^A-Z])INW[\s:/-]*((?=[0-9A-Z]*[0-9])[0-9A-Z]{8,30})'))[1]
$$;
revoke all on function public.bank_inward_ref(text) from public, anon;
grant execute on function public.bank_inward_ref(text) to authenticated, service_role;

-- ── 3. Stamp it on the export invoices this line's receipts paid ─────────────────────────────────
create or replace function public.bank_fx_stamp_export_ref(p_txn_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_txn record;
  v_ref text;
  v_n   integer := 0;
begin
  /* R-1678: only a foreign inward remittance (bank_fx_narration) has a FIRA reference. */
  select t.id, t.tenant_id, t.description, t.reference, t.matched_to_type, t.matched_to_id into v_txn
    from public.bank_transactions t where t.id = p_txn_id;
  if not found or public.bank_fx_narration(v_txn.description) is null then return 0; end if;
  v_ref := coalesce(public.bank_inward_ref(v_txn.description), nullif(btrim(coalesce(v_txn.reference, '')), ''));
  if v_ref is null then return 0; end if;
  update public.invoices i
     set export_inward_ref = v_ref
   where i.tenant_id = v_txn.tenant_id
     and i.export_inward_ref is null
     and (upper(coalesce(nullif(btrim(i.currency), ''), 'INR')) <> 'INR' or i.gst_treatment = 'overseas')
     and i.id in (
       select coalesce(p.invoice_id, q.invoice_id)
         from public.payments p
         left join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
        where p.tenant_id = v_txn.tenant_id
          and (p.bank_txn_id = v_txn.id
               or (v_txn.matched_to_type = 'payment' and p.id::text = v_txn.matched_to_id)));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function public.bank_fx_stamp_export_ref(uuid) from public, anon, authenticated;
grant execute on function public.bank_fx_stamp_export_ref(uuid) to service_role;

-- ── 4. The two expense rows (from 20261104001617_r2427) — new ledger name + the stamp ────────────
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
  /* R-2427: called by the export-receipt RPCs after the line is matched to the receipt.
     R-1678: the ledger is "Exchange gain / loss (realised)" (CA to confirm), and the export invoices
     this line realised record its inward reference. */
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
      ('EXP-FXD-' || p_txn_id::text, v_txn.tenant_id, 'Exchange gain / loss (realised)', null, v_txn.txn_date, p_forex, 0, 'none', 'bank',
       case when p_forex < 0 then 'Exchange gain' else 'Exchange loss' end || ' on realisation — ' || p_what,
       true, v_txn.txn_date, v_txn.bank_account_id, p_txn_id);
  end if;
  perform public.bank_fx_stamp_export_ref(p_txn_id);
end;
$$;
revoke all on function public.bank_fx_book_differences(uuid, uuid, integer, integer, text) from public, anon, authenticated;
grant execute on function public.bank_fx_book_differences(uuid, uuid, integer, integer, text) to service_role;

-- ── 5. R-2427's rows → the new ledger (a rename: amounts, dates and periods untouched) ────────────
update public.expenses
   set category = 'Exchange gain / loss (realised)'
 where category = 'Foreign Exchange Gain / Loss';

-- ── 5b. Un-reconciled → the forex / charges rows go AND the inward reference it stamped (from R-2427) ──
create or replace function public.tg_bank_fx_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref text;
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
  /* R-1678: the inward reference this line stamped (bank_fx_stamp_export_ref) goes too. Runs before
     R-2098's trg_bank_split_line_unmatched (name order), so the receipts still point at the line. */
  if public.bank_fx_narration(old.description) is not null then
    v_ref := coalesce(public.bank_inward_ref(old.description), nullif(btrim(coalesce(old.reference, '')), ''));
    if v_ref is not null then
      update public.invoices i
         set export_inward_ref = null
       where i.tenant_id = old.tenant_id
         and i.export_inward_ref = v_ref
         and i.id in (
           select coalesce(p.invoice_id, q.invoice_id)
             from public.payments p
             left join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
            where p.tenant_id = old.tenant_id
              and (p.bank_txn_id = old.id or (old.matched_to_type = 'payment' and p.id::text = old.matched_to_id)));
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function public.tg_bank_fx_line_unmatched() from public, anon, authenticated;

-- ── 6. reconcile_bank_credit_new_sale_fx, 11 args (from 20261104023601_r2444_lut_per_fy) + the stamp ──
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
               or (public.current_request_role() is null
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

  /* R-2440 → R-2444: 0% export only under the LUT of the bank line's financial year — tenant_luts,
     one row per FY, read by export_lut_refusal (lut_for). Same words on every export path. */
  v_lut := public.export_lut_refusal(v_txn.tenant_id, v_txn.txn_date);
  if v_lut is not null then
    raise exception '%', v_lut using errcode = 'check_violation';
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
  /* R-1678: the export invoice records the remittance's INW reference (FIRA / e-BRC). */
  perform public.bank_fx_stamp_export_ref(p_txn_id);

  return v_res || jsonb_build_object(
    'currency', v_cur, 'fx_rate', v_n_rate, 'foreign_amount', v_n_amt, 'fx_invoices', v_invs);
end;
$$;

revoke all on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) from public, anon;
grant execute on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) to authenticated, service_role;

comment on function public.reconcile_bank_credit_new_sale_fx(uuid, uuid, jsonb, boolean, date, date, text, text, text, numeric, numeric) is
  'R-2425/R-2440/R-2444: an export receipt (foreign inward remittance) booked as a new sale — reconcile_bank_credit_new_sale (11 args, no TDS) + the quote and its invoice stamped with the currency and the bank''s rate, in one transaction. Refused unless the currency, foreign amount and rate are the ones in the bank line''s narration, foreign amount × rate = the bank credit (±₹1), the customer is outside India and the company has an LUT for the line''s financial year (tenant_luts, R-2444).';

-- ── 7. reconcile_bank_credit_split (from 20261103200938_r2430_placeholder_ref_bank_line) + p_rest 'fx' ──
create or replace function public.reconcile_bank_credit_split(
  p_txn_id      uuid,
  p_customer_id uuid,
  p_items       jsonb,              -- [{quote_id | invoice_id, amount}]
  p_sale        jsonb default null, -- {lines, billing_cycle, create_subscription, sub_start, sub_renewal, amount}
  p_rest        text  default null  -- what the difference is: 'advance' | 'round_off' | 'fx' (R-1678) (null = must be exact)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098. The round-off limit (₹50) is ROUND_OFF_LIMIT in src/lib/banking/credit-pay-for-multi.ts.
   R-2098 round-off full only: a round-off only when every item (and a new sale) ends settled in full. */
/* R-2397: a new sale priced below cost is not booked — its quote waits in Needs approval and
   nothing on this line is paid or reconciled (bank_sale_park_for_approval). */
/* R-1678: p_rest 'fx' — foreign-currency items settled in full; the difference is an exchange gain / loss
   (and, on an inward remittance short of the dollars due, the remitting bank's charges). The limits
   (10% for a ₹ credit, 5% short and 25% rate for a remittance) are FX_INR_GAP_SHARE in
   src/lib/banking/item-fx-pay.ts (splitFxPlan) and R-2427's FX_CHARGES_MAX_SHARE / FX_RATE_MAX_DRIFT in
   src/lib/integrations/zoho-books/bulk-reconcile-plan.ts. */
declare
  c_limit     constant integer := 50;
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_ref       text;
  v_item      jsonb;
  v_amt       numeric;
  v_due       integer;
  v_open      record;
  v_keys      text[] := array[]::text[];
  v_quotes    text[] := array[]::text[];
  v_key       text;
  v_sum       integer := 0;
  v_sale_amt  integer := 0;
  v_sale      jsonb;
  v_diff      integer;
  v_core      jsonb;
  v_parts     jsonb := '[]'::jsonb;
  v_pay_ids   uuid[] := array[]::uuid[];
  v_first     uuid;
  v_adv       jsonb := null;
  v_round     integer := 0;
  v_n         integer := 0;
  v_part      text := null;      -- the first item left part-paid (its amount < its due)
  /* R-1678 ('fx') */
  v_fx_cur    text := null;
  v_icur      text;
  v_fx_ids    text[] := array[]::text[];
  v_fx_dues   integer[] := array[]::integer[];
  v_fx_fdues  numeric[] := array[]::numeric[];
  v_fx_n      jsonb;
  v_fx_fdue   numeric := 0;
  v_fx_short  numeric := 0;
  v_fx_rate   numeric;
  v_fx_charge integer := 0;
  v_fx_diff   integer := 0;
  v_fx_parts  jsonb := '[]'::jsonb;
  v_fx_share  integer;
  v_fx_chg_i  integer;
  v_fx_left   integer;
  v_fx_chleft integer;
  v_fx_what   text;
  k           integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can reconcile a bank receipt' using errcode = '42501';
  end if;

  /* The line, locked: a second click waits here, then finds it reconciled and is refused. */
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay quotes or invoices.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.customers c where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id) then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;
  if p_rest = 'fx' and p_sale is not null then
    raise exception 'An exchange gain / loss settles open invoices in a foreign currency only — book the new sale on its own.' using errcode = '22023';
  end if;
  /* R-2397: below cost → the sale's quote waits for approval; no item is paid, the line stays unmatched. */
  if p_sale is not null and public.bank_sale_lines_below_cost(p_sale->'lines') then
    return public.bank_sale_park_for_approval(p_txn_id, p_customer_id, p_sale->'lines', nullif(p_sale->>'billing_cycle', ''))
           || jsonb_build_object('kind', 'split');
  end if;
  if p_rest is not null and p_rest not in ('advance', 'round_off', 'fx') then
    raise exception 'The money left over is either an advance, a round-off or an exchange gain / loss.' using errcode = '22023';
  end if;
  if p_items is null then p_items := '[]'::jsonb; end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Pick the quotes / invoices this money pays.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 and p_sale is null then
    raise exception 'Pick at least one quote / invoice or a new sale this money pays.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 100 then
    raise exception 'Too many items on one bank line (% — at most 100).', jsonb_array_length(p_items) using errcode = '22023';
  end if;

  /* Each item: one of this customer's OPEN items (bank_credit_open_items — the list the sheet
     shows), listed once, a whole-rupee amount no more than its due. */
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or (nullif(v_item->>'quote_id', '') is null) = (nullif(v_item->>'invoice_id', '') is null) then
      raise exception 'Each item is one quote or one invoice. Refresh and try again.' using errcode = '22023';
    end if;
    begin
      v_amt := (v_item->>'amount')::numeric;
    exception when others then
      raise exception 'The amount for % is not a number.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end;
    if v_amt is null or v_amt <= 0 or v_amt <> trunc(v_amt) then
      raise exception 'Enter a whole-rupee amount of more than ₹0 for %.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end if;
    v_key := coalesce('I:' || nullif(v_item->>'invoice_id', ''), 'Q:' || (v_item->>'quote_id'));
    if v_key = any(v_keys) then
      raise exception '% is listed twice. Keep it once with the full amount.', coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = '22023';
    end if;
    v_keys := v_keys || v_key;
    select o.* into v_open from public.bank_credit_open_items(p_customer_id) o
     where (nullif(v_item->>'invoice_id', '') is not null and o.invoice_id = v_item->>'invoice_id')
        or (nullif(v_item->>'invoice_id', '') is null and o.invoice_id is null and o.quote_id = v_item->>'quote_id');
    if not found then
      raise exception '% is not an open quote or invoice of this customer. Refresh and try again.', coalesce(v_item->>'invoice_id', v_item->>'quote_id')
        using errcode = 'check_violation';
    end if;
    if v_amt > v_open.amount_due then
      raise exception '₹% on % is more than its ₹% due. Put the extra on another item or keep it as advance.',
        v_amt::int, coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_open.amount_due using errcode = 'check_violation';
    end if;
    /* record_payment replays on quote + reference: two items of one quote would book one. */
    if v_open.quote_id is not null then
      if v_open.quote_id = any(v_quotes) then
        raise exception 'Two of these items belong to quote %. Pay one of them here and the other on its own.', v_open.quote_id
          using errcode = 'check_violation';
      end if;
      v_quotes := v_quotes || v_open.quote_id;
    end if;
    if v_part is null and v_amt < v_open.amount_due then
      v_part := coalesce(v_item->>'invoice_id', v_item->>'quote_id');
    end if;
    /* R-1678: an exchange difference only on a foreign-currency item settled in full, all in one currency. */
    if p_rest = 'fx' then
      v_icur := upper(coalesce(nullif(btrim(v_open.currency), ''), 'INR'));
      if v_icur = 'INR' or coalesce(v_open.fx_rate, 0) <= 0 then
        raise exception '% is in ₹ — an exchange gain / loss is only for an invoice in a foreign currency. Keep the difference as advance or round-off.',
          coalesce(v_item->>'invoice_id', v_item->>'quote_id') using errcode = 'check_violation';
      end if;
      if v_fx_cur is not null and v_icur <> v_fx_cur then
        raise exception '% is in % but % is in % — pay invoices of one currency together.',
          coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_icur, v_fx_ids[1], v_fx_cur using errcode = 'check_violation';
      end if;
      if v_amt < v_open.amount_due then
        raise exception '% gets ₹% of its ₹% due — an exchange gain / loss settles an invoice in full only. Pay it in part without it; the rest stays due.',
          coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_amt::int, v_open.amount_due using errcode = 'check_violation';
      end if;
      v_fx_cur := v_icur;
      v_fx_ids := v_fx_ids || coalesce(v_item->>'invoice_id', v_item->>'quote_id');
      v_fx_dues := v_fx_dues || v_amt::int;
      v_fx_fdues := v_fx_fdues || round(v_amt / v_open.fx_rate, 2);
      v_fx_fdue := v_fx_fdue + round(v_amt / v_open.fx_rate, 2);
    end if;
    v_sum := v_sum + v_amt::int;
  end loop;

  if p_sale is not null then
    begin
      v_sale_amt := (p_sale->>'amount')::int;
    exception when others then
      raise exception 'The amount for the new sale is not a whole number.' using errcode = '22023';
    end;
    if coalesce(v_sale_amt, 0) <= 0 then
      raise exception 'Enter how much of this money pays the new sale (more than ₹0).' using errcode = '22023';
    end if;
    v_sum := v_sum + v_sale_amt;
  end if;

  /* R-1678: the exchange difference (and charges kept abroad) instead of advance / round-off. */
  if p_rest = 'fx' then
    if cardinality(v_fx_ids) = 0 then
      raise exception 'Pick the foreign-currency invoices this money settles.' using errcode = '22023';
    end if;
    v_fx_n := public.bank_fx_narration(v_txn.description);
    if v_fx_n is not null then
      /* An inward remittance: the bank's own currency, dollars and rate (R-2427's rules). */
      if v_fx_n->>'currency' <> v_fx_cur then
        raise exception 'These invoices are in %, but this money came in % — reconcile this line by hand.', v_fx_cur, v_fx_n->>'currency'
          using errcode = 'check_violation';
      end if;
      v_fx_rate := (v_fx_n->>'rate')::numeric;
      if abs(round((v_fx_n->>'amount')::numeric * v_fx_rate, 2) - v_txn.credit) > 1 then
        raise exception 'The bank line is ₹%, but % % at ₹% is ₹%. Reconcile this line by hand.',
          v_txn.credit, v_fx_cur, trim_scale((v_fx_n->>'amount')::numeric), trim_scale(v_fx_rate), round((v_fx_n->>'amount')::numeric * v_fx_rate, 2)
          using errcode = 'check_violation';
      end if;
      if abs(v_fx_rate / (v_sum / v_fx_fdue) - 1) > 0.25 then
        raise exception 'The bank''s rate (₹%) is more than 25%% away from these invoices'' rate (₹%) — this money is probably for something else. Reconcile this line by hand.',
          trim_scale(v_fx_rate), round(v_sum / v_fx_fdue, 4) using errcode = 'check_violation';
      end if;
      v_fx_short := v_fx_fdue - (v_fx_n->>'amount')::numeric;
      if abs(v_fx_short) <= 0.02 * cardinality(v_fx_ids) then v_fx_short := 0; end if;   -- whole-₹ dues: cents of noise
      if v_fx_short < 0 then
        raise exception 'The bank got % % but these invoices have only % % due — the extra is the customer''s advance. Reconcile this line by hand.',
          v_fx_cur, trim_scale((v_fx_n->>'amount')::numeric), v_fx_cur, v_fx_fdue using errcode = 'check_violation';
      end if;
      if v_fx_short > v_fx_fdue * 0.05 then
        raise exception 'The bank got % % but these invoices have % % due — % short is more than bank charges (5%%). Pay what came in; the rest stays due.',
          v_fx_cur, trim_scale((v_fx_n->>'amount')::numeric), v_fx_cur, v_fx_fdue, v_fx_short using errcode = 'check_violation';
      end if;
      v_fx_charge := round(v_fx_short * v_fx_rate)::int;
    else
      /* A ₹ credit (NEFT, Razorpay…): the gap is the exchange difference, within 10%. */
      if abs(v_txn.credit - v_sum) > v_sum * 0.10 then
        raise exception '₹% came in for ₹% due on these % invoices — a gap of ₹% is more than 10%%, so it is not an exchange difference. Pay what came in (the rest stays due), or keep the extra as advance.',
          v_txn.credit, v_sum, v_fx_cur, round(abs(v_txn.credit - v_sum)) using errcode = 'check_violation';
      end if;
    end if;
    /* Whole rupees (paise of the credit rounded once): Σ fx_parts.forex = this. */
    v_fx_diff := v_sum - v_fx_charge - round(v_txn.credit)::int;
    /* Split by each item's foreign amount: its share of the credit and of the charges. */
    v_fx_left := round(v_txn.credit)::int;
    v_fx_chleft := v_fx_charge;
    for k in 1 .. cardinality(v_fx_ids) loop
      if k = cardinality(v_fx_ids) then
        v_fx_share := v_fx_left;
        v_fx_chg_i := v_fx_chleft;
      else
        v_fx_share := round(v_txn.credit * v_fx_fdues[k] / v_fx_fdue)::int;
        v_fx_chg_i := round(v_fx_charge * v_fx_fdues[k] / v_fx_fdue)::int;
      end if;
      v_fx_left := v_fx_left - v_fx_share;
      v_fx_chleft := v_fx_chleft - v_fx_chg_i;
      v_fx_parts := v_fx_parts || jsonb_build_object('invoice_id', v_fx_ids[k], 'foreign_due', v_fx_fdues[k], 'due', v_fx_dues[k],
                                                     'bank_share', v_fx_share, 'bank_charges', v_fx_chg_i,
                                                     'forex', v_fx_dues[k] - v_fx_share - v_fx_chg_i);
    end loop;
    v_diff := 0;
  else
  /* Allocated vs received. */
  v_diff := v_txn.credit - v_sum;
  if v_diff < 0 then
    if p_rest = 'round_off' and -v_diff <= c_limit then
      v_round := -v_diff;          -- settled more than came in: a charge
    else
      raise exception 'The items add up to ₹% but only ₹% came in. Lower an amount (a difference up to ₹% can be written off as round-off).',
        v_sum, v_txn.credit, c_limit using errcode = 'check_violation';
    end if;
  elsif v_diff > 0 then
    if p_rest = 'advance' then
      null;
    elsif p_rest = 'round_off' and v_diff <= c_limit then
      v_round := -v_diff;          -- a little more came in: a gain
    else
      raise exception '₹% of the ₹% received is not on any item. Keep it as the customer''s advance%.',
        v_diff, v_txn.credit, case when v_diff <= c_limit then ' or write it off as round-off' else '' end
        using errcode = 'check_violation';
    end if;
  end if;
  end if;

  /* No round-off while an item stays part-paid: the short amount stays due on it. */
  if v_round <> 0 and v_part is not null then
    if v_diff < 0 then
      raise exception '% is paid in part, so nothing is written off as round-off. Lower its amount by ₹% — the rest stays due on it.',
        v_part, -v_diff using errcode = 'check_violation';
    else
      raise exception '% is paid in part, so the ₹% extra is not written off as round-off. Put it on % or keep it as the customer''s advance.',
        v_part, v_diff, v_part using errcode = 'check_violation';
    end if;
  end if;

  /* R-1676: one UTR on several receipts — only this call's own, and not already used. */
  /* R-2430: a placeholder reference is not a UTR — BANK-<line id>, so another zero-ref line on the same quote books. */
  v_ref := public.bank_line_payment_reference(v_txn.reference, v_txn.id);
  perform public.assert_payment_ref_unused(v_txn.tenant_id, 'bank_transfer', v_ref);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key('bank_transfer', v_ref), ''), true);

  /* Each item as if paid on its own. */
  for v_item in select value from jsonb_array_elements(p_items) loop
    /* R-2430: a receipt already on this item with the line's placeholder reference, the same amount and
       on no bank line is probably this money — refused as before R-2430 (a replay), never a second receipt. */
    v_key := public.bank_line_kept_receipt_ref(v_txn.tenant_id, v_txn.reference,
               case when nullif(v_item->>'invoice_id', '') is null then v_item->>'quote_id' end,
               nullif(v_item->>'invoice_id', ''), (v_item->>'amount')::numeric::int);
    if v_key is not null then
      raise exception '% already has a ₹% receipt with reference % that is on no bank line. Pick it with "This money is for" on this line alone, or delete that receipt first. Nothing was saved.',
        coalesce(v_item->>'invoice_id', v_item->>'quote_id'), (v_item->>'amount')::numeric::int, v_key
        using errcode = 'unique_violation';
    end if;
    v_core := public.bank_credit_pay_item(
      p_txn_id, (v_item->>'amount')::numeric::int, v_ref,
      case when nullif(v_item->>'invoice_id', '') is null then v_item->>'quote_id' end,
      nullif(v_item->>'invoice_id', ''), 0, null, null, null, null, null);
    if coalesce((v_core->>'replay')::boolean, false) then
      raise exception '% already has a payment with reference %. Nothing was saved.', coalesce(v_item->>'invoice_id', v_item->>'quote_id'), v_ref
        using errcode = 'unique_violation';
    end if;
    v_pay_ids := v_pay_ids || (v_core->>'payment_id')::uuid;
    v_parts := v_parts || public.bank_credit_item_result(v_txn.tenant_id, v_core, nullif(v_item->>'invoice_id', ''),
                                                          (v_item->>'amount')::numeric::int, 0);
  end loop;

  if p_sale is not null then
    v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_sale->'lines', nullif(p_sale->>'billing_cycle', ''));
    if v_sale_amt > (v_sale->>'quote_total')::int then
      raise exception '₹% on the new sale is more than its ₹% total. Put the extra on another item or keep it as advance.',
        v_sale_amt, (v_sale->>'quote_total')::int using errcode = 'check_violation';
    end if;
    if v_round <> 0 and v_sale_amt < (v_sale->>'quote_total')::int then
      raise exception 'The new sale is paid in part (₹% of ₹%), so nothing is written off as round-off. Lower an amount so the money matches — the rest stays due.',
        v_sale_amt, (v_sale->>'quote_total')::int using errcode = 'check_violation';
    end if;
    v_core := public.bank_credit_pay_item(
      p_txn_id, v_sale_amt, v_ref, v_sale->>'quote_id', null, 0, null, null,
      case when p_sale ? 'create_subscription' then (p_sale->>'create_subscription')::boolean end,
      nullif(p_sale->>'sub_start', '')::date, nullif(p_sale->>'sub_renewal', '')::date);
    v_pay_ids := v_pay_ids || (v_core->>'payment_id')::uuid;
    v_parts := v_parts || (public.bank_credit_item_result(v_txn.tenant_id, v_core, null, v_sale_amt, 0)
                           || jsonb_build_object('new_quote', true, 'quote_total', (v_sale->>'quote_total')::int,
                                                 'tax_rate', (v_sale->>'tax_rate')::int));
  end if;

  if p_rest = 'advance' and v_diff > 0 then
    v_adv := public.bank_credit_book_advance(p_txn_id, p_customer_id, v_diff);
    v_pay_ids := v_pay_ids || (v_adv->>'payment_id')::uuid;
  end if;
  perform set_config('app.payment_ref_batch', '', true);

  /* The line → its first receipt (every existing reader); all receipts → the line. Reconcile
     FIRST: trg_bank_split_line_unmatched clears bank_txn_id when the match changes. */
  v_first := v_pay_ids[1];
  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_first::text, 'manual');
  update public.payments set bank_txn_id = p_txn_id
   where tenant_id = v_txn.tenant_id and id = any(v_pay_ids);
  get diagnostics v_n = row_count;
  if v_n <> cardinality(v_pay_ids) then
    raise exception 'R-2098: linked % of % receipts to the bank line — nothing was saved.', v_n, cardinality(v_pay_ids);
  end if;
  if p_rest = 'fx' then
    v_fx_what := cardinality(v_fx_ids) || ' invoice(s) ' || array_to_string(v_fx_ids, ', ') || ': ' || v_fx_cur || ' ' || trim_scale(v_fx_fdue)
                 || ' due = ₹' || v_sum || ', ₹' || trim_scale(v_txn.credit) || ' received'
                 || case when v_fx_n is not null then ' (' || v_fx_cur || ' ' || trim_scale((v_fx_n->>'amount')::numeric) || ' @ ₹' || trim_scale(v_fx_rate) || ')' else '' end;
    perform public.bank_fx_book_differences(p_txn_id, v_first, v_fx_charge, v_fx_diff, v_fx_what);
  end if;
  if v_round <> 0 then
    insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by)
    values (v_txn.tenant_id, p_txn_id, v_round, auth.uid());
  end if;

  return jsonb_build_object(
    'kind',           'split',
    'amount',         v_txn.credit,
    'allocated',      v_sum,
    'parts',          v_parts,
    'advance_credit', case when v_adv is not null then v_diff else 0 end,
    'advance_quote_id', v_adv->>'quote_id',
    'advance_receipt_voucher_no', v_adv->>'receipt_voucher_no',
    'round_off',      v_round,
    'payment_id',     v_first)
    || case when p_rest = 'fx' then jsonb_build_object('currency', v_fx_cur, 'foreign_due', v_fx_fdue, 'bank_charges', v_fx_charge,
                                                       'forex_difference', v_fx_diff, 'fx_parts', v_fx_parts)
            else '{}'::jsonb end;
end;
$$;
revoke all on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) to authenticated, service_role;

commit;

notify pgrst, 'reload schema';
