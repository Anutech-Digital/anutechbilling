-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') and prosrc like '%R-1678b%')
-- deploy-key: r1678bfxgapindiaoverpay
--
-- R-1678 follow-up (independent review BLOCK, 5 Nov 2026) — a ₹ credit (NEFT / Razorpay, no "USD…@"
-- in the narration) that settles a foreign-currency invoice with p_rest 'fx' (20261105175200) could hide
-- TDS, a short payment, a gateway fee or an advance as an exchange difference:
--   P1: an Indian customer's USD invoice ₹1,00,000, NEFT ₹90,000 (exactly 10% — TDS-shaped) → booked
--       ₹10,000 "Exchange gain / loss (realised)", invoice paid, no TDS receivable (the rule refused only
--       ABOVE 10%).
--   P2: ₹1,10,000 for ₹1,00,000 due → a ₹10,000 "gain" — an over-payment / advance became income.
--
-- WHAT CHANGES (reconcile_bank_credit_split, latest body 20261105175200; the ₹-credit branch only):
--   (a) the gap may be at most 5% of the items' ₹ due (R-2427's 5% charges rule; real USD/INR moves
--       between invoice and receipt are ~1–4%). Same number: FX_INR_GAP_SHARE in src/lib/banking/item-fx-pay.ts.
--   (b) a customer in India (or with no country) → 'fx' refused: their gap is TDS, a short payment or an
--       advance — never an exchange difference.
--   (c) more ₹ than due → the items are settled in full and the extra is the customer's ADVANCE
--       (bank_credit_book_advance, the existing model) — never an exchange gain.
--   An inward remittance in the invoices' currency ("INW … USD1000.0@95") is unchanged: the dollars say
--   what was paid, so a better rate is a real exchange gain (R-2427 rules).
-- Test: supabase/tests/r1678b_fx_gap_india_overpay.test.sql (begin … rollback; red without this file).

begin;

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

commit;

notify pgrst, 'reload schema';
