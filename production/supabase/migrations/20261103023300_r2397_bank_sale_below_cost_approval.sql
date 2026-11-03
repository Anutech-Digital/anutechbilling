-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'approval_bank_txn_id') and to_regprocedure('public.bank_sale_park_for_approval(uuid,uuid,jsonb,text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_new_sale(uuid,uuid,jsonb,boolean,date,date,integer,numeric,text,text)') and prosrc like '%R-2397%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') and prosrc like '%R-2397%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.relink_bank_one_off_sale(uuid,jsonb)') and prosrc like '%R-2397%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_new_sale(uuid,uuid,jsonb,boolean,date,date,integer,numeric,text,text,text)') and prosrc like '%R-2397%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text,text)') and prosrc like '%R-2397%')
-- deploy-key: r2397banksalebelowcost
--
-- R-2397 (3 Nov 2026, G-RECON) — a NEW SALE booked from a bank credit at a below-cost price waits
-- for the owner's approval, like every other quote (one rule everywhere).
--
-- WHY
--   Staging 3 Nov: Manage-seats quotes at a below-cost Zoho price stop at "Needs approval" (R-2213 /
--   R-2344, approvers R-2367 / R-2383), but a new sale with the same price booked from the bank
--   reconcile drawer (reconcile_bank_credit_new_sale / _split and their R-2360 overloads) saved
--   straight through: its quote (bank_credit_new_sale_quote) never wrote quotes.below_cost, so the
--   R-2213 payments trigger had nothing to look at. The margin control could be skipped by booking
--   from a bank line.
--
-- WHAT
--   1. bank_sale_lines_below_cost(lines) — the same rule as lib/quotes/payment-approval.ts
--      linesBelowCost (margin known and under 0%, by lineEconomics: subtotal = Σ qty × rate, cost =
--      Σ qty × cost, a line with rate > 0 and cost ≤ 0 is UNKNOWN unless it is our own SUP- support
--      plan — unknown cost is not "below cost"), read on the drawer's lines exactly as
--      bank_credit_new_sale_quote stores them. These lines carry their own cost, so this reads a
--      fact of the line; it is not a second copy of the catalogue maths.
--   2. Below cost → bank_sale_park_for_approval: the sale's quote is created as before, then set to
--      approval pending (tier owner, requested by the login, below_cost = true) with the bank line
--      in quotes.approval_bank_txn_id. NOTHING is paid and the bank line stays UNMATCHED. The
--      result says needs_approval = true, the quote id and the reason. Approvers are R-2367 /
--      R-2383's (nobody who made the quote; a sole owner with a written reason). After approval the
--      quote is one of the customer's open items — pick it on the bank line (R-2213 lets the money
--      in then).
--      A second save for the same line while that quote is open is refused and names the quote.
--   3. Split (reconcile_bank_credit_split): a below-cost new sale parks the same way and NO item of
--      the split is paid — the line stays whole for the booking after approval.
--   4. Relink of an old one-off sale to a below-cost new sale is refused before anything is undone.
--   5. R-2360 overloads: the Zoho-number duplicate check still runs; the number goes on the
--      waiting quote's notes (it has no invoice yet).
--   Sales at cost or above are unchanged. Thinner margins (above 0, under the floor) keep their
--   existing behaviour — R-2213: only below cost blocks money.
--
-- Test: supabase/tests/r2397_bank_sale_below_cost_approval.test.sql

begin;

alter table public.quotes
  add column if not exists approval_bank_txn_id uuid references public.bank_transactions(id) on delete set null;
comment on column public.quotes.approval_bank_txn_id is
  'R-2397: the bank credit this below-cost sale was booked from in the reconcile drawer. The line stays unmatched while the quote waits for approval; after approval it is paid by picking the quote on that line.';
create index if not exists quotes_approval_bank_txn_idx on public.quotes (approval_bank_txn_id) where approval_bank_txn_id is not null;

-- ── 1. the rule ──────────────────────────────────────────────────────────────────────────────
create or replace function public.bank_sale_lines_below_cost(p_lines jsonb)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
/* R-2397: lib/quotes/payment-approval.ts linesBelowCost on the drawer's sale lines, read as
   bank_credit_new_sale_quote stores them (rate to paise, cost a whole rupee or 0). Lines the
   builder would refuse → false (the builder says why). */
declare
  v_sub     numeric := 0;
  v_cost    numeric := 0;
  v_unknown boolean := false;
  li        jsonb;
  v_qty     integer;
  v_rate    numeric;
  v_c       integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return false;
  end if;
  for li in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(li) <> 'object'
       or coalesce(li->>'qty', '') !~ '^[0-9]+$'
       or coalesce(li->>'rate', '') !~ '^[0-9]+(.[0-9]{1,2})?$' then
      return false;
    end if;
    v_qty  := (li->>'qty')::int;
    v_rate := round((li->>'rate')::numeric, 2);
    v_c    := coalesce(case when coalesce(li->>'cost', '') ~ '^[0-9]+$' then (li->>'cost')::int end, 0);
    v_sub  := v_sub + v_qty * v_rate;
    v_cost := v_cost + v_qty * v_c;
    /* lib/quotes/line-cost.ts lineCostUnknown: a sold line with no cost is unknown, except our own
       support plan (item id SUP-…), whose ₹0 is real. */
    if v_rate > 0 and v_c <= 0 and coalesce(li->>'item_id', '') not like 'SUP-%' then
      v_unknown := true;
    end if;
  end loop;
  if v_unknown or v_sub <= 0 then
    return false;
  end if;
  /* marginBps = Math.round((sub − cost) / sub × 10 000) < 0  ⇔  the unrounded value < −0.5. */
  return (v_sub - v_cost) * 10000 / v_sub < -0.5;
end;
$$;
revoke all on function public.bank_sale_lines_below_cost(jsonb) from public, anon;
grant execute on function public.bank_sale_lines_below_cost(jsonb) to authenticated, service_role;   -- pure maths on the given lines
comment on function public.bank_sale_lines_below_cost(jsonb) is
  'R-2397: the R-2213 below-cost rule (lib/quotes/payment-approval.ts linesBelowCost) on a bank new sale''s lines.';

create or replace function public.bank_sale_below_cost_text(p_quote_id text)
returns text
language sql
immutable
set search_path = public
as $$
  /* R-2397: the one sentence (lib/banking/credit-pay-for.ts BANK_SALE_BELOW_COST_TEXT mirrors it). */
  select case when p_quote_id is null
    then 'This price is below cost, so the sale needs the owner''s approval first. The bank line stays unmatched.'
    else 'This price is below cost, so the sale waits for the owner''s approval. Quote ' || p_quote_id
         || ' is in Needs approval and the bank line stays unmatched. Approve it (Quotes → ' || p_quote_id
         || ' → Approve), then open this bank line again and pick ' || p_quote_id || '.'
  end
$$;
revoke all on function public.bank_sale_below_cost_text(text) from public, anon;
grant execute on function public.bank_sale_below_cost_text(text) to authenticated, service_role;

-- ── 2. park the sale for approval ────────────────────────────────────────────────────────────
create or replace function public.bank_sale_park_for_approval(
  p_txn_id        uuid,
  p_customer_id   uuid,
  p_lines         jsonb,
  p_billing_cycle text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2397: internal — called by the reconcile RPCs after their own login / company checks. */
declare
  v_txn   record;
  v_open  record;
  v_sale  jsonb;
  v_qid   text;
  v_by    uuid;
begin
  select t.id, t.tenant_id, t.credit, t.matched_to_type into v_txn
    from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a sale.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* One waiting sale per bank line: a second save would only make a second quote. */
  select q.id, q.approval_status::text as approval_status into v_open
    from public.quotes q
   where q.tenant_id = v_txn.tenant_id and q.approval_bank_txn_id = p_txn_id
     and q.status in ('draft', 'sent', 'viewed', 'accepted')
     and q.approval_status::text in ('pending', 'approved')
     and coalesce(q.payment_status::text, 'none') in ('none', 'awaiting')
   order by q.created_at desc nulls last, q.id desc
   limit 1;
  if found then
    if v_open.approval_status = 'approved' then
      raise exception 'Quote % for this bank line is approved. Pick % under this customer''s open items to record the money.', v_open.id, v_open.id
        using errcode = 'check_violation';
    end if;
    raise exception 'Quote % for this bank line already waits for the owner''s approval. Approve it (Quotes → % → Approve), or reject it to book a different price.', v_open.id, v_open.id
      using errcode = 'check_violation';
  end if;

  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);
  v_qid  := v_sale->>'quote_id';
  select u.id into v_by from public.users u where u.id = auth.uid();

  update public.quotes
     set approval_status       = 'pending',
         approval_tier         = 'owner',
         approval_requested_by = v_by,
         approval_requested_at = now(),
         below_cost            = true,
         approval_bank_txn_id  = p_txn_id,
         notes = concat_ws(E'\n', nullif(notes, ''),
                   'Below cost — waits for the owner''s approval. The bank line stays unmatched until then.')
   where id = v_qid and tenant_id = v_txn.tenant_id;

  return jsonb_build_object(
    'kind',           'new',
    'needs_approval', true,
    'reconciled',     false,
    'new_quote',      true,
    'quote_id',       v_qid,
    'quote_total',    (v_sale->>'quote_total')::int,
    'tax_rate',       (v_sale->>'tax_rate')::int,
    'reason',         public.bank_sale_below_cost_text(v_qid));
end;
$$;
revoke all on function public.bank_sale_park_for_approval(uuid, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.bank_sale_park_for_approval(uuid, uuid, jsonb, text) to service_role;

create or replace function public.bank_sale_note_external_number(p_quote_id text, p_number text)
returns void
language sql
security definer
set search_path = public
as $$
  /* R-2397: the Zoho number of a sale waiting for approval — on its quote's notes. */
  update public.quotes
     set notes = concat_ws(E'\n', nullif(notes, ''), 'Zoho invoice number: ' || p_number || ' — add it when this sale is booked after approval.')
   where id = p_quote_id;
$$;
revoke all on function public.bank_sale_note_external_number(text, text) from public, anon, authenticated;
grant execute on function public.bank_sale_note_external_number(text, text) to service_role;

-- ── 3. reconcile_bank_credit_new_sale (from 20261029054707_r2098_bank_credit_split) ──────────
create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean default true,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_billing_cycle       text    default null   -- R-2026: yearly | half_yearly | quarterly | monthly
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $
declare
  v_caller   uuid;
  v_trusted  boolean;
  v_txn      record;
  v_sale     jsonb;
begin
  /* R-2098: the quote is bank_credit_new_sale_quote (shared with the split); guards unchanged. */
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

  select t.id, t.tenant_id into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;

  /* R-2397: below cost → the quote waits in Needs approval; nothing is paid or reconciled. */
  if public.bank_sale_lines_below_cost(p_lines) then
    return public.bank_sale_park_for_approval(p_txn_id, p_customer_id, p_lines, p_billing_cycle);
  end if;

  v_sale := public.bank_credit_new_sale_quote(p_txn_id, p_customer_id, p_lines, p_billing_cycle);

  return public.reconcile_bank_credit_to_item(
           p_txn_id, v_sale->>'quote_id', null, p_tds_amount, p_tds_rate_pct, p_tds_section,
           p_create_subscription, p_sub_start, p_sub_renewal)
         || jsonb_build_object('new_quote', true, 'quote_total', (v_sale->>'quote_total')::int, 'tax_rate', (v_sale->>'tax_rate')::int);
end;
$;


-- ── 4. reconcile_bank_credit_split (from 20261029135130_r2098_round_off_full_only) ───────────
create or replace function public.reconcile_bank_credit_split(
  p_txn_id      uuid,
  p_customer_id uuid,
  p_items       jsonb,              -- [{quote_id | invoice_id, amount}]
  p_sale        jsonb default null, -- {lines, billing_cycle, create_subscription, sub_start, sub_renewal, amount}
  p_rest        text  default null  -- what the difference is: 'advance' | 'round_off' (null = must be exact)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $
/* R-2098. The round-off limit (₹50) is ROUND_OFF_LIMIT in src/lib/banking/credit-pay-for-multi.ts.
   R-2098 round-off full only: a round-off only when every item (and a new sale) ends settled in full. */
/* R-2397: a new sale priced below cost is not booked — its quote waits in Needs approval and
   nothing on this line is paid or reconciled (bank_sale_park_for_approval). */
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
  /* R-2397: below cost → the sale's quote waits for approval; no item is paid, the line stays unmatched. */
  if p_sale is not null and public.bank_sale_lines_below_cost(p_sale->'lines') then
    return public.bank_sale_park_for_approval(p_txn_id, p_customer_id, p_sale->'lines', nullif(p_sale->>'billing_cycle', ''))
           || jsonb_build_object('kind', 'split');
  end if;
  if p_rest is not null and p_rest not in ('advance', 'round_off') then
    raise exception 'The money left over is either an advance or a round-off.' using errcode = '22023';
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
  v_ref := coalesce(nullif(btrim(v_txn.reference), ''), 'BANK-' || v_txn.id::text);
  perform public.assert_payment_ref_unused(v_txn.tenant_id, 'bank_transfer', v_ref);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key('bank_transfer', v_ref), ''), true);

  /* Each item as if paid on its own. */
  for v_item in select value from jsonb_array_elements(p_items) loop
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
    'payment_id',     v_first);
end;
$;


-- ── 5. R-2360 overloads (from 20261102061607_r2360_zoho_invoice_number_on_sale) ──────────────
create or replace function public.reconcile_bank_credit_new_sale(
  p_txn_id              uuid,
  p_customer_id         uuid,
  p_lines               jsonb,
  p_create_subscription boolean,
  p_sub_start           date,
  p_sub_renewal         date,
  p_tds_amount          integer,
  p_tds_rate_pct        numeric,
  p_tds_section         text,
  p_billing_cycle       text,
  p_external_number     text      -- R-2360: the Zoho invoice number (null = none)
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $
declare
  v_num   text;
  v_res   jsonb;
  v_saved boolean;
begin
  /* R-2360: the old 10-argument function books (all its guards); then the Zoho number. */
  v_num := public.zoho_external_number_clean(p_external_number);
  v_res := public.reconcile_bank_credit_new_sale(
             p_txn_id, p_customer_id, p_lines, p_create_subscription, p_sub_start, p_sub_renewal,
             p_tds_amount, p_tds_rate_pct, p_tds_section, p_billing_cycle);
  if v_num is null then
    return v_res;
  end if;
  /* R-2397: the sale waits for approval — the duplicate check still runs; the number is kept on
     the quote's notes so it is at hand when the line is booked after approval. */
  if coalesce((v_res->>'needs_approval')::boolean, false) then
    perform public.bank_sale_keep_external_number(p_txn_id, null, v_num);
    perform public.bank_sale_note_external_number(v_res->>'quote_id', v_num);
    return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', false);
  end if;
  v_saved := public.bank_sale_keep_external_number(p_txn_id, nullif(v_res->>'invoice_id', ''), v_num);
  return v_res || jsonb_build_object('external_number', v_num, 'external_number_saved', v_saved);
end;
$;


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
as $
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
$;


-- ── 6. relink_bank_one_off_sale (from 20261028020622_r2026_new_sale_billing_cycle) ───────────
create or replace function public.relink_bank_one_off_sale(p_txn_id uuid, p_target jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $
declare
  v_caller  uuid;
  v_trusted boolean;
  v_row     record;
  v_path    text := p_target->>'path';
  v_undo    jsonb;
  v_res     jsonb;
  v_lock    date;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  /* Relink removes the old receipt — a delete, so owner / accountant (delete_payment's rule). */
  if not v_trusted and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Relinking removes the old one-off receipt, so only an owner or accountant can do it. Ask them to press Relink on this line.' using errcode = '42501';
  end if;
  if v_path is null or v_path not in ('item', 'new_sale', 'advance') then
    raise exception 'Pick what this money is for (an open quote / invoice, a new sale or an advance).' using errcode = '22023';
  end if;

  /* R-2397: a relink to a new sale priced below cost is refused BEFORE the old sale is undone —
     nothing changes; the owner approves a quote first (or the sale is booked at cost or above). */
  if v_path = 'new_sale' and public.bank_sale_lines_below_cost(coalesce(p_target->'lines', '[]'::jsonb)) then
    raise exception '%', public.bank_sale_below_cost_text(null) || ' Nothing was changed — the old sale stays as it is.'
      using errcode = 'check_violation';
  end if;

  perform 1 from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;

  select o.* into v_row
    from public.bank_transactions t
    cross join lateral public.bank_old_one_off_bookings(t.bank_account_id) o
   where t.id = p_txn_id and o.txn_id = p_txn_id;
  if not found then
    raise exception 'This bank line is not an old one-off bank sale, so there is nothing to relink. Un-reconcile it and reconcile it again instead.' using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'books_locked' then
    select t.books_locked_until into v_lock from public.tenants t where t.id = v_caller;
    raise exception 'Books are locked up to %, and this receipt (%)% falls in a locked month. Nothing was changed. Unlock the books on Accounting → Close month (/accounting/close), relink this line, then lock again.',
      to_char(v_lock, 'DD Mon YYYY'), to_char(v_row.received_on, 'DD Mon YYYY'),
      case when v_row.invoice_id is not null then ' or invoice ' || v_row.invoice_id || ' (' || to_char(v_row.invoice_date, 'DD Mon YYYY') || ')' else '' end
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'other_receipts' then
    raise exception 'Quote % has other receipts too, so it cannot be undone from the bank line. Nothing was changed. Open the quote (/quotes/%) and handle its payments there.', v_row.quote_id, v_row.quote_id
      using errcode = 'check_violation';
  end if;
  if v_row.blocker = 'invoice_notes' then
    raise exception 'Invoice % already has a credit / debit note or TDS entry, so it cannot be reversed from here. Nothing was changed. Open the invoice (/invoices/%) and settle it there.', v_row.invoice_id, v_row.invoice_id
      using errcode = 'check_violation';
  end if;

  /* 1. Undo the old one-off sale: credit note (issued GST invoice) / void (draft), receipt removed. */
  v_undo := public.unreconcile_bank_receipt(p_txn_id, true);

  /* 2. Book the line on what the money was really for. */
  if v_path = 'item' then
    v_res := public.reconcile_bank_credit_to_item(
      p_txn_id,
      nullif(p_target->>'quote_id', ''), nullif(p_target->>'invoice_id', ''),
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''),
      (p_target->>'create_subscription')::boolean, (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date);
  elsif v_path = 'new_sale' then
    v_res := public.reconcile_bank_credit_new_sale(
      p_txn_id, (p_target->>'customer_id')::uuid, coalesce(p_target->'lines', '[]'::jsonb),
      coalesce((p_target->>'create_subscription')::boolean, true), (p_target->>'sub_start')::date, (p_target->>'sub_renewal')::date,
      coalesce((p_target->>'tds_amount')::int, 0), (p_target->>'tds_rate_pct')::numeric, nullif(p_target->>'tds_section', ''),
      nullif(p_target->>'billing_cycle', ''));   -- R-2026
  else
    v_res := public.reconcile_bank_credit_as_advance(p_txn_id, (p_target->>'customer_id')::uuid);
  end if;

  return v_res || jsonb_build_object(
    'relinked_from_quote',   v_row.quote_id,
    'relinked_from_invoice', v_row.invoice_id,
    'old_invoice_credited',  v_undo->>'invoice_credited',
    'old_invoice_voided',    v_undo->>'invoice_voided',
    'old_credit_note_id',    v_undo->>'credit_note_id');
end;
$;


commit;
