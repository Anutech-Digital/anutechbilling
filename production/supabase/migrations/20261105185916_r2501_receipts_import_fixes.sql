-- deploy-peek: to_regprocedure('public.remove_zoho_fy_receipts_import(uuid,text)') is not null and to_regprocedure('public._zoho_fy_receipt_bank_line(uuid,uuid,bigint,date,text,uuid)') is not null and to_regprocedure('public._zoho_fy_voucher_no(uuid,text,date)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') and prosrc like '%follow-up 6 Nov%')
-- deploy-key: r2501receiptsfixes
--
-- R-2501 follow-up (6 Nov 2026) — the independent review BLOCKED the first real receipts import
-- (card independentReview v9). Fixes, decided by the coordinator on Pardeep's delegation:
--
--   1. VOUCHER NUMBERS. A receipt imported from Zoho keeps ZOHO'S OWN payment number as its
--      receipt voucher number (Zoho issued it; FY 2025-26 was filed from Zoho) — exactly as R-2499
--      keeps Zoho's invoice numbers. One Zoho payment over several invoices (+ its advance) →
--      '<no>', '<no>-2', '<no>-3' (payments_receipt_voucher_unique). No Zoho number → the app's
--      series of the PAYMENT date's FY (next_document_number(..., received date)). The advance's
--      holder quote: numbered and created on the payment date. Record payment by hand keeps
--      today's series: the switch is app.zoho_fy_receipt_on, set only by import_zoho_fy_receipts.
--        _zoho_fy_voucher_no(tenant, zoho no, date)       new
--        _record_opening_invoice_payment(...)             ← 20261105180900 (latest) + the switch
--        _zoho_fy_receipt_advance(...)                    ← 20261105180900 (latest) + payment date
--   2. UNDO. remove_zoho_fy_receipts_import(batch, reason) — OWNER only — takes one receipts batch
--      back while nothing in it was touched since: every receipt still received, no TDS certificate
--      / status change, every advance credit still open (unused), each bank line still matched by
--      this import only. It un-reconciles the lines, deletes the TDS rows, advance credits, holder
--      quotes, receipts (the invoices' paid amount follows — trg_payments_opening_invoice) and the
--      zoho_fy_receipts rows; the batch row stays, marked removed; one activity_log row.
--      Mirrors remove_zoho_fy_sales_import (R-2499).
--   3. MATCHING SAFETY.
--      2b: the "bank line already reconciled to something else" refusal runs EVERY time (a
--          reconciled line carrying Zoho's reference → refused; one of the same money that same day
--          → refused unless a free line carries Zoho's reference); plus a receipt of the same money
--          on the same invoice within 3 days that this import did not make (any reference) → refused.
--      2c: "the only line that day" (no UTR in it) is taken only when its narration names the
--          customer (a significant word of its name, or a known payer — customer_payers, R-2025);
--          otherwise it is left for a person. Never another customer's line.
--        _zoho_fy_receipt_bank_line(..., customer)        replaces the 5-argument one (dropped)
--        _zoho_fy_line_names_customer(tenant, customer, text)   new
--        _zoho_fy_receipt_link_line(tenant, txn, payments, confidence)   new: lock + re-check +
--          reconcile_bank_txn + payments.bank_txn_id + the ₹1 round-off (bank_receipt_round_offs)
--   4. LOWS. The ₹1 rounding rupee is no longer a ₹1 advance (holder quote + voucher + credit): the
--      receipt stays at the invoice's due and the rupee is a round-off on its bank line (R-2098's
--      bank_receipt_round_offs). TDS gross = what the payment settles on the invoice (money + TDS).
--   import_zoho_fy_receipts(...) ← 20261105180900 (latest) with the above.
--
-- Grants explicit; helpers not granted to any app role. Test:
-- supabase/tests/r2501_receipts_import_fixes.test.sql (rolled back; red without this file).
-- Rollback: re-run the four bodies from 20261105180900; drop the new functions.

begin;

-- ── 1. Voucher number of an imported Zoho receipt ───────────────────────────────────────────
create or replace function public._zoho_fy_voucher_no(p_tenant uuid, p_zoho_no text, p_on date)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 follow-up: Zoho's own payment number (a second / third receipt of the same Zoho payment
     gets '-2', '-3'); none → the app series of the payment date's FY. */
  v_base text := left(btrim(coalesce(p_zoho_no, '')), 40);
  v_try  text;
  v_n    integer := 1;
begin
  if v_base = '' then
    return public.next_document_number('receipt_voucher', p_tenant, p_on);
  end if;
  v_try := v_base;
  while exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.receipt_voucher_no = v_try) loop
    v_n := v_n + 1;
    v_try := v_base || '-' || v_n;
  end loop;
  return v_try;
end;
$function$;
revoke all on function public._zoho_fy_voucher_no(uuid, text, date) from public, anon, authenticated;

-- ── 2. Does a bank line's narration name this customer? (2c) ───────────────────────────────
create or replace function public._zoho_fy_line_names_customer(p_tenant uuid, p_customer_id uuid, p_text text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2501 follow-up: a significant word of the customer's name (4+ letters, not a company-form
     word), or a payer the company already linked to this customer (customer_payers, R-2025). */
  with t as (select ' ' || coalesce(public.payer_name_key(p_text), '') || ' ' as k)
  select exists (
           select 1
             from public.customers c
             cross join lateral regexp_split_to_table(coalesce(public.payer_name_key(c.name), ''), ' ') w
             cross join t
            where c.id = p_customer_id and c.tenant_id = p_tenant
              and length(w) >= 4
              and w not in ('private', 'limited', 'india', 'indian', 'technologies', 'technology', 'tech', 'services',
                            'service', 'solutions', 'solution', 'company', 'enterprises', 'enterprise', 'infotech',
                            'systems', 'system', 'global', 'digital', 'software', 'consultants', 'consulting', 'group',
                            'industries', 'international', 'traders', 'trading', 'associates', 'corporation', 'bank',
                            'neft', 'rtgs', 'imps', 'transfer', 'payment')
              and strpos(t.k, ' ' || w || ' ') > 0)
      or exists (
           select 1 from public.customer_payers cp, t
            where cp.tenant_id = p_tenant and cp.customer_id = p_customer_id
              and strpos(t.k, ' ' || cp.payer_name_key || ' ') > 0);
$function$;
revoke all on function public._zoho_fy_line_names_customer(uuid, uuid, text) from public, anon, authenticated;

-- ── 3. The bank line a Zoho payment came in on (2b + 2c) ────────────────────────────────────
drop function if exists public._zoho_fy_receipt_bank_line(uuid, uuid, bigint, date, text);
create or replace function public._zoho_fy_receipt_bank_line(
  p_tenant uuid, p_bank_account_id uuid, p_received_paise bigint, p_received_on date, p_reference text, p_customer_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 2b / 2c). Lines of exactly the money (to the paisa), that account, ±3 days.
     Free = unmatched and on no receipt. Taken = reconciled to something this import did not book. */
  v_ref   text := upper(btrim(coalesce(p_reference, '')));
  v_hits  uuid[];
  v_all   uuid[];
  v_same  uuid[];
  v_taken record;
begin
  select coalesce(array_agg(t.id order by t.txn_date, t.id), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (where t.txn_date = p_received_on), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (
           where char_length(v_ref) >= 6
             and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0), '{}')
    into v_all, v_same, v_hits
    from public.bank_transactions t
   where t.tenant_id = p_tenant
     and t.bank_account_id = p_bank_account_id
     and coalesce(t.credit, 0) > 0
     and round(t.credit * 100)::bigint = p_received_paise
     and t.txn_date between p_received_on - 3 and p_received_on + 3
     and t.matched_to_type is null
     and not exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id);

  /* 2b, always: a line of this money already reconciled to something else. Carrying Zoho's reference →
     refused; the same day → refused unless a free line carries Zoho's reference. */
  select t.id, coalesce(t.matched_to_type, 'split receipt') as matched_to_type, t.txn_date,
         (char_length(v_ref) >= 6 and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0) as ref_hit
    into v_taken
    from public.bank_transactions t
   where t.tenant_id = p_tenant
     and t.bank_account_id = p_bank_account_id
     and coalesce(t.credit, 0) > 0
     and round(t.credit * 100)::bigint = p_received_paise
     and t.txn_date between p_received_on - 3 and p_received_on + 3
     and (t.matched_to_type is not null
          or exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id))
     and not exists (select 1 from public.zoho_fy_receipts r
                      where r.tenant_id = p_tenant
                        and (r.bank_txn_id = t.id or t.matched_to_id = any (r.payment_ids::text[])))
     and ((char_length(v_ref) >= 6 and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0)
          or t.txn_date = p_received_on)
   order by 4 desc, t.txn_date, t.id
   limit 1;
  if found and (v_taken.ref_hit or cardinality(v_hits) = 0) then
    return jsonb_build_object('txn_id', null, 'taken_txn', v_taken.id, 'taken_as', v_taken.matched_to_type, 'taken_on', v_taken.txn_date);
  end if;

  if cardinality(v_hits) = 1 then
    return jsonb_build_object('txn_id', v_hits[1], 'confidence', 'exact');
  end if;
  /* 2c: the only line, that day, no reference — only when its narration names this customer. */
  if cardinality(v_hits) = 0 and cardinality(v_all) = 1 and cardinality(v_same) = 1
     and exists (select 1 from public.bank_transactions t
                  where t.id = v_same[1]
                    and public._zoho_fy_line_names_customer(p_tenant, p_customer_id, coalesce(t.description, '') || ' ' || coalesce(t.reference, ''))) then
    return jsonb_build_object('txn_id', v_same[1], 'confidence', 'high');
  end if;
  return jsonb_build_object('txn_id', null, 'candidates', cardinality(v_all));
end;
$function$;
revoke all on function public._zoho_fy_receipt_bank_line(uuid, uuid, bigint, date, text, uuid) from public, anon, authenticated;

-- ── 4. Match one bank line to an imported Zoho payment's receipts ───────────────────────────
create or replace function public._zoho_fy_receipt_link_line(p_tenant uuid, p_txn uuid, p_payment_ids uuid[], p_confidence text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 follow-up: the line locked and checked again (matched meanwhile → false, left alone); the
     line → the first receipt, every receipt → the line (R-2098's split shape); a ₹1 difference between
     the money recorded and the line (the rounding rupee) → bank_receipt_round_offs, as R-2098. */
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
    into v_cash
    from public.payments p where p.tenant_id = p_tenant and p.id = any (p_payment_ids);
  v_diff := v_cash - round(v_credit)::integer;
  if v_diff <> 0 and abs(v_diff) <= 1 then
    insert into public.bank_receipt_round_offs (tenant_id, bank_txn_id, amount, created_by)
    values (p_tenant, p_txn, v_diff, auth.uid())
    on conflict (bank_txn_id) do nothing;
  end if;
  return true;
end;
$function$;
revoke all on function public._zoho_fy_receipt_link_line(uuid, uuid, uuid[], text) from public, anon, authenticated;

-- ── 5. The two receipt bodies: Zoho's number / the payment date ─────────────────────────────
-- ← 20261105180900_r2501_zoho_fy_receipts_import.sql (latest; no later redefinition on anutech/*).
create or replace function public._record_opening_invoice_payment(
  p_tenant          uuid,
  p_invoice_id      text,
  p_amount          integer,
  p_method          text,
  p_reference       text,
  p_notes           text,
  p_received_on     date,
  p_bank_account_id uuid,
  p_tds_amount      integer,
  p_tds_gross       integer,
  p_tds_section     text,
  p_tds_rate_pct    numeric,
  p_customer_tan    text,
  p_fiscal_year     text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739: not granted to any app role — reached only from record_multi_invoice_payment,
     which has already checked the role, the company, the customer and the amount.
     R-2501: an FY sale imported from Zoho (zoho_invoice_id) takes its receipt here too.
     R-2501 follow-up: inside import_zoho_fy_receipts (app.zoho_fy_receipt_on set) the voucher is Zoho's own
     payment number (else the app series of the PAYMENT date); Record payment keeps today's series. */
  v_inv    record;
  v_due    integer;
  v_rv     text;
  v_pay    uuid;
  v_status text;
  v_tds    boolean := false;
  v_zon    date := nullif(current_setting('app.zoho_fy_receipt_on', true), '')::date;
begin
  if p_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;
  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable, i.paid_amount, i.status
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = p_tenant
     and (i.document_kind = 'opening_invoice' or i.zoho_invoice_id is not null)
   for update;
  if not found then
    raise exception 'Invoice % is not an invoice imported from Zoho in your company.', p_invoice_id using errcode = '42501';
  end if;
  v_due := case when v_inv.status::text in ('paid', 'void') then 0
                else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
  if p_amount is null or p_amount <= 0 or p_amount > v_due then
    raise exception 'Invoice % has only ₹% due, but ₹% is applied to it. Lower that line.', p_invoice_id, v_due, coalesce(p_amount, 0);
  end if;

  v_rv := case when v_zon is not null
               then public._zoho_fy_voucher_no(p_tenant, nullif(current_setting('app.zoho_fy_receipt_no', true), ''), v_zon)
               else public.next_document_number('receipt_voucher', p_tenant, public.ist_today()) end;
  insert into public.payments (tenant_id, quote_id, invoice_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (p_tenant, null, v_inv.id, v_inv.customer_id, p_amount, p_method, nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_notes, '')), ''), 'received',
          coalesce((p_received_on::timestamp at time zone 'UTC'), now()), v_rv, auth.uid(), p_bank_account_id)
  returning id into v_pay;

  if coalesce(p_tds_amount, 0) > 0 then
    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      p_tenant, v_inv.id, v_pay, v_inv.customer_id, coalesce(v_inv.customer_name, ''),
      nullif(trim(coalesce(p_customer_tan, '')), ''), coalesce(p_tds_section, '194J'),
      coalesce(p_tds_rate_pct, round(p_tds_amount::numeric * 100 / nullif(coalesce(nullif(p_tds_gross, 0), p_amount), 0), 2)),
      coalesce(nullif(p_tds_gross, 0), p_amount), p_tds_amount, p_amount - p_tds_amount,
      coalesce(p_fiscal_year, public.indian_fiscal_year(coalesce(p_received_on, public.ist_today()))),
      coalesce(p_received_on, public.ist_today()), 'pending_cert',
      'Auto-created with payment ' || v_pay::text || ' on imported Zoho invoice ' || v_inv.id
    );
    v_tds := true;
  end if;

  select status::text into v_status from public.invoices where id = v_inv.id;
  return jsonb_build_object('payment_id', v_pay, 'receipt_voucher_no', v_rv, 'applied', p_amount,
                            'invoice_paid', v_status = 'paid', 'overpaid_credit', 0, 'tds_saved', v_tds,
                            'already_recorded', false, 'idempotent_replay', false);
end;
$function$;
revoke all on function public._record_opening_invoice_payment(uuid, text, integer, text, text, text, date, uuid, integer, integer, text, numeric, text, text) from public, anon, authenticated;

-- ← 20261105180900 (latest) + the payment date / Zoho's number.
create or replace function public._zoho_fy_receipt_advance(
  p_tenant uuid, p_customer_id uuid, p_amount integer, p_received_on date, p_method text,
  p_reference text, p_bank_account_id uuid, p_zoho_number text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up: Zoho's number / the payment date's series) */
  v_cust      record;
  v_export    boolean;
  v_rate      integer;
  v_qid       text;
  v_voucher   text;
  v_pay_id    uuid;
  v_credit_id uuid;
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'An advance must be more than ₹0.' using errcode = '22023';
  end if;
  select c.id, c.name, c.country into v_cust from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant;
  if not found then
    raise exception 'Customer not found in your company.' using errcode = 'no_data_found';
  end if;
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(p_tenant, p_received_on) in ('unregistered', 'composition') then 0
              else 18
            end;

  /* R-2501 follow-up: numbered and dated by the payment date (its FY series), never today. */
  v_qid := public.next_document_number('quote', p_tenant, p_received_on);
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, payment_amount, payment_method, payment_reference,
    payment_received_at, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, p_tenant, p_customer_id, v_cust.name, 'Advance on account', 0, 0, 0, v_rate, 0,
    '[]'::jsonb, 'accepted', 'received', p_amount, p_method, p_reference,
    (p_received_on::timestamp at time zone 'UTC'), true, 'yearly', p_received_on,
    'Advance from Zoho payment ' || coalesce(p_zoho_number, '') || ' of ' || to_char(p_received_on, 'DD Mon YYYY')
      || ' — not applied to any invoice in Zoho, kept as customer credit (R-2501).'
  );

  v_voucher := public._zoho_fy_voucher_no(p_tenant, nullif(current_setting('app.zoho_fy_receipt_no', true), ''), p_received_on);
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (p_tenant, v_qid, p_customer_id, p_amount, p_method, p_reference,
          'Advance on account — Zoho payment ' || coalesce(p_zoho_number, ''),
          'received', (p_received_on::timestamp at time zone 'UTC'), v_voucher, auth.uid(), p_bank_account_id)
  returning id into v_pay_id;

  insert into public.customer_credits
    (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
  values
    (p_tenant, p_customer_id, p_amount, 'overpayment', v_pay_id, v_qid,
     'Advance received ' || to_char(p_received_on, 'DD Mon YYYY') || ' (Zoho payment ' || coalesce(p_zoho_number, '') || ') — nothing invoiced', 'open')
  returning id into v_credit_id;

  return jsonb_build_object('quote_id', v_qid, 'payment_id', v_pay_id, 'receipt_voucher_no', v_voucher, 'credit_id', v_credit_id);
end;
$function$;
revoke all on function public._zoho_fy_receipt_advance(uuid, uuid, integer, date, text, text, uuid, text) from public, anon, authenticated;

-- ── 6. Import (and dry run) ← 20261105180900 (latest) + the follow-up ──────────────────────────────
create or replace function public.import_zoho_fy_receipts(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 (+ follow-up 6 Nov: vouchers, 2b / 2c matching safety, round-off, TDS gross) */
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
        update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = case when v_txn is not null then now() end
         where tenant_id = v_tenant and zoho_payment_id = v_zid;
      end if;
      if v_txn is null then
        v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_done_row.bank_account_id, v_done_row.received_paise,
                                                    v_done_row.received_on, v_done_row.reference, v_done_row.customer_id);
        v_txn := nullif(v_bank->>'txn_id', '')::uuid;
        if v_txn is not null and not (v_txn = any (v_used)) then
          begin
            if public._zoho_fy_receipt_link_line(v_tenant, v_txn, v_done_row.payment_ids, v_bank->>'confidence') then
              update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now()
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
        select i.id, i.customer_id, i.status, i.amount, i.net_payable, i.paid_amount, i.document_kind into v_inv
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
                                                 'tds_gross', case when v_tds > 0 then v_settle end);
      end loop;
      if v_reason is null and v_sum_cash <= 0 then
        v_reason := 'Zoho booked only TDS on this payment, no money — record it by hand.';
      end if;
    end if;

    /* Its bank line, looked up BEFORE booking: already reconciled to something else → the money is in
       the books already (an advance / sale on the Reconcile sheet) — refused, never a second receipt. */
    if v_reason is null then
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
                                           received_paise, cash, tds, advance, reference, payment_ids, bank_txn_id, banked_at)
      values (v_tenant, v_zid, p_fy, v_batch, v_cust, v_date, v_acct, v_paise, v_sum_cash + v_excess, v_sum_tds, v_excess,
              v_ref, v_pays, v_txn, case when v_txn is not null then now() end);
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
    v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'date', v_date, 'customer_id', v_cust,
      'cash', v_sum_cash + v_excess, 'tds', v_sum_tds, 'advance', v_excess, 'payment_ids', to_jsonb(v_pays), 'bank_txn_id', v_txn);
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
                             'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2501', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2501' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'banked', v_banked, 'bank_later', v_later,
    'skipped', v_skipped, 'done', v_done,
    'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv);
end;
$function$;

comment on function public.import_zoho_fy_receipts(text, jsonb, boolean) is
  'R-2501: FY customer payments from Zoho as receipts (+ Zoho''s TDS, excess → advance) on the FY sales imported from Zoho, matched to the bank line when it is in (else on a later run). Money from zoho_fy_scan; picks = Zoho id + app account. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_receipts(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_receipts(text, jsonb, boolean) to authenticated, service_role;

-- ── 7. Take one receipts batch back (nothing may have touched it) ───────────────────────────
create or replace function public.remove_zoho_fy_receipts_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 follow-up — mirrors remove_zoho_fy_sales_import (R-2499). OWNER only. */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.zoho_fy_import_batches;
  v_pays   uuid[];
  v_quotes text[];
  v_lines  uuid[];
  v_bad    text;
  v_txn    uuid;
  v_n      integer;
  v_rows   integer;
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in. Sign in again and retry.' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner') then
    raise exception 'Only the owner can remove an FY receipts import.' using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are removing this import (at least 3 characters) — it goes in the activity log.' using errcode = '22023';
  end if;
  select * into v_batch from public.zoho_fy_import_batches
   where id = p_batch_id and tenant_id = v_tenant and kind = 'customerpayments' for update;
  if not found then
    raise exception 'That import was not found. Refresh and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %.', to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  perform 1 from public.zoho_fy_receipts r where r.tenant_id = v_tenant and r.batch_id = p_batch_id for update;
  select coalesce(array_agg(x.pid), '{}'), count(distinct x.zid)::int
    into v_pays, v_rows
    from (select r.zoho_payment_id as zid, unnest(r.payment_ids) as pid
            from public.zoho_fy_receipts r
           where r.tenant_id = v_tenant and r.batch_id = p_batch_id) x;
  perform 1 from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) order by p.id for update;

  /* Untouched since the import? */
  select string_agg(w, '; ') into v_bad from (
    select format('receipt %s is %s', coalesce(p.receipt_voucher_no, p.id::text), p.status) as w
      from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) and p.status <> 'received'
    union all
    select format('%s receipt(s) are no longer there', cardinality(v_pays) - (select count(*) from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays)))
     where (select count(*) from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays)) <> cardinality(v_pays)
    union all
    select format('TDS on %s is %s', x.invoice_id, x.status)
      from public.tds_receivable x where x.tenant_id = v_tenant and x.payment_id = any (v_pays) and x.status <> 'pending_cert'
    union all
    select format('the advance of ₹%s is %s', c.amount, c.status)
      from public.customer_credits c where c.tenant_id = v_tenant and c.source_payment_id = any (v_pays) and c.status <> 'open'
    union all
    select format('bank line of %s was matched by hand', to_char(t.txn_date, 'DD Mon YYYY'))
      from public.bank_transactions t
     where t.tenant_id = v_tenant
       and (t.matched_to_id = any (v_pays::text[])
            or t.id in (select p.bank_txn_id from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays)))
       and t.id not in (select r.bank_txn_id from public.zoho_fy_receipts r
                         where r.tenant_id = v_tenant and r.batch_id = p_batch_id and r.bank_txn_id is not null)
    limit 10) z;
  if v_bad is not null then
    raise exception 'This import cannot be removed — it was used since: %. Take that back first, then remove the import.', v_bad using errcode = 'P0001';
  end if;

  /* Un-reconcile the lines this import matched (R-2098's trigger clears payments.bank_txn_id and
     the round-off), then take the rest back. */
  for v_txn in select distinct r.bank_txn_id from public.zoho_fy_receipts r
                where r.tenant_id = v_tenant and r.batch_id = p_batch_id and r.bank_txn_id is not null loop
    perform public.reconcile_bank_txn(v_txn, null, null, null);
  end loop;
  update public.payments set bank_txn_id = null where tenant_id = v_tenant and id = any (v_pays) and bank_txn_id is not null;

  select coalesce(array_agg(distinct p.quote_id), '{}') into v_quotes
    from public.payments p where p.tenant_id = v_tenant and p.id = any (v_pays) and p.quote_id is not null;

  delete from public.tds_receivable where tenant_id = v_tenant and payment_id = any (v_pays);
  delete from public.customer_credits where tenant_id = v_tenant and source_payment_id = any (v_pays);
  delete from public.zoho_fy_receipts where tenant_id = v_tenant and batch_id = p_batch_id;
  delete from public.payments where tenant_id = v_tenant and id = any (v_pays);
  get diagnostics v_n = row_count;
  /* The ₹0 "Advance on account" holder quotes this import made (nothing else hangs on them). */
  delete from public.quotes q
   where q.tenant_id = v_tenant and q.id = any (v_quotes) and q.plan = 'Advance on account' and q.amount = 0
     and not exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.quote_id = q.id);

  update public.zoho_fy_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_rows
   where id = p_batch_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_receipts.import_removed', 'zoho_fy_import_batch', p_batch_id::text,
          left(format('Removed FY %s receipts import: %s Zoho payments (%s receipts) — %s', v_batch.fy, v_rows, v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'payments', v_rows, 'receipts', v_n, 'reason', v_reason, 'fy', v_batch.fy));

  return jsonb_build_object('removed', v_rows, 'receipts', v_n, 'batch_id', p_batch_id);
end;
$function$;

comment on function public.remove_zoho_fy_receipts_import(uuid, text) is
  'R-2501 follow-up: takes one FY receipts import batch back while untouched (every receipt received, TDS not certified, advance unused, bank lines matched only by the import). Owner only; un-reconciles its lines; activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_zoho_fy_receipts_import(uuid, text) from public, anon;
grant execute on function public.remove_zoho_fy_receipts_import(uuid, text) to authenticated, service_role;

commit;
