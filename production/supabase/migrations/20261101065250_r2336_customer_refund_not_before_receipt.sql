-- deploy-peek: to_regprocedure('public.customer_refundable_items(uuid,date)') is not null and to_regprocedure('public.r2336_refund_late_reason(text,date,date)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.reconcile_bank_debit_as_customer_refund(uuid,uuid,text)') and prosrc like '%R-2336%')
-- deploy-key: r2336refundnotbefore
-- 20261101065250_r2336_customer_refund_not_before_receipt.sql
--
-- R-2336 (1 Nov 2026, p2, goal G-RECON): a customer refund must not pay back money that came in
-- AFTER the bank line.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   R-2322 localhost check (1 Nov): on a 7 Apr 2026 ₹500 money-out line, Banking → Reconcile →
--   Customer refund → E2E Customer listed and PRE-PICKED unused advances received 12 and 14 Jun
--   2026. Booking it sets refunded_at = the bank date (7 Apr) — a refund two months before the
--   money it refunds was received: wrong books, wrong advance ageing.
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   r2336_refund_late_reason(kind, dated_on, line_date) — one sentence, used by both functions
--   below so the screen and the server say the same words; null when dated_on <= the line date
--   (same day is allowed).
--   customer_refundable_items(customer, as_of date) — the R-2322 list + dated_on (the day the
--   money came in: the receipt's date, IST) + late_reason for as_of. Late items are still LISTED
--   (the operator sees why); the screen disables them and never pre-picks one. For credit-note
--   credit the receipt picked per invoice is, when as_of is given, one on/before as_of first.
--   The old customer_refundable_items(uuid) is left exactly as R-2322 wrote it (its deploy-peek
--   checks it; nothing that calls it breaks).
--   reconcile_bank_debit_as_customer_refund — the R-2322 body (latest: 20261101013533) + one
--   guard: the payment's receipt date after the bank line → 22023 with that sentence, before
--   anything is booked. Every R-2322 guard and the undo path are unchanged.
--
-- ─── DECISION ────────────────────────────────────────────────────────────────────────────────
--   For credit-note credit the date checked is the RECEIPT's (when the money came in), not the
--   credit note's: issue_credit_note has no date parameter (credit_date = the day it is issued),
--   so a past refund reconciled today would always be refused if the note's date counted.
--
-- Test: supabase/tests/r2336_customer_refund_not_before_receipt.test.sql (one rolled-back
-- transaction); supabase/tests/r2322_bank_customer_refund.test.sql still green.

begin;

-- ── 1. The sentence ───────────────────────────────────────────────────────────────────────────
create or replace function public.r2336_refund_late_reason(p_kind text, p_dated_on date, p_line_date date)
returns text
language sql
stable
set search_path = public
as $$
  /* R-2336: why this item cannot be refunded on a bank line of p_line_date (null = it can). */
  select case
    when p_dated_on is null or p_line_date is null or p_dated_on <= p_line_date then null
    else 'This ' || case when p_kind = 'advance' then 'advance' else 'payment' end
         || ' came in on ' || to_char(p_dated_on, 'FMDD Mon YYYY')
         || ', after this bank line (' || to_char(p_line_date, 'FMDD Mon YYYY') || ').'
  end;
$$;
revoke all on function public.r2336_refund_late_reason(text, date, date) from public, anon;
grant execute on function public.r2336_refund_late_reason(text, date, date) to authenticated, service_role;

-- ── 2. What this customer can be refunded, for a bank line of p_as_of ────────────────────────
create or replace function public.customer_refundable_items(p_customer_id uuid, p_as_of date)
returns table (
  payment_id   uuid,
  kind         text,      -- 'credit_note' | 'advance'
  refundable   integer,   -- most this payment can take back (rupees)
  whole_only   boolean,   -- an advance goes back whole (refund_payment)
  invoice_id   text,
  credit_notes text,
  voucher_no   text,
  received_on  date,
  dated_on     date,      -- R-2336: the day the money came in (receipt date, IST)
  late_reason  text       -- R-2336: set when dated_on is after p_as_of: not refundable on that line
)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2322 list + R-2336 (p_as_of = the bank line's date): items dated after it come back flagged. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant.' using errcode = '42501';
  end if;

  return query
  select r.pid, r.k, r.amt, r.whole, r.inv, r.ids, r.vno, r.rec_on, r.rec_on,
         public.r2336_refund_late_reason(r.k, r.rec_on, p_as_of)
    from (
      select * from (
        select distinct on (q.invoice_id)
               p.id as pid, 'credit_note'::text as k,
               least(p.amount - coalesce(p.credit_applied, 0), cn.open)::integer as amt,
               false as whole, q.invoice_id as inv, cn.ids, p.receipt_voucher_no as vno,
               (p.received_at at time zone 'Asia/Kolkata')::date as rec_on
          from public.payments p
          join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
          join lateral (
            select sum(cc.amount)::integer as open, string_agg(distinct cc.source_credit_note_id, ', ') as ids
              from public.customer_credits cc
             where cc.tenant_id = p.tenant_id and cc.source_invoice_id = q.invoice_id
               and cc.source = 'credit_note' and cc.status = 'open') cn on cn.open > 0
         where p.tenant_id = v_tenant and p.status = 'received'
           and coalesce(p.customer_id, q.customer_id) = p_customer_id
           and q.invoice_id is not null
           and p.amount - coalesce(p.credit_applied, 0) > 0
         order by q.invoice_id,
                  (p_as_of is not null and (p.received_at at time zone 'Asia/Kolkata')::date > p_as_of),
                  p.amount - coalesce(p.credit_applied, 0) desc, p.received_at desc, p.id
      ) cn_rows
      union all
      select p.id, 'advance'::text, p.amount, true, null::text, null::text, p.receipt_voucher_no,
             (p.received_at at time zone 'Asia/Kolkata')::date
        from public.payments p
        join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
       where p.tenant_id = v_tenant and p.status = 'received'
         and coalesce(p.customer_id, q.customer_id) = p_customer_id
         and q.invoice_id is null
         and coalesce(p.credit_applied, 0) = 0
         and (select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)
                from public.customer_credits cc
               where cc.tenant_id = p.tenant_id and cc.source_payment_id = p.id) = p.amount
         and not exists (select 1 from public.customer_credits cc
                          where cc.tenant_id = p.tenant_id and cc.source_payment_id = p.id and cc.status <> 'open')
    ) r;
end;
$$;
comment on function public.customer_refundable_items(uuid, date) is
  'R-2336: R-2322''s refundable list for a bank line dated p_as_of — dated_on (receipt date, IST) and late_reason (set when the money came in after p_as_of; the screen disables those). Owner/manager/accountant; tenant fail-closed.';
revoke all on function public.customer_refundable_items(uuid, date) from public, anon;
grant execute on function public.customer_refundable_items(uuid, date) to authenticated, service_role;

-- ── 3. Book the refund: the R-2322 body (20261101013533) + the R-2336 date guard ─────────────
create or replace function public.reconcile_bank_debit_as_customer_refund(p_txn_id uuid, p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2322: a money-out bank line = a customer refund, through the existing refund RPCs.
   R-2336: refused when the payment came in after the bank line (refunded_at = the bank date). */
declare
  v_tenant    uuid := public.current_tenant_id();
  v_trusted   boolean;
  v_txn       public.bank_transactions;
  v_pay       public.payments;
  v_quote     record;
  v_cust      uuid;
  v_inv       text;
  v_cash      integer;
  v_cn_open   integer;
  v_own_open  integer;
  v_own_other integer;
  v_kind      text;
  v_max       integer;
  v_before    jsonb;
  v_after     jsonb;
  v_b         jsonb := '{}'::jsonb;
  v_a         jsonb := '{}'::jsonb;
  v_ins       jsonb := '{}'::jsonb;
  v_tbl       text;
  v_key       text;
  v_row       jsonb;
  v_r         jsonb;
  v_refunded  uuid;
  v_id        uuid := gen_random_uuid();
  v_late      text;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company context — sign in again, then reconcile.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series — ask one of them to reconcile this line.'
      using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the money went back (at least 5 characters) — it is printed on the refund voucher.'
      using errcode = '22023';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Bank line not found in your company.' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled.' using errcode = '22023';
  end if;
  if coalesce(v_txn.debit, 0) <= 0 or coalesce(v_txn.credit, 0) > 0 then
    raise exception 'A customer refund is money going out — pick a money-out line.' using errcode = '22023';
  end if;

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found or v_pay.tenant_id is distinct from v_tenant then
    raise exception 'That payment was not found in your company. Pick the customer again.' using errcode = '42501';
  end if;
  if v_pay.status <> 'received' then
    raise exception 'That payment is already refunded (voucher %).', coalesce(v_pay.refund_voucher_no, '—') using errcode = '22023';
  end if;
  select q.id, q.invoice_id, q.customer_id into v_quote
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_tenant;
  if not found then
    raise exception 'That payment has no unused advance or credit-note credit to refund.' using errcode = '22023';
  end if;
  v_cust := coalesce(v_pay.customer_id, v_quote.customer_id);
  if v_cust is null then
    raise exception 'That payment has no customer — add the customer on quote % first.', v_quote.id using errcode = '22023';
  end if;
  v_inv  := v_quote.invoice_id;
  v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);

  -- R-2336: the refund is dated on the bank line, so the money it pays back must have come in by then.
  v_late := public.r2336_refund_late_reason(case when v_inv is not null then 'credit_note' else 'advance' end,
                                             (v_pay.received_at at time zone 'Asia/Kolkata')::date, v_txn.txn_date);
  if v_late is not null then
    raise exception '%', v_late using errcode = '22023';
  end if;

  if v_inv is not null then
    select coalesce(sum(cc.amount), 0)::int into v_cn_open
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_invoice_id = v_inv
       and cc.source = 'credit_note' and cc.status = 'open';
    if v_cn_open <= 0 then
      raise exception 'Invoice % has no open credit-note credit to refund. Issue the credit note first (Invoices → % → Credit note), then reconcile this line.', v_inv, v_inv
        using errcode = '22023';
    end if;
    v_kind := 'credit_note';
    v_max  := least(v_cash, v_cn_open);
    if v_txn.debit > v_max then
      raise exception 'At most ₹% can be refunded against invoice % (open credit-note credit ₹%, this payment brought ₹%), but the bank line is ₹%. Issue a credit note for the rest first.',
        v_max, v_inv, v_cn_open, v_cash, v_txn.debit using errcode = '22023';
    end if;
  else
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
           coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
      into v_own_open, v_own_other
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_payment_id = v_pay.id;
    if coalesce(v_pay.credit_applied, 0) <> 0 or v_own_open <> v_pay.amount or v_own_other <> 0 then
      raise exception 'That payment has no unused advance or credit-note credit to refund.' using errcode = '22023';
    end if;
    v_kind := 'advance';
    v_max  := v_pay.amount;
    if v_txn.debit <> v_pay.amount then
      raise exception 'This advance is ₹% but the bank line is ₹%. An advance is refunded whole — pick the advance of the same amount.',
        v_pay.amount, v_txn.debit using errcode = '22023';
    end if;
  end if;

  v_before := public.r2322_refund_scope(v_tenant, v_pay.id, v_quote.id, v_inv, v_cust);

  perform set_config('app.bank_refund_payment', v_pay.id::text, true);
  if v_kind = 'credit_note' then
    v_r := public.refund_credit_note_credit(v_pay.id, v_txn.debit, trim(p_reason));
  else
    v_r := public.refund_payment(v_pay.id, trim(p_reason));
  end if;
  perform set_config('app.bank_refund_payment', '', true);

  v_refunded := (v_r->>'payment_id')::uuid;
  if coalesce((v_r->>'amount')::int, -1) <> v_txn.debit or v_refunded is null then
    raise exception 'R-2322: the refund came to ₹% but the bank line is ₹% — nothing was booked.', v_r->>'amount', v_txn.debit;
  end if;
  -- The refund left the bank on the line's date (the ledger shows Refund on refunded_at).
  update public.payments
     set refunded_at = (v_txn.txn_date::timestamp at time zone 'UTC')
   where id = v_refunded and tenant_id = v_tenant;

  v_after := public.r2322_refund_scope(v_tenant, v_pay.id, v_quote.id, v_inv, v_cust);
  for v_tbl in select jsonb_object_keys(v_before) loop
    for v_key, v_row in select * from jsonb_each(v_before->v_tbl) loop
      if not (v_after->v_tbl ? v_key) then
        raise exception 'R-2322: the refund removed % row % — nothing was booked.', v_tbl, v_key;
      end if;
      if v_after->v_tbl->v_key is distinct from v_row then
        v_b := jsonb_set(v_b, array[v_tbl], coalesce(v_b->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_row));
        v_a := jsonb_set(v_a, array[v_tbl], coalesce(v_a->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_after->v_tbl->v_key));
      end if;
    end loop;
    for v_key, v_row in select * from jsonb_each(v_after->v_tbl) loop
      if not (v_before->v_tbl ? v_key) then
        v_a   := jsonb_set(v_a, array[v_tbl], coalesce(v_a->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_row));
        v_ins := jsonb_set(v_ins, array[v_tbl], coalesce(v_ins->v_tbl, '[]'::jsonb) || to_jsonb(v_key));
      end if;
    end loop;
  end loop;

  insert into public.bank_customer_refunds
    (id, tenant_id, bank_txn_id, customer_id, kind, amount, source_payment_id, refunded_payment_id,
     quote_id, invoice_id, refund_voucher_no, reason, scope_before, scope_after, scope_inserted, created_by)
  values
    (v_id, v_tenant, v_txn.id, v_cust, v_kind, v_txn.debit, v_pay.id, v_refunded,
     v_quote.id, v_inv, v_r->>'refund_voucher_no', trim(p_reason), v_b, v_a, v_ins, auth.uid());

  update public.bank_transactions
     set matched_to_type = 'customer_refund', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = v_txn.id;

  return jsonb_build_object(
    'refund_id', v_id, 'kind', v_kind, 'amount', v_txn.debit,
    'refund_voucher_no', v_r->>'refund_voucher_no', 'refunded_payment_id', v_refunded,
    'invoice_id', v_inv, 'customer_id', v_cust,
    'split', coalesce((v_r->>'split')::boolean, false),
    'credit_note_credit_left', (v_r->>'credit_note_credit_left')::int);
end;
$$;
comment on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) is
  'R-2322 + R-2336 (no refund of money that came in after the bank line): a money-out bank line booked as a customer refund — credit-note credit (refund_credit_note_credit) or an unused advance (refund_payment), amount = the line, refunded_at = the bank date, line matched once (customer_refund). Undo: un-reconcile the line. Owner/manager/accountant; tenant fail-closed.';
revoke all on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) from public, anon;
grant execute on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) to authenticated, service_role;

commit;
