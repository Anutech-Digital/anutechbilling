-- deploy-peek: to_regprocedure('public.is_customer_advance_quote(text,integer,text,jsonb)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.generate_invoice(text)') and prosrc like '%R-2023%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.nav_badges(text[])') and prosrc like '%R-2023%')
-- deploy-key: r2023customeradvance
-- 20261027110130_r2023_customer_advance.sql
--
-- R-2023 (27 Oct 2026, Pardeep — staging LINKS INFOTECH ₹47,348): a CUSTOMER ADVANCE is its own
-- thing, not a sale. R-1863 books money that arrives before anything is sold as a receipt voucher
-- + an open customer credit, hung on a ₹0, line-less "Advance on account" holder quote (status
-- accepted, payment_status received). Read as a quote it looked like a paid sale waiting for its
-- GST invoice: the quote page offered "Generate GST Invoice" on ₹0 and the Payments Received
-- sidebar badge counted it as "paid, GST invoice not raised".
--
-- WHAT THIS DOES (no data repair — existing advances are read correctly by the rule):
--   1. is_customer_advance_quote(plan, amount, invoice_id, line_items) — the ONE rule, the same as
--      the app's lib/quotes/customer-advance.ts and R-1863's bank_advance_payment(): plan
--      'Advance on account', ₹0, no lines, never invoiced.
--   2. generate_invoice — R-1643 body (20261023192418) + one refusal, BEFORE any number is taken:
--      an advance holder has nothing to invoice; the message says how to use the advance instead
--      (§24). The old ₹0 refusal stays for every other ₹0 quote.
--   3. nav_badges — R-1635 body (20261023184546); 'payments' (paid, GST invoice not raised) no
--      longer counts an advance holder — the badge opens /quotes?focus=to-invoice, which leaves
--      it out too (lib/quotes/focus.ts).
-- Using an advance stays the ONE existing path: Record payment → "Use advance" →
-- record_desk_payment → redeem_customer_credits (R-895 / R-1565 / R-1567) — unchanged.
-- Test: supabase/tests/r2023_customer_advance.test.sql

begin;

-- ── 1. the rule ──────────────────────────────────────────────────────────────
create or replace function public.is_customer_advance_quote(p_plan text, p_amount integer, p_invoice_id text, p_line_items jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  /* R-2023: an R-1863 advance holder quote — the customer's money kept as credit, not a sale. */
  select btrim(coalesce(p_plan, '')) = 'Advance on account'
     and coalesce(p_amount, 0) = 0
     and p_invoice_id is null
     and (p_line_items is null or jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0);
$$;

revoke all on function public.is_customer_advance_quote(text, integer, text, jsonb) from public, anon;
grant execute on function public.is_customer_advance_quote(text, integer, text, jsonb) to authenticated, service_role;

-- ── 2. generate_invoice — R-1643 body + the R-2023 refusal ───────────────────
CREATE OR REPLACE FUNCTION public.generate_invoice(p_quote_id text)
 RETURNS TABLE(invoice_id text, net_payable integer, total_advances integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quote     record;
  v_adv       jsonb;
  v_total     integer;
  v_first     timestamptz;
  v_id        text;
  v_gross     integer;
  v_net       integer;
  v_status    invoice_status;
  v_today     date := public.ist_today();
  v_taxable   integer;
  v_tax       integer;
  v_rate      integer;
  v_cust_st   text;
  v_sell_st   text;
  v_cust_country text;
  v_is_export boolean;
  v_inter     boolean;
  v_cust_gstin text;
  v_caller    uuid;
  v_trusted   boolean;
  v_r1686_ctx text;
  v_r1643_problem text;
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
    raise exception 'No company on this login — only a user of the quote''s company can issue its invoice'
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
      raise exception 'Only an owner, manager, accountant or billing user can issue an invoice' using errcode = '42501';
    end if;
  end;

  select q.id, q.tenant_id, q.customer_id, q.customer_name, q.amount,
         q.payment_method, q.payment_reference, q.invoice_id,
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days,
         q.plan, q.line_items, q.payment_amount
    into v_quote
    from public.quotes q
   where q.id = p_quote_id
   for update;

  if not found then
    raise exception 'Quote % not found', p_quote_id using errcode = 'no_data_found';
  end if;

  if v_caller is not null
     and v_quote.tenant_id is distinct from v_caller then
    raise exception 'Quote % is not in the caller''s tenant', p_quote_id
      using errcode = 'insufficient_privilege';
  end if;

  if v_quote.invoice_id is not null then
    raise exception 'Invoice % already exists for quote %', v_quote.invoice_id, p_quote_id
      using errcode = 'unique_violation';
  end if;

  /* R-2023: an R-1863 customer advance is money kept as the customer's credit — nothing was
     sold, so there is nothing to invoice. Refused before any number is taken (§24: the way on). */
  if public.is_customer_advance_quote(v_quote.plan, v_quote.amount, v_quote.invoice_id, v_quote.line_items) then
    raise exception '% is a customer advance (₹% received from %, kept as their credit) — there is nothing to invoice on it. Make the quote or invoice for what you sell them, then press Record payment and tick "Use advance" to adjust it.',
      p_quote_id, coalesce(v_quote.payment_amount, 0), v_quote.customer_name
      using errcode = 'check_violation';
  end if;

  /* R-1643: a Tax Invoice must show the company's own GSTIN and address (CGST Rule 46); a
     Bill of Supply its address (Rule 49). Refused BEFORE next_document_number — and the call
     is one transaction, so nothing is saved and no number is spent. */
  v_r1643_problem := public.supplier_invoice_problem(v_quote.tenant_id, v_today);
  if v_r1643_problem is not null then
    raise exception '%', v_r1643_problem using errcode = 'check_violation';
  end if;

  v_gross := coalesce(v_quote.amount, 0);
  if v_gross <= 0 then
    raise exception 'Quote % has no amount — cannot generate a zero-value tax invoice', p_quote_id
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_quote.tax_rate, 18);
  if v_quote.subtotal is not null then
    v_taxable := v_quote.subtotal - round(v_quote.subtotal * coalesce(v_quote.discount_pct, 0) / 100.0);
  else
    v_taxable := round(v_gross * 100.0 / (100 + v_rate));
  end if;
  v_tax := v_gross - v_taxable;

  select c.state_code, c.country, c.gstin into v_cust_st, v_cust_country, v_cust_gstin
    from public.customers c where c.id = v_quote.customer_id;

  /* R-373 (7 Oct 2026): a GSTIN's first two digits ARE the GST state code. A customer
     with a GSTIN but no state_code was refused below, although invoice_party_snapshot
     (R-043) already takes the place of supply from the same GSTIN prefix. Fall back to
     it only when state_code is blank and the GSTIN starts with two digits. */
  if nullif(btrim(coalesce(v_cust_st, '')), '') is null
     and btrim(coalesce(v_cust_gstin, '')) ~ '^[0-9]{2}' then
    v_cust_st := substring(btrim(v_cust_gstin) from 1 for 2);
  end if;
  select t.state_code into v_sell_st from public.tenants t where t.id = v_quote.tenant_id;

  /* R-041: an unknown place of supply is refused (never CGST+SGST by default); export has no
     Indian place of supply and is zero-rated on the quote. §24: the message names the fix. */
  v_is_export := v_cust_country is not null
                 and lower(btrim(v_cust_country)) not in ('', 'in', 'ind', 'india');

  if v_is_export then
    v_inter := false;   -- no Indian place of supply; the zero rate on the quote governs
  elsif v_cust_st is null or btrim(v_cust_st) = '' then
    raise exception
      'Cannot issue this invoice: % has no state on record, so GST cannot decide between CGST+SGST and IGST. Add the state on the customer (Customers → % → Edit), then issue the invoice.',
      v_quote.customer_name, v_quote.customer_name
      using errcode = 'check_violation';
  elsif v_sell_st is null or btrim(v_sell_st) = '' then
    raise exception
      'Cannot issue this invoice: your own company has no state on record, so GST cannot decide between CGST+SGST and IGST. Set it in Settings → Company, then issue the invoice.'
      using errcode = 'check_violation';
  else
    v_inter := (v_cust_st <> v_sell_st);
  end if;

  select a.advances, coalesce(a.total_paid, 0), a.first_at
    into v_adv, v_total, v_first
    from public.compute_advance_adjustment(p_quote_id) a;
  v_adv   := coalesce(v_adv, '[]'::jsonb);
  v_total := coalesce(v_total, 0);

  v_net    := greatest(0, v_gross - v_total);
  v_status := case when v_net = 0 then 'paid' else 'pending' end::invoice_status;

  v_id := public.next_document_number('invoice', v_quote.tenant_id, public.ist_today());
  if v_id is null then
    raise exception 'Could not allocate invoice number for quote %', p_quote_id;
  end if;

  insert into public.invoices (
    id, tenant_id, customer_id, customer_name, amount, status,
    invoice_date, due_date, paid_date, razorpay_id,
    adjusted_advances, net_payable, first_advance_at, quote_id,
    taxable_value, tax_amount, tax_rate, inter_state
  ) values (
    v_id, v_quote.tenant_id, v_quote.customer_id, v_quote.customer_name, v_gross, v_status,
    v_today, v_today + coalesce(v_quote.payment_terms_days, 30), case when v_status = 'paid' then v_today else null end,
    case when v_quote.payment_method = 'razorpay' then v_quote.payment_reference else null end,
    v_adv, v_net, v_first, v_quote.id,
    v_taxable, v_tax, v_rate, v_inter
  );

  update public.quotes
     set payment_status = 'invoiced'::payment_status,
         invoice_id     = v_id
   where id = p_quote_id;

  /* R-1686: "Invoice now (before payment)" files the quote's subscriptions, with the unpaid
     balance as their dues. A no-op when they already exist (paid first) or the quote is not a
     new subscription sale — see file_invoiced_quote_subscriptions. Not when nested inside
     activate_quote_on_credit (it files its own, with tasks) or create_direct_invoice. */
  get diagnostics v_r1686_ctx = pg_context;
  if v_r1686_ctx !~ 'function (public\.)?(activate_quote_on_credit|create_direct_invoice)\(' then
    perform public.file_invoiced_quote_subscriptions(p_quote_id, v_net);
  end if;

  return query select v_id, v_net, v_total;
end;
$function$;

-- ── 3. nav_badges — R-1635 body; 'payments' leaves out a customer advance (R-2023) ──
create or replace function public.nav_badges(p_approval_tiers text[] default '{}')
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_me        uuid := auth.uid();
  v_tenant    uuid := public.current_tenant_id();
  v_now       timestamptz := now();
  -- Today in IST — the renewals page's daysBetween() counts IST calendar days.
  v_today     date := (now() at time zone 'Asia/Kolkata')::date;
  v_quotes    integer := 0;
  v_enquiries integer := 0;
begin
  if v_tenant is null then
    raise exception 'nav_badges: no workspace for this session'
      using errcode = 'insufficient_privilege';
  end if;

  if v_me is not null and coalesce(array_length(p_approval_tiers, 1), 0) > 0 then
    select count(*) into v_quotes
      from public.quotes q
     where q.approval_status = 'pending'
       and q.approval_requested_by <> v_me
       and q.approval_tier::text = any (p_approval_tiers);
  end if;

  select count(*) into v_enquiries
    from (
      select 1
        from (
          select e.read_at,
                 lower(regexp_replace(coalesce(e.from_email, ''), '^\s+|\s+$', '', 'g')) as sender,
                 e.id::text as row_id,
                 lower(btrim(regexp_replace(
                   regexp_replace(
                     regexp_replace(coalesce(e.subject, ''), '^\s+|\s+$', '', 'g'),
                     '^(\s*(re|fw|fwd|aw|sv|vs|rv|res)\s*(\[\d+\])?\s*:\s*)+', '', 'i'),
                   '\s+', ' ', 'g'))) as topic
            from public.inbound_emails e
           where e.archived_at is null
             and (e.snoozed_until is null or e.snoozed_until <= v_now)
             and e.status not in ('skipped_non_enquiry', 'duplicate', 'reply_sent')
        ) m
       group by case when m.sender = '' then 'id:' || m.row_id else m.sender end,
                case when m.sender = '' then '' else m.topic end
      having bool_or(m.read_at is null)
    ) unread;

  return jsonb_build_object(
    'leads',     (select count(*) from public.leads l where l.stage in ('new', 'contact', 'lost') and not l.is_junk),
    'enquiries', v_enquiries,
    'deals',     (select count(*) from public.leads l where l.stage in ('quote', 'demo', 'trial', 'won', 'lost') and not l.is_junk),
    'tasks',     (select count(*) from public.tasks t where t.tenant_id = v_tenant and t.status in ('pending', 'snoozed') and t.due_at < v_now),
    'renewals',  (select count(*) from public.subscriptions s where s.status <> 'cancelled' and s.renewal_date is not null and s.renewal_date <= v_today + 7),
    'invoices',  (select count(*) from public.invoices i where i.status in ('pending', 'overdue') and coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0) > 0 and i.written_off_at is null),
    /* R-2023: a customer advance (R-1863 holder) has no GST invoice to raise. */
    'payments',  (select count(*) from public.quotes q where q.payment_status = 'received'
                     and not public.is_customer_advance_quote(q.plan, q.amount, q.invoice_id, q.line_items)),
    'quotes',    v_quotes
  );
end;
$$;

revoke all on function public.nav_badges(text[]) from public;
revoke all on function public.nav_badges(text[]) from anon;
grant execute on function public.nav_badges(text[]) to authenticated;

comment on function public.nav_badges(text[]) is
  'S16 + R-1475 + R-1541 + R-1635 (written-off invoices are not unpaid) + R-2023 (a customer advance is not "paid, invoice not raised"): every sidebar badge count in one call. SECURITY INVOKER — RLS decides what is counted. leads / deals = the page''s All view; tasks, renewals, invoices, enquiries, payments, quotes = what still needs doing, equal to the filtered view the badge opens (lib/hooks/nav-badge-views.ts).';

commit;
