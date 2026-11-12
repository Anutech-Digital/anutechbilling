-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_receipts' and column_name = 'fx_expense_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') and prosrc like '%R-2694 foreign receipt%') and to_regprocedure('public._zoho_fy_fx_line_sync(uuid,uuid[])') is not null
-- deploy-key: r2694zohofyforeignreceipts
--
-- R-2694 (R-2693 part 2, 12 Nov 2026, p0 money, G-FY2526): import USD / foreign-currency Zoho FY payments.
-- Before: every foreign Zoho payment was left out ("book it from its bank line") — all 20 USD invoices of
-- FY 2025-26 stay overdue and the 54 USD inward lines on the bank cannot be reconciled from Zoho's books.
--
-- THE BOOKING (no new ledger — R-2427 / R-1678's forex receipt model, only without a bank line yet):
--   receipt   = on each USD invoice, the ₹ at the INVOICE's own rate (fx_rate): applied USD × its rate,
--               and the whole ₹ due when the payment settles what is left (within 2 cents) — the invoice
--               is Paid exactly when Zoho settles it in full; a part payment leaves the rest due at its rate.
--   forex     = Σ receipts − applied USD × ZOHO's rate → ONE paid expense "Exchange gain / loss (realised)"
--               EXP-ZFXD-<first receipt id> (< 0 = a gain), dated Zoho's payment date, on the deposit account.
--   charges   = Zoho's bank_charges (in the payment's currency, kept abroad by the remitting bank) × Zoho's
--               rate → ONE paid "Bank Charges" expense EXP-ZFXC-<first receipt id>.
--   bank line = what reached the bank = (USD − charges) × Zoho's rate → received_paise: the import's exact
--               ₹ match (now, or "Import again" later) links the line to the receipts, as for a ₹ payment.
--   Until a line holds them, both expenses are "paid, not yet in bank" (report_balance_sheet's
--   expenses_paid_unbanked), the mirror of the receipts' undeposited money: receipts − forex − charges =
--   the money on its way to the bank.
-- NEVER TWICE:
--   * _zoho_fy_fx_line_sync (triggers on bank_transactions / payments): whenever the line holding the
--     receipts of a foreign Zoho payment changes — matched by this import, by hand ("an existing
--     receipt"), un-reconciled — its two expenses follow (reconciled_txn_id = that line, or null). They are
--     never deleted on un-reconcile (they belong to the Zoho payment, not to a line; R-2427's
--     tg_bank_fx_line_unmatched deletes only EXP-FXD-<line id> / EXP-FXC-<line id>).
--   * The same sync REFUSES a bank line that would hold a NEW receipt on an invoice whose imported foreign
--     receipt is still waiting for its line (reconcile_bank_credit_fx_invoice, split 'fx', "This money is
--     for", every Reconcile-from-Zoho row — they all end in a matched line): "match the line to receipt X".
--     A fully paid invoice was already refused there ("nothing left to pay").
--   * _zoho_fy_receipt_link_line: the ₹1 round-off is worked out on receipts − forex − charges vs the line.
-- REFUSED (a person books it): foreign TDS, unused foreign money (an advance in USD), charges not below the
--   money, an invoice in another currency / with no rate, Zoho's rate more than 25% off the invoice's
--   (R-2427's rule), facts read before R-2694 (no per-invoice foreign amounts — "read it from Zoho again").
-- Remove import takes the two expenses back (refused when they were changed — R-2565's rule for the fee).
-- Changes:
--   zoho_fy_receipts + currency, foreign_amount, fx_rate, foreign_charges, fx_difference, fx_charges,
--     fx_expense_id, fx_charges_expense_id
--   import_zoho_fy_receipts ← 20261107134000_r2565 (latest; no later redefinition on anutech/*) + the
--     foreign branch; the zoho_fy_receipts row is written BEFORE the line is linked (the link reads it).
--   _zoho_fy_receipt_link_line ← 20261105192600 (latest) + forex / charges in the round-off.
--   tg_zoho_fy_receipt_fee_gone ← 20261107134000 + the two FX expenses.
--   new _zoho_fy_fx_line_sync + tg_zoho_fy_fx_line_bank / tg_zoho_fy_fx_line_pay; tg_zoho_fy_fx_expense_line;
--   tg_zoho_fy_receipt_payment_delete: Delete payment refuses a receipt the import booked with a currency
--   or a Razorpay fee (R-2565) — Remove import takes it back with its side rows.
-- Not changed: reconcile_bank_credit_fx_invoice, reconcile_bank_credit_split, bank_credit_pay_item,
--   report_pnl / report_balance_sheet (read expenses by category / reconciled_txn_id as today).
-- Follow-ups (card R-2694 followUp): a line whose ₹ is not Zoho's (bank rate ≠ Zoho's rate) is left for a
--   person; the R-2658 Reconcile-from-Zoho row could link the line to the imported receipt by itself.
-- Test: supabase/tests/r2694_zoho_fy_foreign_receipts.test.sql (rolled back; red without this file).
-- Rollback: re-run the three functions from their source files; drop the sync triggers + function; drop
--   the 8 columns (no data moves).

begin;

alter table public.zoho_fy_receipts add column if not exists currency text;
alter table public.zoho_fy_receipts add column if not exists foreign_amount numeric(14, 2);
alter table public.zoho_fy_receipts add column if not exists fx_rate numeric(14, 6);
alter table public.zoho_fy_receipts add column if not exists foreign_charges numeric(14, 2) not null default 0;
alter table public.zoho_fy_receipts add column if not exists fx_difference integer not null default 0;
alter table public.zoho_fy_receipts add column if not exists fx_charges integer not null default 0;
alter table public.zoho_fy_receipts add column if not exists fx_expense_id text;
alter table public.zoho_fy_receipts add column if not exists fx_charges_expense_id text;
alter table public.zoho_fy_receipts drop constraint if exists zoho_fy_receipts_fx_check;
alter table public.zoho_fy_receipts add constraint zoho_fy_receipts_fx_check
  check ((currency is null and foreign_amount is null and fx_rate is null and fx_difference = 0 and fx_charges = 0
          and fx_expense_id is null and fx_charges_expense_id is null and foreign_charges = 0)
         or (currency ~ '^[A-Z]{3}$' and currency <> 'INR' and foreign_amount > 0 and fx_rate > 0 and foreign_charges >= 0
             and fx_charges >= 0 and (fx_difference = 0) = (fx_expense_id is null) and (fx_charges = 0) = (fx_charges_expense_id is null)));
comment on column public.zoho_fy_receipts.currency is
  'R-2694: a foreign-currency Zoho payment''s currency (null = ₹). Its receipts are in ₹ at each invoice''s own rate.';
comment on column public.zoho_fy_receipts.fx_difference is
  'R-2694: receipts (₹ at the invoices'' rates) − applied foreign money × Zoho''s rate, booked as fx_expense_id (EXP-ZFXD-<receipt id>, "Exchange gain / loss (realised)"; < 0 = a gain).';
comment on column public.zoho_fy_receipts.fx_charges is
  'R-2694: Zoho''s bank_charges × Zoho''s rate, booked as fx_charges_expense_id (EXP-ZFXC-<receipt id>, Bank Charges).';

create or replace function public.import_zoho_fy_receipts(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 6 Nov: vouchers, 2b / 2c matching safety, round-off, TDS gross)
     R-2565: Razorpay fee (Zoho bank_charges) booked as the Bank Charges expense EXP-RZPFEE-<receipt>
     R-2694 foreign receipt: USD (any foreign) payments — ₹ at the invoices' rates, exchange gain / loss
     and the remitting bank's charges as EXP-ZFXD / EXP-ZFXC-<first receipt id> */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_acct     uuid;
  v_paise    bigint;
  v_excess   integer;
  v_ref      text;
  v_method   text;
  v_line     jsonb;
  v_inv      record;
  v_cust     uuid;
  v_settle   integer;
  v_tds      integer;
  v_cash     integer;
  v_due      integer;
  v_alloc    jsonb;
  v_sum_cash integer;
  v_sum_tds  integer;
  v_r        jsonb;
  v_adv      jsonb;
  v_pays     uuid[];
  v_bank     jsonb;
  v_txn      uuid;
  v_done_row public.zoho_fy_receipts;
  v_reason   text;
  v_hand     timestamptz;
  v_seen     text[] := array[]::text[];
  v_used     uuid[] := array[]::uuid[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_banked   integer := 0;
  v_later    integer := 0;
  v_n        integer := 0;
  v_tot_cash bigint := 0;
  v_tot_tds  bigint := 0;
  v_tot_adv  bigint := 0;
  /* R-2565 */
  v_fee      integer;
  v_fee_gst  integer;
  v_fee_pay  uuid;
  v_fee_amt  integer;
  v_fee_exp  text;
  v_vendor   record;
  v_own_st   text;
  v_v_st     text;
  v_igst     integer;
  v_cgst     integer;
  v_sgst     integer;
  v_fees     integer := 0;
  v_tot_fee  bigint := 0;
  v_via      boolean;
  v_fee_ctx  boolean := false;
  /* R-2694 foreign receipt (USD …): Zoho's own figures in its currency, the ₹ at the invoices' rates */
  v_cur      text;
  v_zrate    numeric;
  v_famt     numeric;
  v_fchg     numeric;
  v_flines   jsonb;
  v_fline    numeric;
  v_fsum     numeric;
  v_fall     numeric;
  v_icur     text;
  v_part     integer;
  v_fxd      integer;
  v_fxc      integer;
  v_fxd_id   text;
  v_fxc_id   text;
  v_fx_n     integer := 0;
  v_tot_fxd  bigint := 0;
  v_tot_fxc  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing receipts needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY receipts from Zoho. Ask one of them.'
      using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
     or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There are no payments to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2501 at the end, so every receipt, TDS row, advance, bank match,
     the batch row and the log roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'customerpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_payment_id', ''));
    v_reason := null;
    v_num := v_zid;
    v_scan := null;
    v_fee := 0;
    v_fee_gst := 0;
    v_via := false;
    v_cur := null;
    v_zrate := null;
    v_famt := null;
    v_fchg := 0;
    v_flines := null;
    v_fsum := 0;
    v_fall := 0;
    v_fxd := 0;
    v_fxc := 0;

    if v_zid = '' or v_zid = any (v_seen) then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', 'Listed twice or with no Zoho id.');
      continue;
    end if;
    v_seen := v_seen || v_zid;

    /* Already booked (a rerun) — first, so a later lock or Zoho change never calls it "refused".
       Review: bank_txn_id follows the books — the line its receipts are on NOW (matched by hand, or
       un-reconciled since) — and a receipt on no line is matched if its line has come in since. */
    select * into v_done_row from public.zoho_fy_receipts r where r.tenant_id = v_tenant and r.zoho_payment_id = v_zid for update;
    if found then
      v_already := v_already + 1;
      select coalesce(
               (select p.bank_txn_id from public.payments p
                 where p.tenant_id = v_tenant and p.id = any (v_done_row.payment_ids) and p.bank_txn_id is not null limit 1),
               (select t.id from public.bank_transactions t
                 where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                   and t.matched_to_id = any (v_done_row.payment_ids::text[]) limit 1))
        into v_txn;
      if v_txn is distinct from v_done_row.bank_txn_id then
        update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = case when v_txn is not null then now() end,
                                           bank_matched_by_import = false
         where tenant_id = v_tenant and zoho_payment_id = v_zid;
      end if;
      /* R-2565: a Razorpay fee payment reaches the bank inside a Razorpay settlement — matched there
         (Banking → Reconcile → Razorpay settlement, R-2099), never alone by its own amount. */
      if v_txn is null and not v_done_row.via_settlement then
        v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_done_row.bank_account_id, v_done_row.received_paise,
                                                    v_done_row.received_on, v_done_row.reference, v_done_row.customer_id);
        v_txn := nullif(v_bank->>'txn_id', '')::uuid;
        if v_txn is not null and not (v_txn = any (v_used)) then
          begin
            if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_done_row.payment_ids, v_bank->>'confidence') then
              update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now(), bank_matched_by_import = true
               where tenant_id = v_tenant and zoho_payment_id = v_zid;
              v_used := v_used || v_txn;
              v_banked := v_banked + 1;
              v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_done_row.reference,
                                                     'bank_txn_id', v_txn, 'matched_later', true);
            end if;
          exception when others then
            v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_zid,
              'reason', 'Booked earlier; its bank line could not be matched: ' || sqlerrm);
          end;
        end if;
      end if;
      continue;
    end if;

    select * into v_scan from public.zoho_fy_scan s
     where s.tenant_id = v_tenant and s.kind = 'customerpayments' and s.zoho_id = v_zid and s.fy = p_fy;
    if not found or v_scan.payload is null then
      v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
    else
      v_p   := v_scan.payload;
      v_num := btrim(coalesce(v_p->>'number', v_zid));
      begin
        v_date   := (v_p->>'date')::date;
        v_paise  := (v_p->>'receivedPaise')::bigint;
        v_excess := coalesce((v_p->>'excess')::integer, 0);
        v_acct   := nullif(v_pick->>'bank_account_id', '')::uuid;
        v_fee    := coalesce((v_p->>'fee')::integer, 0);
        v_fee_gst := coalesce((v_p->>'feeGst')::integer, 0);
        v_via    := coalesce((v_p->>'viaSettlement')::boolean, false) or v_fee > 0;
        /* R-2694 foreign receipt: the payment's own currency figures (facts from R-2694's normaliser):
           foreignAmount, fxRate (Zoho's ₹ per unit), foreignCharges (Zoho's bank_charges, same currency),
           foreignLines [{zohoInvoiceId, foreign}] (applied per invoice; their sum vs the money = the unused
           part — never trusted from a field of its own). What reaches the bank — and so finds its line — is
           (money − charges) × Zoho's rate, worked out HERE. Every cast is inside this handler (review). */
        v_cur := upper(nullif(btrim(coalesce(v_p->>'currency', '')), ''));
        if v_cur = 'INR' then v_cur := null; end if;
        if v_cur is not null then
          v_zrate  := nullif(v_p->>'fxRate', '')::numeric;
          v_famt   := nullif(v_p->>'foreignAmount', '')::numeric;
          v_fchg   := coalesce(nullif(v_p->>'foreignCharges', '')::numeric, 0);
          v_flines := v_p->'foreignLines';
          v_fee    := 0;            -- a foreign payment's bank_charges are booked below, never as a Razorpay fee
          v_fee_gst := 0;
          v_via    := false;
          v_excess := 0;
          v_paise  := case when v_zrate > 0 and v_famt > 0 then round((v_famt - v_fchg) * v_zrate * 100)::bigint end;
          select coalesce(sum(nullif(x->>'foreign', '')::numeric), 0) into v_fall
            from jsonb_array_elements(case when jsonb_typeof(v_flines) = 'array' then v_flines else '[]'::jsonb end) x;
        end if;
      exception when others then
        v_reason := 'Its date, amount or account could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      v_method := coalesce(nullif(v_p->>'method', ''), 'other');
      v_ref := left(coalesce(nullif(btrim(v_p->>'reference'), ''), 'ZOHO-PAY-' || v_num), 100);
      if jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      /* R-2694 foreign receipt: Zoho's figures must be all there and add up — else a person books it. */
      elsif v_cur is not null and coalesce(jsonb_typeof(v_flines), '') <> 'array' then
        v_reason := format('Received in %s — read it from Zoho again (read before foreign-currency payments could be imported).', v_cur);
      elsif v_cur is not null and (coalesce(v_zrate, 0) <= 0 or coalesce(v_famt, 0) <= 0) then
        v_reason := format('Received in %s in Zoho with no exchange rate or amount — book it from its bank line (Banking → Reconcile).', v_cur);
      elsif v_cur is not null and v_famt - v_fall > 0.01 then
        v_reason := format('%s %s of it is not applied to any invoice in Zoho (an advance in %s) — book it from its bank line (Banking → Reconcile).',
                           v_cur, trim_scale(v_famt - v_fall), v_cur);
      elsif v_cur is not null and v_fall - v_famt > 0.01 then
        v_reason := format('Zoho applies %s %s to its invoices, but the payment is %s %s — its amounts do not add up; book it by hand.',
                           v_cur, trim_scale(v_fall), v_cur, trim_scale(v_famt));
      elsif v_cur is not null and (v_fchg < 0 or v_fchg >= v_famt) then
        v_reason := format('Zoho''s bank charges (%s %s) on this payment of %s %s could not be booked — book it by hand.', v_cur, trim_scale(v_fchg), v_cur, trim_scale(v_famt));
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_paise is null or v_paise <= 0 or v_excess < 0 then
        v_reason := 'Zoho shows no money received on this payment.';
      elsif v_fee < 0 or v_fee_gst < 0 or v_fee_gst > v_fee or v_fee::bigint * 100 >= v_paise then
        v_reason := 'Zoho''s Razorpay fee on this payment could not be booked — read it from Zoho again.';
      elsif v_fee > 0 and v_method <> 'razorpay' then
        v_reason := 'Zoho took bank charges off this payment and it is not a Razorpay payment — book it by hand.';
      /* review: 'razorpay' has no one-credit-once key (payment_ref_key) — the same Razorpay payment already
         in the app (the webhook on a quote, or by hand) would be booked twice and block its settlement. */
      elsif v_via and v_ref ~ '^pay_[A-Za-z0-9]+$'
            and exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.reference = v_ref
                          and p.status in ('received', 'refunded')) then
        v_reason := format('Razorpay payment %s is already in the app (recorded on a quote or by hand) — check it before importing this payment.', v_ref);
      elsif v_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
        v_reason := 'Its payment mode could not be read — read it from Zoho again.';
      elsif jsonb_typeof(v_p->'lines') <> 'array' or jsonb_array_length(v_p->'lines') = 0 then
        v_reason := 'Not applied to any invoice in Zoho (an advance) — record it by hand on the right customer.';
      elsif v_acct is null or not exists (select 1 from public.bank_accounts b where b.id = v_acct and b.tenant_id = v_tenant) then
        v_reason := format('Choose the app account for Zoho''s "%s".', coalesce(nullif(v_p->>'depositAccountName', ''), 'no account'));
      end if;
    end if;

    /* Each line: an FY sale imported from Zoho, of one customer, with the money due. */
    v_alloc := '[]'::jsonb;
    v_cust := null;
    v_sum_cash := 0;
    v_sum_tds := 0;
    if v_reason is null then
      for v_line in select value from jsonb_array_elements(v_p->'lines') loop
        select i.id, i.customer_id, i.status, i.amount, i.net_payable, i.paid_amount, i.document_kind, i.taxable_value,
               i.currency, i.fx_rate into v_inv
          from public.invoices i
         where i.tenant_id = v_tenant and i.zoho_invoice_id = v_line->>'zohoInvoiceId';
        if not found then
          if exists (select 1 from public.invoices i where i.tenant_id = v_tenant and i.document_kind = 'opening_invoice'
                      and upper(i.external_number) = upper(btrim(coalesce(v_line->>'invoiceNumber', '')))) then
            v_reason := format('%s is an opening invoice here — its balance already leaves this receipt out (re-stated by R-2504 first).', v_line->>'invoiceNumber');
          else
            v_reason := format('%s is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).', coalesce(v_line->>'invoiceNumber', '?'));
          end if;
          exit;
        end if;
        if v_cust is not null and v_inv.customer_id is distinct from v_cust then
          v_reason := 'Its invoices belong to different customers here.';
          exit;
        end if;
        v_cust := v_inv.customer_id;
        if v_inv.status::text = 'void' then
          v_reason := format('%s is void here.', v_inv.id);
          exit;
        end if;
        begin
          v_settle := (v_line->>'settle')::integer;
          v_tds    := coalesce((v_line->>'tds')::integer, 0);
        exception when others then
          v_reason := 'Its amounts could not be read — read it from Zoho again.';
          exit;
        end;
        v_due := case when v_inv.status::text = 'paid' then 0
                      else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
        if v_cur is not null then
          /* R-2694 foreign receipt: the line's ₹ is its applied foreign money at the INVOICE's own rate
             (R-2427: the invoice keeps its rate); the whole ₹ due when it pays what is left (2 cents of
             rounding — a rupee-rounded due is never "charges"), so the invoice is Paid exactly when Zoho
             settles it in full. Zoho's rate only makes the exchange difference (below). */
          v_icur := upper(coalesce(nullif(btrim(v_inv.currency), ''), 'INR'));
          select nullif(x->>'foreign', '')::numeric into v_fline
            from jsonb_array_elements(v_flines) x
           where x->>'zohoInvoiceId' = v_line->>'zohoInvoiceId'
           limit 1;
          /* review: TDS first — a TDS-only line has no foreign money and must not loop on "read again" */
          if v_tds <> 0 then
            v_reason := format('%s: Zoho shows TDS on a %s payment — a foreign customer deducts no Indian TDS; book it by hand.', v_inv.id, v_cur);
            exit;
          end if;
          if coalesce(v_fline, 0) <= 0 then
            v_reason := format('%s: the %s applied to it could not be read — read it from Zoho again.', v_inv.id, v_cur);
            exit;
          end if;
          if v_icur <> v_cur or coalesce(v_inv.fx_rate, 0) <= 0 then
            v_reason := format('%s is in %s here, but this payment is in %s — book it by hand.', v_inv.id,
                               case when v_icur = 'INR' then '₹' else v_icur end, v_cur);
            exit;
          end if;
          if abs(v_zrate / v_inv.fx_rate - 1) > 0.25 then
            v_reason := format('Zoho''s rate on this payment (₹%s) is more than 25%% away from %s''s rate (₹%s) — check it in Zoho, or book it from its bank line.',
                               trim_scale(v_zrate), v_inv.id, trim_scale(v_inv.fx_rate));
            exit;
          end if;
          v_part := round(v_fline * v_inv.fx_rate)::integer;
          v_settle := case when v_due > 0 and abs(v_part - v_due) <= greatest(1, ceil(v_inv.fx_rate * 0.02)) then v_due else v_part end;
          if v_settle > v_due then
            v_reason := format('%s has only %s %s due here (₹%s at its rate ₹%s), but Zoho applies %s %s with this payment.',
                               v_inv.id, v_cur, trim_scale(round(v_due / v_inv.fx_rate, 2)), v_due, trim_scale(v_inv.fx_rate), v_cur, trim_scale(v_fline));
            exit;
          end if;
          v_fsum := v_fsum + v_fline;
        end if;
        /* ₹1 over is the two roundings (invoice total, this payment): capped at the due. Follow-up: no
           ₹1 advance (holder quote + voucher + credit) — the rupee is a round-off on the bank line when
           it is matched (_zoho_fy_receipt_link_line, bank_receipt_round_offs as R-2098 does). */
        if v_settle > v_due and v_settle - v_due <= 1 and v_due > 0 then
          v_settle := v_due;
        end if;
        if v_settle is null or v_settle <= 0 or v_tds < 0 or v_tds > v_settle then
          v_reason := format('%s: Zoho''s amounts on it could not be booked (settles ₹%s, TDS ₹%s, due ₹%s).', v_inv.id, coalesce(v_settle, 0), v_tds, v_due);
          exit;
        end if;
        if v_settle > v_due then
          v_reason := format('%s has only ₹%s due here, but Zoho settles ₹%s with this payment.', v_inv.id, v_due, v_settle);
          exit;
        end if;
        /* Follow-up (2b): a receipt of the same money on this invoice within 3 days that this import did not
           make (Record payment by hand, any reference) — the money is in the books already: refused. */
        select p.received_at into v_hand
          from public.payments p
         where p.tenant_id = v_tenant and p.invoice_id = v_inv.id and p.quote_id is null and p.status = 'received'
           and p.amount = v_settle
           and (p.received_at at time zone 'Asia/Kolkata')::date between v_date - 3 and v_date + 3
           and not exists (select 1 from public.zoho_fy_receipts r where r.tenant_id = v_tenant and p.id = any (r.payment_ids))
         limit 1;
        if found then
          v_reason := format('%s already has a ₹%s receipt of %s that this import did not make (recorded by hand?) — check it before importing this payment.',
                             v_inv.id, v_settle, to_char((v_hand at time zone 'Asia/Kolkata')::date, 'DD Mon YYYY'));
          exit;
        end if;
        v_cash := v_settle - v_tds;
        v_sum_cash := v_sum_cash + v_cash;
        v_sum_tds := v_sum_tds + v_tds;
        /* Follow-up (low): TDS gross = what this payment settles on the invoice (money + TDS), not the whole
           invoice — so a part payment's rate is right. */
        v_alloc := v_alloc || jsonb_build_object('invoice_id', v_inv.id, 'amount', v_cash, 'tds_amount', v_tds,
                                                 'tds_gross', case when v_tds > 0 then
                                                   round(coalesce(nullif(v_inv.taxable_value, 0), v_inv.amount)::numeric * v_settle
                                                         / nullif(coalesce(v_inv.net_payable, v_inv.amount), 0))::integer end);
      end loop;
      if v_reason is null and v_sum_cash <= 0 then
        v_reason := 'Zoho booked only TDS on this payment, no money — record it by hand.';
      end if;
      /* R-2694 foreign receipt: what Zoho applies must be the whole payment (no unused money); then
           forex   = receipts (₹ at the invoices' rates) − applied money × Zoho's rate (< 0 = a gain),
           charges = Zoho's bank_charges × Zoho's rate,
         so receipts − forex − charges = (money − charges) × Zoho's rate = the bank line (±₹1 rounding). */
      if v_reason is null and v_cur is not null then
        if abs(v_fsum - v_famt) > 0.01 then
          v_reason := format('Zoho applies %s %s to its invoices, but the payment is %s %s — its amounts do not add up; book it by hand.',
                             v_cur, trim_scale(v_fsum), v_cur, trim_scale(v_famt));
        else
          v_fxd := v_sum_cash - round(v_famt * v_zrate)::integer;
          v_fxc := round(v_fchg * v_zrate)::integer;
        end if;
      end if;
    end if;

    /* Its bank line, looked up BEFORE booking: already reconciled to something else → the money is in
       the books already (an advance / sale on the Reconcile sheet) — refused, never a second receipt. */
    /* R-2565: a Razorpay fee payment has no bank line of its own (only amount − fee reached Razorpay's
       settlement, with other payments): it waits for its settlement line (R-2099). */
    v_bank := '{}'::jsonb;
    if v_reason is null and not v_via then
      v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_acct, v_paise, v_date, v_p->>'reference', v_cust);
      if nullif(v_bank->>'taken_txn', '') is not null then
        v_reason := format('Its bank line (%s, ₹%s) is already reconciled as %s — check that line before importing this payment.',
                           to_char((v_bank->>'taken_on')::date, 'DD Mon YYYY'), round(v_paise / 100.0, 2), replace(v_bank->>'taken_as', '_', ' '));
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    /* Book it — its own sub-transaction: any refusal undoes only this payment. */
    begin
      /* Follow-up: vouchers = Zoho's payment number (else the payment date's series) — read by
         _record_opening_invoice_payment / _zoho_fy_receipt_advance; cleared right after. */
      perform set_config('app.zoho_fy_receipt_on', v_date::text, true);
      perform set_config('app.zoho_fy_receipt_no', coalesce(nullif(btrim(v_p->>'number'), ''), ''), true);
      v_r := public.record_multi_invoice_payment(
        v_cust, v_date, v_method, v_acct, v_ref, v_sum_cash, v_alloc, false,
        'FY ' || p_fy || ' receipt from Zoho (payment ' || v_num || ')');
      if coalesce((v_r->>'idempotent_replay')::boolean, false) then
        raise exception 'Reference % is already recorded on these invoices — booked by hand already?', v_ref;
      end if;
      select coalesce(array_agg((l->>'payment_id')::uuid), '{}') into v_pays
        from jsonb_array_elements(v_r->'lines') l where nullif(l->>'payment_id', '') is not null;

      v_adv := null;
      if v_excess > 0 then
        perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(v_method, v_ref), ''), true);
        v_adv := public._zoho_fy_receipt_advance(v_tenant, v_cust, v_excess, v_date, v_method, v_ref, v_acct, v_num);
        perform set_config('app.payment_ref_batch', '', true);
        v_pays := v_pays || (v_adv->>'payment_id')::uuid;
      end if;
      perform set_config('app.zoho_fy_receipt_on', '', true);
      perform set_config('app.zoho_fy_receipt_no', '', true);

      /* R-2565: Razorpay's fee — on the largest receipt of this payment, as R-045 does for a captured
         payment: payments.gateway_fee / _gst (the business bore it: fee_bearer 'business') and ONE
         "Bank Charges" expense EXP-RZPFEE-<receipt>, vendor Razorpay, GST heads from Razorpay's GSTIN
         state vs ours (unknown → none, no guess). The receipt stays the full amount on the invoice.
         R-2099's settlement takes this booked fee off its own (never twice); the balance sheet keeps
         amount − fee as "not yet in bank" until that settlement line is reconciled. */
      v_fee_exp := null;
      if v_fee > 0 then
        select p.id, p.amount into v_fee_pay, v_fee_amt
          from public.payments p
         where p.tenant_id = v_tenant and p.id = any (v_pays)
         order by p.amount desc, p.id
         limit 1;
        if v_fee_pay is null or v_fee_amt < v_fee then
          raise exception 'Zoho''s Razorpay fee ₹% is more than its receipt — book it by hand.', v_fee;
        end if;
        update public.payments
           set gateway_fee = v_fee, gateway_fee_gst = v_fee_gst, fee_bearer = 'business'
         where tenant_id = v_tenant and id = v_fee_pay;
        if not v_fee_ctx then   -- once per call (review): the Razorpay vendor and our state do not change
          select v.id, v.gstin into v_vendor
            from public.vendors v
           where v.tenant_id = v_tenant and v.name ilike '%razorpay%'
           order by (coalesce(btrim(v.gstin), '') <> '') desc, v.created_at asc
           limit 1;
          select coalesce(nullif(btrim(t.state_code), ''), case when length(btrim(coalesce(t.gstin, ''))) = 15 then left(btrim(t.gstin), 2) end)
            into v_own_st from public.tenants t where t.id = v_tenant;
          v_v_st := case when length(btrim(coalesce(v_vendor.gstin, ''))) = 15 then left(btrim(v_vendor.gstin), 2) end;
          v_fee_ctx := true;
        end if;
        if v_fee_gst = 0 then
          v_igst := 0; v_cgst := 0; v_sgst := 0;
        elsif v_own_st is null or v_v_st is null then
          v_igst := null; v_cgst := null; v_sgst := null;
        elsif v_own_st = v_v_st then
          v_cgst := round(v_fee_gst / 2.0); v_sgst := v_fee_gst - v_cgst; v_igst := 0;
        else
          v_igst := v_fee_gst; v_cgst := 0; v_sgst := 0;
        end if;
        v_fee_exp := 'EXP-RZPFEE-' || v_fee_pay::text;
        insert into public.expenses
          (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, igst, cgst, sgst,
           bill_type, paid, paid_date, payment_method, description, notes)
        values
          (v_fee_exp, v_tenant, 'Bank Charges', 'Razorpay', v_vendor.id, v_date, v_fee, v_fee_gst,
           v_igst, v_cgst, v_sgst, 'gst', true, v_date, 'razorpay',
           left('Razorpay fee on ' || v_ref || ' (Zoho payment ' || v_num || ')', 200),
           format('FY %s receipt from Zoho (R-2565): Razorpay kept ₹%s (GST ₹%s inside, 18%%) before settling; the receipt is the full ₹%s on the invoice. Razorpay''s monthly tax invoice is the bill for this GST.',
                  p_fy, v_fee, v_fee_gst, v_sum_cash + v_excess));
      end if;

      /* R-2694 foreign receipt: the exchange difference and the remitting bank's charges — R-2427 /
         R-1678's two paid expense rows, keyed by the Zoho payment (no bank line yet): on the deposit
         account, Zoho's date, reconciled_txn_id set by _zoho_fy_fx_line_sync when a line holds the
         receipts (never deleted on un-reconcile — they belong to this payment). */
      v_fxd_id := null;
      v_fxc_id := null;
      if v_cur is not null and v_fxd <> 0 then
        v_fxd_id := 'EXP-ZFXD-' || v_pays[1]::text;   -- review: a receipt uuid (expenses.id is global, a Zoho id is not)
        insert into public.expenses
          (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
           paid, paid_date, bank_account_id, notes)
        values
          (v_fxd_id, v_tenant, 'Exchange gain / loss (realised)', null, v_date, v_fxd, 0, 'none', 'bank',
           left(case when v_fxd < 0 then 'Exchange gain' else 'Exchange loss' end || ' on realisation — Zoho payment ' || v_num || ': '
                || v_cur || ' ' || trim_scale(v_famt) || ' @ ₹' || trim_scale(v_zrate) || ' received, booked at the invoices'' rates', 200),
           true, v_date, v_acct,
           format('FY %s receipt from Zoho (R-2694): receipts ₹%s at the invoices'' own rates − %s %s × Zoho''s ₹%s = ₹%s.',
                  p_fy, v_sum_cash, v_cur, trim_scale(v_famt), trim_scale(v_zrate), v_fxd));
      end if;
      if v_cur is not null and v_fxc <> 0 then
        v_fxc_id := 'EXP-ZFXC-' || v_pays[1]::text;
        insert into public.expenses
          (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, payment_method, description,
           paid, paid_date, bank_account_id, notes)
        values
          (v_fxc_id, v_tenant, 'Bank Charges', null, v_date, v_fxc, 0, 'none', 'bank',
           left('Remitting bank''s charges kept abroad — Zoho payment ' || v_num || ': ' || v_cur || ' ' || trim_scale(v_fchg)
                || ' @ ₹' || trim_scale(v_zrate), 200),
           true, v_date, v_acct,
           format('FY %s receipt from Zoho (R-2694): Zoho''s bank charges %s %s × ₹%s.', p_fy, v_cur, trim_scale(v_fchg), trim_scale(v_zrate)));
      end if;

      /* R-2694: the row first — the line link below (and its sync trigger) reads it. */
      insert into public.zoho_fy_receipts (tenant_id, zoho_payment_id, fy, batch_id, customer_id, received_on, bank_account_id,
                                           received_paise, cash, tds, advance, reference, payment_ids, bank_txn_id, banked_at, bank_matched_by_import,
                                           fee, fee_gst, fee_expense_id, via_settlement,
                                           currency, foreign_amount, fx_rate, foreign_charges, fx_difference, fx_charges, fx_expense_id, fx_charges_expense_id)
      values (v_tenant, v_zid, p_fy, v_batch, v_cust, v_date, v_acct, v_paise, v_sum_cash + v_excess, v_sum_tds, v_excess,
              v_ref, v_pays, null, null, false,
              v_fee, v_fee_gst, v_fee_exp, v_via,
              v_cur, case when v_cur is not null then v_famt end, case when v_cur is not null then v_zrate end,
              case when v_cur is not null then v_fchg else 0 end, v_fxd, v_fxc, v_fxd_id, v_fxc_id);

      v_txn := null;
      if nullif(v_bank->>'txn_id', '') is not null and not ((v_bank->>'txn_id')::uuid = any (v_used)) then
        v_txn := (v_bank->>'txn_id')::uuid;
        /* Locked, then checked again — matched meanwhile → left for a later run (_zoho_fy_receipt_link_line). */
        if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_pays, v_bank->>'confidence') then
          v_used := v_used || v_txn;
          update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now(), bank_matched_by_import = true
           where tenant_id = v_tenant and zoho_payment_id = v_zid;
        else
          v_txn := null;
        end if;
      end if;
    exception when others then
      perform set_config('app.payment_ref_batch', '', true);
      perform set_config('app.zoho_fy_receipt_on', '', true);
      perform set_config('app.zoho_fy_receipt_no', '', true);
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', sqlerrm);
      continue;
    end;

    v_n := v_n + 1;
    if v_txn is not null then v_banked := v_banked + 1; else v_later := v_later + 1; end if;
    v_tot_cash := v_tot_cash + v_sum_cash + v_excess;
    v_tot_tds := v_tot_tds + v_sum_tds;
    v_tot_adv := v_tot_adv + v_excess;
    if v_fee > 0 then v_fees := v_fees + 1; v_tot_fee := v_tot_fee + v_fee; end if;
    if v_cur is not null then v_fx_n := v_fx_n + 1; v_tot_fxd := v_tot_fxd + v_fxd; v_tot_fxc := v_tot_fxc + v_fxc; end if;
    v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'date', v_date, 'customer_id', v_cust,
      'cash', v_sum_cash + v_excess, 'tds', v_sum_tds, 'advance', v_excess, 'payment_ids', to_jsonb(v_pays), 'bank_txn_id', v_txn,
      'fee', v_fee, 'fee_gst', v_fee_gst, 'fee_expense_id', v_fee_exp,
      'currency', v_cur, 'foreign_amount', case when v_cur is not null then v_famt end,
      'fx_difference', v_fxd, 'fx_charges', v_fxc, 'fx_expense_id', v_fxd_id, 'fx_charges_expense_id', v_fxc_id);
  end loop;

  /* Batch totals: amount = money received, tax = TDS booked, taxable = the part kept as advance. */
  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_tot_adv, tax_total = v_tot_tds, amount_total = v_tot_cash, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_receipts.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s receipts from Zoho (₹%s, TDS ₹%s, %s on bank lines); %s skipped', v_n, p_fy, v_tot_cash, v_tot_tds, v_banked, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'banked', v_banked,
                             'bank_later', v_later, 'skipped', jsonb_array_length(v_skipped),
                             'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv,
                             'with_fee', v_fees, 'fee', v_tot_fee,
                             'foreign', v_fx_n, 'fx_difference', v_tot_fxd, 'fx_charges', v_tot_fxc));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2501', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2501' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'banked', v_banked, 'bank_later', v_later,
    'skipped', v_skipped, 'done', v_done,
    'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv,
    'with_fee', v_fees, 'fee', v_tot_fee,
    'foreign', v_fx_n, 'fx_difference', v_tot_fxd, 'fx_charges', v_tot_fxc);
end;
$function$;

comment on function public.import_zoho_fy_receipts(text, jsonb, boolean) is
  'R-2501 + R-2565 + R-2694: FY customer payments from Zoho as receipts (+ Zoho''s TDS, excess → advance; a Razorpay payment''s fee (Zoho bank_charges) → Bank Charges expense EXP-RZPFEE-<receipt>, banked by its Razorpay settlement; a foreign-currency payment → ₹ at each invoice''s own rate + exchange gain / loss EXP-ZFXD-<receipt id> + remitting bank charges EXP-ZFXC-<receipt id>) on the FY sales imported from Zoho, matched to the bank line when it is in (else on a later run). Money from zoho_fy_scan; picks = Zoho id + app account. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_receipts(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_receipts(text, jsonb, boolean) to authenticated, service_role;


-- ── Remove import: a deleted zoho_fy_receipts row takes its fee expense with it ─────────────────
create or replace function public.tg_zoho_fy_receipt_fee_gone()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  /* R-2565: remove_zoho_fy_receipts_import deletes the row (its receipts were checked untouched, and a
     settlement-reconciled one refuses the undo); the fee expense this import booked goes with it. */
  if old.fee_expense_id is not null then
    /* review: only the expense exactly as the import booked it — one changed since (amount / GST / no
       longer paid) refuses, so a fee someone edited is never deleted silently. */
    if exists (select 1 from public.expenses e
                where e.tenant_id = old.tenant_id and e.id = old.fee_expense_id
                  and (e.amount is distinct from old.fee or coalesce(e.gst_paid, 0) is distinct from old.fee_gst
                       or e.paid is distinct from true)) then
      raise exception 'The Razorpay fee expense % was changed after the import — put it back (₹% incl. GST ₹%) or remove it by hand first.',
        old.fee_expense_id, old.fee, old.fee_gst using errcode = 'P0001';
    end if;
    delete from public.expenses e where e.tenant_id = old.tenant_id and e.id = old.fee_expense_id;
  end if;
  /* R-2694: a foreign payment's exchange difference and remitting-bank charges go with it too — only as
     the import booked them (amount, still paid); an edited one refuses the undo. */
  if old.fx_expense_id is not null or old.fx_charges_expense_id is not null then
    if exists (select 1 from public.expenses e
                where e.tenant_id = old.tenant_id
                  and ((e.id = old.fx_expense_id and e.amount is distinct from old.fx_difference)
                       or (e.id = old.fx_charges_expense_id and e.amount is distinct from old.fx_charges)
                       or (e.id in (old.fx_expense_id, old.fx_charges_expense_id) and e.paid is distinct from true))) then
      raise exception 'The exchange difference (₹%) or bank charges (₹%) of Zoho payment % were changed after the import — put them back or remove them by hand first.',
        old.fx_difference, old.fx_charges, old.zoho_payment_id using errcode = 'P0001';
    end if;
    delete from public.expenses e where e.tenant_id = old.tenant_id and e.id in (old.fx_expense_id, old.fx_charges_expense_id);
  end if;
  return old;
end;
$function$;
revoke all on function public.tg_zoho_fy_receipt_fee_gone() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_receipt_fee_gone on public.zoho_fy_receipts;
create trigger trg_zoho_fy_receipt_fee_gone
  after delete on public.zoho_fy_receipts
  for each row execute function public.tg_zoho_fy_receipt_fee_gone();

-- ── The line that holds a set of receipts NOW (matched to one of them, or carrying them — R-2098) ──
create or replace function public._zoho_fy_receipt_line_of(p_tenant uuid, p_payment_ids uuid[])
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2694: the same rule as the import's "already" path — payments.bank_txn_id on a matched line, else
     a line matched to one of the receipts. */
  select coalesce(
    (select p.bank_txn_id from public.payments p
       join public.bank_transactions t on t.id = p.bank_txn_id and t.tenant_id = p.tenant_id and t.matched_to_type is not null
      where p.tenant_id = p_tenant and p.id = any (p_payment_ids)
      order by p.bank_txn_id limit 1),
    (select t.id from public.bank_transactions t
      where t.tenant_id = p_tenant and t.matched_to_type = 'payment' and t.matched_to_id = any (p_payment_ids::text[])
      order by t.id limit 1));
$function$;
revoke all on function public._zoho_fy_receipt_line_of(uuid, uuid[]) from public, anon, authenticated;

-- ── Never twice: the FX rows follow the receipts' line; no second receipt from a line meanwhile ──
create or replace function public._zoho_fy_fx_line_sync(p_tenant uuid, p_payment_ids uuid[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r      record;
  v_line uuid;
  v_bad  record;
begin
  /* R-2694: p_payment_ids = the receipts whose bank line just changed. */
  if p_tenant is null or p_payment_ids is null or cardinality(p_payment_ids) = 0 then return; end if;
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = p_tenant and z.currency is not null) then return; end if;

  /* (1) A foreign Zoho payment's exchange difference / charges are "in the bank" exactly when a line
     holds its receipts: reconciled_txn_id = that line (the balance sheet then counts them as banked,
     as R-2427's EXP-FXD-<line>), null when the line is un-reconciled — never deleted, never booked again. */
  for r in
    select z.payment_ids, z.fx_expense_id, z.fx_charges_expense_id
      from public.zoho_fy_receipts z
     where z.tenant_id = p_tenant and z.currency is not null and z.payment_ids && p_payment_ids
       and (z.fx_expense_id is not null or z.fx_charges_expense_id is not null)
  loop
    v_line := public._zoho_fy_receipt_line_of(p_tenant, r.payment_ids);
    update public.expenses e
       set reconciled_txn_id = v_line
     where e.tenant_id = p_tenant and e.id in (r.fx_expense_id, r.fx_charges_expense_id)
       and e.reconciled_txn_id is distinct from v_line;
  end loop;

  /* (2) A bank line now holds a receipt on an invoice whose imported foreign Zoho receipt still waits
     for its own line: that is almost surely the same money (reconcile_bank_credit_fx_invoice, split
     'fx', "This money is for" and every Reconcile-from-Zoho row end here) — refused; the person matches
     the line to the imported receipt (or that receipt's line first). */
  select p.invoice_id, z.zoho_payment_id, z.currency, z.foreign_amount, z.received_on,
         (select coalesce(zp.receipt_voucher_no, zp.id::text) from public.payments zp
           where zp.tenant_id = p_tenant and zp.id = any (z.payment_ids) and zp.invoice_id = p.invoice_id limit 1) as voucher
    into v_bad
    from public.payments p
    join public.zoho_fy_receipts z
      on z.tenant_id = p.tenant_id and z.currency is not null and not (p.id = any (z.payment_ids))
     and exists (select 1 from public.payments zp
                  where zp.tenant_id = p_tenant and zp.id = any (z.payment_ids) and zp.invoice_id = p.invoice_id and zp.status = 'received')
   where p.tenant_id = p_tenant and p.id = any (p_payment_ids) and p.invoice_id is not null and p.status = 'received'
     /* another imported Zoho payment's own receipt (its own money, matched by the import) is not refused */
     and not exists (select 1 from public.zoho_fy_receipts z2 where z2.tenant_id = p_tenant and p.id = any (z2.payment_ids))
     and public._zoho_fy_receipt_line_of(p_tenant, array[p.id]) is not null
     and public._zoho_fy_receipt_line_of(p_tenant, z.payment_ids) is null
   limit 1;
  if found then
    raise exception 'Invoice % already has receipt % from Zoho payment % (% % on %), waiting for its bank line — this is probably that money. Match this bank line to receipt % instead (Banking → Reconcile → an existing receipt), or reconcile that receipt''s own line first.',
      v_bad.invoice_id, v_bad.voucher, v_bad.zoho_payment_id, v_bad.currency, trim_scale(v_bad.foreign_amount),
      to_char(v_bad.received_on, 'DD Mon YYYY'), v_bad.voucher
      using errcode = 'check_violation';
  end if;
end;
$function$;
revoke all on function public._zoho_fy_fx_line_sync(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.tg_zoho_fy_fx_line_bank()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ids uuid[];
begin
  /* R-2694: the receipts this line held before and holds now, and the FX rows tied to it. */
  if old.matched_to_type is not distinct from new.matched_to_type and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  /* review: nothing to do (and no scan) for a company with no imported foreign receipt */
  if not exists (select 1 from public.zoho_fy_receipts z where z.tenant_id = new.tenant_id and z.currency is not null) then
    return new;
  end if;
  select coalesce(array_agg(distinct x), '{}') into v_ids from (
    select p.id as x from public.payments p
     where p.tenant_id = new.tenant_id and p.bank_txn_id = new.id
    union all
    select p.id from public.payments p
     where p.tenant_id = new.tenant_id
       and p.id in (public.bank_match_uuid(case when old.matched_to_type = 'payment' then old.matched_to_id end),
                    public.bank_match_uuid(case when new.matched_to_type = 'payment' then new.matched_to_id end))
    union all
    select unnest(z.payment_ids) from public.zoho_fy_receipts z
     where z.tenant_id = new.tenant_id and z.currency is not null
       and exists (select 1 from public.expenses e where e.tenant_id = z.tenant_id and e.reconciled_txn_id = new.id
                     and e.id in (z.fx_expense_id, z.fx_charges_expense_id))) s;
  perform public._zoho_fy_fx_line_sync(new.tenant_id, v_ids);
  return new;
end;
$function$;
revoke all on function public.tg_zoho_fy_fx_line_bank() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_fx_line_bank on public.bank_transactions;
create trigger trg_zoho_fy_fx_line_bank
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_zoho_fy_fx_line_bank();

create or replace function public.tg_zoho_fy_fx_line_pay()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  /* R-2694: a receipt put on / taken off a line by payments.bank_txn_id (R-2098 split shape). */
  if tg_op = 'UPDATE' and old.bank_txn_id is not distinct from new.bank_txn_id then return new; end if;
  if tg_op = 'INSERT' and new.bank_txn_id is null then return new; end if;
  perform public._zoho_fy_fx_line_sync(new.tenant_id, array[new.id]);
  return new;
end;
$function$;
revoke all on function public.tg_zoho_fy_fx_line_pay() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_fx_line_pay on public.payments;
create trigger trg_zoho_fy_fx_line_pay
  after insert or update of bank_txn_id on public.payments
  for each row execute function public.tg_zoho_fy_fx_line_pay();

-- ── The FX rows' line is DERIVED, whoever writes it ───────────────────────────────────────────────
-- reconcile_bank_txn (R-2472) clears every expense's reconciled_txn_id = the line AFTER it matches the
-- line ("clear-then-set" for an expense match), which would untie these rows right after the sync tied
-- them. So for EXP-ZFXD / EXP-ZFXC rows the value is always the line holding their receipts.
create or replace function public.tg_zoho_fy_fx_expense_line()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ids uuid[];
begin
  /* R-2694 */
  select z.payment_ids into v_ids
    from public.zoho_fy_receipts z
   where z.tenant_id = new.tenant_id and z.currency is not null
     and (z.fx_expense_id = new.id or z.fx_charges_expense_id = new.id)
   limit 1;
  if found then
    new.reconciled_txn_id := public._zoho_fy_receipt_line_of(new.tenant_id, v_ids);
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_zoho_fy_fx_expense_line() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_fx_expense_line on public.expenses;
create trigger trg_zoho_fy_fx_expense_line
  before update of reconciled_txn_id on public.expenses
  for each row when (new.id like 'EXP-ZFX%')
  execute function public.tg_zoho_fy_fx_expense_line();

-- ── A receipt the Zoho import booked with side rows is taken back only by Remove import ─────────────
-- Independent review (BLOCK): Payments → Delete payment (delete_payment, R-1567) deleted an imported USD
-- receipt — the invoice went back to overdue, EXP-ZFXD stayed in the P&L and the zoho_fy_receipts row
-- pointed at a deleted payment ("already" forever). R-2565's Razorpay fee (EXP-RZPFEE) had the same hole.
-- remove_zoho_fy_receipts_import deletes its zoho_fy_receipts rows BEFORE the payments, so it is not refused.
create or replace function public.tg_zoho_fy_receipt_payment_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  /* R-2694 */
  if exists (select 1 from public.zoho_fy_receipts z
              where z.tenant_id = old.tenant_id and old.id = any (z.payment_ids)
                and (z.currency is not null or z.fee_expense_id is not null)) then
    raise exception 'This receipt came from the Zoho import — use Remove import on Invoices → FY receipts from Zoho.'
      using errcode = 'check_violation';
  end if;
  return old;
end;
$function$;
revoke all on function public.tg_zoho_fy_receipt_payment_delete() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_receipt_payment_delete on public.payments;
create trigger trg_zoho_fy_receipt_payment_delete
  before delete on public.payments
  for each row execute function public.tg_zoho_fy_receipt_payment_delete();

-- ── _zoho_fy_receipt_link_line (from 20261105192600 — its latest body) + forex / charges ─────────
create or replace function public._zoho_fy_receipt_link_line(p_tenant uuid, p_txn uuid, p_payment_ids uuid[], p_confidence text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 follow-up: the line locked and checked again (matched meanwhile → false, left alone); the
     line → the first receipt, every receipt → the line (R-2098's split shape); a ₹1 difference between
     the money recorded and the line (the rounding rupee) → bank_receipt_round_offs, as R-2098.
     R-2694: a foreign Zoho payment's money = its receipts − exchange difference − remitting-bank charges
     (the two expenses the import booked; tied to this line by _zoho_fy_fx_line_sync). */
  v_credit numeric;
  v_cash   integer;
  v_diff   integer;
begin
  select t.credit into v_credit from public.bank_transactions t
   where t.id = p_txn and t.tenant_id = p_tenant and t.matched_to_type is null
   for update;
  if not found or exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = p_txn) then
    return false;
  end if;
  perform public.reconcile_bank_txn(p_txn, 'payment', p_payment_ids[1]::text, p_confidence);
  if cardinality(p_payment_ids) > 1 then
    update public.payments set bank_txn_id = p_txn where tenant_id = p_tenant and id = any (p_payment_ids);
  end if;
  select coalesce(sum(p.amount), 0)
         - coalesce((select sum(x.tds_amount) from public.tds_receivable x
                      where x.tenant_id = p_tenant and x.payment_id = any (p_payment_ids) and x.status <> 'reversed'), 0)
         - coalesce((select sum(z.fx_difference + z.fx_charges) from public.zoho_fy_receipts z
                      where z.tenant_id = p_tenant and z.currency is not null and z.payment_ids && p_payment_ids), 0)
    into v_cash
    from public.payments p where p.tenant_id = p_tenant and p.id = any (p_payment_ids);
  v_diff := v_cash - round(v_credit)::integer;
  if v_diff <> 0 and abs(v_diff) <= greatest(1, cardinality(p_payment_ids)) then   -- ₹1 per receipt line at most
    insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by)
    values (p_tenant, p_txn, v_diff, auth.uid())
    on conflict (bank_txn_id) do nothing;
  end if;
  return true;
end;
$function$;
revoke all on function public._zoho_fy_receipt_link_line(uuid, uuid, uuid[], text) from public, anon, authenticated;

commit;
