-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_razorpay_settlement(uuid,jsonb)') and prosrc like '%R-2918%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_razorpay_settlement_line_unmatched()') and prosrc like '%R-2918%') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'razorpay_settlement_recons' and column_name = 'other_income_id')
-- deploy-key: r2918razorpayotherincome
-- 20261118070909_r2918_razorpay_other_income.sql
--
-- R-2918 (18 Nov 2026, Pardeep — reconcile of HDFC 4523, goal G-RECON). A Razorpay settlement bank line is
-- booked by reconcile_razorpay_settlement (R-2099; fee day R-2745; month batch R-2654). It refuses the whole
-- settlement while ONE Razorpay payment inside has no app payment. 49 FY25-26 settlement lines stayed Blocked,
-- many only because of a ₹1 / ₹100 / ₹125 test payment that was never a sale (it is in neither Zoho nor the
-- app). The bank line's own "Other income" would book the WHOLE line — the customers' money too — as income.
--
-- Owner's decision ("Haan, Other income"): such a payment may be booked as Other income, by the owner's /
-- accountant's pick per payment — never by itself (₹200 or less is only suggested on the screen), never a
-- guessed customer. So:
--
--   1. razorpay_settlement_recons gains other_income (rupees) + other_income_id (the other_incomes row);
--      razorpay_settlement_items.kind gains 'other_income' (a Razorpay id is still used once).
--   2. reconcile_razorpay_settlement <- 20261116125550_r2745 (its newest body). New optional list
--      p_settlement.other_income = [{rzp_id, amount_paise, order_id}]: each must be a pay_… id with more than ₹0 that is
--      in NO app payment of the company (payments.reference), not paid on a quote's Razorpay order
--      (quotes.payment_reference = order_id) and in no other reconciled settlement; only an
--      owner / accountant may send it. Their rupees are added to the settlement's payments, so the fee
--      (payments − refunds − bank), its GST split and its day (R-2745 first open day) are worked out exactly as
--      before; the customer receipts are linked as before; the picked rupees become ONE other_incomes row
--      (R-2095's table, head 'other' → P&L "Other income") on the line, dated on the line's day. A settlement
--      with no app payment at all is matched to that row (matched_to_type 'other_income') instead of a receipt.
--      Without the list nothing changes — an unmatched payment is still refused.
--      R-2654's reconcile_razorpay_settlement_in_run calls this function, so "Reconcile all ready" follows.
--   3. tg_razorpay_settlement_line_unmatched <- 20261116125550_r2745 (its newest body): un-reconcile / "Undo
--      this run" also removes that other_incomes row. R-2745's refusal (fee expense inside a filed GST return)
--      is unchanged and comes first — then nothing is removed, the Other income stays too.
-- Not changed: reconcile_razorpay_settlement_in_run, undo_bank_recon_run, refunds / adjustments, the
-- whole-line Other income (book_bank_credit_as_other_income). No data repair.
-- Test: supabase/tests/r2918_razorpay_other_income.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. What the settlement booked as Other income ──────────────────────────────────────────────
alter table public.razorpay_settlement_recons
  add column if not exists other_income    integer not null default 0 check (other_income >= 0),
  add column if not exists other_income_id uuid;
comment on column public.razorpay_settlement_recons.other_income is
  'R-2918: rupees of this settlement''s Razorpay payments that are in no app payment and were booked as Other income (part of gross).';
comment on column public.razorpay_settlement_recons.other_income_id is
  'R-2918: the other_incomes row those rupees were booked on; removed with the settlement when the line is un-reconciled.';

alter table public.razorpay_settlement_items drop constraint if exists razorpay_settlement_items_kind_check;
alter table public.razorpay_settlement_items
  add constraint razorpay_settlement_items_kind_check check (kind in ('payment', 'refund', 'other_income'));

-- ── 2. The one-click reconcile: payments picked as Other income ────────────────────────────────
create or replace function public.reconcile_razorpay_settlement(p_txn_id uuid, p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2099. p_settlement = {id, utr, fee_paise, tax_paise,
     payments: [{rzp_id, amount_paise, payment_ids: [uuid]}],
     refunds:  [{rzp_id, amount_paise, payment_ids: [uuid]}]}  — built from Razorpay's API by
   src/lib/razorpay/settlement-match.ts; every number is re-checked here against the app's rows.
   R-2745: the fee expense is dated on the first open (not GST-filed) day — invoice_date_for_receipt, R-2631's
   one rule; the bank line keeps its own day.
   R-2918: p_settlement may also carry other_income: [{rzp_id, amount_paise, order_id}] — Razorpay payments that are in
   NO app payment and that the owner / accountant picked "Book as Other income" for. Their gross becomes ONE
   other_incomes row (head 'other') on this line; their fee is part of the settlement's fee as before. Never
   applied without that list, never to a payment the app has. */
declare
  v_caller    uuid;
  v_trusted   boolean;
  v_txn       record;
  v_sid       text;
  v_item      jsonb;
  v_ids       uuid[];
  v_all_ids   uuid[] := array[]::uuid[];
  v_ref_ids   uuid[] := array[]::uuid[];
  v_first     uuid;
  v_n         integer;
  v_sum       integer;
  v_rzp_amt   integer;
  v_cash      integer := 0;
  v_refunds   integer := 0;
  v_fee_num   numeric;
  v_fee       integer;
  v_rzp_fee   integer;
  v_rzp_tax   integer;
  v_tol       integer;
  v_booked    integer;
  v_booked_g  integer;
  v_rest      integer;
  v_rest_gst  integer;
  v_exp_id    text := null;
  v_vendor    record;
  v_own_st    text;
  v_v_st      text;
  v_igst      integer;
  v_cgst      integer;
  v_sgst      integer;
  v_recon     uuid;
  v_rzp_ids   text[] := array[]::text[];
  v_fee_day   date := null;     -- R-2745
  v_fee_why   text := null;     -- R-2745
  v_oi_list   jsonb := '[]'::jsonb;   -- R-2918
  v_other     integer := 0;           -- R-2918: rupees booked as Other income
  v_other_n   integer := 0;
  v_other_txt text := '';
  v_rid       text;
  v_oi        uuid := null;
begin
  /* R-2745: the trusted-server rule written with current_request_role() — a re-created body may not carry a raw
     auth.role() list (R-2487 scan, cloudsql-auth-shim-scan). Same for request logins, service_role and a direct DB session. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
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
    raise exception 'Only a money-in (credit) bank line can be a Razorpay settlement.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  v_sid := p_settlement->>'id';
  if v_sid is null or v_sid !~ '^setl_[A-Za-z0-9]+$' then
    raise exception 'The Razorpay settlement id is missing. Fetch the settlement again.' using errcode = '22023';
  end if;
  if exists (select 1 from public.razorpay_settlement_recons r where r.tenant_id = v_txn.tenant_id and r.settlement_id = v_sid) then
    raise exception 'Razorpay settlement % is already reconciled to another bank line. Un-reconcile that line first if it was wrong.', v_sid
      using errcode = 'unique_violation';
  end if;
  /* R-2918: the owner's "Book as Other income" picks (absent / null = none). */
  if jsonb_typeof(p_settlement->'other_income') = 'array' then
    v_oi_list := p_settlement->'other_income';
  elsif p_settlement->'other_income' is not null and jsonb_typeof(p_settlement->'other_income') <> 'null' then
    raise exception 'The Other income list is not valid. Fetch the settlement again.' using errcode = '22023';
  end if;
  v_other_n := jsonb_array_length(v_oi_list);
  if jsonb_typeof(p_settlement->'payments') is distinct from 'array'
     or (jsonb_array_length(p_settlement->'payments') = 0 and v_other_n = 0) then
    raise exception 'This settlement has no payments to reconcile. Fetch it again.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_settlement->'payments') + v_other_n > 2000 then
    raise exception 'Too many payments in one settlement (%).', jsonb_array_length(p_settlement->'payments') + v_other_n using errcode = '22023';
  end if;
  if v_other_n > 0 and not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the Owner or Accountant can book a Razorpay payment as Other income. Ask one of them.' using errcode = '42501';
  end if;
  if p_settlement ? 'refunds' and jsonb_typeof(p_settlement->'refunds') is distinct from 'array' then
    raise exception 'The refunds list is not valid. Fetch the settlement again.' using errcode = '22023';
  end if;

  /* Each Razorpay payment: the app payment(s) it is — this company, received (or since
     refunded), on no bank line, exactly Razorpay's rupees. */
  for v_item in select value from jsonb_array_elements(p_settlement->'payments') loop
    begin
      v_ids := array(select jsonb_array_elements_text(v_item->'payment_ids')::uuid);
      v_rzp_amt := round((v_item->>'amount_paise')::numeric / 100);
    exception when others then
      raise exception 'A payment in the settlement is not valid. Fetch the settlement again.' using errcode = '22023';
    end;
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception 'Razorpay payment % has no app payment. Pick or record it first.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    if v_ids && v_all_ids then
      raise exception 'One app payment is listed for two Razorpay payments (%). Fetch the settlement again.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    if (v_item->>'rzp_id') = any(v_rzp_ids) then
      raise exception 'Razorpay payment % is listed twice.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    v_rzp_ids := v_rzp_ids || (v_item->>'rzp_id');
    select count(*), coalesce(sum(p.amount - p.credit_applied), 0)::int into v_n, v_sum
      from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.status in ('received', 'refunded');
    if v_n <> cardinality(v_ids) then
      raise exception 'The app payment for Razorpay payment % is not in your company or was deleted. Fetch the settlement again.', v_item->>'rzp_id'
        using errcode = 'no_data_found';
    end if;
    if v_sum <> v_rzp_amt then
      raise exception 'Razorpay says ₹% for % but the app recorded ₹%. Correct the payment, then fetch again.', v_rzp_amt, v_item->>'rzp_id', v_sum
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.payments p where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.bank_txn_id is not null)
       or exists (select 1 from public.bank_transactions b
                   where b.tenant_id = v_txn.tenant_id and b.matched_to_type = 'payment'
                     and b.matched_to_id = any(array(select x::text from unnest(v_ids) x))) then
      raise exception 'The app payment for % is already reconciled to another bank line. Un-reconcile that line first if it was matched wrongly.', v_item->>'rzp_id'
        using errcode = 'check_violation';
    end if;
    v_all_ids := v_all_ids || v_ids;
    v_cash := v_cash + v_sum;
  end loop;

  /* R-2918: each payment picked as Other income — a Razorpay payment id of this settlement that is in NO app
     payment of this company and in no other reconciled settlement; whole rupees, more than zero. */
  for v_item in select value from jsonb_array_elements(v_oi_list) loop
    begin
      v_rzp_amt := round((v_item->>'amount_paise')::numeric / 100);
    exception when others then
      raise exception 'A payment in the settlement is not valid. Fetch the settlement again.' using errcode = '22023';
    end;
    v_rid := v_item->>'rzp_id';
    if v_rid is null or v_rid !~ '^pay_[A-Za-z0-9]+$' then
      raise exception 'A payment picked as Other income has no Razorpay payment id. Fetch the settlement again.' using errcode = '22023';
    end if;
    if v_rzp_amt is null or v_rzp_amt <= 0 then
      raise exception 'Razorpay payment % has no amount — it cannot be booked as Other income.', v_rid using errcode = '22023';
    end if;
    if v_rid = any(v_rzp_ids) then
      raise exception 'Razorpay payment % is listed twice.', v_rid using errcode = '22023';
    end if;
    v_rzp_ids := v_rzp_ids || v_rid;
    if exists (select 1 from public.payments p
                where p.tenant_id = v_txn.tenant_id and p.reference = v_rid and p.status::text <> 'deleted') then
      raise exception 'Razorpay payment % is in the app (a receipt carries this reference) — it is a customer payment, not Other income. Fetch the settlement again.', v_rid
        using errcode = 'check_violation';
    end if;
    /* Paid on a quote's Razorpay order (quotes.payment_reference) → that customer's money, never Other income. */
    if nullif(btrim(coalesce(v_item->>'order_id', '')), '') is not null
       and exists (select 1 from public.quotes q
                    where q.tenant_id = v_txn.tenant_id and q.payment_reference = btrim(v_item->>'order_id')) then
      raise exception 'Razorpay payment % was paid on a quote''s payment link in the app — record it on that quote with reference %; it is not Other income.', v_rid, v_rid
        using errcode = 'check_violation';
    end if;
    if exists (select 1 from public.razorpay_settlement_items i where i.tenant_id = v_txn.tenant_id and i.rzp_id = v_rid) then
      raise exception 'Razorpay payment % is already booked in another reconciled settlement. Un-reconcile that line first if it was wrong.', v_rid
        using errcode = 'unique_violation';
    end if;
    v_other := v_other + v_rzp_amt;
    v_other_txt := v_other_txt || case when v_other_txt = '' then '' else ', ' end || v_rid || ' (₹' || v_rzp_amt || ')';
  end loop;

  /* Each refund: a payment the app already shows refunded, in full. */
  for v_item in select value from jsonb_array_elements(coalesce(p_settlement->'refunds', '[]'::jsonb)) loop
    begin
      v_ids := array(select jsonb_array_elements_text(v_item->'payment_ids')::uuid);
      v_rzp_amt := round((v_item->>'amount_paise')::numeric / 100);
    exception when others then
      raise exception 'A refund in the settlement is not valid. Fetch the settlement again.' using errcode = '22023';
    end;
    if coalesce(cardinality(v_ids), 0) = 0 then
      raise exception 'Razorpay refund % has no app payment. Record that payment and its refund first.', v_item->>'rzp_id' using errcode = '22023';
    end if;
    select count(*), coalesce(sum(p.amount - p.credit_applied), 0)::int into v_n, v_sum
      from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id = any(v_ids) and p.status = 'refunded';
    if v_n <> cardinality(v_ids) then
      raise exception 'Razorpay refund % is on a payment the app does not show as refunded. Use Refund on that payment (Payments page) first.', v_item->>'rzp_id'
        using errcode = 'check_violation';
    end if;
    if v_sum <> v_rzp_amt then
      raise exception 'Razorpay refunded ₹% (%) but the app''s refunded payment is ₹%. Partial refunds are booked by hand.', v_rzp_amt, v_item->>'rzp_id', v_sum
        using errcode = 'check_violation';
    end if;
    v_ref_ids := v_ref_ids || v_ids;
    v_refunds := v_refunds + v_sum;
  end loop;

  /* The fee is what is left: payments − refunds − what reached the bank. Razorpay's own figure
     must agree within rupee rounding (each item rounded once).
     R-2918: v_cash from here on = every payment of the settlement — the app's receipts plus the ones picked as
     Other income — so the fee, its GST and its day (R-2745) are worked out exactly as before. */
  v_cash := v_cash + v_other;
  v_fee_num := v_cash - v_refunds - v_txn.credit;
  v_fee := round(v_fee_num);
  v_rzp_fee := round(coalesce((p_settlement->>'fee_paise')::numeric, 0) / 100);
  v_rzp_tax := round(coalesce((p_settlement->>'tax_paise')::numeric, 0) / 100);
  v_tol := 1 + ceil((jsonb_array_length(p_settlement->'payments') + v_other_n + jsonb_array_length(coalesce(p_settlement->'refunds', '[]'::jsonb)))::numeric / 2)::int;
  if v_fee < 0 then
    raise exception 'The payments (₹%) less refunds (₹%) are less than the ₹% that reached the bank. This is not the right settlement for this line.',
      v_cash, v_refunds, v_txn.credit using errcode = 'check_violation';
  end if;
  if abs(v_fee - v_rzp_fee) > v_tol then
    raise exception 'Payments ₹% − refunds ₹% − bank ₹% leaves ₹% of fee, but Razorpay says its fee is ₹%. Fetch the settlement again.',
      v_cash, v_refunds, v_txn.credit, v_fee, v_rzp_fee using errcode = 'check_violation';
  end if;

  /* Fees already booked on these payments one by one (R-045 webhook) are not booked again. */
  select coalesce(sum(e.amount), 0)::int, coalesce(sum(e.gst_paid), 0)::int into v_booked, v_booked_g
    from public.expenses e
   where e.tenant_id = v_txn.tenant_id
     and e.id = any(array(select 'EXP-RZPFEE-' || x::text from unnest(v_all_ids) x));
  v_rest := v_fee - v_booked;
  if v_rest < 0 then
    raise exception 'Razorpay fees of ₹% are already booked on these payments, more than the ₹% this settlement kept. Check the fee expenses (Expenses → Bank Charges), then try again.',
      v_booked, v_fee using errcode = 'check_violation';
  end if;
  v_rest_gst := least(v_rest, greatest(0, v_rzp_tax - v_booked_g));

  if v_rest > 0 then
    select v.id, v.gstin into v_vendor
      from public.vendors v
     where v.tenant_id = v_txn.tenant_id and v.name ilike '%razorpay%'
     order by (coalesce(btrim(v.gstin), '') <> '') desc, v.created_at asc
     limit 1;
    select coalesce(nullif(btrim(t.state_code), ''), case when length(btrim(coalesce(t.gstin, ''))) = 15 then left(btrim(t.gstin), 2) end)
      into v_own_st from public.tenants t where t.id = v_txn.tenant_id;
    v_v_st := case when length(btrim(coalesce(v_vendor.gstin, ''))) = 15 then left(btrim(v_vendor.gstin), 2) end;
    if v_rest_gst = 0 then
      v_igst := 0; v_cgst := 0; v_sgst := 0;
    elsif v_own_st is null or v_v_st is null then
      v_igst := null; v_cgst := null; v_sgst := null;      -- unknown: the GST report flags it, no guess
    elsif v_own_st = v_v_st then
      v_cgst := round(v_rest_gst / 2.0); v_sgst := v_rest_gst - v_cgst; v_igst := 0;
    else
      v_igst := v_rest_gst; v_cgst := 0; v_sgst := 0;
    end if;

    /* R-2745: the fee expense (a new document with input credit) is dated on the first open day — the
       line's own day when nothing is filed; after "GST returns filed up to" / the books lock / a GSTR-1
       mark otherwise (R-2631's one rule; R-2621's gst_filed_why says why). The bank line keeps its day. */
    /* Review: the day moves ONLY for a GST-filed line day (then the notes and the result say why); any other
       line keeps its own day exactly as before R-2745 — never a silent re-date. */
    v_fee_why := public.gst_filed_why(v_txn.tenant_id, v_txn.txn_date);
    v_fee_day := case when v_fee_why is null then v_txn.txn_date
                      else public.invoice_date_for_receipt(v_txn.tenant_id, v_txn.txn_date) end;

    v_exp_id := 'EXP-RZPFEE-STL-' || v_sid;
    insert into public.expenses
      (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, igst, cgst, sgst,
       bill_type, paid, paid_date, payment_method, description, notes)
    values
      (v_exp_id, v_txn.tenant_id, 'Bank Charges', 'Razorpay', v_vendor.id, v_fee_day, v_rest, v_rest_gst,
       v_igst, v_cgst, v_sgst, 'gst', true, v_txn.txn_date, 'razorpay',
       'Razorpay fee on settlement ' || v_sid,
       format('Booked from the Razorpay settlement (R-2099): payments ₹%s − refunds ₹%s − bank ₹%s = fee ₹%s incl. GST; ₹%s of it was already booked on single payments. Razorpay''s monthly tax invoice is the bill for this GST.',
              v_cash, v_refunds, v_txn.credit, v_fee, v_booked)
       || case when v_other > 0
               then format(' ₹%s of the payments is not a customer receipt — booked as Other income (R-2918): %s.', v_other, v_other_txt)
               else '' end
       || case when v_fee_why is not null
               then format(' Dated %s — the first open day: %s; Razorpay kept the fee on %s (bank line day) — R-2745.',
                           to_char(v_fee_day, 'FMDD Mon YYYY'), v_fee_why, to_char(v_txn.txn_date, 'FMDD Mon YYYY'))
               else '' end);
  end if;

  /* The line → its first receipt (every existing reader); all receipts → the line. Reconcile
     FIRST: R-2098's trigger clears bank_txn_id when a line's match changes. */
  if cardinality(v_all_ids) > 0 then
    select p.id into v_first from public.payments p
     where p.tenant_id = v_txn.tenant_id and p.id = any(v_all_ids)
     order by (p.status = 'received') desc, p.received_at asc, p.id
     limit 1;
    perform public.reconcile_bank_txn(p_txn_id, 'payment', v_first::text, 'manual');
    update public.payments set bank_txn_id = p_txn_id
     where tenant_id = v_txn.tenant_id and id = any(v_all_ids);
    get diagnostics v_n = row_count;
    if v_n <> cardinality(v_all_ids) then
      raise exception 'R-2099: linked % of % payments to the bank line — nothing was saved.', v_n, cardinality(v_all_ids);
    end if;
  end if;

  /* R-2918: the picked payments' gross → ONE Other income row on this line (R-2095's table: P&L "Other
     income", head 'other'), dated on the line's day like the whole-line Other income. AFTER the line is
     matched (the un-reconcile trigger below removes it with the settlement). A settlement with no app
     payment at all is matched to this row instead of a receipt. */
  if v_other > 0 then
    insert into public.other_incomes (tenant_id, bank_txn_id, income_date, amount, head, description, created_by)
    values (v_txn.tenant_id, p_txn_id, v_txn.txn_date, v_other, 'other',
            left(format('Razorpay payment not in the app, booked as Other income from settlement %s: %s', v_sid, v_other_txt), 500),
            auth.uid())
    returning id into v_oi;
    if cardinality(v_all_ids) = 0 then
      perform public.reconcile_bank_txn(p_txn_id, 'other_income', v_oi::text, 'manual');
    end if;
  end if;

  insert into public.razorpay_settlement_recons
    (tenant_id, settlement_id, bank_txn_id, utr, gross, refunds, fee, fee_gst, fee_expense_id, created_by,
     other_income, other_income_id)
  values
    (v_txn.tenant_id, v_sid, p_txn_id, nullif(btrim(p_settlement->>'utr'), ''), v_cash, v_refunds, v_fee,
     least(v_fee, v_rzp_tax), v_exp_id, auth.uid(), v_other, v_oi)
  returning id into v_recon;

  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'payment', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(p_settlement->'payments') x;
  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'refund', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(coalesce(p_settlement->'refunds', '[]'::jsonb)) x;
  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'other_income', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100), array[]::uuid[]
    from jsonb_array_elements(v_oi_list) x;

  return jsonb_build_object(
    'kind',             'razorpay_settlement',
    'settlement_id',    v_sid,
    'amount',           v_txn.credit,
    'payments',         cardinality(v_all_ids),
    'gross',            v_cash,
    'refunds',          v_refunds,
    'fee',              v_fee,
    'fee_booked_now',   v_rest,
    'fee_gst_now',      v_rest_gst,
    'fee_expense_id',   v_exp_id,
    'fee_expense_date', v_fee_day,
    'fee_date_why',     v_fee_why,
    'other_income',     v_other,
    'other_income_payments', v_other_n,
    'other_income_id',  v_oi,
    'payment_id',       v_first);
end;
$$;
revoke all on function public.reconcile_razorpay_settlement(uuid, jsonb) from public, anon;
grant execute on function public.reconcile_razorpay_settlement(uuid, jsonb) to authenticated, service_role;
comment on function public.reconcile_razorpay_settlement(uuid, jsonb) is
  'R-2099: one Razorpay settlement bank credit → its app payments (payments.bank_txn_id, line matched to the first), refunds checked as already refunded, the unbooked fee + GST as one Bank Charges expense EXP-RZPFEE-STL-<settlement>. R-2745: that expense is dated on the first open (not GST-filed) day (invoice_date_for_receipt); the line keeps its day. R-2918: payments listed in other_income (in no app payment; owner/accountant pick only) are booked as one other_incomes row on the line. One transaction; a settlement / Razorpay id is used once. Owner/manager/accountant/billing; tenant fail-closed.';

-- ── 3. Un-reconcile: the Other income goes with the settlement ─────────────────────────────────
create or replace function public.tg_razorpay_settlement_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rec record;
  v_e   record;
  v_why text;
begin
  /* R-2099: the line no longer carries the settlement — its fee expense and rows go with it
     (R-2098's trg_bank_split_line_unmatched frees the receipts). */
  if old.matched_to_type is not distinct from new.matched_to_type
     and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  /* R-2745: the GST return of the fee expense's day was filed after the booking → its input credit is in a
     filed 3B. Nothing is deleted from a filed return: refuse, so the whole un-reconcile rolls back and the
     line stays reconciled (Undo this run lists the line with this reason). Same trust rule as tg_books_locked:
     a direct DB session / service_role (data repair) is not checked. */
  if coalesce(public.current_request_role(), '') in ('anon', 'authenticated') then
    for v_e in
      select e.id, e.expense_date, e.amount, e.gst_paid
        from public.razorpay_settlement_recons r
        join public.expenses e on e.tenant_id = r.tenant_id and e.id = r.fee_expense_id
       where r.tenant_id = old.tenant_id and r.bank_txn_id = old.id
    loop
      v_why := public.gst_filed_why(old.tenant_id, v_e.expense_date);
      if v_why is not null then
        raise exception 'This line''s Razorpay fee expense % (₹% with ₹% GST as input credit) is dated % and GST for that day is already filed (%), so it cannot be deleted — the line stays reconciled. If the match was wrong, reverse that input credit by hand in an open month (Expenses → Bank Charges) so the books stay right; the line itself can be un-reconciled only when GST for that day is no longer marked filed.',
          v_e.id, v_e.amount, v_e.gst_paid, to_char(v_e.expense_date, 'FMDD Mon YYYY'), v_why
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  for v_rec in
    delete from public.razorpay_settlement_recons
     where tenant_id = old.tenant_id and bank_txn_id = old.id
    returning fee_expense_id, other_income_id
  loop
    if v_rec.fee_expense_id is not null then
      delete from public.expenses where tenant_id = old.tenant_id and id = v_rec.fee_expense_id;
    end if;
    /* R-2918: the payments this settlement booked as Other income go with it (Undo this run / un-reconcile). */
    if v_rec.other_income_id is not null then
      delete from public.other_incomes where tenant_id = old.tenant_id and id = v_rec.other_income_id;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_razorpay_settlement_line_unmatched() from public, anon, authenticated;

commit;
