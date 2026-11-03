-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_credit_split(uuid,uuid,jsonb,jsonb,text)') and prosrc like '%R-2430%')
-- deploy-key: r2430placeholderrefbankline
--
-- R-2430 (p1 money, 3 Nov 2026) — two DIFFERENT bank credits with a placeholder reference on the
-- SAME quote / invoice: the second was silently an "idempotent replay" (nothing booked, no error).
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   R-2424 made a placeholder reference ("000000000000000", "NA", …) stop counting as a UTR for the
--   one-credit-once rule (payment_ref_key → NULL). But the bank-credit RPCs still wrote the RAW
--   reference on the receipt, and record_payment's same-quote retry check (tenant, quote, reference)
--   plus the opening-invoice unique index (tenant, invoice, reference) compare raw references. So a
--   customer paying ₹5,000 + ₹5,000 on one quote in two NEFTs that both read 000000000000000: the
--   second line's receipt was "the same receipt again" → idempotent_replay, the line matched to the
--   FIRST receipt, ₹5,000 never booked.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   * bank_line_payment_reference(reference, txn id): the bank line's reference when
--     bank_reference_is_real() says it is a real UTR (trimmed, as before), else 'BANK-' || txn id —
--     what the RPCs already used for an EMPTY reference. Every bank line then gives its receipt its
--     own reference: two zero-ref lines → two receipts; the same line booked again → the same
--     reference → still a replay (booked once).
--   * bank_line_kept_receipt_ref(...): a receipt ALREADY on the quote with the line's placeholder
--     reference as printed, the same amount and on no bank line (typed by hand from the statement, or
--     booked from this line before R-2430 and kept when it was un-reconciled) is this money —
--     "This money is for" matches the line to THAT receipt (as before); the split refuses (as before).
--   * Redefined from their LATEST bodies, the one reference line changed (+ this note):
--       reconcile_bank_credit_to_item   ← 20261029054707_r2098_bank_credit_split
--         (reconcile_bank_credit_new_sale, its R-2360 overload and reconcile_bank_credit_new_sale_fx
--          (R-2425 / R-2440) all book through it — no change needed in them)
--       bank_credit_book_advance        ← 20261029054707_r2098_bank_credit_split (quote + receipt)
--       reconcile_bank_credit_split     ← 20261103024934_r2397_bank_sale_below_cost_approval
--          (the multi-invoice "This money is for" path; its R-2360 overload calls it)
--   * The opening-invoice path of Reconcile from Zoho (R-2419, record_multi_invoice_payment) and the
--     older bank-screen record_payment calls pick their reference in the app — same rule there
--     (src/lib/payments/bank-line-reference.ts).
--   * Not changed: record_payment / record_multi_invoice_payment (a typed reference stays the
--     receipt's reference), payment_ref_key, bank_reference_is_real (R-2441 owns it).
--
-- Test: supabase/tests/r2430_placeholder_ref_bank_line.test.sql

begin;

create or replace function public.bank_line_payment_reference(p_reference text, p_txn_id uuid)
returns text
language sql
stable            -- reads bank_reference_is_real, which a later migration may redefine (R-2441)
parallel safe
set search_path to 'public'
as $$
  /* R-2430: a real UTR is the receipt's reference; a placeholder / empty one is not — the bank line's own id is. */
  select case when public.bank_reference_is_real(p_reference) then btrim(p_reference)
              else 'BANK-' || p_txn_id::text end
$$;

comment on function public.bank_line_payment_reference(text, uuid) is
  'R-2430: the payment reference a receipt booked from a bank line carries — the line''s reference when it is a real UTR (bank_reference_is_real), else BANK-<line id>, so two placeholder-reference lines never read as one receipt.';

revoke all on function public.bank_line_payment_reference(text, uuid) from public, anon;
grant execute on function public.bank_line_payment_reference(text, uuid) to authenticated, service_role;

create or replace function public.bank_line_kept_receipt_ref(
  p_tenant_id  uuid,
  p_reference  text,
  p_quote_id   text,
  p_invoice_id text,
  p_amount     integer
)
returns text
language sql
stable
set search_path to 'public'
as $$
  /* R-2430: a receipt already on this quote with the line's PLACEHOLDER reference as printed, the
     same amount, and on no bank line — typed by hand from the statement, or booked from a bank line
     before R-2430 and kept when that line was un-reconciled. Returns that reference (so the line is
     matched to THAT receipt, never a second one), else null. A real UTR never comes here. */
  select btrim(p_reference)
   where nullif(btrim(coalesce(p_reference, '')), '') is not null
     and not public.bank_reference_is_real(p_reference)
     and exists (
       select 1 from public.payments p
        where p.tenant_id = p_tenant_id
          and p.status = 'received'
          and p.reference = btrim(p_reference)
          and p.amount = p_amount
          and p.quote_id = coalesce(p_quote_id,
                (select i.quote_id from public.invoices i where i.id = p_invoice_id and i.tenant_id = p_tenant_id))
          and p.bank_txn_id is null
          and not exists (select 1 from public.bank_transactions t
                           where t.tenant_id = p_tenant_id and t.matched_to_type = 'payment' and t.matched_to_id = p.id::text))
$$;

comment on function public.bank_line_kept_receipt_ref(uuid, text, text, text, integer) is
  'R-2430: the placeholder reference of an existing receipt on this quote (same amount, on no bank line) a placeholder-reference bank line should be matched to, else null.';

revoke all on function public.bank_line_kept_receipt_ref(uuid, text, text, text, integer) from public, anon, authenticated;
grant execute on function public.bank_line_kept_receipt_ref(uuid, text, text, text, integer) to service_role;

-- ── reconcile_bank_credit_to_item (from 20261029054707_r2098_bank_credit_split) ──────────────
create or replace function public.reconcile_bank_credit_to_item(
  p_txn_id              uuid,
  p_quote_id            text    default null,
  p_invoice_id          text    default null,
  p_tds_amount          integer default 0,
  p_tds_rate_pct        numeric default null,
  p_tds_section         text    default null,
  p_create_subscription boolean default null,
  p_sub_start           date    default null,
  p_sub_renewal         date    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid;
  v_trusted    boolean;
  v_txn        record;
  v_ref        text;
  v_core       jsonb;
  v_pay_id     uuid;
  v_quote_id   text;
begin
  /* §17c fail-closed + R-718 money roles. R-2044: no whole invoice for a part request.
     R-2098: the payment itself is bank_credit_pay_item (shared with the split). */
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
  if (p_quote_id is null) = (p_invoice_id is null) then
    raise exception 'Pick one quote or one invoice this money is for.' using errcode = '22023';
  end if;

  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id for update;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  if v_caller is not null and v_txn.tenant_id is distinct from v_caller then
    raise exception 'This bank line is not in your company' using errcode = '42501';
  end if;
  if coalesce(v_txn.credit, 0) <= 0 then
    raise exception 'Only a money-in (credit) bank line can pay a quote or invoice.' using errcode = '22023';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This bank line is already reconciled (%). Un-reconcile it first if it was matched wrongly.', v_txn.matched_to_type
      using errcode = 'check_violation';
  end if;

  /* The line's UTR is the payment reference (record_payment replays on quote + reference). */
  /* R-2430: a placeholder reference (000000000000000) is not this line's UTR — BANK-<line id> instead;
     but a receipt already on this quote with that placeholder, the same amount and on no bank line
     (typed by hand, or kept from before R-2430) is THIS money: keep its reference so it replays. */
  v_ref := coalesce(
    public.bank_line_kept_receipt_ref(v_txn.tenant_id, v_txn.reference, p_quote_id, p_invoice_id,
                                      v_txn.credit::int + greatest(0, coalesce(p_tds_amount, 0))),
    public.bank_line_payment_reference(v_txn.reference, v_txn.id));
  v_core := public.bank_credit_pay_item(
    p_txn_id, v_txn.credit, v_ref, p_quote_id, p_invoice_id, p_tds_amount, p_tds_rate_pct, p_tds_section,
    p_create_subscription, p_sub_start, p_sub_renewal);
  v_pay_id := (v_core->>'payment_id')::uuid;
  v_quote_id := v_core->>'quote_id';

  /* Already recorded by hand with this UTR: reconcile this line to THAT payment, never a second
     one — unless another bank line already carries it. */
  if coalesce((v_core->>'replay')::boolean, false)
     and exists (select 1 from public.bank_transactions t
                  where t.tenant_id = v_txn.tenant_id and t.id <> v_txn.id
                    and t.matched_to_type = 'payment' and t.matched_to_id = v_pay_id::text) then
    raise exception 'A payment with reference % is already recorded on % and reconciled to another bank line. Nothing was changed.', v_ref, v_quote_id
      using errcode = 'unique_violation';
  end if;

  perform public.reconcile_bank_txn(p_txn_id, 'payment', v_pay_id::text, 'manual');

  return public.bank_credit_item_result(v_txn.tenant_id, v_core, p_invoice_id, v_txn.credit, greatest(0, coalesce(p_tds_amount, 0)));
end;
$$;
revoke all on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) from public, anon;
grant execute on function public.reconcile_bank_credit_to_item(uuid, text, text, integer, numeric, text, boolean, date, date) to authenticated, service_role;

-- ── bank_credit_book_advance (from 20261029054707_r2098_bank_credit_split) ─────────────────
create or replace function public.bank_credit_book_advance(p_txn_id uuid, p_customer_id uuid, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2098: reconcile_bank_credit_as_advance's booking without the lock and the reconcile — the
   whole line there, the money left over in reconcile_bank_credit_split. */
declare
  v_txn       record;
  v_cust      record;
  v_export    boolean;
  v_rate      integer;
  v_qid       text;
  v_ref       text;
  v_voucher   text;
  v_pay_id    uuid;
  v_credit_id uuid;
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'An advance must be more than ₹0.' using errcode = '22023';
  end if;
  select t.* into v_txn from public.bank_transactions t where t.id = p_txn_id;
  if not found then raise exception 'Bank line not found' using errcode = 'no_data_found'; end if;
  select c.id, c.name, c.country, c.tenant_id into v_cust from public.customers c where c.id = p_customer_id;
  if not found or v_cust.tenant_id is distinct from v_txn.tenant_id then
    raise exception 'Customer not found in your company — pick the customer who paid.' using errcode = 'no_data_found';
  end if;

  /* The advance's GST rate — same rule as create_direct_invoice / reconcile_bank_credit_new_sale. */
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_txn.tenant_id, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  v_ref := public.bank_line_payment_reference(v_txn.reference, v_txn.id);   -- R-2430: placeholder → BANK-<line id>

  /* The ₹0 holder quote the receipt hangs on (payments need a quote). Nothing to invoice. */
  v_qid := public.next_document_number('quote', v_txn.tenant_id, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, payment_amount, payment_method, payment_reference,
    payment_received_at, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, v_txn.tenant_id, p_customer_id, v_cust.name, 'Advance on account', 0, 0, 0, v_rate, 0,
    '[]'::jsonb, 'accepted', 'received', p_amount, 'bank_transfer',
    v_ref,
    (v_txn.txn_date::timestamp at time zone 'UTC'), true, 'yearly', public.ist_today(),
    'Advance received in the bank on ' || to_char(v_txn.txn_date, 'DD Mon YYYY')
      || ' — kept as customer credit, nothing invoiced yet (R-1863).'
  );

  /* The receipt, as record_payment writes it (voucher from the series, bank date — R-1118). */
  v_voucher := public.next_document_number('receipt_voucher', v_txn.tenant_id, public.ist_today());
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (v_txn.tenant_id, v_qid, p_customer_id, p_amount, 'bank_transfer', v_ref,
          'Advance on account — bank credit of ' || to_char(v_txn.txn_date, 'DD Mon YYYY'),
          'received', (v_txn.txn_date::timestamp at time zone 'UTC'), v_voucher, auth.uid(), v_txn.bank_account_id)
  returning id into v_pay_id;

  /* The credit, as record_payment writes an overpayment's (same source, same links). */
  insert into public.customer_credits
    (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
  values
    (v_txn.tenant_id, p_customer_id, p_amount, 'overpayment', v_pay_id, v_qid,
     'Advance received ' || to_char(v_txn.txn_date, 'DD Mon YYYY') || ' (bank) — nothing invoiced yet', 'open')
  returning id into v_credit_id;

  return jsonb_build_object('quote_id', v_qid, 'payment_id', v_pay_id, 'receipt_voucher_no', v_voucher,
                            'credit_id', v_credit_id, 'customer_name', v_cust.name);
end;
$$;
revoke all on function public.bank_credit_book_advance(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.bank_credit_book_advance(uuid, uuid, integer) to service_role;

-- ── reconcile_bank_credit_split (from 20261103024934_r2397_bank_sale_below_cost_approval) ──
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
as $$
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
$$;
revoke all on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) from public, anon;
grant execute on function public.reconcile_bank_credit_split(uuid, uuid, jsonb, jsonb, text) to authenticated, service_role;

commit;
