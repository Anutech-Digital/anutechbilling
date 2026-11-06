-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2519b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.apply_part_request_terms(text)') and prosrc like '%R-2519b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.cancel_quote(text,text)') and prosrc like '%R-2519b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_open_balance(text)') and prosrc like '%R-2519b%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_quotes_proforma_columns_guarded()') and prosrc like '%R-2519b%')
-- deploy-key: r2519bproformafollowup
-- 20261106074318_r2519b_proforma_followup.sql
--
-- R-2519 follow-up — the independent review (card R-2519 independentReview v9) said BLOCK.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────
--   1. BLOCKER: trg_quotes_proforma_columns_guarded is now BEFORE INSERT OR UPDATE. A signed-in user
--      can no longer INSERT a quote carrying subscription_billing_id / proforma_* / cancelled_* (a
--      sales user set a subscription to 1 seat / ₹1 MRR that way, and could plant a fake "cancelled"
--      row for an owner's Undo). Only server code passes (definer functions, service role, direct DB).
--      New marker quotes.proforma_terms_set_at / _by, written only by set_part_request_terms;
--      apply_part_request_terms applies only marked terms.
--   2. HIGH: cancel_quote frees only the LATEST billed period of a subscription (a later period with
--      a proforma or tax invoice → "cancel the later one(s) first"). The app re-bills a freed
--      period on THAT billing row (generate-renewal-quote → bill_subscription_instalment(row)).
--   3. MEDIUM (coordinator): a part that has not begun is billed ahead as a proforma only — never a
--      tax invoice (not for "invoice on due date", not from credit) unless that proforma is paid.
--   4. LOW: Mark rejected / expired on an accepted proforma whose seats were applied → refused (as
--      Cancel); quote_open_balance of a cancelled quote is 0 (body of 20261019162652 R-1686, plus that; its
--      trusted check uses the R-2487 current_request_role() form the auth-shim scan requires).
-- Bodies: set_part_request_terms, apply_part_request_terms, cancel_quote, bill_subscription_instalment,
-- tg_quotes_cancelled_stays_closed from 20261106065103 (R-2519); only the lines named above change.
-- Test: supabase/tests/r2519b_proforma_followup.test.sql (one transaction, rolled back).

begin;

alter table public.quotes add column if not exists proforma_terms_set_at timestamptz;
alter table public.quotes add column if not exists proforma_terms_set_by uuid;
/* Terms set under R-2519 (before this marker) are the function's own writes — mark them. */
update public.quotes set proforma_terms_set_at = now()
 where proforma_seats is not null and proforma_terms_set_at is null;
comment on column public.quotes.proforma_terms_set_at is
  'R-2519b: when set_part_request_terms wrote proforma_seats / proforma_seat_rate — apply_part_request_terms applies only marked terms.';

create or replace function public.tg_quotes_proforma_columns_guarded()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2519b (independent review, BLOCK): INSERT too. A signed-in user could INSERT a quote already
     carrying subscription_billing_id + proforma seats (or a fake cancelled row) and accept it. Only
     server code writes these columns: a SECURITY DEFINER function (current_user is its owner), the
     service role, or a direct DB session. A client request is a direct request login
     (public.is_direct_request_login, R-2485). No settable flag is trusted — any session can SET one. */
  if coalesce(public.current_request_role(), '') = 'service_role'
     or not public.is_direct_request_login() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.proforma_seats is not null or new.proforma_seat_rate is not null
       or new.proforma_terms_applied_at is not null or new.proforma_terms_set_at is not null or new.proforma_terms_set_by is not null
       or new.cancelled_at is not null or new.cancelled_by is not null or new.cancel_reason is not null
       or new.cancelled_from_status is not null or new.cancelled_payment_status is not null
       or new.cancelled_part_billing_id is not null or new.subscription_billing_id is not null then
      raise exception 'A proforma for a subscription part is made only by Bill next part — these fields cannot be set by hand.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.proforma_seats is distinct from old.proforma_seats
     or new.proforma_seat_rate is distinct from old.proforma_seat_rate
     or new.proforma_terms_applied_at is distinct from old.proforma_terms_applied_at
     or new.proforma_terms_set_at is distinct from old.proforma_terms_set_at
     or new.proforma_terms_set_by is distinct from old.proforma_terms_set_by
     or new.cancelled_at is distinct from old.cancelled_at
     or new.cancelled_by is distinct from old.cancelled_by
     or new.cancel_reason is distinct from old.cancel_reason
     or new.cancelled_from_status is distinct from old.cancelled_from_status
     or new.cancelled_payment_status is distinct from old.cancelled_payment_status
     or new.cancelled_part_billing_id is distinct from old.cancelled_part_billing_id
     or new.subscription_billing_id is distinct from old.subscription_billing_id then
    raise exception 'These proforma fields change only through Bill next part, Cancel or Undo cancel.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_quotes_proforma_columns_guarded() from public, anon, authenticated;
drop trigger if exists trg_quotes_proforma_columns_guarded on public.quotes;
create trigger trg_quotes_proforma_columns_guarded
  before insert or update on public.quotes
  for each row execute function public.tg_quotes_proforma_columns_guarded();


create or replace function public.set_part_request_terms(p_quote_id text, p_seats integer, p_seat_rate integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519b: writes the server marker (proforma_terms_set_at). R-2519: change an unpaid single-subscription proforma to p_seats × ₹p_seat_rate. The subscription
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
  /* A customer invoiced on the due date gets the part's tax invoice then, paid or not — a seat
     change on the proforma would be lost there. Change the seats from Manage seats instead. */
  if exists (select 1 from public.customers c where c.id = v_q.customer_id and coalesce(c.invoice_parts_on_due_date, false)) then
    raise exception 'This customer is invoiced on the due date, so the proforma''s seats cannot change here — use Manage seats.'
      using errcode = '22023';
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
  perform set_config('app.r2519_write', 'on', true);
  update public.quotes
     set line_items = jsonb_build_array(v_line),
         seats = p_seats,
         subtotal = v_taxable,
         amount = v_taxable + v_tax,
         proforma_seats = p_seats,
         proforma_seat_rate = p_seat_rate,
         /* R-2519b: the marker apply_part_request_terms requires — only this function writes it. */
         proforma_terms_set_at = now(),
         proforma_terms_set_by = auth.uid()
   where id = v_q.id;
  perform set_config('app.r2519_write', '', true);
  return jsonb_build_object('quote_id', v_q.id, 'seats', p_seats, 'seat_rate', p_seat_rate,
                            'taxable', v_taxable, 'amount', v_taxable + v_tax);
end;
$$;

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
  v_taxable integer;
begin
  /* R-2519b (independent review): only terms set_part_request_terms wrote (its marker) are applied. */
  select q.id, q.tenant_id, q.proforma_seats, q.proforma_seat_rate, q.subscription_billing_id, q.proforma_terms_set_at
    into v_q from public.quotes q where q.id = p_quote_id;
  if not found or v_q.proforma_seats is null or v_q.proforma_seat_rate is null or v_q.subscription_billing_id is null
     or v_q.proforma_terms_set_at is null then
    return false;
  end if;
  /* The amount comes from the two guarded columns (only set_part_request_terms writes them —
     trg_quotes_proforma_columns_guarded), never from the editable subtotal. */
  v_taxable := v_q.proforma_seats * v_q.proforma_seat_rate;
  /* Same company only: the part and its subscription must be the quote's company's. */
  select b.* into v_b from public.subscription_billings b
   where b.id = v_q.subscription_billing_id and b.tenant_id = v_q.tenant_id for update;
  if not found then return false; end if;
  select s.id, s.seats, s.mrr, s.term_amount, s.term_months, s.billing_cycle::text as cycle
    into v_s from public.subscriptions s
   where s.id = v_b.subscription_id and s.tenant_id = v_q.tenant_id for update;
  if not found then return false; end if;
  if v_b.invoice_id is null and v_b.taxable_amount is distinct from v_taxable then
    update public.subscription_billings
       set taxable_amount = v_taxable, updated_at = now()
     where id = v_b.id and invoice_id is null;
  end if;
  v_months := case v_s.cycle when 'monthly' then 1 when 'quarterly' then 3
                             when 'half_yearly' then 6 when 'yearly' then 12 else 1 end;
  /* MRR = the part's taxable ÷ its months (18 × ₹300 a month → ₹5,400). */
  v_mrr := round(v_taxable::numeric / v_months)::integer;
  v_parts := public.part_request_parts_in_term(v_s.term_months, v_s.cycle);
  if v_s.seats is distinct from v_q.proforma_seats or v_s.mrr is distinct from v_mrr then
    perform set_config('app.amendment_note',
      'R-2519: proforma ' || v_q.id || ' — ' || v_q.proforma_seats || ' seats at ₹' || coalesce(v_q.proforma_seat_rate, 0) || ' a seat', true);
    update public.subscriptions
       set seats = v_q.proforma_seats,
           mrr = v_mrr,
           /* R-2369's exact term amount follows the new part amount (N parts in the term). */
           term_amount = case when term_amount is null or v_parts is null then term_amount
                              else v_taxable * v_parts end
     where id = v_s.id;
  end if;
  perform set_config('app.r2519_write', 'on', true);
  update public.quotes set proforma_terms_applied_at = coalesce(proforma_terms_applied_at, now()) where id = v_q.id;
  perform set_config('app.r2519_write', '', true);
  return true;
end;
$$;

create or replace function public.cancel_quote(p_quote_id text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2519b: refused while a later period's proforma is open. R-2519: cancel an unpaid quote / proforma. The subscription is not touched. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_reason  text := nullif(btrim(coalesce(p_reason, '')), '');
  v_later   text;
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
  /* R-2519b: only the LATEST billed period of a subscription is freed. With a later period billed
     (a proforma, paid or not, or its tax invoice) the billing job — which bills only the current
     term — would never bill the freed earlier one again. */
  if v_q.subscription_billing_id is not null then
    select string_agg(coalesce(q2.id, b2.invoice_id), ', ' order by b2.period_start) into v_later
      from public.subscription_billings b
      join public.subscription_billings b2 on b2.subscription_id = b.subscription_id and b2.period_start > b.period_start
      left join public.quotes q2 on q2.subscription_billing_id = b2.id and q2.tenant_id = v_q.tenant_id
     where b.id = v_q.subscription_billing_id
       and (q2.id is not null or b2.invoice_id is not null);
    if v_later is not null then
      raise exception 'A later period of this subscription is already billed (%) — cancel the later proforma(s) first; a paid or invoiced later period needs a credit note, not a cancel here.', v_later
        using errcode = '22023';
    end if;
  end if;
  if coalesce(v_q.is_add_seats, false) then
    raise exception 'Quote % added seats to a subscription — use Mark rejected, which also takes those seats back.', v_q.id
      using errcode = '22023';
  end if;
  /* Accepted with a seat change → those seats are already on the subscription (apply_part_request_terms). */
  if v_q.proforma_terms_applied_at is not null then
    raise exception 'Proforma % was accepted and its % seats are already on the subscription — change the seats from Manage seats, or record the payment.',
      v_q.id, v_q.proforma_seats using errcode = '22023';
  end if;

  perform set_config('app.r2519_write', 'on', true);
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
  perform set_config('app.r2519_write', '', true);
  /* The part(s) are free to be billed again — their due date was this request's (a group request
     names every part on its lines: billing_id). */
  if v_q.subscription_billing_id is not null then
    update public.subscription_billings
       set due_on = null, request_reminder_step = null, updated_at = now()
     where invoice_id is null and tenant_id = v_q.tenant_id
       and (id = v_q.subscription_billing_id
            or id::text in (select l->>'billing_id' from jsonb_array_elements(coalesce(v_q.line_items, '[]'::jsonb)) l
                             where l ? 'billing_id'));
  end if;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_q.tenant_id, (select u.id from public.users u where u.id = auth.uid()),
          'quote.cancelled', 'quote', v_q.id,
          left(format('Cancelled %s — %s', v_q.id, v_reason), 120),
          jsonb_build_object('status', jsonb_build_object('from', v_q.status::text, 'to', 'cancelled'), 'reason', v_reason));

  return jsonb_build_object('quote_id', v_q.id, 'status', 'cancelled', 'part_released', v_q.subscription_billing_id is not null);
end;
$$;

create or replace function public.tg_quotes_cancelled_stays_closed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  /* R-2519, R-2519b */
  if old.cancelled_at is not null and new.cancelled_at is not null
     and new.status::text is distinct from old.status::text then
    raise exception 'Quote % was cancelled — use Undo cancel to reopen it.', old.id using errcode = '22023';
  end if;
  /* R-2519b: closing (rejected / expired) an accepted proforma whose seats are already on the
     subscription, with no invoice, would leave those seats unpaid — refused, as Cancel refuses it. */
  /* Only a client's own status change (Mark rejected) — the billing code closes a proforma it just
     invoiced from credit ('paid another way') and Customer stopped ends the subscription itself. */
  if public.is_direct_request_login()
     and new.status::text in ('rejected', 'expired') and old.status::text not in ('rejected', 'expired')
     and old.proforma_terms_applied_at is not null and old.invoice_id is null and new.invoice_id is null then
    raise exception 'Proforma % was accepted and its % seats are already on the subscription — record the payment, or change the seats from Manage seats first.',
      old.id, old.proforma_seats using errcode = '22023';
  end if;
  return new;
end;
$$;

create or replace function public.quote_open_balance(p_quote_id text)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q        record;
  v_caller   uuid;
  v_trusted  boolean;
  v_received integer;
begin
  /* R-454 / §17c: fail closed for a login with no company. R-2519b: a cancelled quote owes nothing. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;

  select q.id, q.tenant_id, q.amount, q.cancelled_at into v_q from public.quotes q where q.id = p_quote_id;
  if not found then return null; end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id using errcode = 'insufficient_privilege';
  end if;
  if v_q.cancelled_at is not null then
    return 0;
  end if;

  if exists (select 1 from public.invoices i
              where i.tenant_id = v_q.tenant_id and i.quote_id = p_quote_id and i.status <> 'void') then
    -- Same sum as activate_quote_on_credit's credit exposure and lib/credit owedOnInvoices.
    return (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::int
              from public.invoices i
             where i.tenant_id = v_q.tenant_id and i.quote_id = p_quote_id
               and i.status in ('pending', 'overdue'));
  end if;

  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p
   where p.tenant_id = v_q.tenant_id and p.quote_id = p_quote_id and p.status = 'received';
  return greatest(0, coalesce(v_q.amount, 0) - v_received)::int;
end;
$$;


create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. R-2095 (Sept): the first part of a sale booked from a bank receipt (invoice_on_receipt) is invoiced once any money came in. R-2230: a new request is due on the part start + the payment terms (customer, else the sale quote, else 0 — prepaid, R-2044), stored on its parts (subscription_billings.due_on). R-2423: a new request's line names the product, domain, seats and period, and which part of the term it is — part_request_line_name; the old short label stays in the line's description and the notes. R-2519b: a part not begun yet is billed as a proforma only (no tax invoice ahead); the request insert sets the guard flag. R-2519: a new request is a Proforma Invoice — its number comes from the PI series (next_document_number('proforma')), each line is seats × a per-seat rate when exact (as R-2101's invoice lines), it is due on the LATER of the part start and today + the terms (a part billed late is not 'due' on a past day), and paying a request whose seats / per-seat rate were changed (set_part_request_terms) puts those terms on the subscription and the part first (apply_part_request_terms), so its tax invoice bills what the proforma asked. */
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
  /* R-2519: a proforma whose seats / rate were changed asks its OWN amount — credit covers the part
     only when it covers that (the part's laid amount is the old seats until it is paid). */
  if v_has_q and exists (select 1 from public.quotes pq where pq.id = v_q.id and pq.proforma_seats is not null) then
    v_paid_up := public.instalment_credit(v_b.subscription_id) >= coalesce(v_q.amount, 0);
  end if;
  /* R-2095 (Sept reconcile): a sale booked from a bank receipt — its first part is invoiced on the
     first receipt even when part-paid (balance due on the invoice), like the whole-quote rule in
     bank_credit_pay_item. Staging: Suresh's half-yearly sale had money and no GST invoice. */
  v_on_rcpt := v_first and exists (
                 select 1 from public.quotes sq
                  where sq.id = v_sub.quote_id and sq.invoice_on_receipt
                    and exists (select 1 from public.payments p where p.quote_id = sq.id and p.status = 'received' and p.amount > 0));

  /* v_on_due: the customer's "Invoice on due date" switch — the old path, a tax invoice on the
     bill date even if unpaid (chased by invoice-dunning). */
  /* R-2519b (coordinator): a period that has not begun is billed AHEAD — only a proforma, never a tax
     invoice (not for an 'invoice on due date' customer, not from credit). Its tax invoice comes when
     the proforma is paid, or on its real date (the billing job). */
  if v_b.period_start > public.ist_today() and not v_req_paid then
    /* Already covered by the customer's money: no proforma asking for it again and no invoice ahead —
       the billing job invoices it on its date. */
    if v_paid_up and not v_has_q then
      return jsonb_build_object('action', 'waiting', 'reason', 'paid_ahead', 'subscription_ids', '[]'::jsonb,
                                'gross', v_gross, 'bill_on', v_b.bill_on);
    end if;
    v_on_due := false; v_paid_up := false; v_on_rcpt := false;
  end if;

  if v_req_paid or v_on_due or v_paid_up or v_on_rcpt then
    if coalesce(p_dry_run, false) then
      return jsonb_build_object('action', 'invoice', 'gross', v_gross, 'dry_run', true, 'parts', v_parts,
        'reason', case when v_req_paid then 'request_paid' when v_on_due then 'invoice_on_due_date'
                       when v_on_rcpt and not v_paid_up then 'first_receipt_of_sale' when v_first then 'first_part_of_sale' else 'already_paid' end);
    end if;
    /* R-2519: the proforma's own seats / rate (changed before it was paid) go on the subscription
       and the part first, so the tax invoice bills what the customer paid. */
    if v_has_q and (v_req_paid or v_paid_up) then
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

  /* R-2519b: the guard (trg_quotes_proforma_columns_guarded) lets only server code make a part request. */
  perform set_config('app.r2519_write', 'on', true);
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
  perform set_config('app.r2519_write', '', true);
  /* R-2230: every part of the request carries its due date. */
  update public.subscription_billings set due_on = v_due, updated_at = now()
   where id = any(v_ids) and due_on is null;
  return jsonb_build_object('action', 'request', 'quote_id', v_id, 'created', true, 'gross', v_gross, 'label', v_label, 'parts', v_parts, 'due_on', v_due);
end;
$$;

revoke all on function public.apply_part_request_terms(text) from public, anon, authenticated;
grant execute on function public.apply_part_request_terms(text) to service_role;
revoke all on function public.set_part_request_terms(text, integer, integer) from public, anon;
grant execute on function public.set_part_request_terms(text, integer, integer) to authenticated, service_role;
revoke all on function public.cancel_quote(text, text) from public, anon;
grant execute on function public.cancel_quote(text, text) to authenticated, service_role;
revoke all on function public.bill_subscription_instalment(uuid, boolean) from public, anon;
grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;
revoke all on function public.tg_quotes_cancelled_stays_closed() from public, anon, authenticated;

commit;
