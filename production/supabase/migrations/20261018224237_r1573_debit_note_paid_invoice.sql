-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_debit_note(text,integer,text,text,text)') and prosrc like '%R-1573%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%R-1573%')
-- deploy-key: r1573dnpaid
-- 20261018224237_r1573_debit_note_paid_invoice.sql
--
-- R-1573 (P2 money, audit 18 Oct 2026): a debit note (late interest, an extra charge) on a PAID
-- invoice was never chased, and when the customer paid it the money became customer credit.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   issue_debit_note (20261018171947_r1563_credit_note_refund.sql:337-338) only raises
--     invoices.net_payable — status stays 'paid'. invoiceAmountDue
--     (src/lib/payments/amount-due.ts:48) returns 0 for a paid invoice, so Invoices, Aging,
--     /collections and dunning all show ₹0 due. The Trial Balance moved too: revenue + output
--     GST went up by the note, receivables did not (tb_money_events_balanced 6k: −₹1,180).
--   record_payment (20261018162355_r1574_renewal_quote_once.sql:851) skips a paid invoice, and
--     :906-907 makes everything above quotes.amount an overpayment credit — the interest the
--     customer paid became redeemable credit and the debit note stayed unpaid.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   (1) issue_debit_note on a PAID invoice → status 'pending', paid_date null, paid_amount =
--       the invoice's net_payable before the note (what was settled in the R-015 / R-1561
--       convention due = net_payable − paid_amount). Amount due = exactly the note. An older
--       paid invoice with paid_amount 0 (advance-adjusted, or marked paid before R-015) is
--       therefore not asked for its whole value again; an overpaid one does not hide the note
--       behind money that is already the customer's credit. Overdue is derived from due_date
--       (src/lib/invoices/overdue.ts) — no 'overdue' write here. Result: + invoice_reopened.
--   (2) record_payment on a quote whose invoice has debit notes: the money owed is
--       quotes.amount + the debit notes, and the overpayment credit is only what goes past that
--       less the overpayment credit this quote's payments already made (the same rows the
--       balance sheet nets in advances_from_customers). Paying the note settles the invoice
--       (the existing paid_amount / status branch); nothing becomes credit unless more than the
--       note comes in. Credit notes are NOT taken off here: issue_credit_note_core already made
--       their excess a credit row (R-1566), and their effect on the invoice is in net_payable.
--       A quote without debit notes keeps the old incremental formula exactly.
--   Bodies: issue_debit_note = R-1566 body (20261018171947), record_payment = R-1574 body
--   (20261018162355) — only the R-1573 parts differ.
--
-- Test: supabase/tests/r1573_debit_note_paid_invoice.test.sql, tb_money_events_balanced 6j-6l.

begin;

CREATE OR REPLACE FUNCTION public.issue_debit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv           record;
  v_is_service    boolean;
  v_caller_tenant uuid;
  v_rate          integer;
  v_taxable       integer;
  v_tax           integer;
  v_dn_id         text;
  v_new_net       integer;
  v_reopened      boolean := false;  -- R-1573
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can issue a debit note' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Debit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state, i.status
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  /* R-1566: a debit note adds to an ISSUED invoice (CGST s.34(3)). */
  if v_inv.status in ('draft', 'void') then
    raise exception 'Invoice % is % — a debit note is only for an issued invoice. %', p_invoice_id, v_inv.status,
      case when v_inv.status = 'draft' then 'Change the draft instead.' else 'Raise a new invoice instead.' end
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id, public.ist_today());
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := coalesce(v_inv.net_payable, v_inv.amount) + p_gross_amount;
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  /* R-1573: a PAID invoice owes the note now — Pending, so Invoices / Aging / Collections /
     dunning ask for it and record_payment settles it. paid_amount = what was settled before
     the note (the old net_payable), so due = net_payable − paid_amount = the note: never the
     whole invoice again (an advance-adjusted or pre-R-015 paid invoice has paid_amount 0),
     and an overpayment already given as customer credit is not counted twice. */
  if v_inv.status = 'paid' then
    update public.invoices
       set status      = 'pending'::invoice_status,
           paid_date   = null,
           paid_amount = greatest(0, coalesce(v_inv.net_payable, v_inv.amount)),
           updated_at  = now()
     where id = p_invoice_id;
    v_reopened := true;
  end if;

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net,
    'invoice_reopened', v_reopened
  );
end;
$function$;

comment on function public.issue_debit_note(text, integer, text, text, text) is
  'CGST s.34(3) debit note on an issued invoice (R-1566: not draft/void). Raises net_payable; R-1573: a Paid invoice goes back to Pending with the note as the amount due. Owner/manager/accountant/billing.';

revoke all on function public.issue_debit_note(text, integer, text, text, text) from public, anon;
grant execute on function public.issue_debit_note(text, integer, text, text, text) to authenticated, service_role;

-- ── record_payment — R-1574 body + R-1573 debit notes in what is owed ─────────────────
CREATE OR REPLACE FUNCTION public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote                 record;
  v_tenant_id             uuid;
  v_caller_tenant         uuid;
  v_is_service_role       boolean;
  v_has_existing_invoice  boolean;
  v_receipt_voucher_no    text := null;
  v_payment_id            uuid;
  v_prior_received        integer;
  v_total_received        integer;
  v_expected              integer;
  v_outstanding           integer;
  v_overpaid_credit       integer := 0;
  v_is_first_payment      boolean;
  v_is_fully_paid         boolean;
  v_new_payment_status    public.payment_status;
  v_customer_id           uuid;
  v_converted_now         boolean := false;
  v_lead                  record;
  v_domain                text;
  v_subscription_created  boolean := false;
  v_new_sub_id            uuid;
  v_first_line            jsonb;
  v_commitment            text;
  v_is_annual             boolean;
  v_is_monthly            boolean;
  v_plan_name             text;
  v_plan_lower            text;
  v_vendor                public.vendor;
  v_seats                 integer;
  v_is_renewal_quote      boolean := false;
  v_renewal_sub           record;
  v_r1574_link_lost       boolean := false;  -- R-1574
  v_renewal_rolled_forward boolean := false;
  v_extension_months      integer;
  v_new_mrr               integer;
  v_invoice               record;
  v_already_adjusted      integer;
  v_post_invoice_received integer;
  v_net_due               integer;
  v_invoice_paid          boolean := false;
  v_po_id                 text := null;
  v_po_created            boolean := false;
  v_unit_wholesale_pm     integer;
  v_total_wholesale       integer;
  v_po_seats              integer;
  v_po_months             integer;
  v_po_plan               text;
  v_po_vendor             public.vendor;
  v_po_sub_id             uuid;
  v_was_trial             boolean := false;
  v_existing_payment      record;
  v_is_add_seats          boolean := false;
  v_has_bulk              boolean := false;
  v_bulk_total_seats      integer;
  v_bulk_pool             integer;
  v_running_mrr           integer;
  v_dom_mrr               integer;
  v_dom_seats             integer;
  v_dom                   text;
  v_idx                   integer;
  v_n                     integer;
  v_d                     jsonb;
  v_bulk_count            integer := 0;
  v_start                 date;
  -- 0172: multi-line-item support
  v_line_idx              integer;
  v_line_amount           integer;
  -- R-329: what the line's subscription renews at (qty x renewal_rate), else v_line_amount.
  v_renew_amount          integer;
  v_first_sub_in_quote    boolean := true;
  -- Only domain/Workspace-type products are meaningfully tied to a single
  -- domain; a quote mixing e.g. a support plan + a hosting plan has no
  -- per-line domain of its own, so both would otherwise fall back to the
  -- SAME customer domain and collide against
  -- subscriptions_tenant_quote_domain_unique (tenant_id, quote_id,
  -- lower(domain)). Track domains already used THIS call and null out any
  -- repeat instead of erroring or silently dropping the subscription.
  v_used_domains          text[] := array[]::text[];
  v_sub_domain            text;
  -- R-829: a line's OWN typed domain is kept even when another line of the quote has it
  -- (Starter + Business Standard on one domain). Only the same domain AND the same plan
  -- clash; such a line is listed in domain_conflicts in the result, never dropped silently.
  v_own_domain            boolean;
  v_used_domain_plans     text[] := array[]::text[];
  v_domain_conflicts      jsonb := '[]'::jsonb;
  -- R-346: the quote already has its subscriptions (activated on credit, or recreated).
  v_quote_subs_exist      boolean := false;
  -- R-378: the line's cost as ₹/seat/month → subscriptions.vendor_cost_per_seat_month.
  v_cost_pm               integer;
  -- R-1573: debit notes on the quote's invoice (owed on top of quotes.amount), and the
  -- overpayment credit this quote's payments already made.
  v_r1573_debits          integer := 0;
  v_r1573_credited        integer := 0;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  v_is_service_role := auth.role() = 'service_role';
  if not v_is_service_role then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then
      raise exception 'No tenant context';
    end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'amount must be > 0'; end if;
  if p_method is null or p_method not in ('upi','razorpay','bank_transfer','cheque','cash','other')
    then raise exception 'invalid payment method: %', p_method; end if;
  if p_reference is null or length(trim(p_reference)) = 0 then raise exception 'reference required'; end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id,
         q.amount, q.line_items, q.invoice_id, q.payment_status,
         q.domain, q.extension_months, q.is_add_seats, q.subtotal, q.is_one_off, q.is_extension,
         q.prospect_state_code, q.prospect_state, q.prospect_country,
         q.renewal_subscription_id, q.renewal_term_date  -- R-1574
    into v_quote
    from public.quotes q
   where q.id = p_quote_id for update;
  if not found then raise exception 'quote % not found', p_quote_id; end if;
  if not v_is_service_role and v_quote.tenant_id <> v_caller_tenant then
    raise exception 'quote % does not belong to your tenant', p_quote_id;
  end if;

  select p.id, p.receipt_voucher_no, p.customer_id
    into v_existing_payment
    from public.payments p
   where p.tenant_id = v_quote.tenant_id
     and p.quote_id  = p_quote_id
     and p.reference = p_reference
     and p.status    = 'received'
   limit 1;
  if found then
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_expected    := coalesce(v_quote.amount, 0);
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end if;

  v_tenant_id            := v_quote.tenant_id;
  v_has_existing_invoice := v_quote.invoice_id is not null;
  v_expected             := coalesce(v_quote.amount, 0);
  v_domain               := v_quote.domain;
  /* Default to the TERM of the subscription being renewed, not a hard 12. A monthly
     subscription renewed with a plain renewal quote was being pushed a YEAR forward, so
     it would never be chased again and its MRR would keep counting for twelve months of
     service nobody had sold. Falls back to 12 when there is no subscription in hand
     (a new sale), which is where the old constant was right. */
  /* Left deliberately NULL when the quote does not say. The term of the subscription
     being renewed is not known yet — v_renewal_sub is selected below — and reading an
     unassigned RECORD raises 55000 for every payment, renewal or not. Resolved right
     after that select. */
  v_extension_months     := v_quote.extension_months;
  v_is_add_seats         := coalesce(v_quote.is_add_seats, false);
  v_has_bulk := exists (
    select 1
      from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce((li->>'bulk')::boolean, false)
  );

  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;

  /* R-1574: a renewal quote whose link was lost (a second quote overwrote it, or the link was
     never written) used to fall through to the NEW-SALE path below — a second subscription
     was created and the subscription it was made for was not renewed. A quote made by
     create_renewal_quote names the subscription term it renews: while that term is still the
     open one it IS that renewal. When the term has moved on, the first payment is refused
     with the next step rather than opening a duplicate subscription. Quotes made before
     R-1574 carry no term and behave exactly as before. */
  if not v_is_renewal_quote and v_quote.renewal_subscription_id is not null then
    select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
      into v_renewal_sub
      from public.subscriptions s
     where s.tenant_id = v_tenant_id
       and s.id = v_quote.renewal_subscription_id
     for update;
    if found then
      if v_renewal_sub.renewal_date is not distinct from v_quote.renewal_term_date then
        v_is_renewal_quote := true;
        v_r1574_link_lost  := true;
      elsif not exists (select 1 from public.payments
                         where quote_id = p_quote_id and status = 'received') then
        raise exception 'Renewal quote % was made for the term of subscription "%" due on %, but that subscription now renews on % — that term was already renewed (or its date was changed), so this payment would renew nothing. Nothing was recorded. Open the subscription and record the money on its current renewal quote%, or record it as customer credit.',
          p_quote_id, v_renewal_sub.plan, v_quote.renewal_term_date, v_renewal_sub.renewal_date,
          coalesce(' (' || (select s2.renewal_quote_id from public.subscriptions s2 where s2.id = v_renewal_sub.id) || ')', '')
          using errcode = 'P0001';
      end if;
    end if;
  end if;

  /* Now the term IS known. Default to the term of the subscription being renewed rather
     than a hard 12: renewing a MONTHLY subscription used to push its renewal date twelve
     months out, so it was never chased again and its MRR counted for a year of service
     nobody had sold. Falls back to 12 for a new sale, where no subscription exists and the
     old constant was right. */
  if v_extension_months is null then
    v_extension_months := coalesce(case when v_is_renewal_quote then v_renewal_sub.term_months end, 12);
  end if;

  select coalesce(sum(amount), 0) into v_prior_received
    from public.payments where quote_id = p_quote_id and status = 'received';
  v_is_first_payment := (v_prior_received = 0);

  /* #27 (migrations 0060/0061), lost from this function and re-added 22 Aug 2026.
     A quote with no amount has nothing to pay. Without this, paying ₹5,000 against a
     ₹0 quote recorded the payment, marked the quote received, and created an mrr=0
     subscription — a live customer with a subscription worth nothing, which then
     enters the renewal cadence and is invoiced for ₹0.

     Placed AFTER the idempotency replay above, deliberately: a quote that WAS priced,
     was paid, and was later edited to 0 must still replay idempotently rather than
     start throwing at a webhook that already succeeded. Only a NEW payment is refused. */
  if coalesce(v_quote.amount, 0) <= 0 then
    raise exception 'Quote % has no amount, so a payment cannot be recorded against it. Set the quote total first, then record the payment.', p_quote_id;
  end if;

  v_customer_id := v_quote.customer_id;
  if v_is_first_payment and v_quote.lead_id is not null and v_quote.customer_id is null then
    select l.contact_name, l.contact_email, l.contact_phone, l.company, l.notes, l.domain, l.stage,
           l.state_code, l.state, l.gstin
      into v_lead from public.leads l
     where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if not found then raise exception 'lead % not found', v_quote.lead_id; end if;
    if v_domain is null then v_domain := v_lead.domain; end if;
    v_was_trial := (v_lead.stage = 'trial');

    /* Dedup (migrations 0064/0065), lost from this function and re-added 22 Aug 2026.
       The lead is a fresh row but the company may already be a customer — the same
       business enquiring a second time, or a renewal that came in as a new lead. This
       used to insert unconditionally, so that company got a SECOND customer row, and
       then a second subscription and a second invoice series against the same buyer.

       Matched on contact_email, case-insensitively and tenant-scoped. Email only:
       company NAME is not an identity (a short trade name vs the full registered name)
       and matching on it would merge two genuinely different customers, which is the
       worse error of the two — a wrongly-merged customer is far harder to unpick than
       a duplicate. No email on the lead means no match, and a new customer is created. */
    /* R-137 (3 Oct 2026): email alone merged different businesses that shared one
       inbox — every test quote on the owner's own address landed on one customer
       (one customer collected 64 quotes, Rs 3.9L of payments). Now: same GSTIN, or
       same email AND a matching name (match_existing_customer). The rule above still
       holds — when unsure, a duplicate is the lesser error. */
    v_customer_id := public.match_existing_customer(v_tenant_id, v_lead.contact_email, v_lead.gstin, v_lead.company);

    if v_customer_id is null then
      insert into public.customers (tenant_id, name, contact_name, contact_email, contact_phone, domain, since, health, notes, state_code, state, gstin)
      values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, current_date,
              case when p_amount >= v_expected then 85 else 75 end, v_lead.notes, v_lead.state_code, v_lead.state, v_lead.gstin)
      returning id into v_customer_id;
    else
      /* Reused. The quote must point at the customer that actually exists, or the
         invoice and the subscription below hang off a different row than the payment. */
      update public.quotes set customer_id = v_customer_id
       where id = p_quote_id and tenant_id = v_tenant_id;

      /* R-373 (7 Oct 2026): the reused customer may have no state (149/160 locally),
         and generate_invoice refuses an invoice without one. The lead in hand carries
         the state the buyer gave (or a GSTIN whose first two digits are the code), so
         fill a BLANK customer state from it — never overwrite one already set. Same
         rule as fillBlankCustomerState on the online path. */
      update public.customers c
         set state_code = case
                            when btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$' then btrim(v_lead.state_code)
                            else substring(btrim(v_lead.gstin) from 1 for 2)
                          end,
             state      = case
                            when nullif(btrim(coalesce(c.state, '')), '') is null then v_lead.state
                            else c.state
                          end
       where c.id = v_customer_id
         and c.tenant_id = v_tenant_id
         and nullif(btrim(coalesce(c.state_code, '')), '') is null
         and (btrim(coalesce(v_lead.state_code, '')) ~ '^[0-9]{2}$'
              or btrim(coalesce(v_lead.gstin, '')) ~ '^[0-9]{2}');
    end if;

    update public.leads
       set stage              = 'won',
           trial_converted_at = case when v_was_trial then now() else trial_converted_at end
     where id = v_quote.lead_id and tenant_id = v_tenant_id;
    v_converted_now := true;
  elsif v_is_first_payment and v_quote.customer_id is null and v_quote.lead_id is null then
    insert into public.customers (tenant_id, name, domain, since, health, state_code, state, country)
    values (v_tenant_id, coalesce(nullif(trim(v_quote.customer_name), ''), 'Customer'),
            v_domain, current_date, case when p_amount >= v_expected then 85 else 75 end,
            v_quote.prospect_state_code, v_quote.prospect_state,
            coalesce(nullif(trim(v_quote.prospect_country), ''), 'India'))
    returning id into v_customer_id;
    v_converted_now := true;
  elsif v_quote.lead_id is not null then
    select l.stage into v_lead from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if v_is_first_payment then
      update public.leads
         set trial_converted_at = case when stage = 'won' and trial_started_at is not null and trial_converted_at is null then now() else trial_converted_at end
       where id = v_quote.lead_id and tenant_id = v_tenant_id;
    end if;
  end if;

  if not v_has_existing_invoice then
    v_receipt_voucher_no := public.next_document_number('receipt_voucher', v_tenant_id, public.ist_today());
  end if;

  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
      status, received_at, receipt_voucher_no, recorded_by)
    values (v_tenant_id, p_quote_id, v_customer_id, p_amount, p_method, p_reference,
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, auth.uid())
    returning id into v_payment_id;
  exception when unique_violation then
    select p.id, p.receipt_voucher_no, p.customer_id into v_existing_payment
      from public.payments p
     where p.tenant_id = v_tenant_id and p.quote_id = p_quote_id
       and p.reference = p_reference and p.status = 'received' limit 1;
    select coalesce(sum(amount), 0) into v_total_received
      from public.payments where quote_id = p_quote_id and status = 'received';
    v_outstanding := greatest(0, v_expected - v_total_received);
    return jsonb_build_object(
      'payment_id', v_existing_payment.id,
      'receipt_voucher_no', v_existing_payment.receipt_voucher_no,
      'customer_id', v_existing_payment.customer_id,
      'total_received', v_total_received,
      'expected', v_expected,
      'outstanding', v_outstanding,
      'is_first_payment', false,
      'is_fully_paid', v_total_received >= v_expected,
      'idempotent_replay', true,
      'already_recorded', true
    );
  end;

  v_total_received := v_prior_received + p_amount;
  v_outstanding    := greatest(0, v_expected - v_total_received);
  v_is_fully_paid  := v_total_received >= v_expected;
  v_new_payment_status := case
    when v_has_existing_invoice then 'invoiced'
    when v_is_fully_paid        then 'received'
    else                             'partial' end::public.payment_status;

  /* 0157: a ONE-OFF sale creates no subscription. Lost from this function and re-added
     22 Aug 2026 — and this is the costliest of the three, because it does not just
     record something wrong, it goes on to CHARGE for it. A direct invoice (is_one_off)
     is a single sale; the guard's absence gave it a recurring subscription, which the
     renewal cron then bills again on its next cycle. The customer is invoiced for a
     subscription nobody sold them. */
  /* R-346: a quote activated on credit already has its subscriptions (and draft POs). The
     first payment used to file them all AGAIN — two active subscriptions per line, both
     renewing. Existing rows for this quote_id mean "already filed": the payment goes down the
     elsif below, which only brings the outstanding down. */
  v_quote_subs_exist := exists (
    select 1 from public.subscriptions s
     where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id
  );

  if v_is_first_payment and not v_is_renewal_quote and not v_is_add_seats
     and not coalesce(v_quote.is_one_off, false)
     and not v_quote_subs_exist then  -- R-346
    if jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0 then
      for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
        v_first_line := v_quote.line_items -> v_line_idx;
        v_commitment := v_first_line->>'commitment';
        v_plan_name  := coalesce(v_first_line->>'name',
                          case when v_commitment = 'monthly' then 'Monthly subscription'
                               else 'Annual subscription' end);
        v_is_annual  := v_commitment is distinct from 'monthly' and v_commitment is not null;
        v_is_monthly := v_commitment = 'monthly';
        v_po_sub_id  := null;

        if (v_is_annual or v_is_monthly) and v_customer_id is not null then
          -- 0172: exact vendor via the catalog item itself; name-guess only
          -- for lines with no item_id (hand-typed, no catalog link).
          v_vendor := null;
          if v_first_line->>'item_id' is not null then
            select i.vendor into v_vendor from public.items i
             where i.id = v_first_line->>'item_id' and i.tenant_id = v_tenant_id;
          end if;
          if v_vendor is null then
            v_plan_lower := lower(v_plan_name);
            v_vendor := case
              when v_plan_lower like '%google%'    then 'google'::public.vendor
              when v_plan_lower like '%m365%'      then 'microsoft'::public.vendor
              when v_plan_lower like '%microsoft%' then 'microsoft'::public.vendor
              when v_plan_lower like '%365%'       then 'microsoft'::public.vendor
              when v_plan_lower like '%zoho%'      then 'zoho'::public.vendor
              else 'other'::public.vendor end;
          end if;

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, current_date);
          v_line_amount := round(
            coalesce((v_first_line->>'qty')::numeric, 0) * coalesce((v_first_line->>'rate')::numeric, 0)
              * (1 - coalesce((v_first_line->>'discount_pct')::numeric, 0) / 100)
          )::int;
          /* R-329: a cart coupon discounts the first payment only. The line then says what it
             renews at; the subscription's mrr (and so every renewal) is filed from that. */
          v_renew_amount := case
            when nullif(v_first_line->>'renewal_rate', '') is not null
              then round(coalesce((v_first_line->>'qty')::numeric, 0) * (v_first_line->>'renewal_rate')::numeric)::int
            else v_line_amount end;

          /* R-378: the line's cost per seat, as ₹/seat/MONTH (monthly line = as is, annual = /12). */
          v_cost_pm := case
            when jsonb_typeof(v_first_line->'cost') = 'number' and (v_first_line->>'cost')::numeric > 0
              then round((v_first_line->>'cost')::numeric / case when v_is_monthly then 1.0 else 12.0 end)::int
            else null end;

          if coalesce((v_first_line->>'bulk')::boolean, false)
             and jsonb_typeof(v_first_line->'domains') = 'array'
             and jsonb_array_length(v_first_line->'domains') > 0 then
            select coalesce(sum((e->>'seats')::int), 0) into v_bulk_total_seats
              from jsonb_array_elements(v_first_line->'domains') e;
            if v_bulk_total_seats <= 0 then
              raise exception 'bulk line has zero total seats (quote %)', p_quote_id;
            end if;
            v_bulk_pool := greatest(0, round(
                             coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end  -- R-329
                           ))::int;
            v_running_mrr := 0;
            v_idx := 0;
            v_n := jsonb_array_length(v_first_line->'domains');
            for v_d in select e from jsonb_array_elements(v_first_line->'domains') e loop
              v_idx := v_idx + 1;
              v_dom := lower(trim(v_d->>'domain'));
              v_dom_seats := coalesce((v_d->>'seats')::int, 0);
              if v_dom = '' then continue; end if;
              if v_idx < v_n then
                v_dom_mrr := floor(v_bulk_pool::numeric * v_dom_seats / v_bulk_total_seats)::int;
              else
                v_dom_mrr := v_bulk_pool - v_running_mrr;
              end if;
              v_running_mrr := v_running_mrr + v_dom_mrr;

              insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                start_date, renewal_date, status, outstanding_amount, domain, quote_id,
                term_months, vendor_cost_per_seat_month)  -- R-378
              values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
                v_start,
                (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
                'active', 0, v_dom, p_quote_id,
                case when v_is_monthly then 1 else 12 end,
                v_cost_pm)  -- R-378
              on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
                do nothing
              returning id into v_new_sub_id;

              insert into public.customer_domains (tenant_id, customer_id, domain)
              values (v_tenant_id, v_customer_id, v_dom)
              on conflict (tenant_id, lower(domain)) do nothing;

              v_bulk_count := v_bulk_count + 1;
              v_used_domains := array_append(v_used_domains, v_dom);
              v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
            end loop;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_bulk_total_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          else
            v_seats := coalesce((v_first_line->>'qty')::int, 0);
            -- 0172: prefer THIS line's own domain (the quote builder now lets
            -- staff type a distinct domain per product line) over the
            -- whole-quote/customer fallback below, which was the only source
            -- before per-line domains existed.
            v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
            v_own_domain := v_sub_domain is not null;  -- R-829
            if v_sub_domain is null then
              if v_domain is null and v_customer_id is not null then
                select domain into v_domain from public.customers where id = v_customer_id;
              end if;
              v_sub_domain := lower(nullif(trim(v_domain), ''));
            end if;
            /* R-829: the line's own domain stays unless THIS plan already has it on this quote
               (the unique index is per quote + domain + plan). A borrowed quote/customer
               domain still goes on one subscription only, as before (a support line next to
               Workspace does not take the Workspace domain). */
            if v_sub_domain is not null then
              if v_own_domain then
                if (v_sub_domain || '|' || lower(v_plan_name)) = any(v_used_domain_plans) then
                  v_domain_conflicts := v_domain_conflicts || jsonb_build_object(
                    'line', v_line_idx + 1, 'plan', v_plan_name, 'domain', v_sub_domain);
                  v_sub_domain := null;
                end if;
              elsif v_sub_domain = any(v_used_domains) then
                v_sub_domain := null;
              end if;
            end if;
            insert into public.subscriptions (tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
              start_date, renewal_date, status, outstanding_amount, domain, quote_id,
              term_months, vendor_cost_per_seat_month)  -- R-378
            values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
              greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,  -- R-329
              (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
              case when v_first_sub_in_quote then v_outstanding else 0 end,
              v_sub_domain, p_quote_id,
              case when v_is_monthly then 1 else 12 end,
              v_cost_pm)  -- R-378
            returning id into v_new_sub_id;
            if v_sub_domain is not null then
              v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
              v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
            end if;
            v_subscription_created := true;
            v_first_sub_in_quote := false;
            v_po_seats := v_seats; v_po_months := 12; v_po_plan := v_plan_name;
            v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
          end if;

          if v_po_sub_id is not null then
            select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
              into v_unit_wholesale_pm from public.items
             where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
            if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
              v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
            end if;
            v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
            v_po_id := public.next_document_number('purchase_order', v_tenant_id);
            insert into public.purchase_orders (
              id, tenant_id, subscription_id, customer_id, customer_name, domain,
              vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
            ) values (
              v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
              v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
              'Auto-created from quote ' || p_quote_id ||
              case when coalesce((v_first_line->>'bulk')::boolean, false) then ' (bulk order - ' || v_bulk_count || ' domains)'
                   else ' (new sub)' end,
              auth.uid()
            );
            v_po_created := true;
          end if;
        end if;
      end loop;
    end if;
    v_po_sub_id := null;
  elsif v_customer_id is not null and not v_is_renewal_quote and not v_is_add_seats and not v_has_bulk then
    update public.subscriptions set outstanding_amount = v_outstanding
     where tenant_id = v_tenant_id and customer_id = v_customer_id and quote_id = p_quote_id and outstanding_amount > 0;
  end if;

  if v_is_renewal_quote and v_is_fully_paid then
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    /* R-812: the subscription keeps ITS OWN plan. The line name is quote text — an
       extension line reads "<plan> · 3-month extension" — and writing it here renamed the
       subscription on every extension payment. The line name is only a fallback for a
       subscription that has no plan at all. */
    v_plan_name := coalesce(nullif(trim(v_renewal_sub.plan), ''), v_first_line->>'name');
    if v_first_line is not null then
      v_seats     := coalesce((v_first_line->>'qty')::int, v_renewal_sub.seats);
    else
      v_seats := v_renewal_sub.seats;
    end if;
    v_new_mrr := greatest(0, round(coalesce(v_quote.subtotal, v_expected)::numeric / greatest(v_extension_months, 1)))::int;
    update public.subscriptions
       /* A full TERM, not a fixed twelve months. On a monthly subscription one month IS
          the whole term, and the old test left renewal_state stuck at whatever step the
          cadence had reached — so the ladder never re-armed and the next month went
          unchased. */
       set renewal_state = case when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
                                then 'renewed'
                                /* R-805: a part-year extension moved the date — start the
                                   reminder ladder again rather than keep a stale step. */
                                when coalesce(v_quote.is_extension, false) then 'pending'
                                else renewal_state end,
           /* R-805: an extension by MONTHS (not whole years) sets the new INCLUSIVE last day
              = (first day of the following term + N months) - 1 day, reading both stored
              shapes like followingTermStart() in subscription-schedule.ts: an ANNIVERSARY row
              (renewal_date = start_date + whole terms) is followed by renewal_date itself, an
              inclusive row by the day after it. Renewals and whole-year extensions roll
              exactly as before. */
           renewal_date  = case
             when coalesce(v_quote.is_extension, false) and v_extension_months % 12 <> 0 then
               ((case when v_renewal_sub.start_date is not null and exists (
                         select 1 from generate_series(1, 100) n
                          where (v_renewal_sub.start_date
                                 + make_interval(months => n * greatest(coalesce(v_renewal_sub.term_months, 12), 1)))::date
                                = v_renewal_sub.renewal_date)
                      then v_renewal_sub.renewal_date
                      else v_renewal_sub.renewal_date + 1 end)
                + make_interval(months => v_extension_months))::date - 1
             else (v_renewal_sub.renewal_date + (v_extension_months || ' months')::interval)::date
           end,
           seats = v_seats, plan = v_plan_name,
           mrr   = case when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = 0, renewal_quote_id = null,
           reminder_count = 0, last_reminder_sent_at_v2 = null, status = 'active'
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor; v_po_sub_id := v_renewal_sub.id;
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif((prices->'annual'->>'wholesale')::int, 0), nullif(wholesale, 0))
      into v_unit_wholesale_pm from public.items
     where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
    if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
      v_unit_wholesale_pm := greatest(0, round(v_expected::numeric * 0.83 / greatest(v_po_seats * v_po_months, 1)))::int;
    end if;
    v_total_wholesale := v_unit_wholesale_pm * v_po_seats * v_po_months;
    v_po_id := public.next_document_number('purchase_order', v_tenant_id);
    insert into public.purchase_orders (
      id, tenant_id, subscription_id, customer_id, customer_name, domain,
      vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
    ) values (
      v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
      v_po_vendor, v_po_plan, v_po_seats, v_po_months, v_unit_wholesale_pm, v_total_wholesale, 'draft',
      'Auto-created from quote ' || p_quote_id ||
      case when v_is_renewal_quote then ' (renewal/extension)'
           when v_bulk_count > 0    then ' (bulk order - ' || v_bulk_count || ' domains)'
           else ' (new sub)' end,
      auth.uid()
    );
    v_po_created := true;
  end if;

  update public.quotes
     set payment_status = v_new_payment_status,
         payment_amount = v_total_received,
         payment_method = p_method,
         payment_reference = p_reference,
         payment_received_at = now(),
         payment_notes = nullif(trim(coalesce(p_notes, '')), ''),
         customer_id = v_customer_id,
         status = case
           when status in ('draft', 'sent', 'viewed') then 'accepted'::public.quote_status
           else status
         end
   where id = p_quote_id and tenant_id = v_tenant_id;

  if v_has_existing_invoice then
    select i.amount, i.net_payable, i.status, i.adjusted_advances into v_invoice
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_tenant_id;
    if found and v_invoice.status <> 'paid' then
      v_already_adjusted := coalesce((select sum((adv->>'amount')::int) from jsonb_array_elements(v_invoice.adjusted_advances) adv), 0);
      v_post_invoice_received := v_total_received - v_already_adjusted;
      v_net_due := coalesce(v_invoice.net_payable, v_invoice.amount);
      /* R-015 (Pardeep, 29 Sep 2026). This wrote NOTHING unless the invoice was settled
         in full, so `invoices.paid_amount` stayed 0 on every part-paid invoice — and
         Aging and the Balance Sheet both count the whole `net_payable`. A Rs 1,00,000
         invoice with Rs 40,000 received showed Rs 1,00,000 outstanding while the same
         Rs 40,000 was also counted as cash: wrong on both sides of the books at once.
         (Only `sync_project_invoice_paid`, on the project side, ever filled the column,
         which is why it looks populated to anybody who checks a project invoice.)

         paid_amount is written on EVERY payment now. `greatest(0, ...)` because
         v_post_invoice_received is net of advances already adjusted onto the invoice and
         can legitimately go negative; a negative paid_amount would flatter the aging
         rather than merely be wrong.

         status and paid_date still move only on full settlement. invoice_status has no
         'partial' value, and adding one reaches every screen that switches on status —
         that is a change to ask for, not to take. Aging reads net_payable - paid_amount,
         which needs no new status.

         paid_date uses ist_today(): current_date is the UTC day on this server (R-015
         part 1), so an invoice settled at 01:00 IST was stamped yesterday. It is still
         the SETTLEMENT day and not the payment's own received date — record_payment has
         no received-date parameter to read, so the dialog patches that in afterwards. */
      update public.invoices
         set paid_amount = greatest(0, v_post_invoice_received),
             status      = case when v_post_invoice_received >= v_net_due
                                then 'paid'::invoice_status else status end,
             paid_date   = case when v_post_invoice_received >= v_net_due
                                then public.ist_today() else paid_date end
       where id = v_quote.invoice_id and tenant_id = v_tenant_id;
      v_invoice_paid := v_post_invoice_received >= v_net_due;
    end if;
  end if;

  /* R-346: paid in full → the credit reminders ("Credit: send payment link", "Credit: payment
     not in — stop service?") have nothing left to chase. Only those two; the set-up task stays. */
  if v_invoice_paid then
    update public.tasks
       set status = 'cancelled'
     where tenant_id = v_tenant_id
       and quote_id  = p_quote_id
       and status in ('pending', 'snoozed')
       and title like 'Credit:%';
  end if;

  /* ─── Overpayment → customer credit, ISI transaction me (audit A5, 1 Sep 2026) ───
     Outstanding upar 0 par floor hota hai, to expected se zyada aaya paisa yahan
     record na ho to KAHIN record nahi hota. Ye insert pehle client-side tha
     (record-payment-dialog.tsx), RPC ke commit ke BAAD — network/RLS ki ek hichki
     aur customer ka extra rupaya hamesha ke liye be-hisaab. Incremental hi jodta
     hai (is payment ne jitna naya excess banaya), taki kai kishton me double na gine —
     wahi ganit jo client me tha. */
  /* R-1573: a debit note (late interest, extra charge) on the quote's invoice is owed on top
     of quotes.amount — money paid for it settles the invoice above, it is not credit. Only
     what goes past quote + debit notes is, less the overpayment credit this quote's payments
     already made (an overpayment made BEFORE the note was credited against the smaller
     total — the incremental formula would credit part of it twice). Same rows as the
     balance sheet's advances_from_customers (2). No debit note → the old formula, unchanged. */
  if v_has_existing_invoice then
    select coalesce(sum(d.amount), 0)::int into v_r1573_debits
      from public.debit_notes d
     where d.tenant_id = v_tenant_id and d.invoice_id = v_quote.invoice_id;
  end if;
  if v_r1573_debits > 0 then
    select coalesce(sum(cc.amount), 0)::int into v_r1573_credited
      from public.customer_credits cc
      join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant_id
     where cc.tenant_id = v_tenant_id
       and cc.source in ('overpayment', 'redeemed_split')
       and p.quote_id = p_quote_id and p.status = 'received'
       and p.id <> v_payment_id;
    v_overpaid_credit := least(p_amount, greatest(0,
                           greatest(0, v_total_received - (v_expected + v_r1573_debits)) - v_r1573_credited));
  else
    v_overpaid_credit := greatest(0, v_total_received - v_expected)
                       - greatest(0, v_prior_received - v_expected);
  end if;
  if v_overpaid_credit > 0 and v_customer_id is not null then
    insert into public.customer_credits
      (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
    values
      (v_tenant_id, v_customer_id, v_overpaid_credit, 'overpayment', v_payment_id, p_quote_id,
       'Excess over quote ' || p_quote_id, 'open');
  end if;

  return jsonb_build_object(
    'payment_id', v_payment_id,
    'receipt_voucher_no', v_receipt_voucher_no,
    'customer_id', v_customer_id,
    'total_received', v_total_received,
    'expected', v_expected,
    'outstanding', v_outstanding,
    'is_first_payment', v_is_first_payment,
    'is_fully_paid', v_is_fully_paid,
    'converted_now', v_converted_now,
    'subscription_created', v_subscription_created,
    'bulk_domains_created', v_bulk_count,
    'invoice_paid', v_invoice_paid,
    'has_existing_invoice', v_has_existing_invoice,
    'is_renewal_quote', v_is_renewal_quote,
    'renewal_link_lost', v_r1574_link_lost,
    'renewal_rolled_forward', v_renewal_rolled_forward,
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'overpaid_credit', v_overpaid_credit,
    'domain_conflicts', v_domain_conflicts,  -- R-829
    'idempotent_replay', false
  );
end;
$function$
;

commit;
