-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2519%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.billing_part_group(uuid)') and prosrc like '%R-2519%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.next_document_number(text,uuid,date)') and prosrc like '%R-2519%') and to_regprocedure('public.set_part_request_terms(text,integer,integer)') is not null and to_regprocedure('public.cancel_quote(text,text)') is not null and to_regprocedure('public.undo_cancel_quote(text)') is not null
-- deploy-key: r2519renewalproforma
-- 20261106053300_r2519_renewal_proforma.sql
--
-- R-2519 (Pardeep, 6 Nov 2026: "Zoho ki tarah proforma bhejna") — staging BITDECENTRO
-- Q-A378-27-0947: Renewals → "Bill next part" made a lump "1 × ₹5,100 One-time" QUOTATION on the
-- Q- series, due 12 Oct in its notes while the page said 6 Nov, and the 17 stored seats could not
-- be made 18 before it was saved. Zoho sends PI/26-27/1296: 18 × ₹300, its own PI series.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────
--   1. Numbering: doc_type 'proforma', prefix PI — "PI-<code>-<YY>-<NNNN>", its own series per
--      financial year (next_document_number body of 20261018022629 R-1529, only the list of doc
--      types grows). NOT a GST series: a Proforma is not a tax invoice (§17a) — its tax invoice
--      still comes from the INV series when it is paid.
--   2. bill_subscription_instalment (body of 20261103141332 R-2423):
--        - a NEW request's number is a PI number (existing requests keep theirs);
--        - each line is seats × a per-seat rate when that is exact (the R-2101 invoice-line rule),
--          with per_seat / period_start / period_end on the line (period_end inclusive);
--        - due on the LATER of the part start and today, + the payment terms — a part billed late
--          (Q-0947: 12 Oct part billed 6 Nov) is due from today, so the notes and the page agree;
--        - a paid request whose seats / rate were changed first puts them on the subscription and
--          the part (apply_part_request_terms) before its tax invoice is raised.
--      Amounts, GST, statuses, siblings, credit-note and first-part rules: unchanged.
--      billing_part_group (body of 20261030035007 R-2095) reads a group request line's taxable as
--      qty × rate (it read the rate alone; older lines are qty 1, so they read the same).
--   3. quotes.proforma_seats / proforma_seat_rate / proforma_terms_applied_at and
--      set_part_request_terms(quote, seats, per-seat rate): the Bill-next-part preview's seat /
--      rate change, written on an UNPAID single-subscription request only (no invoice, no money).
--      The subscription is NOT changed then — only when the request is paid (bill_subscription_
--      instalment) or accepted (trigger trg_quotes_part_request_terms), through the same
--      subscriptions update every seat change uses (record_contract_amendment logs it, with an
--      app.amendment_note naming the proforma).
--   4. cancel_quote(quote, reason) / undo_cancel_quote(quote) (coordinator, 6 Nov — Q-0947 must be
--      cancelled): an unpaid quote or proforma is CANCELLED, never deleted — stored status
--      'rejected' (closed for every existing rule: reminders, awaiting payment, accept page) plus
--      cancelled_at / cancelled_by / cancel_reason / cancelled_from_status, which the app shows
--      as "Cancelled". Payment status → none. The subscription is not touched. A part request lets
--      go of its part (cancelled_part_billing_id keeps the link; the part's due date is cleared)
--      so the part can be billed again. Undo while nothing was paid: the old status and the link
--      come back (refused when the part already has a new request). Refused: money received, an
--      invoice raised, an add-seats quote (rejecting it takes the seats back — R-1705; that is
--      Mark rejected's job), already closed. One activity_log row each way.
--
-- Test: supabase/tests/r2519_renewal_proforma.test.sql (one transaction, rolled back).

begin;

-- ── 1. numbering: doc_type proforma, prefix PI ───────────────────────────────────────────
alter table public.document_series drop constraint if exists document_series_doc_type_check;
alter table public.document_series add constraint document_series_doc_type_check
  check (doc_type = any (array['invoice', 'bill_of_supply', 'receipt_voucher', 'refund_voucher', 'credit_note',
                               'debit_note', 'quote', 'purchase_order', 'campaign', 'proforma']));

create or replace function public.default_doc_prefix(p_doc_type text)
 returns text
 language sql
 immutable
as $function$
  select case p_doc_type
    when 'invoice'         then 'INV'
    when 'bill_of_supply'  then 'BOS'   -- R-1529, CGST Rule 49
    when 'receipt_voucher' then 'RV'
    when 'refund_voucher'  then 'RFV'
    when 'credit_note'     then 'CN'
    when 'debit_note'      then 'DN'
    when 'quote'           then 'Q'
    when 'proforma'        then 'PI'    -- R-2519, renewal proforma invoices
    when 'purchase_order'  then 'PO'
    when 'campaign'        then 'CAMP'
    else upper(p_doc_type)
  end;
$function$;
grant execute on function public.default_doc_prefix(text) to authenticated, service_role;

-- ── 2. columns ──────────────────────────────────────────────────────────────────────────
alter table public.quotes add column if not exists proforma_seats integer;
alter table public.quotes add column if not exists proforma_seat_rate integer;
alter table public.quotes add column if not exists proforma_terms_applied_at timestamptz;
alter table public.quotes add column if not exists cancelled_at timestamptz;
alter table public.quotes add column if not exists cancelled_by uuid;
alter table public.quotes add column if not exists cancel_reason text;
alter table public.quotes add column if not exists cancelled_from_status text;
alter table public.quotes add column if not exists cancelled_payment_status text;
alter table public.quotes add column if not exists cancelled_part_billing_id uuid
  references public.subscription_billings(id) on delete set null;
alter table public.quotes drop constraint if exists quotes_proforma_terms_r2519;
alter table public.quotes add constraint quotes_proforma_terms_r2519
  check ((proforma_seats is null or proforma_seats between 1 and 100000)
     and (proforma_seat_rate is null or proforma_seat_rate between 0 and 10000000));

comment on column public.quotes.proforma_seats is
  'R-2519: seats a part payment request (proforma) was changed to before it was paid — put on the subscription when it is paid or accepted.';
comment on column public.quotes.proforma_seat_rate is
  'R-2519: ₹ per seat for the request''s part (one period), set with proforma_seats.';
comment on column public.quotes.proforma_terms_applied_at is
  'R-2519: when proforma_seats / proforma_seat_rate were put on the subscription.';
comment on column public.quotes.cancelled_at is
  'R-2519: the quote / proforma was cancelled (kept, not deleted). Stored status is rejected; the app shows Cancelled.';
comment on column public.quotes.cancelled_from_status is
  'R-2519: the status before Cancel — Undo puts it back.';
comment on column public.quotes.cancelled_part_billing_id is
  'R-2519: the subscription part a cancelled part request was for (its subscription_billing_id is let go so the part can be billed again).';

-- ── 3. helpers ──────────────────────────────────────────────────────────────────────────
create or replace function public.r2519_per_seat(p_seats integer, p_taxable integer)
returns boolean
language sql
immutable
set search_path = public
as $$
  /* R-2519: a part's line is seats × a whole-rupee per-seat rate only when that is exact
     (R-2101's invoice-line rule) — else 1 × the taxable, so qty × rate is always the taxable. */
  select coalesce(p_seats, 0) > 0 and coalesce(p_taxable, 0) > 0 and p_taxable % p_seats = 0;
$$;
revoke all on function public.r2519_per_seat(integer, integer) from public, anon;
grant execute on function public.r2519_per_seat(integer, integer) to authenticated, service_role;

/* R-2519: put a proforma's own seats / per-seat rate on its part and its subscription. Called only
   from bill_subscription_instalment (paid) and the accept trigger — never by a user. Idempotent. */
create or replace function public.apply_part_request_terms(p_quote_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_q      record;
  v_b      record;
  v_s      record;
  v_months integer;
  v_mrr    integer;
  v_parts  integer;
begin
  select q.id, q.tenant_id, q.subtotal, q.proforma_seats, q.proforma_seat_rate, q.subscription_billing_id
    into v_q from public.quotes q where q.id = p_quote_id;
  if not found or v_q.proforma_seats is null or v_q.subscription_billing_id is null then
    return false;
  end if;
  select b.* into v_b from public.subscription_billings b where b.id = v_q.subscription_billing_id for update;
  if not found then return false; end if;
  if v_b.invoice_id is null and v_b.taxable_amount is distinct from v_q.subtotal then
    update public.subscription_billings
       set taxable_amount = v_q.subtotal, updated_at = now()
     where id = v_b.id and invoice_id is null;
  end if;

  select s.id, s.seats, s.mrr, s.term_amount, s.term_months, s.billing_cycle::text as cycle
    into v_s from public.subscriptions s where s.id = v_b.subscription_id for update;
  if not found then return false; end if;
  v_months := case v_s.cycle when 'monthly' then 1 when 'quarterly' then 3
                             when 'half_yearly' then 6 when 'yearly' then 12 else 1 end;
  /* MRR = the part's taxable ÷ its months (18 × ₹300 a month → ₹5,400). */
  v_mrr := round(v_q.subtotal::numeric / v_months)::integer;
  v_parts := public.part_request_parts_in_term(v_s.term_months, v_s.cycle);
  if v_s.seats is distinct from v_q.proforma_seats or v_s.mrr is distinct from v_mrr then
    perform set_config('app.amendment_note',
      'R-2519: proforma ' || v_q.id || ' — ' || v_q.proforma_seats || ' seats at ₹' || coalesce(v_q.proforma_seat_rate, 0) || ' a seat', true);
    update public.subscriptions
       set seats = v_q.proforma_seats,
           mrr = v_mrr,
           /* R-2369's exact term amount follows the new part amount (N parts in the term). */
           term_amount = case when term_amount is null or v_parts is null then term_amount
                              else v_q.subtotal * v_parts end
     where id = v_s.id;
  end if;
  update public.quotes set proforma_terms_applied_at = coalesce(proforma_terms_applied_at, now()) where id = v_q.id;
  return true;
end;
$$;
revoke all on function public.apply_part_request_terms(text) from public, anon, authenticated;
grant execute on function public.apply_part_request_terms(text) to service_role;

-- ── 4. set_part_request_terms: the preview's seat / rate change on an unpaid request ───────
create or replace function public.set_part_request_terms(p_quote_id text, p_seats integer, p_seat_rate integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519: change an unpaid single-subscription proforma to p_seats × ₹p_seat_rate. The subscription
   is changed only when the proforma is paid / accepted (apply_part_request_terms). */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_b       record;
  v_s       record;
  v_taxable integer;
  v_tax     integer;
  v_period  text;
  v_line    jsonb;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can change a proforma.' using errcode = '42501';
  end if;
  if p_seats is null or p_seats < 1 or p_seats > 100000 then
    raise exception 'Seats must be a whole number from 1 to 100,000.' using errcode = '22023';
  end if;
  if p_seat_rate is null or p_seat_rate < 0 or p_seat_rate > 10000000 then
    raise exception 'The rate a seat must be ₹0 to ₹1,00,00,000.' using errcode = '22023';
  end if;

  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found or v_q.subscription_billing_id is null then
    raise exception 'Quote % is not a proforma for a part of a subscription.', p_quote_id using errcode = '22023';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.invoice_id is not null then
    raise exception 'Proforma % already has its tax invoice — it cannot be changed.', v_q.id using errcode = '22023';
  end if;
  if v_q.status::text in ('rejected', 'expired') then
    raise exception 'Proforma % is closed — it cannot be changed.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0) then
    raise exception 'Money was already received on % — its seats and rate cannot change now.', v_q.id using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(v_q.line_items, '[]'::jsonb)) <> 1 then
    raise exception 'Proforma % covers several subscriptions — change each subscription''s seats from Manage seats.', v_q.id
      using errcode = '22023';
  end if;
  select b.* into v_b from public.subscription_billings b where b.id = v_q.subscription_billing_id;
  if v_b.invoice_id is not null then
    raise exception 'This part already has its tax invoice — it cannot be changed.' using errcode = '22023';
  end if;
  select s.plan, s.domain, s.term_months, s.billing_cycle::text as cycle into v_s
    from public.subscriptions s where s.id = v_b.subscription_id;

  v_taxable := p_seats * p_seat_rate;
  v_tax     := round(v_taxable * coalesce(v_q.tax_rate, 0) / 100.0);
  v_period  := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_line := (v_q.line_items->0)
            || jsonb_build_object(
                 'name', public.part_request_line_name(v_s.plan, v_s.domain, p_seats, v_period, v_b.period_index,
                                                       public.part_request_parts_in_term(v_s.term_months, v_s.cycle)),
                 'qty', p_seats, 'rate', p_seat_rate, 'per_seat', true,
                 'period_start', v_b.period_start, 'period_end', v_b.period_end - 1);
  update public.quotes
     set line_items = jsonb_build_array(v_line),
         seats = p_seats,
         subtotal = v_taxable,
         amount = v_taxable + v_tax,
         proforma_seats = p_seats,
         proforma_seat_rate = p_seat_rate
   where id = v_q.id;
  return jsonb_build_object('quote_id', v_q.id, 'seats', p_seats, 'seat_rate', p_seat_rate,
                            'taxable', v_taxable, 'amount', v_taxable + v_tax);
end;
$$;
revoke all on function public.set_part_request_terms(text, integer, integer) from public, anon;
grant execute on function public.set_part_request_terms(text, integer, integer) to authenticated, service_role;

/* Accepting a proforma (customer's accept page / Mark accepted) puts its seats on too. */
create or replace function public.tg_quotes_part_request_terms()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* R-2519 */
  if new.status::text = 'accepted' and old.status::text is distinct from 'accepted'
     and new.subscription_billing_id is not null and new.proforma_seats is not null then
    perform public.apply_part_request_terms(new.id);
  end if;
  return null;
end;
$$;
revoke all on function public.tg_quotes_part_request_terms() from public, anon, authenticated;
drop trigger if exists trg_quotes_part_request_terms on public.quotes;
create trigger trg_quotes_part_request_terms
  after update of status on public.quotes
  for each row execute function public.tg_quotes_part_request_terms();

-- ── 5. Cancel / Undo cancel (kept, never deleted) ──────────────────────────────────────────
create or replace function public.cancel_quote(p_quote_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519: cancel an unpaid quote / proforma. The subscription is not touched. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can cancel a quote.' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 5 then
    raise exception 'Write why it is cancelled (at least 5 characters) — it is kept on the record.' using errcode = '22023';
  end if;
  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote % not found.', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.cancelled_at is not null then
    raise exception 'Quote % is already cancelled.', v_q.id using errcode = '22023';
  end if;
  if v_q.status::text in ('rejected', 'expired') or v_q.superseded_by is not null then
    raise exception 'Quote % is already closed.', v_q.id using errcode = '22023';
  end if;
  if v_q.invoice_id is not null
     or exists (select 1 from public.invoices i where i.quote_id = v_q.id and i.status::text <> 'void')
     or (v_q.subscription_billing_id is not null and exists (
           select 1 from public.subscription_billings b where b.id = v_q.subscription_billing_id and b.invoice_id is not null)) then
    raise exception 'Quote % already has a tax invoice — cancel that with a credit note instead.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0) then
    raise exception 'Money was already received on % — refund it first, or record the rest.', v_q.id using errcode = '22023';
  end if;
  if coalesce(v_q.is_add_seats, false) then
    raise exception 'Quote % added seats to a subscription — use Mark rejected, which also takes those seats back.', v_q.id
      using errcode = '22023';
  end if;

  update public.quotes
     set cancelled_from_status = v_q.status::text,
         cancelled_payment_status = v_q.payment_status::text,
         cancelled_part_billing_id = v_q.subscription_billing_id,
         subscription_billing_id = null,
         status = 'rejected',
         payment_status = 'none',
         cancelled_at = now(),
         cancelled_by = auth.uid(),
         cancel_reason = v_reason,
         notes = concat_ws(E'\n', nullif(notes, ''), 'Cancelled — ' || v_reason || ' (' || to_char(public.ist_today(), 'DD Mon YYYY') || ').')
   where id = v_q.id;
  /* The part is free to be billed again — its due date was this request's. */
  if v_q.subscription_billing_id is not null then
    update public.subscription_billings
       set due_on = null, request_reminder_step = null, updated_at = now()
     where id = v_q.subscription_billing_id and invoice_id is null;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_q.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'quote.cancelled', 'quote', v_q.id,
          left(format('Cancelled %s — %s', v_q.id, v_reason), 120),
          jsonb_build_object('status', jsonb_build_object('from', v_q.status::text, 'to', 'cancelled'), 'reason', v_reason));

  return jsonb_build_object('quote_id', v_q.id, 'status', 'cancelled', 'part_released', v_q.subscription_billing_id is not null);
end;
$$;
revoke all on function public.cancel_quote(text, text) from public, anon;
grant execute on function public.cancel_quote(text, text) to authenticated, service_role;

create or replace function public.undo_cancel_quote(p_quote_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519: undo Cancel while nothing was paid — the old status and the part link come back. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can undo a cancel.' using errcode = '42501';
  end if;
  select q.* into v_q from public.quotes q where q.id = p_quote_id for update;
  if not found then
    raise exception 'Quote % not found.', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in your company.', p_quote_id using errcode = '42501';
  end if;
  if v_q.cancelled_at is null then
    raise exception 'Quote % is not cancelled.', v_q.id using errcode = '22023';
  end if;
  if exists (select 1 from public.payments p where p.quote_id = v_q.id and p.status = 'received' and p.amount > 0)
     or v_q.invoice_id is not null then
    raise exception 'Money or an invoice is already on % — it cannot be reopened.', v_q.id using errcode = '22023';
  end if;
  if v_q.cancelled_part_billing_id is not null then
    if exists (select 1 from public.subscription_billings b where b.id = v_q.cancelled_part_billing_id and b.invoice_id is not null) then
      raise exception 'Its part already has a tax invoice — % cannot be reopened.', v_q.id using errcode = '22023';
    end if;
    if exists (select 1 from public.quotes q2 where q2.subscription_billing_id = v_q.cancelled_part_billing_id) then
      raise exception 'A new proforma (%) was made for this part — cancel that one first.',
        (select q2.id from public.quotes q2 where q2.subscription_billing_id = v_q.cancelled_part_billing_id limit 1)
        using errcode = '22023';
    end if;
  end if;

  update public.quotes
     set status = coalesce(v_q.cancelled_from_status, 'sent')::public.quote_status,
         payment_status = coalesce(v_q.cancelled_payment_status, 'awaiting')::public.payment_status,
         subscription_billing_id = v_q.cancelled_part_billing_id,
         cancelled_part_billing_id = null,
         cancelled_at = null, cancelled_by = null, cancel_reason = null,
         cancelled_from_status = null, cancelled_payment_status = null,
         notes = concat_ws(E'\n', nullif(notes, ''), 'Cancel undone (' || to_char(public.ist_today(), 'DD Mon YYYY') || ').')
   where id = v_q.id;
  if v_q.cancelled_part_billing_id is not null then
    update public.subscription_billings
       set due_on = coalesce(due_on, greatest(bill_on, coalesce(v_q.created_date, public.ist_today())) + coalesce(v_q.payment_terms_days, 0)),
           updated_at = now()
     where id = v_q.cancelled_part_billing_id;
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_q.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'quote.cancel_undone', 'quote', v_q.id,
          left(format('Cancel undone on %s', v_q.id), 120),
          jsonb_build_object('status', jsonb_build_object('from', 'cancelled', 'to', coalesce(v_q.cancelled_from_status, 'sent'))));
  return jsonb_build_object('quote_id', v_q.id, 'status', coalesce(v_q.cancelled_from_status, 'sent'));
end;
$$;
revoke all on function public.undo_cancel_quote(text) from public, anon;
grant execute on function public.undo_cancel_quote(text) to authenticated, service_role;

-- billing_part_group (body of 20261030035007 R-2095): a group request line is now seats × rate.
create or replace function public.billing_part_group(p_billing_id uuid)
returns table(billing_id uuid, subscription_id uuid, taxable integer, plan text, seats integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2519: a request line's taxable is qty × rate. R-2092: the not-yet-invoiced parts of one quote for one period — one tax invoice, one request.
   R-2095: a request spent on an invoice that credit notes cancelled no longer fixes the group.
   R-2104: the quote-period rounding applies when the subscriptions are the quote's deal (MRR × 12
   within ₹6 a subscription of the quote's term taxable), however many rupees the parts are off. */
declare
  v_b       record;
  v_sub     record;
  v_req     record;
  v_ids     uuid[];
  v_tax     integer[];
  v_plans   text[];
  v_seats   integer[];
  v_subs    uuid[];
  v_mrr     integer;
  v_q       record;
  v_months  integer;
  v_count   integer;
  v_qtax    integer;
  v_per     integer;
  v_target  integer;
  v_sum     integer;
  v_diff    integer;
  v_pick    integer;
  v_all     integer;
  v_exact   numeric;
  v_line    jsonb;
  i         integer;
begin
  select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  if not found then return; end if;
  select s.id, s.tenant_id, s.quote_id, s.plan, s.seats, s.billing_cycle::text as cycle
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then return; end if;

  /* Invoiced, or not sold on a quote: itself only (as before). */
  if v_b.invoice_id is not null or v_sub.quote_id is null then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* A payment request already made for this part's group fixes the group: its lines name their
     parts (billing_id). A request without such lines (one subscription, before R-2092) keeps its
     part alone. */
  select q.id, q.line_items into v_req
    from public.quotes q
   where q.subscription_billing_id in (
           select b2.id from public.subscription_billings b2
             join public.subscriptions s2 on s2.id = b2.subscription_id
            where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id
              and b2.period_start = v_b.period_start and b2.period_end = v_b.period_end)
     and (q.subscription_billing_id = v_b.id
          or q.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text)))
     /* R-2095: a request whose invoice credit notes cancelled is spent — the freed part gets a new one. */
     and not (q.invoice_id is not null and q.invoice_id = any(v_b.credited_invoice_ids))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  if found then
    if not (v_req.line_items @> jsonb_build_array(jsonb_build_object('billing_id', v_b.id::text))) then
      return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
      return;
    end if;
    return query
      /* R-2519: a line is qty × rate (seats × a per-seat rate since R-2519; qty 1 before). */
      select b2.id, b2.subscription_id, (coalesce(nullif(l->>'qty', '')::numeric, 1) * (l->>'rate')::numeric)::integer, s2.plan, s2.seats
        from jsonb_array_elements(v_req.line_items) with ordinality as x(l, n)
        join public.subscription_billings b2 on b2.id = (l->>'billing_id')::uuid
        join public.subscriptions s2 on s2.id = b2.subscription_id
       where b2.invoice_id is null
       order by x.n;
    return;
  end if;

  /* The quote's other parts for the same period, not invoiced and without a request of their own. */
  select array_agg(g.id order by g.created_at, g.sid), array_agg(g.taxable_amount order by g.created_at, g.sid),
         array_agg(g.plan order by g.created_at, g.sid), array_agg(g.seats order by g.created_at, g.sid),
         array_agg(g.sid order by g.created_at, g.sid), sum(g.mrr)::int
    into v_ids, v_tax, v_plans, v_seats, v_subs, v_mrr
    from (select b2.id, b2.taxable_amount, s2.plan, s2.seats, s2.id as sid, s2.created_at,
                 round(coalesce(s2.mrr, 0))::int as mrr
            from public.subscription_billings b2
            join public.subscriptions s2 on s2.id = b2.subscription_id
           where s2.tenant_id = v_sub.tenant_id
             and s2.quote_id = v_sub.quote_id
             and s2.billing_cycle::text = v_sub.cycle
             and (s2.id = v_sub.id or s2.status = 'active')
             and b2.period_start = v_b.period_start
             and b2.period_end = v_b.period_end
             and b2.tax_rate is not distinct from v_b.tax_rate
             and b2.invoice_id is null
             and not exists (select 1 from public.quotes r where r.subscription_billing_id = b2.id
                               and not (r.invoice_id is not null and r.invoice_id = any(b2.credited_invoice_ids)))) g;

  if v_ids is null or array_length(v_ids, 1) <= 1 then
    return query select v_b.id, v_b.subscription_id, v_b.taxable_amount, v_sub.plan, v_sub.seats;
    return;
  end if;

  /* Rounding at quote-period level: the quote's own period taxable (quote_split_due's split),
     only when the group is every split-billed subscription of the quote and the difference is
     rounding, never a seat or price change. R-2104: "rounding" was ≤ ₹1 a line — but a part laid
     from a whole-rupee MRR is off by up to ₹0.5 a MONTH (₹1.5 a quarter) plus the quote split's
     remainder on the last part: 2 × (3 seats × ₹1,002) quarterly = ₹1,506 laid vs ₹1,503 asked,
     the sheet's ₹1,774 paid, the group's ₹1,777 "short" — no tax invoice. The test is now the
     DEAL: the group's MRR × 12 within ₹6 a subscription (an MRR's own rounding) of the quote's
     term taxable. A seat or price change moves the MRR by far more and keeps the parts as laid. */
  select q.subtotal, q.discount_pct, q.billing_cycle::text as cycle, q.line_items into v_q
    from public.quotes q where q.id = v_sub.quote_id;
  v_months := case v_q.cycle when 'monthly' then 1 when 'quarterly' then 3 when 'half_yearly' then 6 else null end;
  select count(*) into v_all from public.subscriptions s2
   where s2.tenant_id = v_sub.tenant_id and s2.quote_id = v_sub.quote_id and s2.status = 'active'
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle;
  if v_months is not null and v_q.cycle = v_sub.cycle and v_all = array_length(v_ids, 1) then
    v_qtax := round(coalesce(v_q.subtotal, 0))::int;
    v_qtax := v_qtax - round(v_qtax * coalesce(v_q.discount_pct, 0) / 100.0)::int;
    v_count := ceil(12.0 / v_months)::int;
    if v_qtax > 0 and v_count > 1 and v_b.period_index between 1 and v_count then
      v_per := floor(v_qtax::numeric / v_count)::int;
      v_target := v_per + case when v_b.period_index = v_count then v_qtax - v_per * v_count else 0 end;
      select sum(x) into v_sum from unnest(v_tax) x;
      v_diff := v_target - v_sum;
      if v_diff <> 0 and abs(v_mrr * 12 - v_qtax) <= 6 * array_length(v_ids, 1) then
        /* The line whose own share (quote line qty × rate ÷ parts) lies on the side of the
           difference; else the last line. */
        v_pick := null;
        if coalesce(v_q.discount_pct, 0) = 0 and jsonb_typeof(v_q.line_items) = 'array' then
          for i in 1 .. array_length(v_ids, 1) loop
            select l into v_line from jsonb_array_elements(v_q.line_items) l
             where l->>'name' = v_plans[i]
               and (l->>'qty') ~ '^[0-9]+(\.0+)?$' and (l->>'qty')::numeric = v_seats[i]
             limit 1;
            if v_line is not null and (v_line->>'rate') ~ '^[0-9]+(\.[0-9]+)?$' then
              v_exact := (v_line->>'qty')::numeric * (v_line->>'rate')::numeric / v_count;
              if sign(v_exact - v_tax[i]) = sign(v_diff) then v_pick := i; exit; end if;
            end if;
          end loop;
        end if;
        v_pick := coalesce(v_pick, array_length(v_ids, 1));
        v_tax[v_pick] := v_tax[v_pick] + v_diff;
      end if;
    end if;
  end if;

  return query
    select v_ids[k], v_subs[k], v_tax[k], v_plans[k], v_seats[k]
      from generate_subscripts(v_ids, 1) k order by k;
end;
$$;


-- ── 6. numbering + the part request (bodies above the line say what changed) ─────────────────
CREATE OR REPLACE FUNCTION public.next_document_number(p_doc_type text, p_tenant_id uuid DEFAULT NULL::uuid, p_on date DEFAULT NULL::date)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_caller      uuid := public.current_tenant_id();
  v_tenant_id   uuid;
  v_on          date := coalesce(p_on, public.ist_today());
  v_fy          text;
  v_prefix      text;
  v_code        text;
  v_next_number integer;
  v_trusted     boolean;
  v_doc_type    text := p_doc_type;
begin
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_caller is not null then
    if p_tenant_id is not null and p_tenant_id <> v_caller then
      raise exception 'Cannot allocate a document number for another tenant'
        using errcode = 'insufficient_privilege';
    end if;
    v_tenant_id := v_caller;
  else
    /* R-454: p_tenant_id is honoured only for trusted server paths. A signed-in user with
       no company could otherwise burn numbers in any company's invoice series (a gap in a
       GST invoice series is a compliance problem). */
    if not v_trusted then
      raise exception 'No company on this login — cannot allocate a document number'
        using errcode = '28000';
    end if;
    v_tenant_id := p_tenant_id;
  end if;

  if v_tenant_id is null then
    raise exception 'No tenant context — next_document_number requires authenticated session or explicit tenant_id';
  end if;

  if p_doc_type not in ('invoice','bill_of_supply','receipt_voucher','refund_voucher','credit_note','debit_note','quote','purchase_order','campaign','proforma') then  -- R-2519: proforma = PI series
    raise exception 'Invalid doc_type: %', p_doc_type;
  end if;

  /* R-1529: a business that is NOT GST-registered (or is under the composition scheme)
     cannot issue a Tax Invoice — it issues a Bill of Supply (CGST Rule 49), from its OWN
     series (owner decision q2: BOS-…). Every invoice path (generate_invoice, direct,
     project, milestone, subscription billing) asks for 'invoice'; routing it here means
     none of them can take an INV number for such a business, and none had to change.
     The invoices trigger tg_invoice_document_kind checks the number and the tax again. */
  if p_doc_type = 'invoice'
     and public.supplier_gst_status(v_tenant_id, v_on) in ('unregistered', 'composition') then
    v_doc_type := 'bill_of_supply';
  end if;

  /* R-015: from the DOCUMENT's date, not the clock. A document dated in one financial
     year must not take its number from another's series — that is what a GSTR-1 return
     is reconciled against. */
  v_fy     := public.indian_fiscal_year(v_on);
  v_prefix := public.default_doc_prefix(v_doc_type);

  select doc_code into v_code from public.tenants where id = v_tenant_id;
  v_code := coalesce(nullif(trim(v_code), ''), upper(substring(replace(v_tenant_id::text, '-', '') from 1 for 4)));
  /* Capped at 4 (R-015). Nothing has ever constrained tenants.doc_code, and a longer one
     would silently push the number back over the Rule 46(b) 16-character limit. 4 is what
     the uuid fallback on the line above already produces. */
  v_code := substring(v_code from 1 for 4);

  insert into public.document_series (tenant_id, doc_type, fiscal_year, prefix, last_number)
  values (v_tenant_id, v_doc_type, v_fy, v_prefix, 1)
  on conflict (tenant_id, doc_type, fiscal_year)
  do update set
    last_number = document_series.last_number + 1,
    updated_at  = now()
  returning last_number into v_next_number;

  return public.format_document_number(v_prefix || '-' || v_code, v_fy, v_next_number);
end;
$function$;


create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. R-2095 (Sept): the first part of a sale booked from a bank receipt (invoice_on_receipt) is invoiced once any money came in. R-2230: a new request is due on the part start + the payment terms (customer, else the sale quote, else 0 — prepaid, R-2044), stored on its parts (subscription_billings.due_on). R-2423: a new request's line names the product, domain, seats and period, and which part of the term it is — part_request_line_name; the old short label stays in the line's description and the notes. R-2519: a new request is a Proforma Invoice — its number comes from the PI series (next_document_number('proforma')), each line is seats × a per-seat rate when exact (as R-2101's invoice lines), it is due on the LATER of the part start and today + the terms (a part billed late is not 'due' on a past day), and paying a request whose seats / per-seat rate were changed (set_part_request_terms) puts those terms on the subscription and the part first (apply_part_request_terms), so its tax invoice bills what the proforma asked. */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_b        record;
  v_sub      record;
  v_q        record;
  v_has_q    boolean := false;
  v_first    boolean;
  v_rate     integer;
  v_tax      integer;
  v_gross    integer;
  v_country  text;
  v_req_paid boolean := false;
  v_raised   record;
  v_id       text;
  v_period   text;
  v_on_due   boolean := false;
  v_label    text;
  v_cycle    text;
  v_paid_up  boolean := false;
  v_sale     record;
  v_ids      uuid[];
  v_lead     uuid;
  v_taxable  integer;
  v_parts    integer;
  v_lines    jsonb;
  v_g        record;
  v_seats    integer;
  v_unlaid   uuid[];
  v_on_rcpt  boolean := false;
  v_terms    integer;
  v_due      date;
  v_nparts   integer;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can bill its part'
      using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can bill a subscription part' using errcode = '42501';
  end if;

  if coalesce(p_dry_run, false) then
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id;
  else
    select b.* into v_b from public.subscription_billings b where b.id = p_billing_id for update;
  end if;
  if not found then
    raise exception 'Billing part % not found', p_billing_id using errcode = 'no_data_found';
  end if;
  if v_caller is not null and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing part % is not in the caller''s company', p_billing_id using errcode = 'insufficient_privilege';
  end if;

  if v_b.invoice_id is not null then
    return jsonb_build_object('action', 'already_invoiced', 'invoice_id', v_b.invoice_id);
  end if;

  /* R-2092 siblings laid: the quote's parts of one period are billed together — so a part is
     not billed (no invoice, no request) while another active subscription of the SAME quote,
     billed in the same cycle, has no parts laid yet. Its own billing run lays them and bills the
     whole group then. Before: the billing code laid one subscription's parts and billed them
     before the next subscription's were there (a lay that failed was swallowed), and the quote's
     Q1 went out as the Starter alone (localhost, 29 Oct). A subscription whose parts can never be
     laid here (no start date, billed elsewhere for the period) does not hold the others back. */
  select array_agg(s2.id order by s2.created_at, s2.id) into v_unlaid
    from public.subscriptions s2
    join public.subscriptions me on me.id = v_b.subscription_id
   where me.quote_id is not null
     and s2.tenant_id = me.tenant_id and s2.quote_id = me.quote_id and s2.id <> me.id
     and s2.status = 'active'
     and s2.billing_cycle = me.billing_cycle
     and s2.billing_cycle is distinct from 'yearly'::billing_cycle
     and s2.start_date is not null
     and coalesce(s2.mrr, 0) > 0
     and (s2.billed_externally_until is null or s2.billed_externally_until < v_b.period_start)
     and not exists (select 1 from public.subscription_billings b3 where b3.subscription_id = s2.id);
  if v_unlaid is not null then
    return jsonb_build_object('action', 'waiting', 'reason', 'siblings_not_laid',
                              'subscription_ids', to_jsonb(v_unlaid));
  end if;

  select s.id, s.tenant_id, s.quote_id, s.customer_id, s.customer_name, s.plan, s.seats, s.domain,
         s.billing_cycle::text as cycle, s.term_months
    into v_sub from public.subscriptions s where s.id = v_b.subscription_id;
  if not found then
    raise exception 'Subscription behind billing part % no longer exists', p_billing_id using errcode = 'no_data_found';
  end if;

  /* R-2092: the group (a single part = the old behaviour). Its first part leads: a request is
     linked to it. */
  v_lines := '[]'::jsonb; v_taxable := 0; v_parts := 0; v_seats := 0;
  for v_g in select * from public.billing_part_group(p_billing_id) loop
    v_parts := v_parts + 1;
    v_ids := coalesce(v_ids, '{}'::uuid[]) || v_g.billing_id;
    v_taxable := v_taxable + v_g.taxable;
    v_seats := v_seats + coalesce(v_g.seats, 0);
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'billing_id', v_g.billing_id::text, 'plan', v_g.plan, 'seats', coalesce(v_g.seats, 0), 'taxable', v_g.taxable));
  end loop;
  if v_parts = 0 then
    v_ids := array[v_b.id]; v_taxable := v_b.taxable_amount; v_parts := 1; v_seats := coalesce(v_sub.seats, 0);
  end if;
  v_lead := v_ids[1];

  /* The group's gross, the same figure raise_subscription_billing will invoice: export → 0%. */
  select c.country, coalesce(c.invoice_parts_on_due_date, false) into v_country, v_on_due
    from public.customers c where c.id = v_sub.customer_id;
  v_rate := case when v_country is not null
                  and lower(btrim(v_country)) not in ('', 'in', 'ind', 'india', 'bharat') then 0
                 else v_b.tax_rate end;
  v_tax   := round(v_taxable * v_rate / 100.0);
  v_gross := v_taxable + v_tax;

  /* R-2095: a request already spent on an invoice that credit notes cancelled is not this period's
     request any more — its money stays in the quote's pool (instalment_credit). */
  select q.id, q.amount, q.status::text as status, q.invoice_id into v_q
    from public.quotes q where q.subscription_billing_id = any(v_ids)
     and not (q.invoice_id is not null and exists (
               select 1 from public.subscription_billings bx
                where bx.id = any(v_ids) and q.invoice_id = any(bx.credited_invoice_ids)))
   order by (q.subscription_billing_id = v_b.id) desc
   limit 1;
  v_has_q := found;
  if v_has_q then
    v_req_paid := coalesce((select sum(p.amount) from public.payments p
                             where p.quote_id = v_q.id and p.status = 'received'), 0) >= coalesce(v_q.amount, 0);
  end if;

  /* The sale quote IS the payment request of the first part of the first term. R-2048: it is
     invoiced only when money covers it (instalment_credit counts the sale quote's receipts) —
     no longer "paid by definition"; an accepted-but-unpaid sale got an unpaid tax invoice.
     R-2092: "money covers it" = the QUOTE's pool covers the GROUP — before, each subscription
     counted the sale quote's whole receipt as its own, so a short payment covered both. */
  /* R-2095: a first part whose invoice credit notes cancelled is not covered by the sale quote
     any more (that quote was spent on the cancelled invoice) — it gets its own request. */
  v_first := v_sub.quote_id is not null
             and cardinality(v_b.credited_invoice_ids) = 0
             and v_b.period_index = 1
             and v_b.term_start = (select min(b2.term_start) from public.subscription_billings b2
                                    where b2.subscription_id = v_b.subscription_id);
  v_paid_up := public.instalment_credit(v_b.subscription_id) >= v_gross;
  /* R-2095 (Sept reconcile): a sale booked from a bank receipt — its first part is invoiced on the
     first receipt even when part-paid (balance due on the invoice), like the whole-quote rule in
     bank_credit_pay_item. Staging: Suresh's half-yearly sale had money and no GST invoice. */
  v_on_rcpt := v_first and exists (
                 select 1 from public.quotes sq
                  where sq.id = v_sub.quote_id and sq.invoice_on_receipt
                    and exists (select 1 from public.payments p where p.quote_id = sq.id and p.status = 'received' and p.amount > 0));

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  if v_req_paid or v_on_due or v_paid_up or v_on_rcpt then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_on_rcpt and not v_paid_up then 'first_receipt_of_sale' when v_first then 'first_part_of_sale' else 'already_paid' end);
    end if;
    /* R-2519: the proforma's own seats / rate (changed before it was paid) go on the subscription
       and the part first, so the tax invoice bills what the customer paid. */
    if v_req_paid then
      perform public.apply_part_request_terms(v_q.id);
    end if;
    select r.* into v_raised from public.raise_subscription_billing(v_b.id) r;
    if v_has_q and v_q.invoice_id is null then
      update public.quotes
         set invoice_id = case when v_req_paid then v_raised.invoice_id else invoice_id end,
             status = case when v_req_paid then status else 'expired'::public.quote_status end,
             notes = case when v_req_paid then notes
                          else concat_ws(E'\n', nullif(notes, ''),
                                 case when v_on_due
                                      then 'Closed: the customer is invoiced on the due date — tax invoice ' || v_raised.invoice_id || '.'
                                      else 'Closed: this part was already paid another way — tax invoice ' || v_raised.invoice_id || '.' end) end
       where id = v_q.id;
    end if;
    return jsonb_build_object('action', 'invoice', 'invoice_id', v_raised.invoice_id,
      'gross', v_raised.gross, 'already_raised', v_raised.already_raised, 'parts', v_parts);
  end if;

  if v_has_q then
    return jsonb_build_object('action', 'request_open', 'quote_id', v_q.id, 'status', v_q.status, 'gross', v_gross);
  end if;
  /* R-2048: the first part of an unpaid sale — the open sale quote is what the customer pays; no
     invoice and no second request. Paying it raises this part's invoice (credit rule above). A
     closed (rejected / expired) sale quote is not a request any more → this part gets its own. */
  if v_first then
    select q.id, q.status::text as status into v_sale
      from public.quotes q where q.id = v_sub.quote_id;
    if found and v_sale.status in ('draft', 'sent', 'viewed', 'accepted') then
      return jsonb_build_object('action', 'request_open', 'quote_id', v_sale.id, 'status', v_sale.status,
                                'gross', v_gross, 'sale_quote', true);
    end if;
  end if;
  if coalesce(p_dry_run, false) then
    return jsonb_build_object('action', 'request', 'gross', v_gross, 'dry_run', true, 'parts', v_parts);
  end if;

  /* R-2230: the request's due date — the part start + the payment terms (part_request_terms_days). */
  v_terms := public.part_request_terms_days(v_b.subscription_id);
  /* R-2519: billed late (after the part began) → due from today, never a day already past. */
  v_due   := greatest(v_b.period_start, public.ist_today()) + v_terms;

  /* R-2519: a renewal part's request is a Proforma Invoice — its own PI series per financial year. */
  v_id := public.next_document_number('proforma', v_b.tenant_id);
  if v_id is null then
    raise exception 'No proforma number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Advance payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;
  /* R-2423: parts in one term (12-month term billed monthly → 12); null when it does not divide. */
  v_nparts := public.part_request_parts_in_term(v_sub.term_months, v_sub.cycle);

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    domain, created_date, expires_date, line_items, subtotal, total_cost, discount_pct, tax_rate,
    is_one_off, billing_cycle, payment_terms_days, notes, subscription_billing_id
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name,
    case when v_parts > 1 then (select string_agg(x->>'plan', ' + ' order by n) from jsonb_array_elements(v_lines) with ordinality t(x, n))
         else v_sub.plan end,
    case when v_parts > 1 then v_seats else v_sub.seats end,
    v_gross, 'sent', 'awaiting',
    /* Sent on the bill date (the period's first day); due on v_due (R-2230: part start + terms, 0 =
       that day). No expiry — it stays open until it is paid or "Customer stopped". */
    v_sub.domain, public.ist_today(), null,
    /* R-2092: one line per subscription of the group, each naming its part (billing_id) — the
       group is then fixed by the request (billing_part_group). A group of one: the old line. */
    case when v_parts > 1 then
      (select jsonb_agg(jsonb_build_object(
                'id',          'part-' || v_b.period_index::text || '-' || n::text,
                'name',        public.part_request_line_name(
                                 x->>'plan',
                                 s3.domain,
                                 coalesce((x->>'seats')::integer, 0), v_period, v_b.period_index,
                                 /* each sibling's own term (an Annual and a Flexible line differ) */
                                 public.part_request_parts_in_term(s3.term_months, s3.billing_cycle::text)),
                'description', v_label,
                /* R-2519: seats × per-seat rate when exact (r2101_part_line's rule). */
                'qty',         case when public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer)
                                    then (x->>'seats')::integer else 1 end,
                'rate',        case when public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer)
                                    then (x->>'taxable')::integer / (x->>'seats')::integer else (x->>'taxable')::integer end,
                'per_seat',    public.r2519_per_seat(coalesce((x->>'seats')::integer, 0), (x->>'taxable')::integer),
                'period_start', b4.period_start,
                'period_end',   b4.period_end - 1,
                'cost',        0,
                'one_time',    true,
                'billing_id',  x->>'billing_id') order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n)
         left join public.subscription_billings b4 on b4.id = (x->>'billing_id')::uuid
         left join public.subscriptions s3 on s3.id = b4.subscription_id)
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        public.part_request_line_name(v_sub.plan, v_sub.domain, coalesce(v_sub.seats, 0), v_period, v_b.period_index, v_nparts),
        'description', v_label,
        'qty',         case when public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount) then v_sub.seats else 1 end,
        'rate',        case when public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount)
                            then v_b.taxable_amount / v_sub.seats else v_b.taxable_amount end,
        'per_seat',    public.r2519_per_seat(coalesce(v_sub.seats, 0), v_b.taxable_amount),
        'period_start', v_b.period_start,
        'period_end',   v_b.period_end - 1,
        'cost',        0,
        'one_time',    true))
    end,
    v_taxable, 0, 0, v_rate,
    true, 'yearly', v_terms,
    v_label || '. Due on ' || to_char(v_due, 'FMDD Mon YYYY') || '. The tax invoice is issued when this is paid.',
    v_lead
  );
  /* R-2230: every part of the request carries its due date. */
  update public.subscription_billings set due_on = v_due, updated_at = now()
   where id = any(v_ids) and due_on is null;
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts, 'due_on', v_due);
end;
$$;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;

commit;
