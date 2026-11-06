-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') and prosrc like '%R-2518%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text,text)') and prosrc like '%R-2518%') and to_regclass('public.bank_sale_split_repairs') is not null and to_regprocedure('public.repair_split_merged_bank_sale(text,jsonb,boolean)') is not null and to_regprocedure('public.undo_split_merged_bank_sale(uuid,boolean)') is not null
-- deploy-key: r2518zohoinvoicepersale
--
-- R-2518 (6 Nov 2026, G-RECON, staging reconcile): one UPI ₹6,294 (29 Jun 2026) paid TWO Zoho
-- invoices — INV/26-27/0516 ₹3,243 (15 × 180 + 1 × 48) and another ₹3,051 (14 × 180 + 1 × 66). The
-- reconcile booked ONE app invoice with all four lines and no Zoho number: amount, date and GST right,
-- but the documents are not 1:1 with Zoho (Zoho has an IRN for each). Cause: Find in Zoho and the bulk
-- "Reconcile from Zoho" put every Zoho invoice's lines on ONE sale, and R-2360 keeps a Zoho number
-- only when the payment applied to exactly one invoice.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────────────
--   1. reconcile_bank_credit_split (latest body 20261106030000, R-1678b) — p_sale may be an ARRAY of new
--      sales: one quote → one invoice per Zoho invoice, each with its own lines and GST, each paid from
--      the line through the same bank_credit_pay_item (R-2098's model; no parallel RPC), each with its
--      own Zoho number in invoices.external_number (R-2360's column, guard and unique index). A Zoho
--      number twice in the call, or already in the app (another invoice / an imported opening
--      invoice), is refused BEFORE anything is booked. One object = one sale, unchanged. Several sales
--      with one below cost → refused (one approval at a time); one sale below cost parks as before.
--   2. reconcile_bank_credit_split(…, p_external_number) (R-2360 wrapper, latest body R-2397): the
--      single number is refused when the call books several sales (each carries its own).
--   3. paid_amount on a bank-receipt sale (status paid, paid_amount 0) — BY DESIGN, not changed:
--      generate_invoice records money received BEFORE the invoice in adjusted_advances and sets
--      net_payable = amount − that money (0 when paid in full); paid_amount holds receipts AFTER the
--      invoice. Money in = paid_amount + Σ adjusted_advances (lib/invoices/payment-state.ts,
--      lib/payments/amount-due.ts). The test pins it (section E).
--   4. bank_sale_split_repairs + repair_split_merged_bank_sale(invoice, groups, dry_run) +
--      undo_split_merged_bank_sale(repair, dry_run) — OWNER ONLY data repair, NOT run by this
--      migration (Pardeep approves each run after the R-2518 report,
--      scripts/ops/r2518-merged-bank-sales-report.sql). It takes back the merged bank sale the way
--      "undo the sale" does (unreconcile_bank_receipt's steps: full credit note on the issued
--      invoice — the GST series is never broken —, receipt voucher kept as cancelled, receipt removed,
--      quote rejected) and books the SAME bank line again through (1): one sale per Zoho invoice with
--      its Zoho number. Subscriptions the merged sale made stay as they are (create_subscription
--      false on the new sales). The backup row keeps the invoice, quote, receipt, line and
--      subscriptions as they were; undo takes the per-Zoho sales back the same way and books the
--      original lines again as ONE sale (a new invoice number — an issued invoice is never deleted).
--      dry_run (the default) does everything inside a sub-transaction that is rolled back.
-- Test: supabase/tests/r2518_zoho_invoice_per_sale.test.sql (begin … rollback; red without this file).
-- Rollback: re-run 20261106030000's split body and 20261103024934's wrapper body; drop the two repair
--   functions, the helper and the table (only if no repair was run).

begin;

-- ── 1. reconcile_bank_credit_split: one or SEVERAL new sales ─────────────────────────────────────
create or replace function public.reconcile_bank_credit_split(
  p_txn_id      uuid,
  p_customer_id uuid,
  p_items       jsonb,              -- [{quote_id | invoice_id, amount}]
  p_sale        jsonb default null, -- {lines, billing_cycle, create_subscription, sub_start, sub_renewal, amount, external_number}
                                    -- R-2518: or an ARRAY of such sales (one app sale per Zoho invoice)
  p_rest        text  default null  -- what the difference is: 'advance' | 'round_off' | 'fx' (R-1678) (null = must be exact)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2518: p_sale may be an ARRAY of new sales — one app sale (quote → invoice) per Zoho invoice, each
   with its own lines, GST and Zoho number (external_number, R-2360's guard: unique per company, an
   imported opening invoice included). One object = one sale, exactly as before. */
/* R-2098. The round-off limit (₹50) is ROUND_OFF_LIMIT in src/lib/banking/credit-pay-for-multi.ts.
   R-2098 round-off full only: a round-off only when every item (and a new sale) ends settled in full. */
/* R-2397: a new sale priced below cost is not booked — its quote waits in Needs approval and
   nothing on this line is paid or reconciled (bank_sale_park_for_approval). */
/* R-1678: p_rest 'fx' — foreign-currency items settled in full; the difference is an exchange gain / loss
   (and, on an inward remittance short of the dollars due, the remitting bank's charges). The limits
   (5% for a ₹ credit — R-1678b, 5% short and 25% rate for a remittance) are FX_INR_GAP_SHARE in
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
  v_fx_adv    integer := 0;      -- R-1678b: over-payment on a ₹ credit → the customer's advance
  k           integer;
  /* R-2518 */
  v_sales     jsonb := '[]'::jsonb;
  v_sale_in   jsonb;
  v_sale_amts integer[] := array[]::integer[];
  v_nums      text[] := array[]::text[];
  v_num       text;
  v_holder    text;
  v_saved     boolean;
  v_inv_id    text;
  v_res       jsonb;
  s           integer;
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
  /* R-2518: one sale (an object, as before) or several (an array). */
  if p_sale is not null and jsonb_typeof(p_sale) = 'object' then
    v_sales := jsonb_build_array(p_sale);
  elsif p_sale is not null and jsonb_typeof(p_sale) = 'array' then
    v_sales := p_sale;
    if jsonb_array_length(v_sales) > 20 then
      raise exception 'Too many new sales on one bank line (% — at most 20).', jsonb_array_length(v_sales) using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(v_sales) x where jsonb_typeof(x) <> 'object') then
      raise exception 'Each new sale needs its lines and amount. Refresh and try again.' using errcode = '22023';
    end if;
  elsif p_sale is not null and jsonb_typeof(p_sale) <> 'null' then
    raise exception 'Each new sale needs its lines and amount. Refresh and try again.' using errcode = '22023';
  end if;
  if p_rest = 'fx' and jsonb_array_length(v_sales) > 0 then
    raise exception 'An exchange gain / loss settles open invoices in a foreign currency only — book the new sale on its own.' using errcode = '22023';
  end if;
  /* R-2397: below cost → the sale's quote waits for approval; no item is paid, the line stays unmatched. */
  if exists (select 1 from jsonb_array_elements(v_sales) x where public.bank_sale_lines_below_cost(x->'lines')) then
    /* R-2518: several sales — refused, nothing saved (one quote waits for approval at a time). */
    if jsonb_array_length(v_sales) > 1 then
      raise exception 'One of these new sales is priced below cost, so it needs approval first. Nothing was saved — book that sale on its own (it goes to Needs approval), then the others.'
        using errcode = 'check_violation';
    end if;
    v_num := public.zoho_external_number_clean(v_sales->0->>'external_number');
    if v_num is not null then
      perform public.bank_sale_keep_external_number(p_txn_id, null, v_num);   -- R-2518: refused when already in the app
    end if;
    v_res := public.bank_sale_park_for_approval(p_txn_id, p_customer_id, v_sales->0->'lines', nullif(v_sales->0->>'billing_cycle', ''))
             || jsonb_build_object('kind', 'split');
    if v_num is not null then
      perform public.bank_sale_note_external_number(v_res->>'quote_id', v_num);
      v_res := v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', false);
    end if;
    return v_res;
  end if;
  if p_rest is not null and p_rest not in ('advance', 'round_off', 'fx') then
    raise exception 'The money left over is either an advance, a round-off or an exchange gain / loss.' using errcode = '22023';
  end if;
  if p_items is null then p_items := '[]'::jsonb; end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Pick the quotes / invoices this money pays.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) = 0 and jsonb_array_length(v_sales) = 0 then
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

  for s in 1 .. jsonb_array_length(v_sales) loop
    v_sale_in := v_sales->(s - 1);
    begin
      v_sale_amt := (v_sale_in->>'amount')::int;
    exception when others then
      raise exception 'The amount for the new sale is not a whole number.' using errcode = '22023';
    end;
    if coalesce(v_sale_amt, 0) <= 0 then
      raise exception 'Enter how much of this money pays the new sale (more than ₹0).' using errcode = '22023';
    end if;
    v_sale_amts := v_sale_amts || v_sale_amt;
    v_sum := v_sum + v_sale_amt;
    /* R-2518: each sale's Zoho number — once in this call, and not already in the app (R-2360's holder:
       another invoice's external_number or an imported opening invoice). Refused BEFORE anything is booked. */
    v_num := public.zoho_external_number_clean(v_sale_in->>'external_number');
    if v_num is not null then
      if upper(v_num) = any(v_nums) then
        raise exception 'Zoho invoice % is on two of these new sales. Keep it on one.', v_num using errcode = '22023';
      end if;
      v_holder := public.invoice_external_number_holder(v_txn.tenant_id, v_num, null);
      if v_holder is not null then
        raise exception 'Zoho invoice % is already in the app as %. Nothing was saved.', v_num, v_holder
          using errcode = 'unique_violation';
      end if;
      v_nums := v_nums || upper(v_num);
    end if;
  end loop;

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
      /* A ₹ credit (NEFT, Razorpay…). R-1678b (independent review): never for a customer in India (their
         gap is TDS, a short payment or an advance); short by at most 5%; more than due = advance. */
      if coalesce(nullif(lower(btrim((select c.country from public.customers c
                                        where c.id = p_customer_id and c.tenant_id = v_txn.tenant_id))), ''), 'india')
         in ('india', 'in', 'ind', 'bharat') then
        raise exception 'This customer is in India — a gap on their payment is TDS, a short payment or an advance, never an exchange difference. Record it without "exchange gain / loss".'
          using errcode = 'check_violation';
      end if;
      if v_txn.credit > v_sum then
        v_fx_adv := round(v_txn.credit)::int - v_sum;
      elsif v_sum - v_txn.credit > v_sum * 0.05 then
        raise exception '₹% came in for ₹% due on these % invoices — ₹% short is more than 5%%, so it is not an exchange difference (TDS, a fee or a part payment). Record it without "exchange gain / loss".',
          v_txn.credit, v_sum, v_fx_cur, round(v_sum - v_txn.credit) using errcode = 'check_violation';
      end if;
    end if;
    /* Whole rupees (paise of the credit rounded once): Σ fx_parts.forex = this. */
    v_fx_diff := v_sum - v_fx_charge - round(v_txn.credit)::int + v_fx_adv;   -- 0 on an over-payment
    /* Split by each item's foreign amount: its share of the credit and of the charges. */
    v_fx_left := round(v_txn.credit)::int - v_fx_adv;
    v_fx_chleft := v_fx_charge;
    for k in 1 .. cardinality(v_fx_ids) loop
      if v_fx_adv > 0 then
        v_fx_share := v_fx_dues[k];   -- over-payment: each item gets its due, the extra is advance
        v_fx_chg_i := 0;
      elsif k = cardinality(v_fx_ids) then
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
    v_diff := v_fx_adv;
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

  for s in 1 .. jsonb_array_length(v_sales) loop
    v_sale_in := v_sales->(s - 1);
    v_sale_amt := v_sale_amts[s];
    v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, v_sale_in->'lines', nullif(v_sale_in->>'billing_cycle', ''));
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
      case when v_sale_in ? 'create_subscription' then (v_sale_in->>'create_subscription')::boolean end,
      nullif(v_sale_in->>'sub_start', '')::date, nullif(v_sale_in->>'sub_renewal', '')::date);
    v_pay_ids := v_pay_ids || (v_core->>'payment_id')::uuid;
    v_parts := v_parts || (public.bank_credit_item_result(v_txn.tenant_id, v_core, null, v_sale_amt, 0)
                           || jsonb_build_object('new_quote', true, 'quote_total', (v_sale->>'quote_total')::int,
                                                 'tax_rate', (v_sale->>'tax_rate')::int));
    /* R-2518: the sale's Zoho number on its own invoice (R-2360's step: checked again, then stored). A sale
       billed in parts has no invoice yet → saved = false (the result says so; the app keeps it on the
       first part's invoice, as for one sale). */
    v_num := public.zoho_external_number_clean(v_sale_in->>'external_number');
    if v_num is not null then
      v_inv_id := nullif(v_parts->(jsonb_array_length(v_parts) - 1)->>'invoice_id', '');
      v_saved := public.bank_sale_keep_external_number(p_txn_id, v_inv_id, v_num);
      v_parts := jsonb_set(v_parts, array[(jsonb_array_length(v_parts) - 1)::text],
                           (v_parts->(jsonb_array_length(v_parts) - 1))
                           || jsonb_build_object('external_number', v_num, 'external_number_saved', v_saved));
    end if;
  end loop;

  if p_rest in ('advance', 'fx') and v_diff > 0 then   -- R-1678b: 'fx' over-payment → advance
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


-- ── 2. The R-2360 wrapper: one Zoho number only for ONE new sale ─────────────────────────────────
create or replace function public.reconcile_bank_credit_split(
  p_txn_id          uuid,
  p_customer_id     uuid,
  p_items           jsonb,
  p_sale            jsonb,
  p_rest            text,
  p_external_number text            -- R-2360: the Zoho invoice number of the NEW sale (null = none)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num   text;
  v_res   jsonb;
  v_part  jsonb;
  v_inv   text := null;
  v_saved boolean;
begin
  /* R-2360 */
  v_num := public.zoho_external_number_clean(p_external_number);
  if v_num is not null and p_sale is null then
    raise exception 'A Zoho invoice number is kept only on a new sale. Add the sale, or clear the Zoho number.' using errcode = '22023';
  end if;
  /* R-2518: several new sales each carry their own Zoho number (p_sale[].external_number). */
  if v_num is not null and jsonb_typeof(p_sale) = 'array' and jsonb_array_length(p_sale) > 1 then
    raise exception 'These % new sales each carry their own Zoho invoice number — one number cannot be put on all of them.', jsonb_array_length(p_sale)
      using errcode = '22023';
  end if;
  v_res := public.reconcile_bank_credit_split(p_txn_id, p_customer_id, p_items, p_sale, p_rest);
  if v_num is null then
    return v_res;
  end if;
  /* R-2397: the sale waits for approval — duplicate check, number kept on the quote's notes. */
  if coalesce((v_res->>'needs_approval')::boolean, false) then
    perform public.bank_sale_keep_external_number(p_txn_id, null, v_num);
    perform public.bank_sale_note_external_number(v_res->>'quote_id', v_num);
    return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', false);
  end if;
  for v_part in select value from jsonb_array_elements(coalesce(v_res->'parts', '[]'::jsonb)) loop
    if coalesce((v_part->>'new_quote')::boolean, false) then
      v_inv := nullif(v_part->>'invoice_id', '');
    end if;
  end loop;
  v_saved := public.bank_sale_keep_external_number(p_txn_id, v_inv, v_num);
  return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', v_saved);
end;
$$;
revoke all on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text, text) from public, anon;
grant execute on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text, text) to authenticated, service_role;

-- ── 3. Repair (owner only, NOT run here): split a merged bank sale per Zoho invoice ───────────────
create table if not exists public.bank_sale_split_repairs (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  invoice_id   text        not null,
  quote_id     text        not null,
  payment_id   uuid        not null,
  bank_txn_id  uuid        not null,
  groups       jsonb       not null,
  backup       jsonb       not null,
  result       jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  undone_at    timestamptz,
  undone_by    uuid,
  undo_result  jsonb
);
comment on table public.bank_sale_split_repairs is
  'R-2518: one row per run of repair_split_merged_bank_sale — the merged bank sale as it was (backup: invoice, quote, receipt, bank line, subscriptions), the Zoho groups, what was booked, and the undo. Written only by the repair / undo functions.';
create index if not exists bank_sale_split_repairs_tenant_idx on public.bank_sale_split_repairs (tenant_id, created_at desc);
alter table public.bank_sale_split_repairs enable row level security;
revoke all on table public.bank_sale_split_repairs from public, anon, authenticated;
grant select on table public.bank_sale_split_repairs to authenticated;
grant all on table public.bank_sale_split_repairs to service_role;
drop policy if exists bank_sale_split_repairs_select on public.bank_sale_split_repairs;
create policy bank_sale_split_repairs_select on public.bank_sale_split_repairs as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.bank_sale_split_repairs;
create policy zzz_service_role_all on public.bank_sale_split_repairs as permissive for all to service_role using (true) with check (true);

/* Is the caller trusted (service role / a direct DB session) or the company's owner? */
create or replace function public.bank_sale_repair_gate()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_caller  uuid;
begin
  /* R-2518 */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner') then
    raise exception 'Only the owner can run this data repair.' using errcode = '42501';
  end if;
  return v_caller;   -- null = trusted, any company
end;
$$;
revoke all on function public.bank_sale_repair_gate() from public, anon, authenticated;
grant execute on function public.bank_sale_repair_gate() to service_role;

/* A quote's lines (builder shape) → the lines bank_credit_new_sale_quote takes. */
create or replace function public.bank_sale_lines_from_quote(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  /* R-2518 */
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'id',         li->>'id',
           'item_id',    nullif(li->>'item_id', ''),
           'name',       li->>'name',
           'qty',        (li->>'qty')::int,
           'rate',       trim_scale(round((li->>'rate')::numeric, 2))::text,
           'cost',       coalesce(case when coalesce(li->>'cost', '') ~ '^[0-9]+$' then (li->>'cost')::int end, 0),
           'commitment', coalesce(case when li->>'commitment' in ('annual_yearly', 'monthly') then li->>'commitment' end, 'one_time'),
           'domain',     nullif(li->>'domain', ''))) order by ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality as t(li, ord)
$$;
revoke all on function public.bank_sale_lines_from_quote(jsonb) from public, anon;   -- R-2518: pure (reads no table) — safe for any login (R-401 grant rule)
grant execute on function public.bank_sale_lines_from_quote(jsonb) to authenticated, service_role;

/* bank_credit_new_sale_quote's total for these lines at this GST rate (paise rates, subtotal rounded once). */
create or replace function public.bank_sale_lines_total(p_lines jsonb, p_rate integer)
returns integer
language sql
immutable
set search_path = public
as $$
  /* R-2518 */
  select (s + round(s * coalesce(p_rate, 0) / 100.0))::int
    from (select round(coalesce(sum((li->>'qty')::int * (li->>'rate')::numeric), 0)) as s
            from jsonb_array_elements(p_lines) li) x
$$;
revoke all on function public.bank_sale_lines_total(jsonb, integer) from public, anon;   -- R-2518: pure (reads no table) — safe for any login (R-401 grant rule)
grant execute on function public.bank_sale_lines_total(jsonb, integer) to authenticated, service_role;

/* "Undo the sale" for one bank-receipt sale whose line is ALREADY freed — unreconcile_bank_receipt's
   p_undo_sale steps: full credit note on the issued invoice (a draft is voided), the receipt voucher
   kept as cancelled, the receipt removed, the quote rejected. */
create or replace function public.bank_sale_take_back(p_tenant_id uuid, p_quote_id text, p_payment_id uuid, p_why text, p_ref text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pay   public.payments;
  v_inv   record;
  v_q     record;
  v_cn    jsonb;
  v_void  text;
begin
  /* R-2518 */
  select * into v_pay from public.payments where id = p_payment_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'R-2518: receipt % not found — nothing was changed.', p_payment_id; end if;
  select id, invoice_id into v_q from public.quotes where id = p_quote_id and tenant_id = p_tenant_id for update;
  if not found then raise exception 'R-2518: quote % not found — nothing was changed.', p_quote_id; end if;
  if v_q.invoice_id is not null then
    select id, status, amount, external_number into v_inv from public.invoices where id = v_q.invoice_id and tenant_id = p_tenant_id for update;
    if found then
      if v_inv.status = 'draft' then
        update public.invoices set status = 'void'::invoice_status, paid_date = null where id = v_inv.id and tenant_id = p_tenant_id;
        v_void := v_inv.id;
      elsif v_inv.status <> 'void' then
        v_cn := public.issue_credit_note_core(v_inv.id, v_inv.amount, 'cancellation', p_why, p_ref, false);
        update public.invoices
           set status = 'pending'::invoice_status, paid_date = null, paid_amount = 0, net_payable = 0, updated_at = now()
         where id = v_inv.id and tenant_id = p_tenant_id;
      end if;
      /* R-2518 (review): a cancelled invoice no longer IS that Zoho invoice — the number is freed (kept in
         this result and the repair row), or R-2360's holder check would refuse it on a live invoice. */
      if v_inv.external_number is not null then
        update public.invoices set external_number = null where id = v_inv.id and tenant_id = p_tenant_id;
      end if;
    end if;
  end if;
  if v_pay.receipt_voucher_no is not null then
    insert into public.cancelled_vouchers
      (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied, received_at, reason, cancelled_by)
    values
      (v_pay.tenant_id, 'receipt_voucher', v_pay.receipt_voucher_no, v_pay.id, v_pay.quote_id, v_pay.customer_id,
       v_pay.amount, coalesce(v_pay.credit_applied, 0), v_pay.received_at, p_why, public.current_user_id());
  end if;
  delete from public.payments where id = v_pay.id;
  update public.quotes
     set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
         payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
   where id = p_quote_id and tenant_id = p_tenant_id;
  return jsonb_build_object('quote_id', p_quote_id, 'invoice_id', v_q.invoice_id,
                            'invoice_credited', case when v_cn is not null then v_q.invoice_id end,
                            'credit_note_id', v_cn->>'credit_note_id', 'invoice_voided', v_void,
                            'receipt_removed', v_pay.id, 'external_number', v_inv.external_number);
end;
$$;
revoke all on function public.bank_sale_take_back(uuid, text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.bank_sale_take_back(uuid, text, uuid, text, text) to service_role;

/* The amounts for these sales on a line of p_credit: each sale in full; a difference up to ₹50 is a
   round-off, more money is the customer's advance, less leaves the LAST sale part-paid. */
create or replace function public.bank_sale_split_amounts(p_sales jsonb, p_credit integer)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_sum  integer := 0;
  v_diff integer;
  v_n    integer := jsonb_array_length(p_sales);
  v_out  jsonb := p_sales;
  v_last integer;
begin
  /* R-2518 (review): nothing is written off on its own — less money leaves the LAST sale part-paid (its
     balance stays due: TDS, a short payment), more money is the customer's advance. TS twin:
     zohoSalesPlan (src/lib/banking/zoho-sales-split.ts). */
  select coalesce(sum((x->>'amount')::int), 0) into v_sum from jsonb_array_elements(p_sales) x;
  v_diff := p_credit - v_sum;
  if v_diff = 0 then
    return jsonb_build_object('sales', v_out, 'rest', null);
  elsif v_diff > 0 then
    return jsonb_build_object('sales', v_out, 'rest', 'advance');
  end if;
  v_last := (p_sales->(v_n - 1)->>'amount')::int + v_diff;
  if v_last <= 0 then
    raise exception 'R-2518: the bank line (₹%) does not reach the last sale — split this one by hand.', p_credit using errcode = 'check_violation';
  end if;
  v_out := jsonb_set(v_out, array[(v_n - 1)::text, 'amount'], to_jsonb(v_last));
  return jsonb_build_object('sales', v_out, 'rest', null);
end;
$$;
revoke all on function public.bank_sale_split_amounts(jsonb, integer) from public, anon;   -- R-2518: pure (reads no table) — safe for any login (R-401 grant rule)
grant execute on function public.bank_sale_split_amounts(jsonb, integer) to authenticated, service_role;

create or replace function public.repair_split_merged_bank_sale(
  p_invoice_id text,
  p_groups     jsonb,              -- [{external_number, line_ids: [quote line id, …]}, …] — one per Zoho invoice
  p_dry_run    boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_dry     constant text := 'R2518';
  v_caller  uuid;
  v_inv     record;
  v_q       record;
  v_pay     record;
  v_txn     record;
  v_lock    date;
  v_g       jsonb;
  v_ids     text[] := array[]::text[];
  v_all     text[];
  v_num     text;
  v_nums    text[] := array[]::text[];
  v_holder  text;
  v_sales   jsonb := '[]'::jsonb;
  v_lines   jsonb;
  v_plan    jsonb;
  v_back    jsonb;
  v_res     jsonb;
  v_out     jsonb;
  v_rid     uuid;
begin
  /* R-2518: OWNER ONLY. Not run by any migration — Pardeep approves each run after the report. */
  v_caller := public.bank_sale_repair_gate();

  select i.* into v_inv from public.invoices i
   where i.id = p_invoice_id and (v_caller is null or i.tenant_id = v_caller) for update;
  if not found then raise exception 'Invoice % was not found in your company.', p_invoice_id using errcode = 'no_data_found'; end if;
  select q.* into v_q from public.quotes q where q.id = v_inv.quote_id and q.tenant_id = v_inv.tenant_id for update;
  if not found or not coalesce(v_q.invoice_on_receipt, false) then
    raise exception 'Invoice % is not a sale booked from a bank receipt — nothing was changed.', p_invoice_id using errcode = 'check_violation';
  end if;
  if v_inv.status not in ('paid', 'pending', 'overdue') then
    raise exception 'Invoice % is % — nothing to split.', p_invoice_id, v_inv.status using errcode = 'check_violation';
  end if;
  if nullif(btrim(coalesce(v_inv.external_number, '')), '') is not null then
    raise exception 'Invoice % already carries Zoho number % — it is one Zoho invoice, not several.', p_invoice_id, v_inv.external_number using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.credit_notes where invoice_id = v_inv.id)
     or exists (select 1 from public.debit_notes where invoice_id = v_inv.id)
     or exists (select 1 from public.tds_receivable where invoice_id = v_inv.id) then
    raise exception 'Invoice % has a credit / debit note or TDS entry — split it by hand.', p_invoice_id using errcode = 'check_violation';
  end if;
  /* R-2518 (review): only the plain shape — the quote's ONE invoice, billed once, at today's GST rule. */
  if v_q.invoice_id is distinct from v_inv.id
     or exists (select 1 from public.invoices o where o.tenant_id = v_q.tenant_id and o.quote_id = v_q.id and o.id <> v_inv.id)
     or exists (select 1 from public.subscription_billings b where b.tenant_id = v_q.tenant_id and b.invoice_id = v_inv.id) then
    raise exception 'Quote % has more than this one invoice (or invoice % is a part of it) — split it by hand.', v_q.id, p_invoice_id using errcode = 'check_violation';
  end if;
  if coalesce(v_q.billing_cycle, 'yearly') in ('monthly', 'quarterly', 'half_yearly') then
    raise exception 'Quote % is billed in parts (%) — split it by hand.', v_q.id, v_q.billing_cycle using errcode = 'check_violation';
  end if;
  if coalesce(v_q.tax_rate, 0) <> (case
       when public.supply_is_zero_rated((select c.country from public.customers c where c.id = v_q.customer_id),
                                        (select c.gst_treatment from public.customers c where c.id = v_q.customer_id)) then 0
       when public.supplier_gst_status(v_q.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
       else 18 end) then
    raise exception 'The GST rate of quote % (% per cent) is not what a new sale would charge today — split it by hand.', v_q.id, v_q.tax_rate
      using errcode = 'check_violation';
  end if;
  if (select count(*) from public.payments p where p.quote_id = v_q.id and p.tenant_id = v_q.tenant_id) <> 1 then
    raise exception 'Quote % has more than one receipt (or none) — split it by hand.', v_q.id using errcode = 'check_violation';
  end if;
  select p.* into v_pay from public.payments p where p.quote_id = v_q.id and p.tenant_id = v_q.tenant_id for update;
  select t.* into v_txn from public.bank_transactions t
   where t.tenant_id = v_q.tenant_id and t.matched_to_type = 'payment' and t.matched_to_id = v_pay.id::text for update;
  if not found then
    raise exception 'Receipt % is not the bank line''s own receipt — split it by hand.', coalesce(v_pay.receipt_voucher_no, v_pay.id::text) using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.payments p where p.tenant_id = v_txn.tenant_id and p.bank_txn_id = v_txn.id and p.id <> v_pay.id)
     or exists (select 1 from public.bank_receipt_round_offs r where r.bank_txn_id = v_txn.id)
     or round(v_txn.credit)::int <> v_pay.amount or v_txn.credit <> round(v_txn.credit) then
    raise exception 'The bank line of % carries more than this one receipt (another receipt, a round-off or paise) — split it by hand.', p_invoice_id using errcode = 'check_violation';
  end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_txn.tenant_id;
  if v_lock is not null and (v_lock >= v_inv.invoice_date or v_lock >= v_txn.txn_date) then
    raise exception 'Books are locked up to % and invoice % (%) / its receipt (%) falls inside. Nothing was changed.',
      to_char(v_lock, 'DD Mon YYYY'), p_invoice_id, to_char(v_inv.invoice_date, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  /* The groups: ≥ 2, each a Zoho number + its lines; every line of the quote in exactly one group. */
  if jsonb_typeof(p_groups) is distinct from 'array' or jsonb_array_length(p_groups) < 2 or jsonb_array_length(p_groups) > 20 then
    raise exception 'Give 2 to 20 groups — one per Zoho invoice.' using errcode = '22023';
  end if;
  select array_agg(li->>'id' order by li->>'id') into v_all
    from jsonb_array_elements(case when jsonb_typeof(v_q.line_items) = 'array' then v_q.line_items else '[]'::jsonb end) li;
  for v_g in select value from jsonb_array_elements(p_groups) loop
    v_num := public.zoho_external_number_clean(v_g->>'external_number');
    if v_num is null then raise exception 'Every group needs its Zoho invoice number.' using errcode = '22023'; end if;
    if upper(v_num) = any(v_nums) then raise exception 'Zoho invoice % is in two groups.', v_num using errcode = '22023'; end if;
    v_nums := v_nums || upper(v_num);
    v_holder := public.invoice_external_number_holder(v_inv.tenant_id, v_num, null);
    if v_holder is not null then
      raise exception 'Zoho invoice % is already in the app as %. Nothing was changed.', v_num, v_holder using errcode = 'unique_violation';
    end if;
    if jsonb_typeof(v_g->'line_ids') is distinct from 'array' or jsonb_array_length(v_g->'line_ids') = 0 then
      raise exception 'Group % has no lines.', v_num using errcode = '22023';
    end if;
    v_ids := v_ids || array(select jsonb_array_elements_text(v_g->'line_ids'));
    select jsonb_agg(li order by ord) into v_lines
      from jsonb_array_elements(v_q.line_items) with ordinality as t(li, ord)
     where li->>'id' in (select jsonb_array_elements_text(v_g->'line_ids'));
    v_lines := public.bank_sale_lines_from_quote(v_lines);
    v_sales := v_sales || jsonb_build_object(
      'lines', v_lines, 'billing_cycle', v_q.billing_cycle, 'create_subscription', false,
      'external_number', v_num, 'amount', public.bank_sale_lines_total(v_lines, v_q.tax_rate));
  end loop;
  if (select array_agg(x order by x) from unnest(v_ids) x) is distinct from v_all then
    raise exception 'The groups must hold every line of quote % exactly once (lines: %).', v_q.id, array_to_string(v_all, ', ') using errcode = '22023';
  end if;
  v_plan := public.bank_sale_split_amounts(v_sales, round(v_txn.credit)::int);

  v_back := jsonb_build_object(
    'invoice', to_jsonb(v_inv), 'quote', to_jsonb(v_q), 'payment', to_jsonb(v_pay),
    'bank_line', jsonb_build_object('id', v_txn.id, 'txn_date', v_txn.txn_date, 'credit', v_txn.credit, 'reference', v_txn.reference),
    'subscriptions', coalesce((select jsonb_agg(to_jsonb(s) order by s.created_at) from public.subscriptions s
                                where s.tenant_id = v_q.tenant_id and s.quote_id = v_q.id), '[]'::jsonb));

  begin
    insert into public.bank_sale_split_repairs (tenant_id, invoice_id, quote_id, payment_id, bank_txn_id, groups, backup, created_by)
    values (v_inv.tenant_id, v_inv.id, v_q.id, v_pay.id, v_txn.id, p_groups, v_back, auth.uid())
    returning id into v_rid;

    /* 1. Take the merged sale back (line freed first — the one reconcile path). */
    perform public.reconcile_bank_txn(v_txn.id, null, null, 'manual');
    v_out := public.bank_sale_take_back(v_inv.tenant_id, v_q.id, v_pay.id,
               'Merged bank sale split per Zoho invoice (R-2518)', 'repair_split_merged_bank_sale ' || v_rid::text);
    /* 2. The same line again: one sale per Zoho invoice, each with its Zoho number. */
    v_res := public.reconcile_bank_credit_split(v_txn.id, v_q.customer_id, '[]'::jsonb, v_plan->'sales', v_plan->>'rest');
    v_res := jsonb_build_object('repair_id', v_rid, 'taken_back', v_out, 'booked', v_res, 'dry_run', p_dry_run);
    update public.bank_sale_split_repairs set result = v_res where id = v_rid;
    if p_dry_run then
      raise exception using errcode = 'P0001', message = c_dry;
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm <> c_dry then raise; end if;   -- a real refusal: as it is
  end;
  return v_res;
end;
$$;
revoke all on function public.repair_split_merged_bank_sale(text, jsonb, boolean) from public, anon;
grant execute on function public.repair_split_merged_bank_sale(text, jsonb, boolean) to authenticated, service_role;
comment on function public.repair_split_merged_bank_sale(text, jsonb, boolean) is
  'R-2518 DATA REPAIR (owner only; dry run by default): a bank-receipt sale that merged several Zoho invoices → credit note on it + one sale per Zoho invoice on the same bank line, each with its Zoho number. Backup in bank_sale_split_repairs; undo_split_merged_bank_sale takes it back.';

create or replace function public.undo_split_merged_bank_sale(p_repair_id uuid, p_dry_run boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c_dry     constant text := 'R2518';
  v_caller  uuid;
  v_r       record;
  v_txn     record;
  v_part    jsonb;
  v_pays    uuid[] := array[]::uuid[];
  v_adv_id  uuid;
  v_adv     public.payments;
  v_open    integer;
  v_taken   jsonb := '[]'::jsonb;
  v_q       jsonb;
  v_lines   jsonb;
  v_plan    jsonb;
  v_res     jsonb;
  v_lock    date;
begin
  /* R-2518: OWNER ONLY. */
  v_caller := public.bank_sale_repair_gate();
  select r.* into v_r from public.bank_sale_split_repairs r
   where r.id = p_repair_id and (v_caller is null or r.tenant_id = v_caller) for update;
  if not found then raise exception 'Repair % was not found in your company.', p_repair_id using errcode = 'no_data_found'; end if;
  if v_r.undone_at is not null then
    raise exception 'Repair % was already undone on %.', p_repair_id, to_char(v_r.undone_at, 'DD Mon YYYY') using errcode = 'check_violation';
  end if;
  if v_r.result is null or coalesce((v_r.result->>'dry_run')::boolean, false) then
    raise exception 'Repair % was never booked — nothing to undo.', p_repair_id using errcode = 'check_violation';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = v_r.bank_txn_id and t.tenant_id = v_r.tenant_id for update;
  if not found then raise exception 'The bank line of repair % is gone — undo it by hand.', p_repair_id; end if;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_r.tenant_id;
  if v_lock is not null and v_lock >= v_txn.txn_date then
    raise exception 'Books are locked up to % and this receipt (%) falls inside. Nothing was changed.', to_char(v_lock, 'DD Mon YYYY'), to_char(v_txn.txn_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  /* What the repair booked: each new sale's receipt (+ an advance) — still exactly that on the line. */
  for v_part in select value from jsonb_array_elements(coalesce(v_r.result->'booked'->'parts', '[]'::jsonb)) loop
    v_pays := v_pays || (v_part->>'payment_id')::uuid;
    if exists (select 1 from public.credit_notes where invoice_id = v_part->>'invoice_id')
       or exists (select 1 from public.debit_notes where invoice_id = v_part->>'invoice_id')
       or exists (select 1 from public.tds_receivable where invoice_id = v_part->>'invoice_id')
       or (select count(*) from public.payments p where p.quote_id = v_part->>'quote_id') <> 1 then
      raise exception 'Invoice % (from this repair) has changed since (a note, TDS or another receipt) — undo it by hand.', v_part->>'invoice_id'
        using errcode = 'check_violation';
    end if;
  end loop;
  v_adv_id := (select p.id from public.payments p where p.tenant_id = v_r.tenant_id and p.bank_txn_id = v_txn.id
                  and public.bank_advance_payment(p.id) limit 1);
  if exists (select 1 from public.payments p where p.tenant_id = v_r.tenant_id and p.bank_txn_id = v_txn.id
                and p.id <> all(v_pays) and p.id is distinct from v_adv_id)
     or v_txn.matched_to_type is distinct from 'payment' or not (v_txn.matched_to_id::uuid = any(v_pays)) then
    raise exception 'The bank line has changed since the repair — undo it by hand.' using errcode = 'check_violation';
  end if;
  if v_adv_id is not null then
    select * into v_adv from public.payments where id = v_adv_id for update;
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int into v_open
      from public.customer_credits cc where cc.tenant_id = v_r.tenant_id and cc.source_payment_id = v_adv_id;
    if v_open <> v_adv.amount then
      raise exception 'The ₹% advance this repair kept is already used or refunded — undo it by hand.', v_adv.amount using errcode = 'check_violation';
    end if;
  end if;

  begin
    perform public.reconcile_bank_txn(v_txn.id, null, null, 'manual');
    if v_adv_id is not null then
      perform public.delete_payment(v_adv_id);
      update public.quotes
         set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
             payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
       where id = v_adv.quote_id and tenant_id = v_r.tenant_id;
    end if;
    for v_part in select value from jsonb_array_elements(v_r.result->'booked'->'parts') loop
      v_taken := v_taken || public.bank_sale_take_back(v_r.tenant_id, v_part->>'quote_id', (v_part->>'payment_id')::uuid,
                              'Split per Zoho invoice undone (R-2518)', 'undo_split_merged_bank_sale ' || p_repair_id::text);
    end loop;
    /* The original lines again as ONE sale (an issued invoice is never deleted — a new number). */
    v_q := v_r.backup->'quote';
    v_lines := public.bank_sale_lines_from_quote(v_q->'line_items');
    v_plan := public.bank_sale_split_amounts(
                jsonb_build_array(jsonb_build_object('lines', v_lines, 'billing_cycle', v_q->>'billing_cycle', 'create_subscription', false,
                                                     'amount', public.bank_sale_lines_total(v_lines, (v_q->>'tax_rate')::int))),
                round(v_txn.credit)::int);
    v_res := public.reconcile_bank_credit_split(v_txn.id, (v_q->>'customer_id')::uuid, '[]'::jsonb, v_plan->'sales', v_plan->>'rest');
    v_res := jsonb_build_object('repair_id', p_repair_id, 'taken_back', v_taken, 'booked', v_res, 'dry_run', p_dry_run);
    update public.bank_sale_split_repairs set undone_at = now(), undone_by = auth.uid(), undo_result = v_res where id = p_repair_id;
    if p_dry_run then
      raise exception using errcode = 'P0001', message = c_dry;
    end if;
  exception when sqlstate 'P0001' then
    if sqlerrm <> c_dry then raise; end if;
  end;
  return v_res;
end;
$$;
revoke all on function public.undo_split_merged_bank_sale(uuid, boolean) from public, anon;
grant execute on function public.undo_split_merged_bank_sale(uuid, boolean) to authenticated, service_role;
comment on function public.undo_split_merged_bank_sale(uuid, boolean) is
  'R-2518 DATA REPAIR undo (owner only; dry run by default): credit notes the per-Zoho sales of a repair and books the original lines on the same bank line again as one sale.';

commit;

notify pgrst, 'reload schema';
