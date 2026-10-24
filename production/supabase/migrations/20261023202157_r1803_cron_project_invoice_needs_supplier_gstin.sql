-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_subscription_billing(uuid)') and prosrc like '%R-1803%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.raise_project_milestone_invoice(uuid)') and prosrc like '%R-1803%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_project_direct_invoice(uuid,text,text,text,jsonb,integer,boolean)') and prosrc like '%R-1803%')
-- deploy-key: r1803cronprojectgstin
-- 20261023202157_r1803_cron_project_invoice_needs_supplier_gstin.sql
--
-- R-1803 (P1 money / GST, R-1643 follow-up — its needsDecision #2): R-1643
-- (20261023192418) made generate_invoice and create_direct_invoice refuse a Tax Invoice when
-- the company's own GSTIN or address is missing (supplier_invoice_problem). Three paths that
-- issue invoices WITHOUT going through generate_invoice still took an INV number and issued one:
--
--   raise_subscription_billing      — the daily billing cron (/api/cron/billing) and
--                                     "raise due instalments" after a payment
--   raise_project_milestone_invoice — "Raise invoice" on a project milestone
--   create_project_direct_invoice   — "Create invoice" in the project dialog (create → accept
--                                     → raise milestone)
--
-- WHAT THIS MIGRATION DOES — the same rule (supplier_invoice_problem, R-1643), at the source,
-- BEFORE next_document_number:
--   1. raise_subscription_billing: after the "already billed" answer (a billed instalment
--      still returns its invoice), refuse with R-1643's message + "the next billing run issues
--      this instalment once that is done" (23514). The cron does NOT crash: /api/cron/billing
--      calls this once per instalment inside its own try/catch, records the refusal per
--      subscription in errors[] (the [cron/billing] stderr line the error digest reads, and
--      "errors N" in the /automation run history, R-1104) and carries on with the next
--      subscription — the same path as the existing "your own company has no state" refusal.
--      The instalment stays unbilled; the next run issues it once the details are on record.
--   2. raise_project_milestone_invoice: refuse after the "already raised" check.
--   3. create_project_direct_invoice: refuse before the project, its quote and milestone are
--      made (the whole call is one transaction anyway; this answers before any work).
--   Bodies = the live definitions (20261018030414_r1561, 20260930178000, 20260822200000 —
--   checked identical on local Docker) + the R-1803 block only. Grants are kept (create or
--   replace keeps the ACL).
--
-- NOT CHANGED: no stored row. Invoices already issued without the company's GSTIN stay as
-- they are (R-1643 needsDecision #1).
--
-- Proof: supabase/tests/r1803_cron_project_invoice_needs_gstin.test.sql (one rollback, local
-- Docker; without this migration it FAILs at step 1).

begin;

CREATE OR REPLACE FUNCTION public.raise_subscription_billing(p_billing_id uuid)
 RETURNS TABLE(invoice_id text, gross integer, already_raised boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_b        record;
  v_sub      record;
  v_id       text;
  v_gross    integer;
  v_tax      integer;
  v_rate     integer;
  v_cust_st  text;
  v_sell_st  text;
  v_cust_gstin   text;
  v_sell_gstin   text;
  v_cust_country text;
  v_is_export    boolean;
  v_inter    boolean;
  v_lines    jsonb;
  v_terms    integer := 30;
  v_today    date := public.ist_today();
  v_existing integer;
  v_received integer := 0;
  v_applied  integer := 0;
  v_credit   integer := 0;
  v_status   invoice_status;
  v_caller   uuid;
  v_trusted  boolean;
  v_r1803_problem text;
begin
  /* R-454: who may act WITHOUT a company of their own. Only trusted server paths: the
     service_role key (public quote-accept, cron, webhooks) or a direct database session
     (psql, scripts) that carries no request role at all. A signed-in user with no company
     (customer-portal login, apprentice, mid-signup) is NOT trusted — before R-454 a NULL
     current_tenant_id() skipped the tenant check entirely (fail-open). */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login — only a user of the subscription''s company can raise its invoice'
      using errcode = '28000';
  end if;
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  /* activate_quote_on_credit ("Activate now, pay later") calls this with the SAME caller and
     has its own rules (any active member of the company; over-limit / annual = owner), so a
     call nested inside it is left to that function's guard. PG_CONTEXT is the real call stack —
     a browser cannot fake it, and nobody but the migration owner can create functions. */
  declare
    v_r885_ctx text;
  begin
    get diagnostics v_r885_ctx = pg_context;
    if not (coalesce(auth.role(), '') = 'service_role'
            or (auth.role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing')
       and v_r885_ctx !~ 'function (public\.)?activate_quote_on_credit\(' then
      raise exception 'Only an owner, manager, accountant or billing user can raise an instalment invoice' using errcode = '42501';
    end if;
  end;

  select b.* into v_b
    from public.subscription_billings b
   where b.id = p_billing_id
   for update;

  if not found then
    raise exception 'Billing instalment % not found', p_billing_id
      using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_b.tenant_id is distinct from v_caller then
    raise exception 'Billing instalment % is not in the caller''s tenant', p_billing_id
      using errcode = 'insufficient_privilege';
  end if;

  /* Already billed. Ordinary answer, not an error — the cron retries. */
  if v_b.invoice_id is not null then
    select i.amount into v_existing from public.invoices i where i.id = v_b.invoice_id;
    return query select v_b.invoice_id, coalesce(v_existing, 0), true;
    return;
  end if;

  /* R-1803 (R-1643 follow-up): the company's own GSTIN + address (Bill of Supply: address)
     before any number is taken — the same rule generate_invoice reads. The billing cron
     calls this once per instalment and records a refusal per subscription (errors[] in
     /api/cron/billing, the [cron/billing] log line, "errors N" in the run history), then
     carries on with the next one; the instalment stays unbilled and the next run issues it
     once the company's details are on record. */
  v_r1803_problem := public.supplier_invoice_problem(v_b.tenant_id, v_today);
  if v_r1803_problem is not null then
    raise exception '% The next billing run issues this instalment once that is done.', v_r1803_problem
      using errcode = 'check_violation';
  end if;

  select s.id, s.tenant_id, s.customer_id, s.customer_name, s.plan, s.seats, s.quote_id
    into v_sub
    from public.subscriptions s
   where s.id = v_b.subscription_id;

  if not found then
    raise exception 'Subscription % behind instalment % no longer exists',
      v_b.subscription_id, p_billing_id using errcode = 'no_data_found';
  end if;

  /* ── R-372: place of supply, same rules as generate_invoice (R-041) ──────────────
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state on either side resolved to FALSE = intra-state = CGST+SGST: a missing
     fact turned into a confident tax head (AGENTS.md §2) on every instalment invoice.

     State = the entered state_code, else the first two digits of the GSTIN (a registered
     party has already told us their state) — the same fallback invoice_party_snapshot
     uses to freeze pos_state_code, so the head and the printed place of supply agree.

     EXPORT (country set and not India) is the one case where no Indian state is correct:
     zero-rated under IGST Section 16, so no tax and no CGST/SGST/IGST split.

     Anything else still unknown REFUSES. The billing cron reports it per subscription and
     the instalment stays unbilled until the state is set. */
  select c.state_code, c.gstin, c.country into v_cust_st, v_cust_gstin, v_cust_country
    from public.customers c where c.id = v_sub.customer_id;
  select t.state_code, t.gstin into v_sell_st, v_sell_gstin
    from public.tenants t where t.id = v_b.tenant_id;

  v_cust_st := case
    when nullif(btrim(coalesce(v_cust_st, '')), '') is not null then lpad(btrim(v_cust_st), 2, '0')
    when btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_cust_gstin) from 1 for 2)
    else null
  end;
  v_sell_st := case
    when nullif(btrim(coalesce(v_sell_st, '')), '') is not null then lpad(btrim(v_sell_st), 2, '0')
    when btrim(coalesce(v_sell_gstin, '')) ~ '^[0-9]{2}' then substring(btrim(v_sell_gstin) from 1 for 2)
    else null
  end;

  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india', 'bharat');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply
    v_rate  := 0;       -- zero-rated export (IGST s16)
  elsif v_cust_st is null then
    raise exception
      'Cannot issue the instalment invoice: % has no state (or GSTIN) on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit); the next billing run will issue it.',
      v_sub.customer_name, v_sub.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null then
    raise exception
      'Cannot issue the instalment invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company; the next billing run will issue it.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);   -- both lpad-ed to 2 digits above
    v_rate  := v_b.tax_rate;
  end if;

  v_tax   := round(v_b.taxable_amount * v_rate / 100.0);
  v_gross := v_b.taxable_amount + v_tax;

  -- ── What has already been paid towards this subscription ──────────────────
  if v_sub.quote_id is not null then
    select coalesce(sum(p.amount), 0) into v_received
      from public.payments p
     where p.quote_id = v_sub.quote_id
       and p.status   = 'received';
  end if;

  select coalesce(sum(i.paid_amount), 0) into v_applied
    from public.subscription_billings b
    join public.invoices i on i.id = b.invoice_id
   where b.subscription_id = v_b.subscription_id;

  v_credit := least(greatest(0, v_received - v_applied), v_gross);
  v_status := case when v_credit >= v_gross then 'paid' else 'pending' end::invoice_status;

  /* R-372: the fallback was 0, which made every termless instalment due on issue.
     30 matches generate_invoice. */
  if v_sub.quote_id is not null then
    select coalesce(q.payment_terms_days, 30) into v_terms
      from public.quotes q where q.id = v_sub.quote_id;
  end if;
  v_terms := coalesce(v_terms, 30);

  /* ONE line, qty 1, rate = the whole instalment. Not qty = seats with a per-seat
     rate: an instalment of ₹2,000 over 3 seats is ₹666.67 each, and a tax invoice
     whose qty × rate does not equal its amount is wrong on its face. The seat count
     and service period go in the description, where CGST Rule 46 wants them. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'instalment-' || v_b.period_index::text,
    'name',        v_sub.plan,
    'description', coalesce(v_sub.seats, 0)::text || ' seats · '
                   || to_char(v_b.period_start, 'DD Mon YYYY') || ' to '
                   || to_char(v_b.period_end,   'DD Mon YYYY'),
    'qty',         1,
    'rate',        v_b.taxable_amount,
    'cost',        0
  ));

  v_id := public.next_document_number('invoice', v_b.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate an invoice number for instalment %', p_billing_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date,
    /* quote_id STAYS NULL — build-props.ts:69-71 prefers the quote for every amount
       it prints, so linking a ₹2,360 instalment to its ₹28,320 quote would print
       ₹28,320 on it. The link lives on subscription_billings. */
    quote_id,
    net_payable, paid_amount, taxable_value, tax_amount, tax_rate, inter_state,
    line_items
  ) values (
    v_id, v_b.tenant_id, v_sub.customer_id, v_sub.customer_name, v_gross, v_status,
    v_today, v_today + v_terms,
    case when v_status = 'paid' then v_today else null end,
    null,
    /* R-1561: net_payable = the FULL instalment; the money already received is recorded
       ONCE, in paid_amount. Every reader computes due = net_payable − paid_amount, so the
       old `greatest(0, v_gross - v_credit)` here subtracted the credit a second time
       (₹2,360 with ₹1,000 received showed ₹360 due, not ₹1,360). paid_amount must stay
       = credit: v_applied above sums it to stop one receipt paying every instalment. */
    v_gross, v_credit,
    v_b.taxable_amount, v_tax, v_rate, v_inter,
    v_lines
  );

  update public.subscription_billings
     set invoice_id = v_id, updated_at = now()
   where id = p_billing_id;

  return query select v_id, v_gross, false;
end;
$function$;

CREATE OR REPLACE FUNCTION public.raise_project_milestone_invoice(p_milestone_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_proj     record;
  v_id       text;
  v_paid     integer;
  v_full     boolean;
  v_pay_date date;
  v_inv_date date;
  v_rate     integer;
  v_taxable  integer;
  v_tax      integer;
  v_lines    jsonb;
  v_r1803_problem text;
begin
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  /* R-013 (Pardeep, 27 Sep 2026): the hardened form. The old guard opened by testing
     that the tenant was NOT null and only then comparing — so a NULL tenant skipped the
     comparison entirely, which is the anon case and the signed-in-but-no-users-row case,
     and quote/invoice ids are countable. Migration 20260927100000 rewrote 17 definer RPCs
     by regex; this file recreates one of them, so it must carry the hardened shape
     forward or it silently undoes that fix.

     The old wording is deliberately NOT quoted here. `definer_rpc_hardening.test.sql`
     FAIL 4 scans `pg_get_functiondef`, which includes COMMENTS — so writing the phrase in
     prose turns that security test red for no reason (AGENTS.md L46). Verified: quoting it
     did exactly that. */
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated'))
     or (v_tenant is not null and v_ms.tenant_id is distinct from v_tenant) then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if v_ms.invoice_id is not null then
    raise exception 'Invoice % already raised for this milestone', v_ms.invoice_id
      using errcode = 'unique_violation';
  end if;

  /* R-1803 (R-1643 follow-up): no project Tax Invoice without the company's own GSTIN +
     address (Bill of Supply: address) — checked before the number below is taken. */
  v_r1803_problem := public.supplier_invoice_problem(v_ms.tenant_id, public.ist_today());
  if v_r1803_problem is not null then
    raise exception '%', v_r1803_problem using errcode = 'check_violation';
  end if;

  select * into v_proj from public.project_sales where id = v_ms.project_id;

  select coalesce(sum(amount), 0), min(received_at)
    into v_paid, v_pay_date
    from public.project_payments where milestone_id = p_milestone_id;
  v_full := v_paid >= v_ms.total_amount;

  -- R-003. Was: the first payment's date when fully paid. The number is allocated
  -- below, from today's series, so any earlier date puts the two out of step.
  v_inv_date := public.ist_today();

  v_rate    := coalesce(v_proj.gst_rate, 18);
  v_taxable := round(v_ms.total_amount * 100.0 / (100 + v_rate));
  v_tax     := v_ms.total_amount - v_taxable;

  /* R-010. ONE line, qty 1, rate = this milestone's taxable value — so qty × rate is the
     amount and the document cannot contradict itself. The SAC comes from the project, not
     from a literal: `project_sales.sac_code` is NOT NULL and defaults to 998314. */
  v_lines := jsonb_build_array(jsonb_build_object(
    'id',          'milestone-' || v_ms.seq::text,
    'name',        coalesce(nullif(btrim(v_proj.title), ''), 'Project services')
                   || ' — '
                   || coalesce(nullif(btrim(v_ms.label), ''), 'Milestone ' || v_ms.seq::text),
    'description', nullif(btrim(coalesce(v_proj.description, '')), ''),
    'qty',         1,
    'rate',        v_taxable,
    'cost',        0,
    'hsn',         v_proj.sac_code
  ));

  v_id := public.next_document_number('invoice', v_ms.tenant_id, public.ist_today());
  if v_id is null then raise exception 'Could not allocate invoice number'; end if;

  insert into public.invoices
    (id, tenant_id, customer_id, customer_name, amount, status,
     invoice_date, due_date, paid_date, adjusted_advances, net_payable, quote_id,
     taxable_value, tax_amount, tax_rate, inter_state, line_items)
  values
    (v_id, v_ms.tenant_id, v_proj.customer_id, v_proj.customer_name, v_ms.total_amount,
     (case when v_full then 'paid' else 'pending' end)::invoice_status,
     v_inv_date, greatest(coalesce(v_ms.due_date, v_inv_date), v_inv_date),
     -- The money's own date, not the document's. An advance really did arrive then.
     case when v_full then v_pay_date else null end,
     '[]'::jsonb,
     case when v_full then 0 else v_ms.total_amount end,
     null,
     v_taxable, v_tax, v_rate, coalesce(v_proj.inter_state, false), v_lines);

  update public.project_milestones
     set invoice_id = v_id,
         status     = case when v_full then 'paid' else 'invoiced' end
   where id = p_milestone_id;

  return v_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.create_project_direct_invoice(p_customer_id uuid, p_customer_name text, p_title text, p_description text, p_line_items jsonb, p_gst_rate integer, p_inter_state boolean)
 RETURNS TABLE(invoice_id text, project_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lines   jsonb;
  v_taxable integer := 0;
  v_gst     integer;
  v_total   integer;
  v_pid     uuid;
  v_msid    uuid;
  v_inv     text;
  v_r1803_problem text;
begin
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  /* R-1803 (R-1643 follow-up): refuse before the project, its quote number and its milestone
     are made (raise_project_milestone_invoice checks again before the invoice number). */
  if public.current_tenant_id() is not null then
    v_r1803_problem := public.supplier_invoice_problem(public.current_tenant_id(), public.ist_today());
    if v_r1803_problem is not null then
      raise exception '%', v_r1803_problem using errcode = 'check_violation';
    end if;
  end if;

  select coalesce(jsonb_agg(
           li || jsonb_build_object('amount',
             coalesce(nullif((li->>'amount'), '')::int,
                      coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0)))
         ), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_line_items) li;

  select coalesce(sum(greatest(coalesce((li->>'amount')::int, 0), 0)), 0)
    into v_taxable from jsonb_array_elements(v_lines) li;
  if v_taxable <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gst   := round(v_taxable * coalesce(p_gst_rate, 18) / 100.0);
  v_total := v_taxable + v_gst;

  v_pid := public.create_project_quote(
    p_customer_id, p_customer_name, p_title, p_description, v_lines,
    coalesce(p_gst_rate, 18), coalesce(p_inter_state, false),
    jsonb_build_array(jsonb_build_object('label', 'Full amount', 'total_amount', v_total, 'due_date', current_date::text))
  );

  perform public.accept_project_quote(v_pid);

  -- THE ONE CHANGE: `pm` alias so `pm.project_id` is unmistakably the column, not this
  -- function's OUT variable of the same name.
  select pm.id into v_msid
    from public.project_milestones pm
   where pm.project_id = v_pid
   order by pm.seq
   limit 1;
  if v_msid is null then raise exception 'Milestone was not created for project %', v_pid; end if;

  v_inv := public.raise_project_milestone_invoice(v_msid);

  return query select v_inv, v_pid;
end;
$function$;

commit;
