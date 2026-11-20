-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'subscription_billings' and column_name = 'due_on') and to_regprocedure('public.open_part_requests(uuid,uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)') and prosrc like '%R-2230%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.activate_quote_on_credit(text,integer,boolean,text)') and prosrc like '%R-2230%')
-- deploy-key: r2230partduedates
-- 20261101184900_r2230_part_due_dates.sql
--
-- R-2230 (Zoho Billing audit A6, 1 Nov 2026): every payment-request part has a due date.
-- A subscription billed in parts gets a payment request (a quote, R-2044) for each part. The part
-- showed "Rs 1,632 due · No payment due date", and the customer page said "Unpaid invoices now
-- Rs 0" next to Outstanding Rs 1,632 — so the pay-later limit and follow-up missed it.
--
-- ─── WHAT CHANGES ────────────────────────────────────────────────────────────────────────
--   subscription_billings.due_on      the date the part's payment request is due. Written when
--                                     the request is made (every part of a grouped request).
--   part_request_terms_days(sub)      the ONE terms rule for a part request: the customer's
--                                     payment terms, else the sale quote's, else 0 (R-2044: the
--                                     request is prepaid, due on the part's first day). Invoices
--                                     keep their own rule (quote terms, else 30) — unchanged.
--   bill_subscription_instalment      a new request is due on part start + those terms; the
--                                     request carries the terms (payment_terms_days) and its text
--                                     says "Due on <date>". Body of 20261030123423 (R-2095), only
--                                     the request branch touched.
--   open_part_requests(customer, sub) what each open part request still owes and when it is due
--                                     (one row per part; is_lead = one row per request, sum those).
--                                     SECURITY INVOKER — row security keeps it to the caller's company.
--   activate_quote_on_credit          "already owed" for the credit limit = unpaid invoices + what
--                                     open part requests still owe. Body of 20261029045403 (R-2097),
--                                     only that sum touched.
--   Backfill (derived, no money): parts that already have a request get due_on = their bill date +
--   the request's own payment terms — exactly the date the request already told the customer
--   ("Due on <bill date>", terms 0). Amounts, GST, invoices and payments are not touched.
-- Test: supabase/tests/r2230_part_due_dates.test.sql

begin;

-- ── 1. The due date on the part ────────────────────────────────────────────────────────
alter table public.subscription_billings add column if not exists due_on date;
comment on column public.subscription_billings.due_on is
  'R-2230: when this part''s payment request is due (part start + part_request_terms_days). Set when the request is made; null = no request yet.';

-- ── 2. The one terms rule for a part request ───────────────────────────────────────────
create or replace function public.part_request_terms_days(p_subscription_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  /* R-2230: customer terms, else the sale quote's, else 0 (R-2044 prepaid). Never negative. */
  select greatest(0, coalesce(
           (select c.payment_terms_days from public.subscriptions s
              join public.customers c on c.id = s.customer_id
             where s.id = p_subscription_id),
           (select q.payment_terms_days from public.subscriptions s
              join public.quotes q on q.id = s.quote_id
             where s.id = p_subscription_id),
           0));
$$;
revoke all on function public.part_request_terms_days(uuid) from public, anon, authenticated;
grant execute on function public.part_request_terms_days(uuid) to service_role;

-- ── 3. What open part requests still owe ───────────────────────────────────────────────
create or replace function public.open_part_requests(p_customer_id uuid default null, p_subscription_id uuid default null)
returns table (quote_id text, customer_id uuid, subscription_id uuid, billing_id uuid,
               term_start date, period_index integer, due_on date, still_due integer, is_lead boolean)
language sql
stable
security invoker
set search_path = public
as $$
  /* R-2230. Open = a part request (subscription_billing_id set), sent / viewed / accepted
     ("Customer stopped" rejects it; a part paid another way expires it), no invoice yet (paying it
     raises the invoice), and money still due (amount − received payments, the
     bill_subscription_instalment rule). One row per part the request covers (R-2092 groups name
     theirs in line_items.billing_id); still_due is the REQUEST's, so a total sums is_lead rows. */
  with req as (
    select q.id, q.customer_id, q.subscription_billing_id as lead_id, q.line_items,
           greatest(0, coalesce(q.amount, 0)
                       - coalesce((select sum(p.amount) from public.payments p
                                    where p.quote_id = q.id and p.status = 'received'), 0))::integer as still_due
      from public.quotes q
     where q.subscription_billing_id is not null
       and q.invoice_id is null
       and q.status in ('sent', 'viewed', 'accepted')
       and (p_customer_id is null or q.customer_id = p_customer_id)
  ), parts as (
    select r.id as quote_id, r.lead_id as billing_id from req r
    union
    select r.id, b.id
      from req r
      cross join lateral jsonb_array_elements(case when jsonb_typeof(r.line_items) = 'array' then r.line_items else '[]'::jsonb end) li
      join public.subscription_billings b on b.id::text = li->>'billing_id'
  )
  select r.id, r.customer_id, b.subscription_id, b.id, b.term_start, b.period_index,
         coalesce(lead.due_on, lead.bill_on), r.still_due, b.id = r.lead_id
    from req r
    join parts p on p.quote_id = r.id
    join public.subscription_billings b on b.id = p.billing_id
    join public.subscription_billings lead on lead.id = r.lead_id
   where r.still_due > 0
     and (p_subscription_id is null or b.subscription_id = p_subscription_id);
$$;
revoke all on function public.open_part_requests(uuid, uuid) from public, anon;
grant execute on function public.open_part_requests(uuid, uuid) to authenticated, service_role;

-- ── 4. bill_subscription_instalment — the request is due on part start + terms ─────────
create or replace function public.bill_subscription_instalment(p_billing_id uuid, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2044: invoice a paid part or make its payment request — once. R-2048: the sale quote's first part only when money covers it; an open unpaid sale quote IS its request. R-2092: the quote's parts for one period are ONE group — one invoice, one request, the quote's money pool; none billed while a sibling's parts are not laid (R-2092 siblings laid). R-2095: a part freed by credit notes is billed afresh. R-2095 (Sept): the first part of a sale booked from a bank receipt (invoice_on_receipt) is invoiced once any money came in. R-2230: a new request is due on the part start + the payment terms (customer, else the sale quote, else 0 — prepaid, R-2044), stored on its parts (subscription_billings.due_on). */
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
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
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
         s.billing_cycle::text as cycle
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
  v_due   := v_b.period_start + v_terms;

  v_id := public.next_document_number('quote', v_b.tenant_id);
  if v_id is null then
    raise exception 'No quote number could be issued for the payment request of billing part %. Check Settings → Document numbering.', p_billing_id;
  end if;
  /* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive (schedule.ts). */
  v_period := to_char(v_b.period_start, 'FMDD Mon') || '–' || to_char(v_b.period_end - 1, 'FMDD Mon YYYY');
  v_label := 'Advance payment for '
             || case v_sub.cycle when 'quarterly' then 'Q' || v_b.period_index::text
                                 when 'half_yearly' then 'H' || v_b.period_index::text
                                 else 'month ' || v_b.period_index::text end
             || ' · ' || v_period;

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
                'name',        v_label,
                'description', coalesce(x->>'plan', 'Subscription') || ' · ' || coalesce(x->>'seats', '0') || ' seats',
                'qty',         1,
                'rate',        (x->>'taxable')::integer,
                'cost',        0,
                'one_time',    true,
                'billing_id',  x->>'billing_id') order by n)
         from jsonb_array_elements(v_lines) with ordinality t(x, n))
    else
      jsonb_build_array(jsonb_build_object(
        'id',          'part-' || v_b.period_index::text,
        'name',        v_label,
        'description', coalesce(v_sub.plan, 'Subscription') || ' · ' || coalesce(v_sub.seats, 0)::text || ' seats',
        'qty',         1,
        'rate',        v_b.taxable_amount,
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

-- ── 5. activate_quote_on_credit — open part requests count toward the credit limit ─────
create or replace function public.activate_quote_on_credit(
  p_quote_id text,
  p_credit_days integer,
  p_approve_over_limit boolean default false,
  p_annual_override_reason text default null   -- R-368
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  /* R-2097: a yearly price not divisible by 12 stores a fractional monthly tier; read it as numeric */
  v_uid              uuid := auth.uid();
  v_caller_tenant    uuid;
  v_is_owner         boolean;
  v_quote            record;
  v_cust             record;
  v_lead             record;
  v_tenant_id        uuid;
  v_customer_id      uuid;
  v_received         integer;
  v_limit            integer;
  v_owed             integer;
  v_this             integer;
  v_exposure         integer;
  v_over             boolean;
  v_today            date := public.ist_today();
  v_due              date;
  v_invoice_id       text;
  v_balance          integer;
  v_owner            uuid;
  v_who              text;
  v_t1               timestamptz;
  v_t2               timestamptz;
  v_t3               timestamptz;
  v_expected         integer;
  v_domain           text;
  v_subs_created     integer := 0;
  v_pos              text[] := array[]::text[];
  -- subscription loop (same names/rules as record_payment)
  v_line_idx         integer;
  v_first_line       jsonb;
  v_commitment       text;
  v_plan_name        text;
  v_plan_lower       text;
  v_is_annual        boolean;
  v_is_monthly       boolean;
  v_vendor           public.vendor;
  v_start            date;
  v_line_amount      integer;
  v_renew_amount     integer;
  v_bulk_total_seats integer;
  v_bulk_pool        integer;
  v_running_mrr      integer;
  v_idx              integer;
  v_n                integer;
  v_d                jsonb;
  v_dom              text;
  v_dom_seats        integer;
  v_dom_mrr          integer;
  v_bulk_count       integer := 0;
  v_seats            integer;
  v_sub_domain       text;
  v_used_domains     text[] := array[]::text[];
  v_own_domain       boolean;                       -- R-829
  v_used_domain_plans text[] := array[]::text[];    -- R-829
  v_domain_conflicts jsonb := '[]'::jsonb;          -- R-829
  v_new_sub_id       uuid;
  v_po_sub_id        uuid;
  v_po_seats         integer;
  v_po_plan          text;
  v_po_vendor        public.vendor;
  v_unit_wholesale_pm integer;
  v_total_wholesale  integer;
  v_po_id            text;
  v_first_sub        boolean := true;
  v_annual_reason    text := nullif(btrim(coalesce(p_annual_override_reason, '')), '');  -- R-368
  v_has_annual       boolean;                                                              -- R-368
  v_cost_pm          integer;                                                              -- R-378
begin
  if v_uid is null then
    raise exception 'Sign in to activate a quote on credit.' using errcode = 'insufficient_privilege';
  end if;
  v_caller_tenant := public.current_tenant_id();
  if v_caller_tenant is null then
    raise exception 'No tenant context';
  end if;
  if not exists (select 1 from public.users u where u.id = v_uid and u.is_active) then
    raise exception 'Your account is not active.' using errcode = 'insufficient_privilege';
  end if;
  v_is_owner := public.current_user_is_owner();

  if p_credit_days is null or p_credit_days < 1 or p_credit_days > 180 then
    raise exception 'Credit days must be 1 to 180.' using errcode = 'check_violation';
  end if;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.lead_id, q.status, q.payment_status,
         q.amount, q.line_items, q.invoice_id, q.domain, q.is_add_seats, q.is_one_off,
         q.credit_activated_at, q.credit_due_date,
         q.billing_cycle   -- R-370
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;
  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if v_quote.tenant_id <> v_caller_tenant then
    raise exception 'Quote % does not belong to your tenant', p_quote_id using errcode = 'insufficient_privilege';
  end if;
  v_tenant_id   := v_quote.tenant_id;
  v_customer_id := v_quote.customer_id;
  v_expected    := coalesce(v_quote.amount, 0);

  -- Double click / second tab: report what is already there instead of a second invoice.
  if v_quote.credit_activated_at is not null then
    return jsonb_build_object(
      'already_active', true,
      'invoice_id', v_quote.invoice_id,
      'due_date', v_quote.credit_due_date,
      'subscriptions_created', 0,
      'tasks_created', 0
    );
  end if;

  if v_quote.status <> 'accepted' then
    raise exception 'Only an accepted quote can be activated on credit. Mark % accepted first.', p_quote_id
      using errcode = 'check_violation';
  end if;
  -- ── R-370: split billing is invoiced one period at a time by raise_subscription_billing.
  -- A whole-term credit invoice here would be billed a second time by the instalments.
  -- Same test as lib/payments/record-payment-invoice.ts isSplitBilled.
  if v_quote.billing_cycle is not null and v_quote.billing_cycle::text <> 'yearly' then
    raise exception 'This quote is billed in instalments (%) — record the first instalment instead, or switch billing to yearly.',
      replace(v_quote.billing_cycle::text, '_', '-')
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_one_off, false) then
    raise exception 'Quote % is a one-off sale: there is no subscription to activate. Issue the invoice instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if coalesce(v_quote.is_add_seats, false) then
    raise exception 'Quote % adds seats to an existing subscription. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.renewal_quote_id = p_quote_id) then
    raise exception 'Quote % renews an existing subscription, which is already active. Record the payment instead.', p_quote_id
      using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.subscriptions s where s.tenant_id = v_tenant_id and s.quote_id = p_quote_id) then
    raise exception 'Quote % already has subscriptions.', p_quote_id using errcode = 'check_violation';
  end if;

  select coalesce(sum(p.amount), 0) into v_received
    from public.payments p where p.quote_id = p_quote_id and p.status = 'received';
  if v_received > 0 or v_quote.payment_status in ('received', 'partial') then
    raise exception 'Payment is already recorded on quote %, so it is not a credit sale.', p_quote_id
      using errcode = 'check_violation';
  end if;

  if v_quote.lead_id is not null then
    select l.trial_started_at, l.trial_converted_at into v_lead
      from public.leads l where l.id = v_quote.lead_id and l.tenant_id = v_tenant_id;
    if found and v_lead.trial_started_at is not null and v_lead.trial_converted_at is null then
      raise exception 'Quote % is on a trial. Convert or stop the trial first.', p_quote_id
        using errcode = 'check_violation';
    end if;
  end if;

  if v_customer_id is null then
    raise exception 'Quote % has no customer yet. Accept it from the quote page so the customer is created.', p_quote_id
      using errcode = 'check_violation';
  end if;
  select c.id, c.name, c.domain, c.allow_pay_later, c.credit_limit into v_cust
    from public.customers c where c.id = v_customer_id and c.tenant_id = v_tenant_id;
  if not found then
    raise exception 'Customer of quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;
  if not v_cust.allow_pay_later then
    raise exception 'Pay later is off for %. Turn it on in the customer''s Pay later settings, or record the payment first.', v_cust.name
      using errcode = 'check_violation';
  end if;

  if not exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where li->>'commitment' is not null
  ) then
    raise exception 'Quote % has no subscription line (monthly or annual), so there is nothing to activate.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Credit limit ──
  v_limit := coalesce(v_cust.credit_limit, 50000);
  select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::int
    into v_owed
    from public.invoices i
   where i.tenant_id = v_tenant_id and i.customer_id = v_customer_id
     and i.status in ('pending', 'overdue');
  /* R-2230: what the customer's open part payment requests still owe counts too — the same rule
     as the customer page's "Unpaid now" (public.open_part_requests, one row per request = is_lead). */
  v_owed := v_owed + coalesce((select sum(r.still_due) from public.open_part_requests(v_customer_id, null) r
                                where r.is_lead), 0)::int;
  -- An invoice already raised on this quote is inside v_owed; do not count it twice.
  v_this     := case when v_quote.invoice_id is null then v_expected else 0 end;
  v_exposure := v_owed + v_this;
  v_over     := v_exposure > v_limit;
  if v_over and not v_is_owner then
    raise exception 'Over the credit limit: % already owes Rs %, this invoice is Rs %, total Rs % against a limit of Rs %. Only the owner can approve this.',
      v_cust.name, v_owed, v_this, v_exposure, v_limit
      using errcode = 'insufficient_privilege';
  end if;
  if v_over and not coalesce(p_approve_over_limit, false) then
    raise exception 'Over the credit limit: total Rs % against a limit of Rs %. Tick "Approve over limit" to go ahead.',
      v_exposure, v_limit
      using errcode = 'check_violation';
  end if;

  -- ── R-368: annual plans need payment first; only the owner overrides, with a reason ──
  -- After the credit-limit checks so their messages stay as they were. Same test as the app
  -- (lib/credit/activate-on-credit.ts annualLineNames): a commitment that is not monthly and
  -- not one_time.
  select exists (
    select 1 from jsonb_array_elements(case when jsonb_typeof(v_quote.line_items) = 'array' then v_quote.line_items else '[]'::jsonb end) li
     where coalesce(li->>'commitment', '') not in ('', 'monthly', 'one_time')
  ) into v_has_annual;
  if v_has_annual and not v_is_owner then
    raise exception 'Annual plans need payment first. Only the owner can activate an annual plan on credit (quote %).', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;
  if v_has_annual and (v_annual_reason is null or length(v_annual_reason) < 5) then
    raise exception 'Annual plans need payment first. To activate quote % on credit anyway, write the reason for the override.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Invoice (tax maths untouched: generate_invoice) ──
  -- An issued invoice is frozen (tg_invoices_freeze_issued: no due_date edits), so the due
  -- date goes in through generate_invoice's own rule: due = today + quotes.payment_terms_days.
  -- The credit days ARE the agreed terms of this sale, so the quote carries them.
  if v_quote.invoice_id is null then
    update public.quotes set payment_terms_days = p_credit_days
     where id = p_quote_id and tenant_id = v_tenant_id;
    select g.invoice_id into v_invoice_id from public.generate_invoice(p_quote_id) g;
  else
    -- Invoice raised before this: its due date stands (an issued invoice cannot be edited).
    v_invoice_id := v_quote.invoice_id;
    if exists (select 1 from public.invoices i where i.id = v_invoice_id and i.status in ('paid', 'void')) then
      raise exception 'Invoice % on quote % is % — nothing to give credit on.', v_invoice_id, p_quote_id,
        (select i.status from public.invoices i where i.id = v_invoice_id)
        using errcode = 'check_violation';
    end if;
  end if;
  select coalesce(i.due_date, v_today + p_credit_days) into v_due
    from public.invoices i where i.id = v_invoice_id;
  select greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))::int into v_balance
    from public.invoices i where i.id = v_invoice_id;

  -- ── Subscriptions: record_payment's rules, line by line ──
  v_domain := v_quote.domain;
  for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop
    v_first_line := v_quote.line_items -> v_line_idx;
    v_commitment := v_first_line->>'commitment';
    v_plan_name  := coalesce(v_first_line->>'name',
                      case when v_commitment = 'monthly' then 'Monthly subscription'
                           else 'Annual subscription' end);
    /* R-1688: the one rule (quote_line_is_subscription). This read
       `v_is_monthly := v_commitment = 'monthly'`, which is NULL for a line with no commitment, so
       `continue when not (false or NULL)` did NOT continue and a One-time line was filed as an
       Annual subscription (and a commitment 'one_time' line was filed as annual outright). A line
       marked one-time, commitment 'one_time' or a one-time catalogue item is never filed; a line
       with no commitment keeps this path's old meaning (filed: true) so legacy quotes do not change. */
    v_is_monthly := coalesce(v_commitment = 'monthly', false)
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_is_annual  := not v_is_monthly
                    and public.quote_line_is_subscription(v_first_line, v_tenant_id, true);
    v_po_sub_id  := null;
    continue when not (v_is_annual or v_is_monthly);

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
                       coalesce(v_renew_amount, v_expected) / case when v_is_monthly then 1.0 else 12.0 end
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
          start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)  -- R-378
        values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_dom_seats, v_dom_mrr,
          v_start,
          (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date,
          'active', 0, v_dom, p_quote_id,
          case when v_is_monthly then 1 else 12 end,
          v_cost_pm)  -- R-378
        on conflict (tenant_id, quote_id, lower(domain), lower(plan)) where quote_id is not null and domain is not null  -- R-829
          do nothing
        returning id into v_new_sub_id;
        if v_new_sub_id is not null then v_subs_created := v_subs_created + 1; end if;

        insert into public.customer_domains (tenant_id, customer_id, domain)
        values (v_tenant_id, v_customer_id, v_dom)
        on conflict (tenant_id, lower(domain)) do nothing;

        v_bulk_count := v_bulk_count + 1;
        v_used_domains := array_append(v_used_domains, v_dom);
        v_used_domain_plans := array_append(v_used_domain_plans, v_dom || '|' || lower(v_plan_name));  -- R-829
      end loop;
      v_po_seats := v_bulk_total_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    else
      v_seats := coalesce((v_first_line->>'qty')::int, 0);
      v_sub_domain := nullif(lower(trim(v_first_line->>'domain')), '');
      v_own_domain := v_sub_domain is not null;  -- R-829
      if v_sub_domain is null then
        if v_domain is null then v_domain := v_cust.domain; end if;
        v_sub_domain := lower(nullif(trim(v_domain), ''));
      end if;
      -- R-829: same rule as record_payment — own domain kept unless this plan already has it.
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
        start_date, renewal_date, status, outstanding_amount, domain, quote_id, term_months,
          vendor_cost_per_seat_month)  -- R-378
      values (v_tenant_id, v_customer_id, v_quote.customer_name, v_plan_name, v_vendor, v_seats,
        greatest(0, round(v_renew_amount / case when v_is_monthly then 1.0 else 12.0 end))::int, v_start,
        (v_start + case when v_is_monthly then interval '1 month' else interval '1 year' end)::date, 'active',
        -- Nothing is paid yet: the whole quote is outstanding, carried on the first subscription
        -- exactly as record_payment does for a part payment.
        case when v_first_sub then v_expected else 0 end,
        v_sub_domain, p_quote_id,
        case when v_is_monthly then 1 else 12 end,
        v_cost_pm)  -- R-378
      returning id into v_new_sub_id;
      v_subs_created := v_subs_created + 1;
      if v_sub_domain is not null then
        v_used_domains := array_append(v_used_domains, lower(v_sub_domain));
        v_used_domain_plans := array_append(v_used_domain_plans, lower(v_sub_domain) || '|' || lower(v_plan_name));  -- R-829
      end if;
      v_po_seats := v_seats; v_po_plan := v_plan_name;
      v_po_vendor := v_vendor; v_po_sub_id := v_new_sub_id;
    end if;
    v_first_sub := false;

    -- Draft PO for the vendor seats, same as record_payment (the seats go live now).
    if v_po_sub_id is not null then
      select coalesce(nullif(round((prices->'annual'->>'wholesale')::numeric)::int, 0), nullif(wholesale, 0))
        into v_unit_wholesale_pm from public.items
       where tenant_id = v_tenant_id and lower(name) = lower(v_po_plan) limit 1;
      if v_unit_wholesale_pm is null or v_unit_wholesale_pm <= 0 then
        v_unit_wholesale_pm := greatest(0, round(coalesce(v_line_amount, v_expected)::numeric * 0.83 / greatest(v_po_seats * 12, 1)))::int;
      end if;
      v_total_wholesale := v_unit_wholesale_pm * v_po_seats * 12;
      v_po_id := public.next_document_number('purchase_order', v_tenant_id);
      insert into public.purchase_orders (
        id, tenant_id, subscription_id, customer_id, customer_name, domain,
        vendor, plan, seats, term_months, unit_cost_pm, total_cost, status, notes, created_by
      ) values (
        v_po_id, v_tenant_id, v_po_sub_id, v_customer_id, v_quote.customer_name, v_domain,
        v_po_vendor, v_po_plan, v_po_seats, 12, v_unit_wholesale_pm, v_total_wholesale, 'draft',
        'Auto-created from quote ' || p_quote_id || ' (activated on credit)',
        v_uid
      );
      v_pos := array_append(v_pos, v_po_id);
    end if;
  end loop;

  if v_subs_created = 0 then
    raise exception 'No subscription could be created from quote % — check its lines.', p_quote_id
      using errcode = 'check_violation';
  end if;

  -- ── Tasks for the owner. Tasks only: nothing is sent, nothing is suspended. ──
  select u.id into v_owner from public.users u
   where u.tenant_id = v_tenant_id and u.role = 'owner' and u.is_active
   order by u.created_at limit 1;
  v_owner := coalesce(v_owner, v_uid);
  v_who := coalesce(nullif(trim(v_quote.customer_name), ''), p_quote_id);

  -- 10:00 IST on the day; never in the past.
  v_t1 := greatest(now(), (v_today + time '10:00') at time zone 'Asia/Kolkata');
  v_t2 := greatest(v_t1, ((v_due - 3) + time '10:00') at time zone 'Asia/Kolkata');
  v_t3 := ((v_due + 15) + time '10:00') at time zone 'Asia/Kolkata';

  insert into public.tasks (tenant_id, owner_id, title, notes, kind, due_at, quote_id) values
    (v_tenant_id, v_owner,
     'Set up seats (DNS, users) · ' || v_who,
     'Quote ' || p_quote_id || ' is active on credit. Verify the domain (DNS) and create the users. Invoice '
       || v_invoice_id || ', Rs ' || v_balance || ' due ' || to_char(v_due, 'DD Mon YYYY') || '.',
     'custom', v_t1, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: send payment link · ' || v_who,
     'Invoice ' || v_invoice_id || ' (Rs ' || v_balance || ') is due ' || to_char(v_due, 'DD Mon YYYY')
       || '. Send the payment link. Reminder only — nothing is sent to the customer automatically.',
     'followup', v_t2, p_quote_id),
    (v_tenant_id, v_owner,
     'Credit: payment not in — stop service? · ' || v_who,
     'Invoice ' || v_invoice_id || ' was due ' || to_char(v_due, 'DD Mon YYYY')
       || ' and is 15 days late. Decide: wait, chase or stop the service. Nothing is suspended automatically.',
     'followup', v_t3, p_quote_id);

  update public.quotes
     set credit_activated_at = now(),
         credit_activated_by = v_uid,
         credit_due_date     = v_due,
         credit_over_limit_approved_by = case when v_over then v_uid else null end,
         credit_annual_override_reason = case when v_has_annual then v_annual_reason else null end,  -- R-368
         credit_annual_override_by     = case when v_has_annual then v_uid else null end             -- R-368
   where id = p_quote_id and tenant_id = v_tenant_id;

  return jsonb_build_object(
    'already_active', false,
    'invoice_id', v_invoice_id,
    'due_date', v_due,
    'amount_due', v_balance,
    'subscriptions_created', v_subs_created,
    'purchase_orders', to_jsonb(v_pos),
    'tasks_created', 3,
    'over_limit', v_over,
    'owed_before', v_owed,
    'credit_limit', v_limit,
    'domain_conflicts', v_domain_conflicts  -- R-829
  );
end;
$function$;

-- ── 6. Backfill: parts that already have a request get the date it already stated ───────
update public.subscription_billings b
   set due_on = b.bill_on + coalesce(q.payment_terms_days, 0)
  from public.quotes q
 where q.subscription_billing_id = b.id
   and b.due_on is null;
-- The other parts of a grouped request (R-2092) take the lead's date.
update public.subscription_billings b
   set due_on = lead.due_on
  from public.quotes q
  join public.subscription_billings lead on lead.id = q.subscription_billing_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(q.line_items) = 'array' then q.line_items else '[]'::jsonb end) li
 where q.subscription_billing_id is not null
   and li->>'billing_id' = b.id::text
   and b.id <> lead.id
   and b.due_on is null
   and lead.due_on is not null;

commit;
