-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_razorpay_settlement(uuid,jsonb)') and prosrc like '%R-2745%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_razorpay_settlement_line_unmatched()') and prosrc like '%R-2745%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_razorpay_settlement_in_run(uuid,uuid,jsonb)') and prosrc like '%R-2745%')
-- deploy-key: r2745razorpayfeefirstopenday
-- 20261113161800_r2745_razorpay_fee_first_open_day.sql
--
-- R-2745 (13 Nov 2026, p0 money, G-RECON — fix card from R-2654's independent check). A Razorpay settlement
-- bank line is booked by R-2099's reconcile_razorpay_settlement: the EXISTING receipts are linked to the line
-- and the fee Razorpay kept (the part not yet booked per payment) becomes ONE "Bank Charges" expense
-- EXP-RZPFEE-STL-<settlement> with its GST as input credit. Until now that expense was dated on the BANK
-- LINE's day, and un-reconciling the line (by hand, or "Undo this run" of R-2654's month batch) deleted it —
-- also when that month's GST return is already filed. The month batch does this at scale (HDFC 4523: 138 open
-- settlement lines, 116 in filed FY25-26 months), so a filed month's 3B input credit would change in the app.
--
-- Owner's standing rule (Pardeep, R-2631 option A): the money is always recorded, and a NEW document is never
-- dated inside a GST-filed month — it goes on the first open day. So:
--
--   1. reconcile_razorpay_settlement <- 20261029060514_r2099 (its only body). The bank line is still matched
--      on its own day and the receipts, settlement rows, amounts and GST split are unchanged. Only the fee
--      expense's date moves: expense_date = invoice_date_for_receipt(company, line day) — R-2631's ONE rule
--      (R-2621 gst_filed_why: "GST returns filed up to" / books lock / GSTR-1 of the month or FY quarter marked
--      filed) — i.e. the first open day, and the line's own day when nothing is filed. paid_date stays the
--      line's day (the day Razorpay kept the money); the notes say the day moved and why. The result carries
--      fee_expense_date + fee_date_why (null when the day did not move) for the screen. R-2654's
--      reconcile_razorpay_settlement_in_run calls this function, so the one-line path and the month batch
--      follow the same rule.
--   2. tg_razorpay_settlement_line_unmatched <- 20261029060514_r2099 (its only body). Before it deletes a fee
--      expense whose day's GST is NOW filed (gst_filed_why not null — the return was filed after the booking)
--      it raises a plain error naming the expense, the day and why, so the un-reconcile is rolled back: the
--      line stays reconciled, the expense and its input credit stay. By hand (Reconcile sheet) that is the
--      refusal the user sees; in undo_bank_recon_run (R-2654, unchanged) the line lands in `left` with that
--      reason and the run's other lines are still undone. Safer path chosen on purpose: nothing is ever
--      removed from a filed return; if the match was wrong the owner reverses the credit in an open month by
--      hand. Same trust rule as tg_books_locked: only request logins (anon / authenticated) are checked — a
--      direct DB session / service_role data repair is not.
--   3. reconcile_razorpay_settlement_in_run <- 20261111161247_r2654 (its only body): a line booked again under
--      the SAME run id after a partial undo (only possible through the API — the sheet starts a new run per
--      press) is recorded again (undone_at cleared, booked_at = now()) instead of silently not, so that run's
--      Undo can take it back. Everything else unchanged.
-- Not changed: undo_bank_recon_run (R-2654 — the trigger's refusal is caught per line); R-2565's per-payment
-- fee expenses (EXP-RZPFEE-<payment>, booked by the webhook on the payment's day — their own card);
-- expenses already booked (no data repair).
-- Test: supabase/tests/r2745_razorpay_fee_first_open_day.test.sql (begin … rollback; red without this file).

begin;

-- ── 1. The one-click reconcile: fee expense on the first open day ──────────────────────────────
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
   one rule; the bank line keeps its own day. */
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
begin
  /* R-2487 shim (R-2745): the trusted-server rule through current_request_role(), same meaning as before. */
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
  if jsonb_typeof(p_settlement->'payments') is distinct from 'array' or jsonb_array_length(p_settlement->'payments') = 0 then
    raise exception 'This settlement has no payments to reconcile. Fetch it again.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_settlement->'payments') > 2000 then
    raise exception 'Too many payments in one settlement (%).', jsonb_array_length(p_settlement->'payments') using errcode = '22023';
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
     must agree within rupee rounding (each item rounded once). */
  v_fee_num := v_cash - v_refunds - v_txn.credit;
  v_fee := round(v_fee_num);
  v_rzp_fee := round(coalesce((p_settlement->>'fee_paise')::numeric, 0) / 100);
  v_rzp_tax := round(coalesce((p_settlement->>'tax_paise')::numeric, 0) / 100);
  v_tol := 1 + ceil((jsonb_array_length(p_settlement->'payments') + jsonb_array_length(coalesce(p_settlement->'refunds', '[]'::jsonb)))::numeric / 2)::int;
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
    v_fee_day := public.invoice_date_for_receipt(v_txn.tenant_id, v_txn.txn_date);
    if v_fee_day is distinct from v_txn.txn_date then
      v_fee_why := public.gst_filed_why(v_txn.tenant_id, v_txn.txn_date);
    end if;

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
       || case when v_fee_why is not null
               then format(' Dated %s — the first open day: %s; Razorpay kept the fee on %s (bank line day) — R-2745.',
                           to_char(v_fee_day, 'FMDD Mon YYYY'), v_fee_why, to_char(v_txn.txn_date, 'FMDD Mon YYYY'))
               else '' end);
  end if;

  /* The line → its first receipt (every existing reader); all receipts → the line. Reconcile
     FIRST: R-2098's trigger clears bank_txn_id when a line's match changes. */
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

  insert into public.razorpay_settlement_recons
    (tenant_id, settlement_id, bank_txn_id, utr, gross, refunds, fee, fee_gst, fee_expense_id, created_by)
  values
    (v_txn.tenant_id, v_sid, p_txn_id, nullif(btrim(p_settlement->>'utr'), ''), v_cash, v_refunds, v_fee,
     least(v_fee, v_rzp_tax), v_exp_id, auth.uid())
  returning id into v_recon;

  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'payment', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(p_settlement->'payments') x;
  insert into public.razorpay_settlement_items (tenant_id, recon_id, kind, rzp_id, amount, payment_ids)
  select v_txn.tenant_id, v_recon, 'refund', x->>'rzp_id', round((x->>'amount_paise')::numeric / 100),
         array(select jsonb_array_elements_text(x->'payment_ids')::uuid)
    from jsonb_array_elements(coalesce(p_settlement->'refunds', '[]'::jsonb)) x;

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
    'payment_id',       v_first);
end;
$$;
revoke all on function public.reconcile_razorpay_settlement(uuid, jsonb) from public, anon;
grant execute on function public.reconcile_razorpay_settlement(uuid, jsonb) to authenticated, service_role;
comment on function public.reconcile_razorpay_settlement(uuid, jsonb) is
  'R-2099: one Razorpay settlement bank credit → its app payments (payments.bank_txn_id, line matched to the first), refunds checked as already refunded, the unbooked fee + GST as one Bank Charges expense EXP-RZPFEE-STL-<settlement>. R-2745: that expense is dated on the first open (not GST-filed) day (invoice_date_for_receipt); the line keeps its day. One transaction; a settlement / Razorpay id is used once. Owner/manager/accountant/billing; tenant fail-closed.';

-- ── 2. Un-reconcile: a fee expense inside a filed return is never deleted ──────────────────────
create or replace function public.tg_razorpay_settlement_line_unmatched()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exp text;
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
        raise exception 'This line''s Razorpay fee expense % (₹% with ₹% GST as input credit) is dated % and GST for that day is already filed (%), so it cannot be deleted — the line stays reconciled. If the match was wrong, reverse that input credit by hand in an open month (Expenses → Bank Charges), then un-reconcile the line.',
          v_e.id, v_e.amount, v_e.gst_paid, to_char(v_e.expense_date, 'FMDD Mon YYYY'), v_why
          using errcode = 'check_violation';
      end if;
    end loop;
  end if;
  for v_exp in
    delete from public.razorpay_settlement_recons
     where tenant_id = old.tenant_id and bank_txn_id = old.id
    returning fee_expense_id
  loop
    if v_exp is not null then
      delete from public.expenses where tenant_id = old.tenant_id and id = v_exp;
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_razorpay_settlement_line_unmatched() from public, anon, authenticated;

-- ── 3. In-run booking: a re-booked line is recorded on the run again ───────────────────────────
create or replace function public.reconcile_razorpay_settlement_in_run(p_run_id uuid, p_txn_id uuid, p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2535_run_gate();
  v_run    public.bank_recon_runs;
  v_txn    public.bank_transactions;
  v_res    jsonb;
begin
  select * into v_run from public.bank_recon_runs r where r.id = p_run_id and r.tenant_id = v_tenant for share;
  if not found then
    raise exception 'This Razorpay settlements run is not in your company — reload the page and press Reconcile all ready again.' using errcode = 'no_data_found';
  end if;
  if v_run.source is distinct from 'razorpay_batch' then
    raise exception 'This run is not a Razorpay settlements run — reload the page and press Reconcile all ready again.' using errcode = '22023';
  end if;
  if v_run.undone_at is not null then
    raise exception 'This run was undone — press Reconcile all ready again (a new run starts).' using errcode = 'check_violation';
  end if;
  select * into v_txn from public.bank_transactions bt
   where bt.id = p_txn_id and bt.tenant_id = v_tenant and bt.bank_account_id = v_run.bank_account_id;
  if not found then
    raise exception 'This bank line is not in the run''s account — reload the bank page.' using errcode = 'no_data_found';
  end if;
  /* Review: a line un-reconciled by hand since an older run booked it is no longer that run's — release
     the stale record (else the line is blocked from every later run, and the old run's Undo could reverse
     a booking it did not make). A line still matched is refused by R-2099 below. */
  if v_txn.matched_to_type is null then
    update public.bank_recon_run_lines o set undone_at = now()
     where o.tenant_id = v_tenant and o.txn_id = p_txn_id and o.run_id <> p_run_id and o.undone_at is null;
  elsif exists (select 1 from public.bank_recon_run_lines o
              where o.tenant_id = v_tenant and o.txn_id = p_txn_id and o.run_id <> p_run_id and o.undone_at is null) then
    raise exception 'Another run already booked this bank line — undo that run or un-reconcile the line first.' using errcode = 'check_violation';
  end if;

  /* R-2099's one booking path — it locks the line, refuses a reconciled line / used settlement, and
     re-checks every amount against the app's own rows (R-2745: its fee expense on the first open day). */
  v_res := public.reconcile_razorpay_settlement(p_txn_id, p_settlement);

  select * into v_txn from public.bank_transactions bt where bt.id = p_txn_id;
  /* R-2745: booked again under the same run id after a partial undo → recorded again (undoable), never
     silently left out. */
  insert into public.bank_recon_run_lines (run_id, tenant_id, txn_id, kind, matched_to_type, matched_to_id)
  values (p_run_id, v_tenant, p_txn_id, 'razorpay_settlement', v_txn.matched_to_type, v_txn.matched_to_id)
  on conflict (run_id, txn_id) do update
    set undone_at = null, booked_at = now(), kind = excluded.kind,
        matched_to_type = excluded.matched_to_type, matched_to_id = excluded.matched_to_id;
  return v_res || jsonb_build_object('run_id', p_run_id);
end;
$function$;
revoke all on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) from public, anon;
grant execute on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) to authenticated, service_role;
comment on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) is
  'R-2654: reconcile_razorpay_settlement (R-2099) + record the line on a razorpay_batch run of bank_recon_runs, in one transaction — so "Undo this run" can take it back. R-2745: a line booked again under the same run after a partial undo is recorded again. Owner/accountant, own company.';

commit;
