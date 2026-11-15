-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.r2848_roll_together(text)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_payment(text,integer,text,text,text)') and prosrc like '%r2848_roll_together%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unroll_unpaid_renewal_terms(uuid,text)') and prosrc like '%r2848_together_paid%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.r2847_together_payment_ready()') and prosrc like '%select true%') and exists(select 1 from pg_trigger where tgname = 'quotes_r2848_closed_unlinks' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_trigger where tgname = 'subscriptions_r2848_no_delete_on_together' and tgrelid = to_regclass('public.subscriptions'))
-- deploy-key: r2848renewaltogetherpayment
-- 20261115134526_r2848_renewal_together_payment.sql
--
-- R-2848 (15 Nov 2026, p1 money) — R-2809b, part 2 of "yearly subscriptions: Bill together" (R-2809, parent R-2805;
-- Pratik report 8b70e37f). Needs R-2847 (20261115125834: renewal_quote_subscriptions, create_renewal_quote_together,
-- the not-ready gate).
--
-- ─── BEFORE ───────────────────────────────────────────────────────────────────────────────────────
-- record_payment's renewal branch picked ONE subscription by renewal_quote_id (for update limit 1) and rolled it by the
-- quote's extension_months with mrr = the WHOLE quote subtotal / months — on a together quote that renews one
-- subscription with every subscription's money and leaves the others unrenewed. cancel_quote never cleared
-- subscriptions.renewal_quote_id (rev-r2847 MED-2: create_renewal_quote then handed the cancelled quote back). The
-- R-2749 / R-2761 undo knew only renewal PARTS. So R-2847 kept create_renewal_quote_together shut.
--
-- ─── AFTER ────────────────────────────────────────────────────────────────────────────────────────
-- * public.r2848_together_paid(quote) — is a together quote still paid: its tax invoice (if any) is not void / draft,
--   not credited in full, and 'paid' or covered by received payments (₹1 rounding); with no invoice, received payments
--   >= the quote amount.
-- * public.r2848_roll_together(quote) — paid → EVERY live link row not yet renewed: its subscription (row lock, id
--   order) renews once by ITS OWN term: renewal_date = renewal_term_date + extension_months (guarded on renewal_date =
--   renewal_term_date), renewal_state renewed, seats = its link seats (R-2583 cut included), mrr = its link subtotal /
--   months (never the quote total), outstanding = what its OTHER quotes still owe (R-1703, together quotes included),
--   renewal_quote_id cleared (only when it is this quote), reminders reset, status active (as the one-subscription
--   path); link renewed_at set; one 'forward' row in subscription_renewal_moves (new column quote_id); its own draft
--   vendor PO (once per subscription and quote). Not paid / already renewed → nothing.
-- * record_payment (latest body 20261108051500_r2589, verbatim + R-2848): a quote with renewal_quote_subscriptions
--   rows skips the one-subscription path. Every payment is refused (nothing recorded) when the quote's links were
--   released (closed) or a member's renewal date moved since the quote (set it back, then pay). Part payment renews
--   none. The roll runs from the payment / invoice triggers below and once more after the invoice update. A retry /
--   second payment / overpayment renews nothing again. R-1703 there also counts together quotes the sub is on.
-- * Undo / redo (R-2749 pattern, R-2761 held rules): unroll_unpaid_renewal_terms (latest body 20261113231500_r2761 +
--   R-2848) reads a 'forward' move with quote_id as paid while r2848_together_paid(quote) — so the R-2761 re-check
--   triggers never move a paid together term back; an unpaid one goes back once (renewed_at cleared, so paying again
--   rolls it forward once). r2848_recheck_together(quote) = roll + unroll each member, run on every money event of a
--   together quote: its invoice leaves / reaches 'paid' or is voided, a paid invoice is issued, a credit note is added
--   / removed (only a FULL credit moves anything), a received payment is added / deleted / changes status.
-- * Quote closed with no money (cancel_quote / Mark rejected / expired by date; NOT replaced by a revision or combined)
--   → every subscription's renewal_quote_id that points at it is cleared (rev-r2847 MED-2 — single renewal, extension,
--   support-upgrade and together quotes alike), logged in activity_log ('quote.r2848_unlinked'), and a together quote's
--   link rows are released. Undo cancel of a single quote links those subscriptions back (refused when one has another
--   open quote now); Undo cancel of a together quote whose links were released, and Activate on credit of a together
--   quote → refused.
-- * A subscription on a live together quote that has not renewed it yet cannot be deleted (the link row would cascade
--   away and the payment would renew the others only).
-- * tg_invoice_stamp_line_periods (latest body 20261113210500_r2744): a together quote's invoice line with
--   subscription_id stores ITS subscription's period (its renewal_term_date, its start / term) — one GST invoice for the
--   whole quote, each line its own service period.
-- * create_renewal_quote_together (R-2847 body) + rev-r2847 MED-1 (tax_rate one of 0/5/12/18/28), LOW-4 (line qty > 0,
--   rate >= 0, item_id null or this company's own item), LOW-6 (customer re-checked after the row locks).
--   create_renewal_quote (R-2847 body) + MED-1.
-- * r2847_together_payment_ready() → true (opens R-2847's gate) — last, in this same migration.
--
-- Readers looked at and left as they are (one-subscription-per-quote, safe for a together quote): bank_credit_pay_item /
-- bank_credit_open_items (R-2095 / R-1838 / R-2466) take "a" linked subscription only to call the item a renewal (the
-- quote's is_renewal says so too) and to apply R-2179's yearly-invoice-on-receipt rule — every member is yearly
-- (R-2847 refuses others); activate_quote_on_credit refuses while any member is linked and the R-2848 guard refuses
-- once paid; r2768_invoice_line_period_plan skips invoices whose lines carry service_period.
-- Tenant guard (CLAUDE.md §17c): R-2810's login rule (trusted = service_role / a non-request login).
-- Test: supabase/tests/r2848_renewal_together_payment.test.sql (one transaction, rolled back; red without this file).

begin;

-- ── 1. Moves know the together quote ─────────────────────────────────────────────────────────────
alter table public.subscription_renewal_moves add column if not exists quote_id text;
comment on column public.subscription_renewal_moves.quote_id is
  'R-2848: a move made by a renewal quote billed together (renewal_quote_subscriptions) — paid while r2848_together_paid(quote_id).';


-- ── 2. Is a together quote still paid? ───────────────────────────────────────────────────────────
create or replace function public.r2848_together_paid(p_quote_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2848: a renewal quote billed together is paid while
     - its tax invoice (if it has one) is not void and not credited in full, and is 'paid' — or the received payments
       cover the quote amount (an invoice left 'pending' by a ₹1 GST rounding on a fully paid quote stays paid);
     - with no invoice: the received payments cover the quote amount. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_inv     record;
  v_cn      bigint;
  v_rec     bigint;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  select q.id, q.tenant_id, q.amount, q.invoice_id into v_q from public.quotes q where q.id = p_quote_id;
  if not found or coalesce(v_q.amount, 0) <= 0 then
    return false;
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s company', p_quote_id using errcode = '42501';
  end if;
  select coalesce(sum(p.amount), 0) into v_rec
    from public.payments p where p.quote_id = v_q.id and p.tenant_id = v_q.tenant_id and p.status = 'received';
  select i.id, i.status::text as status, i.amount into v_inv
    from public.invoices i
   where i.tenant_id = v_q.tenant_id
     and (i.id = v_q.invoice_id or (v_q.invoice_id is null and i.quote_id = v_q.id and i.status::text <> 'void'))
   order by (i.id = v_q.invoice_id) desc, i.created_at desc
   limit 1;
  if found then
    if v_inv.status in ('void', 'draft') then
      return false;
    end if;
    select coalesce(sum(c.amount), 0) into v_cn from public.credit_notes c where c.invoice_id = v_inv.id;
    if v_cn >= coalesce(v_inv.amount, 0) then
      return false;   -- credited in full
    end if;
    return v_inv.status = 'paid' or v_rec >= v_q.amount;
  end if;
  return v_rec >= v_q.amount;
end;
$$;
revoke all on function public.r2848_together_paid(text) from public, anon, authenticated;
grant execute on function public.r2848_together_paid(text) to service_role;

-- ── 3. The roll: each linked subscription renews once by its own term ─────────────────────────────
create or replace function public.r2848_roll_together(p_quote_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: a renewal quote billed together, paid → every live link row not yet renewed renews ITS subscription once
   (see the migration header) and gets its own draft vendor PO (once per subscription and quote — a roll again after
   an undo makes no second PO). Returns the subscription ids renewed by this call. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_q       record;
  v_l       record;
  v_s       record;
  v_open    integer;
  v_due     date;
  v_mrr     integer;
  v_n       integer;
  v_unit    integer;
  v_seats   integer;
  v_po_id   text;
  v_done    jsonb := '[]'::jsonb;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the quote''s company can renew it' using errcode = '28000';
  end if;
  select q.id, q.tenant_id, q.invoice_id, q.amount, q.subtotal, q.customer_id, q.customer_name, q.domain
    into v_q from public.quotes q where q.id = p_quote_id;
  if not found then
    return v_done;
  end if;
  if v_caller is not null and v_q.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s company', p_quote_id using errcode = '42501';
  end if;
  if not public.r2848_together_paid(p_quote_id) then
    return v_done;
  end if;
  /* Row locks in subscription id order (the order create_renewal_quote_together locks them in). */
  perform 1 from public.subscriptions s
   where s.id in (select l.subscription_id from public.renewal_quote_subscriptions l
                   where l.quote_id = p_quote_id and l.tenant_id = v_q.tenant_id and l.released_at is null)
   order by s.id for update;
  for v_l in
    select l.* from public.renewal_quote_subscriptions l
     where l.quote_id = p_quote_id and l.tenant_id = v_q.tenant_id
       and l.released_at is null and l.renewed_at is null
     order by l.subscription_id
     for update
  loop
    select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.vendor, s.domain into v_s
      from public.subscriptions s where s.id = v_l.subscription_id and s.tenant_id = v_q.tenant_id;
    if not found or v_s.renewal_date is distinct from v_l.renewal_term_date then
      continue;   -- its term moved (hand edit) — record_payment refuses this before money is taken
    end if;
    /* R-1703: paying the NEW term does not pay the old one — what this subscription's OTHER quotes still owe
       (its sale quote, its single renewal quotes, and other together quotes it is on). */
    select coalesce(sum(o.open_amt), 0)::int, min(o.due) into v_open, v_due
      from (
        select public.quote_open_balance(q.id) as open_amt,
               coalesce(
                 (select min(i.due_date)::date from public.invoices i
                   where i.tenant_id = q.tenant_id and i.quote_id = q.id
                     and i.status in ('pending', 'overdue')
                     and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0),
                 q.credit_due_date::date,
                 case when q.id = s.quote_id then s.payment_due_date::date end) as due
          from public.subscriptions s
          join public.quotes q
            on q.tenant_id = s.tenant_id
           and (q.id = s.quote_id or q.renewal_subscription_id = s.id
                or exists (select 1 from public.renewal_quote_subscriptions l2
                            where l2.quote_id = q.id and l2.subscription_id = s.id))
         where s.id = v_s.id and s.tenant_id = v_q.tenant_id
           and q.id <> p_quote_id
           and (exists (select 1 from public.invoices i2
                         where i2.tenant_id = q.tenant_id and i2.quote_id = q.id and i2.status <> 'void')
                or (q.status = 'accepted' and q.superseded_at is null))
      ) o
     where o.open_amt > 0;
    v_open := coalesce(v_open, 0);
    v_mrr := greatest(0, round(v_l.subtotal::numeric / greatest(v_l.extension_months, 1)))::int;
    perform set_config('app.r2761_auto_move', 'on', true);
    update public.subscriptions
       set renewal_state = 'renewed',
           renewal_date = (v_l.renewal_term_date + make_interval(months => v_l.extension_months))::date,
           seats = coalesce(v_l.seats, seats),
           mrr = case when v_mrr > 0 then v_mrr else mrr end,
           outstanding_amount = v_open,
           payment_due_date = case when v_open > 0 then coalesce(v_due, payment_due_date) end,
           renewal_quote_id = case when renewal_quote_id = p_quote_id then null else renewal_quote_id end,
           reminder_count = 0,
           last_reminder_sent_at_v2 = null,
           status = 'active'
     where id = v_s.id and tenant_id = v_q.tenant_id and renewal_date = v_l.renewal_term_date;
    get diagnostics v_n = row_count;
    perform set_config('app.r2761_auto_move', 'off', true);
    continue when v_n = 0;
    update public.renewal_quote_subscriptions set renewed_at = now() where id = v_l.id;
    insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why, quote_id)
    values (v_q.tenant_id, v_s.id, null, 'forward', v_l.renewal_term_date,
            (v_l.renewal_term_date + make_interval(months => v_l.extension_months))::date, v_q.invoice_id,
            'renewal quote ' || p_quote_id || ' paid (billed together)', p_quote_id);
    v_done := v_done || to_jsonb(v_s.id::text);

    /* Its draft vendor PO, as record_payment drafts one for a renewal (catalogue wholesale by plan name, else 83% of
       ITS share of the quote amount) — once per subscription and quote. */
    if not exists (select 1 from public.purchase_orders po
                    where po.tenant_id = v_q.tenant_id and po.subscription_id = v_s.id
                      and po.notes like 'Auto-created from quote ' || p_quote_id || ' %') then
      v_unit := null;
      select coalesce(nullif(round((i.prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(i.wholesale, 0))
        into v_unit from public.items i
       where i.tenant_id = v_q.tenant_id and lower(i.name) = lower(v_s.plan) limit 1;
      v_seats := greatest(coalesce(v_l.seats, v_s.seats, 1), 1);
      if v_unit is null or v_unit <= 0 then
        v_unit := greatest(0, round(
          round(coalesce(v_q.amount, 0)::numeric * v_l.subtotal / greatest(coalesce(v_q.subtotal, 0), 1)) * 0.83
            / greatest(v_seats * v_l.extension_months, 1)))::int;
      end if;
      v_po_id := public.next_document_number('purchase_order', v_q.tenant_id);
      insert into public.purchase_orders (
        id, tenant_id, subscription_id, customer_id, customer_name, domain,
        vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
      ) values (
        v_po_id, v_q.tenant_id, v_s.id, v_q.customer_id, v_q.customer_name, coalesce(v_s.domain, v_q.domain),
        v_s.vendor, v_s.plan, v_seats, v_l.extension_months, v_unit, v_unit * v_seats * v_l.extension_months, 'draft',
        'Auto-created from quote ' || p_quote_id || ' (renewal, billed together)',
        public.current_user_id()
      );
    end if;
  end loop;
  return v_done;
end;
$$;
revoke all on function public.r2848_roll_together(text) from public, anon, authenticated;
grant execute on function public.r2848_roll_together(text) to service_role;


-- ── 4. record_payment: a together quote renews every linked subscription ─────────────────────────
CREATE OR REPLACE FUNCTION public.record_payment(p_quote_id text, p_amount integer, p_method text, p_reference text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-2848: a renewal quote billed together renews every linked subscription once, by its own term (r2848_roll_together). */
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
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
  v_r2073_upgrade         boolean := false;  -- R-2073: mid-term support plan upgrade
  v_r2073_item_id         text;
  v_r2073_item_name       text;
  v_r2073_item_msrp       integer;
  v_r2073_item_prices     jsonb;
  v_r2073_mrr             integer;
  v_r2227_change          jsonb := null;  -- R-2227: licence plan change (quote line plan_change)
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
  -- R-1703: what the subscription's OTHER quotes still owe, and their oldest due date.
  v_r1703_prior_open      integer := 0;
  v_r1703_prior_due       date;
  -- R-2848: a renewal quote billed together (renewal_quote_subscriptions)
  v_r2848_together        boolean := false;
  v_r2848_bad             text;
  v_r2848_n               integer := 0;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment' using errcode = '42501';
  end if;
  v_is_service_role := public.current_request_role() = 'service_role';
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

  /* R-2848: a renewal quote billed together renews EVERY subscription on its link rows, each by its own term
     (r2848_roll_together, after the invoice update below) — never the one-subscription path. Refused, nothing
     recorded: its links were released (the quote was closed), or a member's renewal date moved since the quote. */
  v_r2848_together := exists (select 1 from public.renewal_quote_subscriptions l
                               where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id);
  if v_r2848_together then
    if not exists (select 1 from public.renewal_quote_subscriptions l
                    where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null) then
      raise exception 'Renewal quote % renewed several subscriptions together but was closed, so its subscriptions were freed. Nothing was recorded. Make the renewal quote together again from Renewals, or record the money as customer credit.',
        p_quote_id using errcode = 'P0001';
    end if;
    perform 1 from public.subscriptions s
     where s.id in (select l.subscription_id from public.renewal_quote_subscriptions l
                     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null)
     order by s.id for update;
    select string_agg(format('%s (quoted for the term due %s, now due %s)', s.plan, to_char(l.renewal_term_date, 'DD Mon YYYY'),
                             coalesce(to_char(s.renewal_date, 'DD Mon YYYY'), 'no date')), ', ' order by s.plan)
      into v_r2848_bad
      from public.renewal_quote_subscriptions l
      join public.subscriptions s on s.id = l.subscription_id
     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null and l.renewed_at is null
       and s.renewal_date is distinct from l.renewal_term_date;
    if v_r2848_bad is not null then
      raise exception 'Renewal quote % renews several subscriptions together, but the renewal date of % changed since the quote was made — this payment would not renew it. Nothing was recorded. Set that renewal date back to the date the quote was made for (Correct details on the subscription), then record the payment again.',
        p_quote_id, v_r2848_bad using errcode = 'P0001';
    end if;
    v_is_renewal_quote := true;
    v_extension_months := coalesce(v_extension_months, 12);
  else
  select s.id, s.renewal_date, s.seats, s.mrr, s.plan, s.renewal_state, s.vendor, s.customer_id, s.customer_name, s.domain as sub_domain, s.term_months, s.start_date
    into v_renewal_sub
    from public.subscriptions s
   where s.tenant_id = v_tenant_id
     and s.renewal_quote_id = p_quote_id
   for update limit 1;
  v_is_renewal_quote := found;
  end if;

  /* R-1574: a renewal quote whose link was lost (a second quote overwrote it, or the link was
     never written) used to fall through to the NEW-SALE path below — a second subscription
     was created and the subscription it was made for was not renewed. A quote made by
     create_renewal_quote names the subscription term it renews: while that term is still the
     open one it IS that renewal. When the term has moved on, the first payment is refused
     with the next step rather than opening a duplicate subscription. Quotes made before
     R-1574 carry no term and behave exactly as before. */
  /* R-2227: a plan-change quote whose link to its subscription was lost (renewal_quote_id cleared or
     overwritten) must never fall through to the NEW-SALE path below — that would open a second
     subscription from its net line. Refuse with the next step instead. */
  if not v_is_renewal_quote and coalesce(v_quote.extension_months, -1) = 0
     and jsonb_typeof(v_quote.line_items) = 'array'
     and jsonb_typeof(v_quote.line_items->0->'plan_change') = 'object' then
    raise exception 'R-2227: plan change quote % is no longer linked to its subscription, so this payment would change nothing. Nothing was recorded. Delete the quote and make it again from the subscription (Change plan).',
      p_quote_id using errcode = 'P0001';
  end if;

  /* R-2589: a plan-change quote is priced on the subscription as Change plan read it — plan_change
     from_seats / from_mrr / from_plan. If the seats, monthly amount or plan changed since (Reduce
     seats, Add seats, Correct details), its price is wrong; and a seat cut already credited the
     removed seats, so letting the quote put its seat count back would credit those seats twice.
     Refused on every payment (part or full); a quote without from_seats / from_mrr was made before
     this check and is refused the same way — the owner makes a new plan-change quote. A quote naming
     another subscription (R-2227's own message) and a subscription no longer active (cancelled with
     credit, paused, expired) are refused here too, so not even a part payment is taken. */
  if v_is_renewal_quote and coalesce(v_quote.extension_months, -1) = 0
     and jsonb_typeof(v_quote.line_items) = 'array'
     and jsonb_typeof(v_quote.line_items->0->'plan_change') = 'object' then
    if (v_quote.line_items->0->'plan_change'->>'subscription_id') is distinct from v_renewal_sub.id::text then
      raise exception 'R-2227: plan change quote % was made for another subscription. Nothing was recorded.',
        p_quote_id using errcode = 'P0001';
    end if;
    if (select s.status::text from public.subscriptions s where s.id = v_renewal_sub.id) is distinct from 'active' then
      raise exception 'R-2589: plan change quote % is for a subscription that is no longer active (%). Nothing was recorded. Delete this quote; a plan can be changed only on an active subscription.',
        p_quote_id, (select s.status::text from public.subscriptions s where s.id = v_renewal_sub.id) using errcode = 'P0001';
    end if;
    if (v_quote.line_items->0->'plan_change'->>'from_seats') is null
       or (v_quote.line_items->0->'plan_change'->>'from_mrr') is null
       or (v_quote.line_items->0->'plan_change'->>'from_seats')::numeric is distinct from v_renewal_sub.seats::numeric
       or (v_quote.line_items->0->'plan_change'->>'from_mrr')::numeric is distinct from v_renewal_sub.mrr::numeric
       or ((v_quote.line_items->0->'plan_change') ? 'from_plan'
           and nullif(trim(v_quote.line_items->0->'plan_change'->>'from_plan'), '') is distinct from nullif(trim(v_renewal_sub.plan), '')) then
      raise exception 'R-2589: plan/seats changed since this quote % was made (priced on % seats at ₹%/month, %; the subscription now has % seats at ₹%/month, %). Nothing was recorded. Delete this quote and make a new plan-change quote from Change plan.',
        p_quote_id,
        coalesce(v_quote.line_items->0->'plan_change'->>'from_seats', '?'),
        coalesce(v_quote.line_items->0->'plan_change'->>'from_mrr', '?'),
        coalesce(v_quote.line_items->0->'plan_change'->>'from_plan', 'plan not stored'),
        v_renewal_sub.seats, v_renewal_sub.mrr, coalesce(v_renewal_sub.plan, 'no plan')
        using errcode = 'P0001';
    end if;
  end if;

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
      values (v_tenant_id, v_lead.company, v_lead.contact_name, v_lead.contact_email, v_lead.contact_phone, v_domain, public.ist_today(),
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
            v_domain, public.ist_today(), case when p_amount >= v_expected then 85 else 75 end,
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
            nullif(trim(coalesce(p_notes, '')), ''), 'received', now(), v_receipt_voucher_no, public.current_user_id())
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
        /* R-1688: the one rule for "does this line become a subscription"
           (quote_line_is_subscription): a line marked one-time ({"one_time": true}, the builder),
           commitment 'one_time', or a one-time catalogue item never does. A line with no
           commitment keeps this path's old meaning: paid first files nothing for it (false). */
        v_is_monthly := coalesce(v_commitment = 'monthly', false)
                        and public.quote_line_is_subscription(v_first_line, v_tenant_id, false);
        v_is_annual  := not v_is_monthly
                        and public.quote_line_is_subscription(v_first_line, v_tenant_id, false);
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

          v_start := coalesce(nullif(v_first_line->>'start_date', '')::date, public.ist_today());
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
            select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
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
              public.current_user_id()
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

  if v_is_renewal_quote and v_is_fully_paid and not v_r2848_together then  -- R-2848: together → r2848_roll_together below
    /* R-1703: paying the NEW term does not pay the old one. Keep what the subscription's
       other quotes (its own quote + its other renewal quotes) still owe, and their oldest
       due date, instead of writing 0. */
    select coalesce(sum(o.open_amt), 0)::int, min(o.due)
      into v_r1703_prior_open, v_r1703_prior_due
      from (
        select public.quote_open_balance(q.id) as open_amt,
               coalesce(
                 (select min(i.due_date)::date from public.invoices i
                   where i.tenant_id = q.tenant_id and i.quote_id = q.id
                     and i.status in ('pending', 'overdue')
                     and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0),
                 q.credit_due_date::date,
                 case when q.id = s.quote_id then s.payment_due_date::date end) as due
          from public.subscriptions s
          join public.quotes q
            on q.tenant_id = s.tenant_id
           and (q.id = s.quote_id or q.renewal_subscription_id = s.id
                or exists (select 1 from public.renewal_quote_subscriptions l2   -- R-2848: a together quote it is on
                            where l2.quote_id = q.id and l2.subscription_id = s.id))
         where s.id = v_renewal_sub.id and s.tenant_id = v_tenant_id
           and q.id <> p_quote_id
           and (exists (select 1 from public.invoices i2
                         where i2.tenant_id = q.tenant_id and i2.quote_id = q.id and i2.status <> 'void')
                or (q.status = 'accepted' and q.superseded_at is null))
      ) o
     where o.open_amt > 0;
    v_r1703_prior_open := coalesce(v_r1703_prior_open, 0);
    v_first_line := case
      when jsonb_typeof(v_quote.line_items) = 'array' and jsonb_array_length(v_quote.line_items) > 0
        then v_quote.line_items->0 else null end;
    /* R-812: the subscription keeps ITS OWN plan. The line name is quote text — an
       extension line reads "<plan> · 3-month extension" — and writing it here renamed the
       subscription on every extension payment. The line name is only a fallback for a
       subscription that has no plan at all. */
    v_plan_name := coalesce(nullif(trim(v_renewal_sub.plan), ''), v_first_line->>'name');
    /* R-2073: a SUPPORT plan upgrade quote (lib/support/create-upgrade-quote.ts) is linked like an
       extension (renewal_quote_id) but buys NO time: extension_months = 0 and its one line is the
       new tier's catalogue row (SUP-…). Paid in full → the subscription moves to that row's plan
       and full-term MRR; renewal date, seats, renewal state, reminders and status stay as they
       are, and no vendor PO is drafted (support is our own service). Every other quote — any
       non-SUP line, or a support renewal/extension with months > 0 — takes the path below
       exactly as before. */
    v_r2073_upgrade := v_extension_months = 0
                       and coalesce(v_first_line->>'item_id', '') like 'SUP-%';
    /* R-2227: a LICENCE plan change quote (api/subscriptions/[id]/change-plan) has the same shape —
       renewal-linked, extension_months = 0 — and its first line carries plan_change {seats, new_mrr,
       cost_per_seat_month, subscription_id}. Paid in full → the subscription takes the new plan,
       item, seats, MRR and licence cost; renewal date, renewal state, reminders and status stay; no
       vendor PO (exactly the R-2073 path below). */
    if v_extension_months = 0 and jsonb_typeof(v_first_line->'plan_change') = 'object' then
      v_r2227_change := v_first_line->'plan_change';
      if v_r2227_change->>'subscription_id' is distinct from v_renewal_sub.id::text then
        raise exception 'R-2227: plan change quote % was made for another subscription. Nothing was recorded.',
          p_quote_id using errcode = 'P0001';
      end if;
      if coalesce((v_r2227_change->>'seats')::int, 0) < coalesce(v_renewal_sub.seats, 0)
         or coalesce((v_r2227_change->>'new_mrr')::int, 0) <= 0 then
        raise exception 'R-2227: plan change quote % has seats or a monthly amount that cannot be right (seats %, monthly %). Nothing was recorded. Delete the quote and make it again from Change plan.',
          p_quote_id, v_r2227_change->>'seats', v_r2227_change->>'new_mrr' using errcode = 'P0001';
      end if;
      v_r2073_upgrade := true;
    end if;
    if v_r2073_upgrade then
      select i.id, i.name, i.msrp, i.prices
        into v_r2073_item_id, v_r2073_item_name, v_r2073_item_msrp, v_r2073_item_prices
        from public.items i
       where i.tenant_id = v_tenant_id and i.id = v_first_line->>'item_id';
      if not found then
        raise exception 'R-2073: upgrade quote % names plan %, which is no longer in the catalogue. Nothing was recorded. Add the plan back under Products, then record the payment again.',
          p_quote_id, v_first_line->>'item_id' using errcode = 'P0001';
      end if;
      v_plan_name := v_r2073_item_name;
      v_r2073_mrr := case
        when v_r2227_change is not null then (v_r2227_change->>'new_mrr')::int  -- R-2227
        when coalesce(v_renewal_sub.term_months, 12) = 1 then nullif(v_r2073_item_msrp, 0)
        else round(nullif((v_r2073_item_prices->'annual_total'->>'msrp')::numeric, 0) / 12)::int
      end;
    end if;
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
       set renewal_state = case when v_r2073_upgrade then renewal_state  -- R-2073
                                when v_extension_months >= coalesce(v_renewal_sub.term_months, 12)
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
             when v_r2073_upgrade then renewal_date  -- R-2073: same renewal date
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
           seats = case when v_r2227_change is not null then (v_r2227_change->>'seats')::int  -- R-2227
                        when v_r2073_upgrade then seats else v_seats end, plan = v_plan_name,
           vendor_cost_per_seat_month = case                                                 -- R-2227
             when v_r2227_change is not null and coalesce((v_r2227_change->>'cost_per_seat_month')::numeric, 0) > 0
               then round((v_r2227_change->>'cost_per_seat_month')::numeric)::int
             else vendor_cost_per_seat_month end,
           item_id = case when v_r2073_upgrade then v_r2073_item_id else item_id end,  -- R-2073
           mrr   = case when v_r2073_upgrade then coalesce(v_r2073_mrr, mrr)          -- R-2073
                        when v_new_mrr > 0 then v_new_mrr else mrr end,
           outstanding_amount = v_r1703_prior_open,  -- R-1703: was 0
           payment_due_date = case when v_r1703_prior_open > 0
                                   then coalesce(v_r1703_prior_due, payment_due_date) end,
           renewal_quote_id = null,
           reminder_count = case when v_r2073_upgrade then reminder_count else 0 end,
           last_reminder_sent_at_v2 = case when v_r2073_upgrade then last_reminder_sent_at_v2 end,
           status = case when v_r2073_upgrade then status else 'active' end
     where id = v_renewal_sub.id and tenant_id = v_tenant_id;
    v_renewal_rolled_forward := true;
    if v_r2073_upgrade then v_renewal_rolled_forward := false; end if;  -- R-2073: nothing rolled
    v_po_seats := v_seats; v_po_months := v_extension_months;
    v_po_plan := v_plan_name; v_po_vendor := v_renewal_sub.vendor;
    v_po_sub_id := case when v_r2073_upgrade then null else v_renewal_sub.id end;  -- R-2073: no PO
  end if;

  if v_po_sub_id is not null then
    select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
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
      public.current_user_id()
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

  /* R-2848: a together quote, paid (an invoice raised before the payment is 'paid' by now) → every member renews once
     by its own term and gets its own draft PO (r2848_roll_together; it may already have run from the payment / invoice
     triggers in this transaction — renewed_at = now() counts those too). */
  if v_r2848_together then
    perform public.r2848_roll_together(p_quote_id);
    select count(*)::int into v_r2848_n
      from public.renewal_quote_subscriptions l
     where l.quote_id = p_quote_id and l.tenant_id = v_tenant_id and l.released_at is null and l.renewed_at = now();
    v_po_created := v_po_created or v_r2848_n > 0;
    v_renewal_rolled_forward := v_r2848_n > 0;
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
    'support_upgrade', v_r2073_upgrade and v_r2227_change is null,  -- R-2073
    'plan_change', v_r2227_change is not null,  -- R-2227
    'extension_months', v_extension_months,
    'domain', v_domain,
    'po_id', v_po_id,
    'po_created', v_po_created,
    'was_trial', v_was_trial,
    'is_add_seats', v_is_add_seats,
    'overpaid_credit', v_overpaid_credit,
    'domain_conflicts', v_domain_conflicts,  -- R-829
    'together', v_r2848_together,  -- R-2848
    'together_renewed', v_r2848_n,  -- R-2848: members renewed by this payment
    'idempotent_replay', false
  );
end;
$function$
;

-- ── 5. unroll_unpaid_renewal_terms: together moves are paid while the quote is ─────────────────
create or replace function public.unroll_unpaid_renewal_terms(p_subscription_id uuid, p_why text default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2749: a renewal part's payment was undone → move renewal_date back to the term's renews_from, once.
   Walks back the chain of ACTIVE 'forward' moves (not yet reversed by a later 'back' of the same term) that
   ends at the CURRENT renewal_date — no such row (a hand-changed date) ends it, so a hand-changed date is never
   touched. The oldest term in that chain whose part is no longer paid decides: renewal_date goes back to its
   renews_from (newer terms rolled on top wait behind it again), renewal_state 'pending', reminders reset.
   HELD (date left, one 'held' row — the owner sees it on the Renewals row): the subscription is not active /
   paused, a quote is linked on renewal_quote_id, or a seat cut is scheduled for the end of the current term.
   R-2761: also the re-check of an open hold — nothing left unpaid → holds resolved; moved back → resolved;
   held for another reason → new held row, the old one resolved; same reason → no second row.
   R-2848: a 'forward' move made by a renewal quote billed together (quote_id) is paid while
   r2848_together_paid(quote_id); moved back → that link row's renewed_at is cleared (paying again rolls it once).
   Returns the number of terms moved back. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_sub     record;
  v_m       record;
  v_date    date;
  v_chain   bigint[] := '{}';
  v_upto    integer := 0;
  v_target  date;
  v_oldest  record;
  v_hold    text;
  v_kind    text;
  v_n       integer;
  v_paid    boolean;
  v_why     text := coalesce(nullif(btrim(p_why), ''), 'renewal part payment undone');
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can change it' using errcode = '28000';
  end if;
  select s.id, s.tenant_id, s.renewal_date, s.status::text as status, s.renewal_quote_id into v_sub
    from public.subscriptions s where s.id = p_subscription_id for update;
  if not found or v_sub.renewal_date is null then
    return 0;
  end if;
  if v_caller is not null and v_sub.tenant_id is distinct from v_caller then
    raise exception 'Subscription % is not in the caller''s company', p_subscription_id using errcode = '42501';
  end if;

  v_date := v_sub.renewal_date;
  for i in 1..24 loop
    select m.id, m.billing_id, m.from_date, m.to_date, m.quote_id into v_m
      from public.subscription_renewal_moves m
     where m.subscription_id = v_sub.id and m.tenant_id = v_sub.tenant_id
       and m.direction = 'forward' and m.to_date = v_date
       and not exists (select 1 from public.subscription_renewal_moves r
                        where r.subscription_id = m.subscription_id and r.tenant_id = m.tenant_id
                          and r.direction = 'back' and r.id > m.id
                          and r.from_date = m.to_date and r.to_date = m.from_date)
     order by m.id desc
     limit 1;
    exit when not found;
    v_chain := v_chain || v_m.id;
    select exists (
      select 1 from public.subscription_billings b
        join public.invoices i on i.id = b.invoice_id and i.tenant_id = b.tenant_id
       where b.subscription_id = v_sub.id and b.tenant_id = v_sub.tenant_id
         and b.renews_from = v_m.from_date and b.renews_to = v_m.to_date
         and i.status = 'paid') into v_paid;
    if not v_paid and v_m.quote_id is not null then
      v_paid := public.r2848_together_paid(v_m.quote_id);   -- R-2848
    end if;
    if not v_paid then
      v_upto := i;            -- walking back = older; the last hit is the OLDEST unpaid term
      v_target := v_m.from_date;
      v_oldest := v_m;
    end if;
    v_date := v_m.from_date;
  end loop;
  if v_upto = 0 then
    /* R-2761: nothing unpaid on the chain ending at today's date → an open hold no longer applies. */
    update public.subscription_renewal_moves
       set resolved_at = now(), resolved_why = v_why || ' — nothing left to move back'
     where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held' and resolved_at is null;
    return 0;
  end if;

  v_kind := case
    when v_sub.status not in ('active', 'paused') then 'not_active'
    when v_sub.renewal_quote_id is not null then 'quote_linked'
    when exists (select 1 from public.subscription_seat_reductions r
                  where r.tenant_id = v_sub.tenant_id and r.subscription_id = v_sub.id
                    and r.status = 'scheduled' and r.timing = 'end_of_term' and r.effective_date = v_sub.renewal_date)
      then 'seat_cut'
  end;
  v_hold := case v_kind
    when 'not_active' then 'subscription is ' || v_sub.status || ' — its end date is kept'
    when 'quote_linked' then 'quote ' || v_sub.renewal_quote_id || ' is linked for the next term'
    when 'seat_cut' then 'a seat cut is scheduled for ' || to_char(v_sub.renewal_date, 'DD Mon YYYY')
  end;
  if v_kind is not null then
    if not exists (select 1 from public.subscription_renewal_moves h
                    where h.subscription_id = v_sub.id and h.tenant_id = v_sub.tenant_id and h.direction = 'held'
                      and h.resolved_at is null and h.id > v_oldest.id
                      and h.from_date = v_sub.renewal_date and h.to_date = v_target
                      and h.hold_kind is not distinct from v_kind) then
      /* close the old open hold first — one open hold per subscription (unique index, rev-r2761 LOW 3) */
      update public.subscription_renewal_moves
         set resolved_at = now(), resolved_why = 'held again: ' || v_hold
       where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held'
         and resolved_at is null;
      insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why, hold_kind)
      values (v_sub.tenant_id, v_sub.id, v_oldest.billing_id, 'held', v_sub.renewal_date, v_target, null,
              v_why || ' — NOT moved back: ' || v_hold, v_kind);
    end if;
    return 0;
  end if;

  perform set_config('app.r2761_auto_move', 'on', true);
  update public.subscriptions
     set renewal_date = v_target,
         renewal_state = 'pending',
         reminder_count = 0,
         last_reminder_sent_at_v2 = null
   where id = v_sub.id and tenant_id = v_sub.tenant_id and renewal_date = v_sub.renewal_date
     and renewal_quote_id is null;
  get diagnostics v_n = row_count;
  perform set_config('app.r2761_auto_move', 'off', true);
  if v_n = 0 then
    return 0;
  end if;
  insert into public.subscription_renewal_moves (tenant_id, subscription_id, billing_id, direction, from_date, to_date, invoice_id, why)
  select m.tenant_id, m.subscription_id, m.billing_id, 'back', m.to_date, m.from_date, m.invoice_id, v_why
    from unnest(v_chain[1:v_upto]) with ordinality as c(mid, ord)
    join public.subscription_renewal_moves m on m.id = c.mid
   order by c.ord;
  /* R-2848: a together term moved back is not renewed any more — paying again rolls it forward once. */
  update public.renewal_quote_subscriptions l
     set renewed_at = null
    from public.subscription_renewal_moves m
   where m.id = any(v_chain[1:v_upto]) and m.quote_id is not null
     and l.quote_id = m.quote_id and l.subscription_id = v_sub.id and l.renewal_term_date = m.from_date;
  update public.subscription_renewal_moves
     set resolved_at = now(), resolved_why = v_why || ' — moved back to ' || to_char(v_target, 'DD Mon YYYY')
   where subscription_id = v_sub.id and tenant_id = v_sub.tenant_id and direction = 'held' and resolved_at is null;
  return v_upto;
end;
$$;
revoke all on function public.unroll_unpaid_renewal_terms(uuid, text) from public, anon, authenticated;
grant execute on function public.unroll_unpaid_renewal_terms(uuid, text) to service_role;

-- ── 6. Undo / redo triggers for a together quote ──────────────────────────────────────────────────
create or replace function public.r2848_recheck_together(p_quote_id text, p_why text)
returns void
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: after a money event on a together quote — roll forward what is paid and not yet renewed
   (r2848_roll_together: nothing when not paid), then re-check every member with unroll_unpaid_renewal_terms (moves
   an unpaid term back once / holds it / settles a hold). Both directions, so undo and redo are symmetric. */
declare
  v_trusted boolean;
  v_caller  uuid := public.current_tenant_id();
  v_tenant  uuid;
  v_sid     uuid;
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  select l.tenant_id into v_tenant from public.renewal_quote_subscriptions l where l.quote_id = p_quote_id limit 1;
  if v_tenant is null then
    return;   -- not a together quote
  end if;
  if v_caller is not null and v_tenant is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s company', p_quote_id using errcode = '42501';
  end if;
  perform public.r2848_roll_together(p_quote_id);
  for v_sid in
    select l.subscription_id from public.renewal_quote_subscriptions l
     where l.quote_id = p_quote_id and l.released_at is null
     order by l.subscription_id
  loop
    perform public.unroll_unpaid_renewal_terms(v_sid, p_why);
  end loop;
end;
$$;
revoke all on function public.r2848_recheck_together(text, text) from public, anon, authenticated;
grant execute on function public.r2848_recheck_together(text, text) to service_role;

create or replace function public.tg_r2848_invoice_money()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: the tax invoice of a together quote left 'paid' (bank un-reconcile, take-back, void) or became / was issued
   'paid' → re-check the quote (members back once when no longer paid; forward once when paid). */
declare
  v_qid text;
begin
  for v_qid in
    select distinct q.id from public.quotes q
     where q.tenant_id = new.tenant_id and (q.invoice_id = new.id or q.id = new.quote_id)
       and exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = q.id)
  loop
    perform public.r2848_recheck_together(v_qid,
      'invoice ' || new.id || case when tg_op = 'INSERT' then ' issued ' || new.status::text
                                   else ' ' || old.status::text || ' → ' || new.status::text end);
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_r2848_invoice_money() from public, anon, authenticated;

drop trigger if exists invoices_r2848_together_status on public.invoices;
create trigger invoices_r2848_together_status
  after update of status on public.invoices
  for each row
  when ((old.status = 'paid') is distinct from (new.status = 'paid') or (new.status = 'void' and old.status is distinct from 'void'))
  execute function public.tg_r2848_invoice_money();
drop trigger if exists invoices_r2848_together_issued_paid on public.invoices;
create trigger invoices_r2848_together_issued_paid
  after insert on public.invoices
  for each row
  when (new.status = 'paid' and new.quote_id is not null)
  execute function public.tg_r2848_invoice_money();

create or replace function public.tg_r2848_credit_note()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: a credit note on a together quote's invoice added (fully credited → members back once; a part credit note
   leaves the quote paid: nothing moves) or removed (paid again → forward once). */
declare
  v_inv text := coalesce(new.invoice_id, old.invoice_id);
  v_tid uuid := coalesce(new.tenant_id, old.tenant_id);
  v_qid text;
begin
  for v_qid in
    select distinct q.id from public.quotes q
      join public.invoices i on i.id = v_inv and i.tenant_id = q.tenant_id
     where q.tenant_id = v_tid and (q.invoice_id = i.id or q.id = i.quote_id)
       and exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = q.id)
  loop
    perform public.r2848_recheck_together(v_qid,
      'credit note ' || coalesce(new.id, old.id)::text || case when tg_op = 'DELETE' then ' removed' else '' end || ' on invoice ' || v_inv);
  end loop;
  return null;
end;
$$;
revoke all on function public.tg_r2848_credit_note() from public, anon, authenticated;

drop trigger if exists credit_notes_r2848_together_unrenews on public.credit_notes;
create trigger credit_notes_r2848_together_unrenews
  after insert or delete on public.credit_notes
  for each row execute function public.tg_r2848_credit_note();

create or replace function public.tg_r2848_payment_money()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: a received payment on a together quote added / deleted / its status changed (un-reconcile, refund,
   re-reconcile) → re-check the quote (back once when no longer paid; forward once when paid). */
declare
  v_qid text := case when tg_op = 'DELETE' then old.quote_id else new.quote_id end;
begin
  if v_qid is not null and exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = v_qid) then
    perform public.r2848_recheck_together(v_qid,
      'payment ' || coalesce(new.id, old.id)::text || ' on ' || v_qid || ' ' || lower(tg_op));
  end if;
  return null;
end;
$$;
revoke all on function public.tg_r2848_payment_money() from public, anon, authenticated;

drop trigger if exists payments_r2848_together_unrenews on public.payments;
create trigger payments_r2848_together_unrenews
  after delete or update of status on public.payments
  for each row
  when (old.status = 'received' and old.quote_id is not null)
  execute function public.tg_r2848_payment_money();
drop trigger if exists payments_r2848_together_received on public.payments;
create trigger payments_r2848_together_received
  after insert or update of status on public.payments
  for each row
  when (new.status = 'received' and new.quote_id is not null)
  execute function public.tg_r2848_payment_money();

-- ── 7. A quote closed with no money lets go of its subscriptions (rev-r2847 MED-2) ─────────────────
create or replace function public.tg_r2848_quote_closed_unlinks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848 (rev-r2847 MED-2): Cancel (R-2519, stored 'rejected' + cancelled_at), Mark rejected or expired by date, with
   no money received → every subscription linked to it on renewal_quote_id is let go (create_renewal_quote makes a new
   quote instead of handing the dead one back) and a together quote's link rows are released (kept as history). The
   subscriptions let go are written to activity_log so Undo cancel can link them back (quotes_r2848_reopened_relinks).
   NOT for a quote replaced by a revision or combined (superseded_by set — the revision takes the link over, R-2368)
   and not for a closed quote WITH money (the owner settles it). */
declare
  v_ids uuid[];
begin
  if new.superseded_by is not null
     or exists (select 1 from public.payments p where p.quote_id = new.id and p.status = 'received' and p.amount > 0) then
    return new;
  end if;
  with u as (
    update public.subscriptions s
       set renewal_quote_id = null
     where s.tenant_id = new.tenant_id and s.renewal_quote_id = new.id
    returning s.id)
  select array_agg(u.id order by u.id) into v_ids from u;
  update public.renewal_quote_subscriptions l
     set released_at = now()
   where l.quote_id = new.id and l.tenant_id = new.tenant_id and l.released_at is null and l.renewed_at is null;
  if v_ids is not null then
    insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
    values (new.tenant_id, (select u.id from public.users u where u.id = auth.uid()), 'quote.r2848_unlinked', 'quote', new.id,
            left(format('Quote %s closed — %s subscription(s) let go of it', new.id, cardinality(v_ids)), 120),
            jsonb_build_object('subscription_ids', to_jsonb(v_ids), 'status', new.status::text));
  end if;
  return new;
end;
$$;
revoke all on function public.tg_r2848_quote_closed_unlinks() from public, anon, authenticated;

drop trigger if exists quotes_r2848_closed_unlinks on public.quotes;
create trigger quotes_r2848_closed_unlinks
  after update of status, cancelled_at on public.quotes
  for each row
  when ((new.cancelled_at is not null and old.cancelled_at is null)
        or (new.status::text in ('rejected', 'expired') and old.status::text not in ('rejected', 'expired')))
  execute function public.tg_r2848_quote_closed_unlinks();

create or replace function public.tg_r2848_quote_reopened_relinks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848 (code review): Undo cancel (R-2519) of a quote that let go of its subscriptions links them back — else
   paying the reopened quote finds no subscription and (an extension / support-upgrade quote has no
   renewal_subscription_id) would file a NEW subscription. A subscription that has another open quote now → refused. */
declare
  v_ids   uuid[];
  v_s     record;
begin
  select array(select jsonb_array_elements_text(a.changes->'subscription_ids')::uuid) into v_ids
    from public.activity_log a
   where a.tenant_id = new.tenant_id and a.entity = 'quote' and a.entity_id = new.id and a.action = 'quote.r2848_unlinked'
   order by a.created_at desc, a.id desc
   limit 1;
  if v_ids is null or cardinality(v_ids) = 0 then
    return new;
  end if;
  for v_s in
    select s.id, s.plan, s.renewal_quote_id from public.subscriptions s
     where s.id = any(v_ids) and s.tenant_id = new.tenant_id
     order by s.id for update
  loop
    if v_s.renewal_quote_id is not null and v_s.renewal_quote_id <> new.id and public.r2847_quote_live(v_s.renewal_quote_id) then
      raise exception '% now has quote % open — cancel that one first, then undo this cancel.', coalesce(v_s.plan, v_s.id::text), v_s.renewal_quote_id
        using errcode = 'check_violation';
    end if;
    update public.subscriptions set renewal_quote_id = new.id where id = v_s.id and tenant_id = new.tenant_id;
  end loop;
  return new;
end;
$$;
revoke all on function public.tg_r2848_quote_reopened_relinks() from public, anon, authenticated;

drop trigger if exists quotes_r2848_reopened_relinks on public.quotes;
create trigger quotes_r2848_reopened_relinks
  after update of status, cancelled_at on public.quotes
  for each row
  when ((old.cancelled_at is not null and new.cancelled_at is null)
        or (old.status::text in ('rejected', 'expired') and new.status::text not in ('rejected', 'expired') and new.superseded_by is null))
  execute function public.tg_r2848_quote_reopened_relinks();

create or replace function public.tg_r2848_together_quote_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848: a together quote whose links were released (closed) is never reopened — paying it would renew nothing;
   a together quote is never activated on credit (that path files NEW subscriptions from its lines). */
begin
  if not exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = old.id) then
    return new;
  end if;
  if new.credit_activated_at is not null and old.credit_activated_at is null then
    raise exception 'Quote % renews several subscriptions together — it cannot be activated on credit. Record the payment on it instead.', old.id
      using errcode = 'check_violation';
  end if;
  if ((old.cancelled_at is not null and new.cancelled_at is null)
      or (old.status::text in ('rejected', 'expired') and new.status::text not in ('rejected', 'expired')))
     and not exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = old.id and l.released_at is null) then
    raise exception 'Quote % renewed several subscriptions together and was closed, so its subscriptions were freed — it cannot be reopened. Make the renewal quote together again from Renewals.', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.tg_r2848_together_quote_guard() from public, anon, authenticated;

drop trigger if exists quotes_r2848_together_guard on public.quotes;
create trigger quotes_r2848_together_guard
  before update of status, cancelled_at, credit_activated_at on public.quotes
  for each row execute function public.tg_r2848_together_quote_guard();

-- ── 8. A subscription waiting on a together quote is not deleted ──────────────────────────────────
create or replace function public.tg_r2848_no_delete_on_together()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2848 (rev-r2847 left 10): its link row would cascade away and paying the quote would renew the others only. */
declare
  v_qid text;
begin
  select l.quote_id into v_qid
    from public.renewal_quote_subscriptions l
   where l.subscription_id = old.id and l.released_at is null and l.renewed_at is null
     and public.r2847_quote_live(l.quote_id)
   limit 1;
  if v_qid is not null then
    raise exception 'Subscription % is on renewal quote % (billed together with other subscriptions) — cancel that quote first, then delete the subscription.', coalesce(old.plan, old.id::text), v_qid
      using errcode = 'check_violation';
  end if;
  return old;
end;
$$;
revoke all on function public.tg_r2848_no_delete_on_together() from public, anon, authenticated;

drop trigger if exists subscriptions_r2848_no_delete_on_together on public.subscriptions;
create trigger subscriptions_r2848_no_delete_on_together
  before delete on public.subscriptions
  for each row execute function public.tg_r2848_no_delete_on_together();

-- ── 9. One GST invoice, each line its own subscription's period ───────────────────────────────────
create or replace function public.tg_invoice_stamp_line_periods()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_q    jsonb;
  v_sub  jsonb;
  v_rule timestamptz;
begin
  if new.quote_id is null or jsonb_typeof(new.line_items) is distinct from 'array' then return new; end if;
  begin
    select to_jsonb(q) into v_q from public.quotes q
     where q.id = new.quote_id and q.tenant_id = new.tenant_id;
    if v_q is null then return new; end if;

    -- Only an invoice whose lines ARE its quote's lines (the copy trigger, or a caller writing the
    -- same lines): same count, and line by line the same name / qty / rate. A part / instalment /
    -- re-priced invoice that writes its own lines prints no period today (build-props R-375) — it is
    -- left unstamped so it keeps printing exactly that. A line that already carries service_period
    -- (a caller that knows each line's own period) is kept either way.
    if jsonb_typeof(v_q->'line_items') is distinct from 'array'
       or jsonb_array_length(v_q->'line_items') <> jsonb_array_length(new.line_items)
       or exists (
         select 1 from jsonb_array_elements(new.line_items) with ordinality as il(l, i)
          where jsonb_typeof(il.l) = 'object'
            and not (il.l ? 'service_period')
            and ((il.l->'name') is distinct from (v_q->'line_items'->(il.i::int - 1)->'name')
                 or (il.l->'qty') is distinct from (v_q->'line_items'->(il.i::int - 1)->'qty')
                 or (il.l->'rate') is distinct from (v_q->'line_items'->(il.i::int - 1)->'rate'))
       ) then
      return new;
    end if;

    -- loadInvoicePeriodRuleFrom: no row / no table -> the old (day-after) rule.
    begin
      select r.from_at into v_rule from public.app_rule_dates r where r.key = 'r2727_invoice_period_rule';
    exception when undefined_table then
      v_rule := null;
    end;

    /* R-2848: a renewal quote billed together (renewal_quote_subscriptions) — each line carries subscription_id +
       renewal_term_date (R-2847); its period is THAT subscription's next term, by the same rule as a single renewal. */
    if exists (select 1 from public.renewal_quote_subscriptions l where l.quote_id = new.quote_id and l.tenant_id = new.tenant_id) then
      new.line_items := (
        select coalesce(jsonb_agg(
                 case when jsonb_typeof(e.l) = 'object' and not (e.l ? 'service_period')
                           and nullif(e.l->>'subscription_id', '') is not null
                      then e.l || jsonb_build_object('service_period',
                             public.invoice_line_service_period(
                               e.l,
                               v_q || jsonb_build_object('renewal_term_date', e.l->'renewal_term_date'),
                               (select jsonb_build_object('start_date', s.start_date, 'term_months', s.term_months)
                                  from public.subscriptions s
                                 where s.tenant_id = new.tenant_id and s.id::text = e.l->>'subscription_id'),
                               v_rule, coalesce(new.created_at, now())))
                      else e.l end
                 order by e.i), new.line_items)
          from jsonb_array_elements(new.line_items) with ordinality as e(l, i));
      return new;
    end if;

    -- loadRenewedSubscription: renewal_subscription_id, else the row whose renewal_quote_id is this quote.
    if (v_q->'is_renewal') = 'true'::jsonb or (v_q->'is_extension') = 'true'::jsonb then
      select jsonb_build_object('start_date', s.start_date, 'term_months', s.term_months) into v_sub
        from public.subscriptions s
       where s.tenant_id = new.tenant_id
         and case when nullif(v_q->>'renewal_subscription_id', '') is not null
                  then s.id::text = v_q->>'renewal_subscription_id'
                  else s.renewal_quote_id = new.quote_id end
       limit 1;
    end if;

    new.line_items := public.invoice_lines_with_periods(new.line_items, v_q, v_sub, v_rule, coalesce(new.created_at, now()));
  exception when others then
    raise warning '[R-2744] invoice % (quote %): line periods not stored (%), printed by the computed path',
      new.id, new.quote_id, sqlerrm;
  end;
  return new;
end;
$$;
revoke all on function public.tg_invoice_stamp_line_periods() from public, anon, authenticated;


-- ── 10. create_renewal_quote_together: rev-r2847 MED-1 / LOW-4 / LOW-6 ─────────────────────────
create or replace function public.create_renewal_quote_together(
  p_tenant_id uuid,
  p_parts     jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2847: ONE renewal quote for 2+ yearly subscriptions of one customer — see the migration header.
   R-2848 (rev-r2847): tax_rate one of 0/5/12/18/28 (MED-1); each line qty > 0, rate >= 0, item_id empty or this
   company's own item (LOW-4); one customer re-checked after the row locks (LOW-6). */
declare
  v_trusted  boolean;
  v_caller   uuid := public.current_tenant_id();
  v_tenant   uuid;
  v_ids      uuid[];
  v_sorted   uuid[];
  v_n        integer;
  v_ncust    integer;
  v_customer uuid;
  v_names    text;
  v_p        record;
  v_s        record;
  v_q        jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_l        jsonb;
  v_i        integer;
  v_rates    integer[] := '{}'::integer[];
  v_rate     integer;
  v_subtotal integer := 0;
  v_part_sub integer;
  v_part_amt integer;
  v_seats    integer := 0;
  v_pseats   integer;
  v_cost     integer := 0;
  v_months   integer;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_plans    text[] := '{}'::text[];
  v_expires  date;
  v_lead     record;
  v_has_lead boolean := false;
  v_found    text;
  v_other    text;
  v_relinked boolean := false;
  v_tax      integer;
  v_amount   integer;
  v_id       text;
  v_today    date := public.ist_today();
begin
  v_trusted := current_setting('role', true) = 'service_role'
               or (coalesce(current_setting('role', true), 'none') not in ('authenticated', 'anon')
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_anon', 'app_jobs'));
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote.' using errcode = '42501';
  end if;
  if p_tenant_id is null or (v_caller is not null and p_tenant_id is distinct from v_caller) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  v_tenant := p_tenant_id;

  /* Not ready gate (see the header). */
  if not public.r2847_together_payment_ready() then
    raise exception 'One renewal quote for several yearly subscriptions is not ready on this server yet — make each renewal quote on its own for now.'
      using errcode = '0A000';
  end if;

  if p_parts is null or jsonb_typeof(p_parts) <> 'array' then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  /* The subscriptions, each once, in the order asked (the first leads the quote's name and domain). */
  begin
    select array_agg(t.id order by t.n) into v_ids
      from (select (e->>'subscription_id')::uuid as id, min(o) as n
              from jsonb_array_elements(p_parts) with ordinality x(e, o)
             where jsonb_typeof(e) = 'object' and nullif(e->>'subscription_id', '') is not null
             group by 1) t;
  exception when invalid_text_representation then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end;
  if coalesce(cardinality(v_ids), 0) < 2 then
    raise exception 'Pick at least two subscriptions to renew together.' using errcode = '22023';
  end if;
  if cardinality(v_ids) <> jsonb_array_length(p_parts) then
    raise exception 'Each subscription can be on the quote only once — pick each one once.' using errcode = '22023';
  end if;
  /* Another company's subscription reads exactly like one that does not exist (no "is this id real?" oracle). */
  select count(*) into v_n from public.subscriptions s where s.id = any(v_ids) and s.tenant_id = v_tenant;
  if v_n < cardinality(v_ids) then
    raise exception 'A subscription to renew was not found — refresh Renewals and try again.' using errcode = 'no_data_found';
  end if;
  select string_agg(s.plan, ', ' order by s.plan) into v_names
    from public.subscriptions s where s.id = any(v_ids) and s.customer_id is null;
  if v_names is not null then
    raise exception '% is not linked to a customer — link it to a customer first, then renew together.', v_names using errcode = '22023';
  end if;
  select count(distinct s.customer_id), min(s.customer_id::text)::uuid, string_agg(distinct coalesce(s.customer_name, '?'), ', ')
    into v_ncust, v_customer, v_names
    from public.subscriptions s where s.id = any(v_ids);
  if v_ncust <> 1 then
    raise exception 'Subscriptions of different customers cannot be on one renewal quote (%) — renew together only one customer''s subscriptions.', v_names
      using errcode = '22023';
  end if;

  /* Two calls at once: one at a time per customer, then the subscriptions' rows in id order. */
  perform pg_advisory_xact_lock(hashtextextended('r2847:renewal-together:' || v_tenant::text || ':' || v_customer::text, 0));
  perform 1 from public.subscriptions s where s.id = any(v_ids) order by s.id for update;
  select array_agg(x order by x) into v_sorted from unnest(v_ids) x;
  /* R-2848 (rev-r2847 LOW-6): the customer read above was before the row locks — a subscription moved to another
     customer meanwhile is caught here. */
  if exists (select 1 from public.subscriptions s where s.id = any(v_ids) and s.customer_id is distinct from v_customer) then
    raise exception 'A subscription changed customer while this renewal quote was being made — refresh Renewals and try again.' using errcode = '22023';
  end if;

  /* The same set again → that quote (a retry, a second click, a second tab); a lost link is put back. Only while EVERY
     subscription on it is still at the term it was quoted for, active and renewing (rev: one member moved or Won't
     renew → never relinked to an old term). */
  select l.quote_id into v_found
    from public.renewal_quote_subscriptions l
   where l.tenant_id = v_tenant and l.subscription_id = any(v_ids) and l.released_at is null
     /* an OPEN quote only — a closed one that took money still holds the terms (refused below), it is never handed
        back as "the quote" */
     and exists (select 1 from public.quotes qo where qo.id = l.quote_id and qo.cancelled_at is null
                   and qo.superseded_by is null and qo.status::text not in ('rejected', 'expired'))
     and v_sorted = (select array_agg(l2.subscription_id order by l2.subscription_id)
                       from public.renewal_quote_subscriptions l2 where l2.quote_id = l.quote_id and l2.released_at is null)
     and not exists (select 1 from public.renewal_quote_subscriptions l3
                       join public.subscriptions s3 on s3.id = l3.subscription_id
                      where l3.quote_id = l.quote_id and l3.released_at is null
                        and (s3.renewal_date is distinct from l3.renewal_term_date or s3.status::text <> 'active'
                             or s3.auto_renew is false))
   limit 1;
  if v_found is not null then
    select string_agg(s.plan || ' (' || s.renewal_quote_id || ')', ', ' order by s.plan) into v_other
      from public.subscriptions s
     where s.id = any(v_ids) and s.renewal_quote_id is not null and s.renewal_quote_id <> v_found
       and public.r2847_quote_live(s.renewal_quote_id);
    if v_other is not null then
      raise exception 'Another renewal quote is open for % — cancel it first; renewal quote % already renews these subscriptions together.', v_other, v_found
        using errcode = '22023';
    end if;
    update public.subscriptions s set renewal_quote_id = v_found
     where s.id = any(v_ids) and s.tenant_id = v_tenant
       and (s.renewal_quote_id is null or (s.renewal_quote_id <> v_found and not public.r2847_quote_live(s.renewal_quote_id)));
    v_relinked := found;
    select to_jsonb(q.*) into v_q from public.quotes q where q.id = v_found;
    return jsonb_build_object('quote_id', v_found, 'created', false, 'relinked', v_relinked, 'already_existed', true,
      'amount', v_q->'amount', 'subtotal', v_q->'subtotal', 'tax_rate', v_q->'tax_rate', 'discount_pct', v_q->'discount_pct',
      'line_items', v_q->'line_items', 'subscription_ids', to_jsonb(v_ids));
  end if;

  /* Each subscription, as asked. */
  for v_p in
    select (e->>'subscription_id')::uuid as sub_id, e->'quote' as q, o::int as n
      from jsonb_array_elements(p_parts) with ordinality x(e, o)
     order by o
  loop
    select s.id, s.plan, s.seats, s.status::text as status, s.billing_cycle::text as cycle, s.term_months, s.renewal_date,
           s.auto_renew, s.renewal_quote_id, s.customer_name, s.domain
      into v_s
      from public.subscriptions s where s.id = v_p.sub_id;
    if v_s.status <> 'active' then
      raise exception '% is % — only an active subscription can be renewed together.', v_s.plan, v_s.status using errcode = '22023';
    end if;
    if v_s.cycle is distinct from 'yearly' or coalesce(v_s.term_months, 12) <> 12 then
      raise exception '% is not a yearly subscription billed once a year — subscriptions billed in parts are billed together with Bill together on their parts.', v_s.plan
        using errcode = '22023';
    end if;
    if v_s.auto_renew is false then
      raise exception '% is marked Won''t renew — press Undo Won''t renew on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_date is null then
      raise exception '% has no renewal date — set it on the subscription first.', v_s.plan using errcode = '22023';
    end if;
    if v_s.renewal_quote_id is not null and public.r2847_quote_live(v_s.renewal_quote_id) then
      raise exception 'Renewal quote % is still open (or has money received on it) for % — cancel it or record the rest of the payment on it first, then renew together.', v_s.renewal_quote_id, v_s.plan
        using errcode = '22023';
    end if;
    select l.quote_id into v_other
      from public.renewal_quote_subscriptions l
     where l.subscription_id = v_s.id and l.renewal_term_date = v_s.renewal_date and l.released_at is null
       and public.r2847_quote_live(l.quote_id)
     limit 1;
    if v_other is not null then
      raise exception '% is already on renewal quote % (billed together with other subscriptions) — cancel % first, then renew together.', v_s.plan, v_other, v_other
        using errcode = '22023';
    end if;
    select q.id into v_other
      from public.quotes q
     where q.tenant_id = v_tenant and q.renewal_subscription_id = v_s.id and q.renewal_term_date = v_s.renewal_date
       and public.r2847_quote_live(q.id)
     limit 1;
    if v_other is not null then
      raise exception 'Renewal quote % was already made for % (due %) — cancel it first, then renew together.', v_other, v_s.plan, to_char(v_s.renewal_date, 'DD Mon YYYY')
        using errcode = '22023';
    end if;

    /* The app's price for this subscription's renewal (create_renewal_quote's rules). */
    v_q := v_p.q;
    if v_q is null or jsonb_typeof(v_q) <> 'object' then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    v_part_sub := nullif(v_q->>'subtotal', '')::integer;
    v_part_amt := nullif(v_q->>'amount', '')::integer;
    if v_part_sub is null or v_part_sub <= 0 or v_part_amt is null or v_part_amt <= 0 then
      raise exception 'The renewal of % has no price, so no quote was made. Check the plan price in Items, then try again.', v_s.plan using errcode = '22023';
    end if;
    if jsonb_typeof(v_q->'line_items') is distinct from 'array' or jsonb_array_length(v_q->'line_items') = 0 then
      raise exception 'The renewal of % has no line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    v_months := coalesce(nullif(v_q->>'extension_months', '')::integer, 12);
    if v_months <> 12 then
      raise exception 'The renewal of % is for % months — only one-year renewals can be on one quote together.', v_s.plan, v_months using errcode = '22023';
    end if;
    v_pseats := nullif(v_q->>'seats', '')::integer;
    /* R-2613 (rule N5), read under the row lock: a cut scheduled for this renewal → priced at the cut's seats. */
    v_cut := public.r2613_applying_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date);
    /* Coordinator decision (15 Nov): never trust the caller's seats — with no cut the part is for the subscription's
       own seats (createRenewalQuote's quoteSeats), and its lines' qty add up to them. */
    if v_cut.id is null and v_pseats is distinct from v_s.seats
       and not public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The renewal of % was priced for % seats, but the subscription has % seats, so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown'), v_s.seats using errcode = '22023';
    end if;
    if (select sum(coalesce(nullif(e->>'qty', '')::numeric, 1)) from jsonb_array_elements(v_q->'line_items') e
         where jsonb_typeof(e) = 'object') is distinct from v_pseats::numeric then
      raise exception 'The renewal of % does not add up (its lines are not for % seats), so no quote was made. Try again from Renewals.',
        v_s.plan, coalesce(v_pseats::text, 'unknown') using errcode = '22023';
    end if;
    if v_cut.id is not null and v_pseats is distinct from v_cut.seats_after then
      raise exception 'A seat cut to % seats is scheduled for % on % while its renewal was priced for % seats, so no quote was made. Try again — it is priced with the cut.',
        v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), v_s.plan, coalesce(v_pseats::text, 'unknown')
        using errcode = 'check_violation';
    end if;
    if v_cut.id is null and public.r2613_removed_seat_cut(v_tenant, v_s.id, v_s.seats, v_s.renewal_date, v_pseats) then
      raise exception 'The seat cut to % seats on % was removed while its renewal was being priced, so no quote was made. Try again — it is priced for % seats.',
        v_pseats, v_s.plan, v_s.seats
        using errcode = 'check_violation';
    end if;

    /* R-2848 (rev-r2847 MED-1): only an Indian GST rate. */
    if coalesce(nullif(v_q->>'tax_rate', '')::integer, 18) not in (0, 5, 12, 18, 28) then
      raise exception 'The renewal of % has GST at % — only 0, 5, 12, 18 or 28%% can be on a quote. Check the plan''s GST in Items, then try again.',
        v_s.plan, (v_q->>'tax_rate') || '%' using errcode = '22023';
    end if;
    /* R-2848 (rev-r2847 LOW-4): every line for at least one seat at a price of 0 or more, and an item of this company. */
    if exists (select 1 from jsonb_array_elements(v_q->'line_items') e
                where jsonb_typeof(e) = 'object'
                  and (coalesce(nullif(e->>'qty', '')::numeric, 1) <= 0
                       or coalesce(nullif(e->>'rate', '')::numeric, 0) < 0
                       or (nullif(e->>'item_id', '') is not null
                           and not exists (select 1 from public.items i where i.id = e->>'item_id' and i.tenant_id = v_tenant)))) then
      raise exception 'The renewal of % has a line with no seats, a price below 0 or an item that is not in your Items, so no quote was made. Try again from Renewals.',
        v_s.plan using errcode = '22023';
    end if;
    v_rates := v_rates || coalesce(nullif(v_q->>'tax_rate', '')::integer, 18);
    v_subtotal := v_subtotal + v_part_sub;
    v_seats := v_seats + coalesce(v_pseats, 0);
    v_cost := v_cost + coalesce(nullif(v_q->>'total_cost', '')::integer, 0);
    v_plans := v_plans || coalesce(nullif(v_q->>'plan', ''), v_s.plan);
    v_expires := least(coalesce(v_expires, nullif(v_q->>'expires_date', '')::date), nullif(v_q->>'expires_date', '')::date);
    if not v_has_lead then
      v_lead := v_s;
      v_has_lead := true;
    end if;
    /* rev: the lines must add up to the part's subtotal (qty × rate, as createRenewalQuote builds them), and the part's
       amount must be that subtotal + its GST (±₹1 rounding) — a quote whose lines show another price than it charges
       is refused. */
    if exists (select 1 from jsonb_array_elements(v_q->'line_items') e where jsonb_typeof(e) <> 'object') then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end if;
    begin
      if (select round(sum(coalesce(nullif(e->>'qty', '')::numeric, 1) * coalesce(nullif(e->>'rate', '')::numeric, 0)))
            from jsonb_array_elements(v_q->'line_items') e) is distinct from v_part_sub
         or abs(v_part_amt - (v_part_sub + round(v_part_sub * coalesce(nullif(v_q->>'tax_rate', '')::integer, 18) / 100.0))) > 1 then
        raise exception 'The renewal of % does not add up (its lines, subtotal ₹% and amount ₹% differ), so no quote was made. Try again from Renewals.',
          v_s.plan, v_part_sub, v_part_amt using errcode = '22023';
      end if;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'The renewal of % has a broken line, so no quote was made. Try again from Renewals.', v_s.plan using errcode = '22023';
    end;
    v_i := 0;
    for v_l in select e from jsonb_array_elements(v_q->'line_items') e loop
      v_i := v_i + 1;
      /* security review: only the keys createRenewalQuote builds are kept — a caller-sent billing_id / plan_change /
         bulk / one_time / years key would make other money code (part-request guards, record_payment's plan-change
         and bulk paths, R-2710 years) read this quote as something it is not. */
      v_l := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_l) x(k, v)
               where k in ('name', 'description', 'item_id', 'qty', 'rate', 'cost', 'commitment', 'hsn', 'sac', 'unit'));
      v_lines := v_lines || jsonb_build_array(v_l || jsonb_build_object(
        'id',                'renewal-' || v_p.n::text || '-' || v_i::text,
        'subscription_id',   v_s.id::text,
        'renewal_term_date', v_s.renewal_date,
        'period_start',      v_s.renewal_date,
        'period_end',        ((v_s.renewal_date + make_interval(months => v_months))::date - 1)));
    end loop;
  end loop;

  if (select count(distinct r) from unnest(v_rates) r) > 1 then
    raise exception 'Subscriptions with different GST rates cannot be on one renewal quote (%) — make their renewal quotes separately.',
      (select string_agg(distinct r::text || '%', ' and ') from unnest(v_rates) r) using errcode = '22023';
  end if;
  v_rate   := v_rates[1];
  v_tax    := round(v_subtotal * v_rate / 100.0);
  v_amount := v_subtotal + v_tax;

  /* A closed together quote (no money on it) no longer holds its subscriptions' terms: ALL its rows are released
     together (kept as history, never deleted). */
  update public.renewal_quote_subscriptions l
     set released_at = now()
   where l.tenant_id = v_tenant and l.released_at is null
     and l.quote_id in (select l2.quote_id from public.renewal_quote_subscriptions l2
                         where l2.tenant_id = v_tenant and l2.subscription_id = any(v_ids) and l2.released_at is null)
     and not public.r2847_quote_live(l.quote_id);

  v_id := public.next_document_number('quote', v_tenant);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_tenant, v_customer, v_lead.customer_name, array_to_string(v_plans, ' + '), v_seats, v_amount, 'sent', 'awaiting',
    null, v_lead.domain, v_today, v_expires, v_lines, v_subtotal, v_cost,
    0, v_rate, true, 12,
    'Renewal of ' || array_to_string(v_plans, ' + ') || ' — billed together on one quote.',
    null, null
  );

  insert into public.renewal_quote_subscriptions
    (tenant_id, quote_id, subscription_id, renewal_term_date, extension_months, subtotal, seats, line_no)
  select v_tenant, v_id, s.id, s.renewal_date, 12, nullif(e->'quote'->>'subtotal', '')::integer,
         nullif(e->'quote'->>'seats', '')::integer, o::int
    from jsonb_array_elements(p_parts) with ordinality x(e, o)
    join public.subscriptions s on s.id = (e->>'subscription_id')::uuid;

  update public.subscriptions s set renewal_quote_id = v_id
   where s.id = any(v_ids) and s.tenant_id = v_tenant;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, (select u.id from public.users u where u.id = auth.uid()), 'quote.renewal_together', 'quote', v_id,
          left(format('Renewal quote %s for %s together', v_id, array_to_string(v_plans, ' + ')), 120),
          jsonb_build_object('subscription_ids', to_jsonb(v_ids), 'subtotal', v_subtotal, 'tax_rate', v_rate, 'amount', v_amount));

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false, 'already_existed', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'tax_rate', v_rate, 'tax', v_tax, 'discount_pct', 0,
    'line_items', v_lines, 'subscription_ids', to_jsonb(v_ids));
end;
$$;
revoke all on function public.create_renewal_quote_together(uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote_together(uuid, jsonb) to authenticated, service_role;

-- ── 11. create_renewal_quote: rev-r2847 MED-1 ─────────────────────────────────────────────────
create or replace function public.create_renewal_quote(
  p_subscription_id uuid,
  p_tenant_id       uuid,
  p_quote           jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1574: ONE transaction — lock the subscription, reuse its quote or make one and link it.
   R-2613: a scheduled end-of-term seat cut is re-read under that lock — a quote (new or re-linked)
   at other seats than the cut's is refused (rule N5).
   R-2710: p_quote.status = 'draft' makes the NEW quote a draft ("Review renewal quote" opens it in
   the editor; nothing is emailed). Anything else — the cron, Send now, old callers — 'sent' as before.
   An existing / re-linked quote is returned as it is (its status is never changed here).
   R-2847: a renewal quote billed together for this term (renewal_quote_subscriptions) whose link was lost is linked
   again and returned — never a second quote for the same term.
   R-2848 (rev-r2847 MED-1): a new quote's tax_rate must be 0, 5, 12, 18 or 28. */
declare
  v_trusted  boolean;
  v_caller   uuid;
  v_sub      record;
  v_q        record;
  v_id       text;
  v_amount   integer;
  v_subtotal integer;
  v_tax      integer;
  v_lines    jsonb;
  v_cut      public.subscription_seat_reductions%rowtype;
  v_seats    integer;
  v_status   public.quote_status;   -- R-2710
  v_tl       record;                -- R-2847
begin
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company context — sign in again, then generate the renewal quote.' using errcode = '28000';
  end if;
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can make a renewal quote. Ask one of them to press "Generate renewal quote" on the subscription.' using errcode = '42501';
  end if;
  if p_subscription_id is null or p_tenant_id is null then
    raise exception 'A renewal quote needs its subscription and company. Open the subscription and press "Generate renewal quote" again.' using errcode = '22004';
  end if;

  select s.id, s.tenant_id, s.renewal_date, s.renewal_quote_id, s.customer_id, s.customer_name, s.seats
    into v_sub
    from public.subscriptions s
   where s.id = p_subscription_id
   for update;
  if not found then
    raise exception 'Subscription % was not found, so no renewal quote was made. Refresh the Renewals page and try again.', p_subscription_id using errcode = 'P0002';
  end if;
  if v_sub.tenant_id <> p_tenant_id or (v_caller is not null and v_sub.tenant_id <> v_caller) then
    raise exception 'Subscription % belongs to another company, so no renewal quote was made. Open it from your own Renewals page.', p_subscription_id using errcode = '42501';
  end if;
  if v_sub.renewal_date is null then
    raise exception 'Subscription % has no renewal date, so its renewal quote cannot be made. Set the renewal date on the subscription first.', p_subscription_id using errcode = '22004';
  end if;

  -- 1. Already linked → that quote (also an extension quote: one open renewal at a time).
  if v_sub.renewal_quote_id is not null then
    select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items
      into v_q
      from public.quotes q
     where q.id = v_sub.renewal_quote_id and q.tenant_id = v_sub.tenant_id;
    if found then
      return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', false,
        'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
        'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
    end if;
  end if;

  /* R-2613: the cut scheduled for this renewal, read AFTER the row lock above — a cut saved while
     the app was pricing this quote is seen here (reduce_subscription_seats locks the same row). */
  v_cut := public.r2613_applying_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date);

  /* R-2847: a renewal quote billed together for this term that lost its link → link it again, make nothing. The link
     guard (r2613_quote_link_guard) checks a scheduled cut against THIS subscription's seats on it. */
  select l.quote_id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items
    into v_tl
    from public.renewal_quote_subscriptions l
    join public.quotes q on q.id = l.quote_id
   where l.tenant_id = v_sub.tenant_id and l.subscription_id = v_sub.id and l.renewal_term_date = v_sub.renewal_date
     and l.released_at is null and public.r2847_quote_live(l.quote_id)
   limit 1;
  if found then
    update public.subscriptions set renewal_quote_id = v_tl.quote_id
     where id = v_sub.id and tenant_id = v_sub.tenant_id;
    return jsonb_build_object('quote_id', v_tl.quote_id, 'created', false, 'relinked', true,
      'amount', v_tl.amount, 'subtotal', v_tl.subtotal, 'discount_pct', v_tl.discount_pct,
      'tax_rate', v_tl.tax_rate, 'line_items', v_tl.line_items);
  end if;

  -- 2. A quote already made for THIS term that lost its link → link it again, make nothing.
  select q.id, q.amount, q.subtotal, q.discount_pct, q.tax_rate, q.line_items, q.seats
    into v_q
    from public.quotes q
   where q.tenant_id = v_sub.tenant_id
     and q.renewal_subscription_id = v_sub.id
     and q.renewal_term_date = v_sub.renewal_date
   limit 1;
  if found then
    if v_cut.id is not null and v_q.seats is distinct from v_cut.seats_after then
      raise exception 'Renewal quote % for this term is for % seats, but a seat cut to % seats is scheduled for % — so it was not linked. Delete that quote, then generate the renewal quote again (it is made with the cut).',
        v_q.id, coalesce(v_q.seats::text, 'unknown'), v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY')
        using errcode = 'check_violation';
    end if;
    update public.subscriptions set renewal_quote_id = v_q.id
     where id = v_sub.id and tenant_id = v_sub.tenant_id;
    return jsonb_build_object('quote_id', v_q.id, 'created', false, 'relinked', true,
      'amount', v_q.amount, 'subtotal', v_q.subtotal, 'discount_pct', v_q.discount_pct,
      'tax_rate', v_q.tax_rate, 'line_items', v_q.line_items);
  end if;

  -- 3. Make it. Refuse a quote with nothing to pay rather than store one.
  v_amount   := nullif(p_quote->>'amount', '')::integer;
  v_subtotal := nullif(p_quote->>'subtotal', '')::integer;
  v_tax      := coalesce(nullif(p_quote->>'tax_rate', '')::integer, 18);
  v_lines    := p_quote->'line_items';
  v_status   := case when p_quote->>'status' = 'draft' then 'draft' else 'sent' end;   -- R-2710
  if v_amount is null or v_amount <= 0 or v_subtotal is null or v_subtotal <= 0 then
    raise exception 'The renewal quote for subscription % has no price, so it was not made. Check the plan price in Items, then generate it again.', p_subscription_id using errcode = '22023';
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0 then
    raise exception 'The renewal quote for subscription % has no line, so it was not made. Generate it again from the subscription.', p_subscription_id using errcode = '22023';
  end if;
  /* R-2848 (rev-r2847 MED-1): only an Indian GST rate. */
  if v_tax not in (0, 5, 12, 18, 28) then
    raise exception 'The renewal quote for subscription % has GST at % — only 0, 5, 12, 18 or 28%% can be on a quote. Check the plan''s GST in Items, then generate it again.',
      p_subscription_id, v_tax::text || '%' using errcode = '22023';
  end if;
  /* R-2613: priced before the cut was saved → refused before a quote number is taken. */
  v_seats := nullif(p_quote->>'seats', '')::integer;
  if v_cut.id is not null and v_seats is distinct from v_cut.seats_after then
    raise exception 'A seat cut to % seats was scheduled for % while this renewal quote was being made for % seats, so it was not made. Generate the renewal quote again — it is made with the cut.',
      v_cut.seats_after, to_char(v_cut.effective_date, 'DD Mon YYYY'), coalesce(v_seats::text, 'unknown')
      using errcode = 'check_violation';
  end if;
  /* R-2613 (the other way round): priced WITH a cut that was removed meanwhile → it would bill
     fewer seats than the customer keeps, and paying it would drop the seats (rule N1). */
  if v_cut.id is null and public.r2613_removed_seat_cut(v_sub.tenant_id, v_sub.id, v_sub.seats, v_sub.renewal_date, v_seats) then
    raise exception 'The seat cut to % seats for % was removed while this renewal quote was being made, so it was not made. Generate the renewal quote again — it is made for % seats.',
      v_seats, to_char(v_sub.renewal_date, 'DD Mon YYYY'), v_sub.seats
      using errcode = 'check_violation';
  end if;

  v_id := public.next_document_number('quote', v_sub.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued, so no renewal quote was made. Check Settings → Document numbering, then try again.' using errcode = 'P0001';
  end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, status, payment_status,
    owner_id, domain, created_date, expires_date, line_items, subtotal, total_cost,
    discount_pct, tax_rate, is_renewal, extension_months, notes,
    renewal_subscription_id, renewal_term_date
  ) values (
    v_id, v_sub.tenant_id, v_sub.customer_id,
    coalesce(nullif(p_quote->>'customer_name', ''), v_sub.customer_name),
    p_quote->>'plan',
    nullif(p_quote->>'seats', '')::integer,
    v_amount, v_status, 'awaiting',  -- R-2710: 'draft' only when asked (Review renewal quote)
    null,
    nullif(p_quote->>'domain', ''),
    coalesce(nullif(p_quote->>'created_date', '')::date, (now() at time zone 'Asia/Kolkata')::date),
    nullif(p_quote->>'expires_date', '')::date,
    v_lines,
    v_subtotal,
    coalesce(nullif(p_quote->>'total_cost', '')::integer, 0),
    0,
    v_tax,
    true,
    coalesce(nullif(p_quote->>'extension_months', '')::integer, 12),
    p_quote->>'notes',
    v_sub.id, v_sub.renewal_date
  );

  update public.subscriptions set renewal_quote_id = v_id
   where id = v_sub.id and tenant_id = v_sub.tenant_id;

  return jsonb_build_object('quote_id', v_id, 'created', true, 'relinked', false,
    'amount', v_amount, 'subtotal', v_subtotal, 'discount_pct', 0,
    'tax_rate', v_tax, 'line_items', v_lines);
end;
$function$;

revoke all on function public.create_renewal_quote(uuid, uuid, jsonb) from public, anon;
grant execute on function public.create_renewal_quote(uuid, uuid, jsonb) to authenticated, service_role;

-- ── 12. Open R-2847's gate — last: record_payment and the readers above now handle the link rows ──
create or replace function public.r2847_together_payment_ready()
returns boolean
language sql
immutable
set search_path = public
as $$
  select true;   -- R-2848: record_payment renews every linked subscription (r2848_roll_together)
$$;
revoke all on function public.r2847_together_payment_ready() from public, anon;
grant execute on function public.r2847_together_payment_ready() to authenticated, service_role;

commit;
