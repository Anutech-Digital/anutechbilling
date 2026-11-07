-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'zoho_fy_receipts' and column_name = 'fee_expense_id') and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') and prosrc like '%R-2565%') and to_regprocedure('public.tg_zoho_fy_receipt_fee_gone()') is not null
-- deploy-key: r2565razorpayfeereceipts
--
-- R-2565 (G-RECON, 7 Nov 2026 staging): the FY 2025-26 receipts import refused every Zoho payment with
-- bank_charges — 130 of the 155 "Razorpay Clearing" payments. Razorpay keeps its fee + 18% GST before it
-- settles; Zoho books amount = the FULL money applied to the invoice and bank_charges = what Razorpay kept.
-- Correct booking (the app's Razorpay rules, R-045 / R-2099 / R-2416..2418):
--   • the receipt = the full amount on the invoice (unchanged — the invoice is fully paid);
--   • the fee = ONE "Bank Charges" expense EXP-RZPFEE-<receipt id> (vendor Razorpay, gst_paid = the 18%
--     inside, heads from Razorpay's GSTIN state — input credit only with a Razorpay GSTIN), and
--     payments.gateway_fee / gateway_fee_gst / fee_bearer 'business' on that receipt — exactly what the
--     webhook books for a captured payment (src/lib/razorpay/fee-expense.ts);
--   • no bank line of its own: the money reached the bank inside a Razorpay SETTLEMENT; Banking →
--     Reconcile → Razorpay settlement (reconcile_razorpay_settlement, R-2099) links these receipts and
--     books only the fee NOT already booked as EXP-RZPFEE-<payment> — never twice. Until then the
--     balance sheet carries amount − fee as "not yet in bank" (the R-045 undeposited rule).
--   No "Razorpay clearing" bank account is made (it would inflate Cash & Bank).
--   Any other bank charge (not Razorpay) is still refused — book it by hand.
-- Changes:
--   zoho_fy_receipts + fee, fee_gst, fee_expense_id
--   import_zoho_fy_receipts(...) ← 20261105192600 (latest, the only later redefiner) + the fee booking,
--     no single-line bank match for a fee payment (also on a rerun), totals with_fee / fee.
--   tg_zoho_fy_receipt_fee_gone: deleting a zoho_fy_receipts row (Remove import) deletes its fee expense.
-- Grants explicit (unchanged for the import; the trigger function to no app role).
-- Test: supabase/tests/r2565_razorpay_fee_receipts.test.sql (rolled back; red without this file).
-- Rollback: re-run import_zoho_fy_receipts from 20261105192600; drop the trigger + function; drop the 3 columns.

begin;

alter table public.zoho_fy_receipts add column if not exists fee integer not null default 0;
alter table public.zoho_fy_receipts add column if not exists fee_gst integer not null default 0;
alter table public.zoho_fy_receipts add column if not exists fee_expense_id text;
alter table public.zoho_fy_receipts drop constraint if exists zoho_fy_receipts_fee_check;
alter table public.zoho_fy_receipts add constraint zoho_fy_receipts_fee_check
  check (fee >= 0 and fee_gst >= 0 and fee_gst <= fee and (fee = 0) = (fee_expense_id is null));
comment on column public.zoho_fy_receipts.fee is
  'R-2565: Razorpay''s fee Zoho took off as bank_charges, whole rupees incl. GST (0 = none) — booked as fee_expense_id; the payment is banked by its Razorpay settlement (R-2099).';
comment on column public.zoho_fy_receipts.fee_expense_id is
  'R-2565: the Bank Charges expense EXP-RZPFEE-<receipt id> this import booked for the fee; removed with the row.';

create or replace function public.import_zoho_fy_receipts(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 6 Nov: vouchers, 2b / 2c matching safety, round-off, TDS gross)
     R-2565: Razorpay fee (Zoho bank_charges) booked as the Bank Charges expense EXP-RZPFEE-<receipt> */
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
      if v_txn is null and coalesce(v_done_row.fee, 0) = 0 then
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
      exception when others then
        v_reason := 'Its date, amount or account could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      v_method := coalesce(nullif(v_p->>'method', ''), 'other');
      v_ref := left(coalesce(nullif(btrim(v_p->>'reference'), ''), 'ZOHO-PAY-' || v_num), 100);
      if jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
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
        select i.id, i.customer_id, i.status, i.amount, i.net_payable, i.paid_amount, i.document_kind, i.taxable_value into v_inv
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
    end if;

    /* Its bank line, looked up BEFORE booking: already reconciled to something else → the money is in
       the books already (an advance / sale on the Reconcile sheet) — refused, never a second receipt. */
    /* R-2565: a Razorpay fee payment has no bank line of its own (only amount − fee reached Razorpay's
       settlement, with other payments): it waits for its settlement line (R-2099). */
    v_bank := '{}'::jsonb;
    if v_reason is null and v_fee = 0 then
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
        select v.id, v.gstin into v_vendor
          from public.vendors v
         where v.tenant_id = v_tenant and v.name ilike '%razorpay%'
         order by (coalesce(btrim(v.gstin), '') <> '') desc, v.created_at asc
         limit 1;
        select coalesce(nullif(btrim(t.state_code), ''), case when length(btrim(coalesce(t.gstin, ''))) = 15 then left(btrim(t.gstin), 2) end)
          into v_own_st from public.tenants t where t.id = v_tenant;
        v_v_st := case when length(btrim(coalesce(v_vendor.gstin, ''))) = 15 then left(btrim(v_vendor.gstin), 2) end;
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

      v_txn := null;
      if nullif(v_bank->>'txn_id', '') is not null and not ((v_bank->>'txn_id')::uuid = any (v_used)) then
        v_txn := (v_bank->>'txn_id')::uuid;
        /* Locked, then checked again — matched meanwhile → left for a later run (_zoho_fy_receipt_link_line). */
        if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_pays, v_bank->>'confidence') then
          v_used := v_used || v_txn;
        else
          v_txn := null;
        end if;
      end if;

      insert into public.zoho_fy_receipts (tenant_id, zoho_payment_id, fy, batch_id, customer_id, received_on, bank_account_id,
                                           received_paise, cash, tds, advance, reference, payment_ids, bank_txn_id, banked_at, bank_matched_by_import,
                                           fee, fee_gst, fee_expense_id)
      values (v_tenant, v_zid, p_fy, v_batch, v_cust, v_date, v_acct, v_paise, v_sum_cash + v_excess, v_sum_tds, v_excess,
              v_ref, v_pays, v_txn, case when v_txn is not null then now() end, v_txn is not null,
              v_fee, v_fee_gst, v_fee_exp);
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
    v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'date', v_date, 'customer_id', v_cust,
      'cash', v_sum_cash + v_excess, 'tds', v_sum_tds, 'advance', v_excess, 'payment_ids', to_jsonb(v_pays), 'bank_txn_id', v_txn,
      'fee', v_fee, 'fee_gst', v_fee_gst, 'fee_expense_id', v_fee_exp);
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
                             'with_fee', v_fees, 'fee', v_tot_fee));

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
    'with_fee', v_fees, 'fee', v_tot_fee);
end;
$function$;

comment on function public.import_zoho_fy_receipts(text, jsonb, boolean) is
  'R-2501 + R-2565: FY customer payments from Zoho as receipts (+ Zoho''s TDS, excess → advance; a Razorpay payment''s fee (Zoho bank_charges) → Bank Charges expense EXP-RZPFEE-<receipt>, banked by its Razorpay settlement) on the FY sales imported from Zoho, matched to the bank line when it is in (else on a later run). Money from zoho_fy_scan; picks = Zoho id + app account. dry_run (default) writes nothing. Owner / accountant.';
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
    delete from public.expenses e where e.tenant_id = old.tenant_id and e.id = old.fee_expense_id;
  end if;
  return old;
end;
$function$;
revoke all on function public.tg_zoho_fy_receipt_fee_gone() from public, anon, authenticated;
drop trigger if exists trg_zoho_fy_receipt_fee_gone on public.zoho_fy_receipts;
create trigger trg_zoho_fy_receipt_fee_gone
  after delete on public.zoho_fy_receipts
  for each row execute function public.tg_zoho_fy_receipt_fee_gone();

commit;
