-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.supplier_invoice_problem(uuid,date)')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.generate_invoice(text)') and prosrc like '%R-1643%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.create_direct_invoice(uuid,jsonb,text,boolean)') and prosrc like '%R-1643%')
-- deploy-key: r1643suppliergstin
-- 20261023192418_r1643_tax_invoice_needs_supplier_gstin.sql
--
-- R-1643 (P1 money / GST, weekly audit 19 Oct 2026): a new company with no GSTIN and no address
-- of its own could issue a GST "Tax Invoice". The setup wizard lets both be left blank, a NULL
-- GST registration counts as registered (supplier_gst_status, R-1529), so generate_invoice
-- (20261019162652_r1686) took an INV- number and issued a tax invoice with no supplier GSTIN
-- and no supplier address — a document CGST Rule 46(a) does not recognise. The only check was
-- on the PDF button, after the number was spent and the invoice was already in GSTR-1.
--
-- ══ DECISION (Pardeep delegates — recorded on the card) ═══════════════════════════════════
--   Registered (or never chosen = registered)  → Tax Invoice: the company's GSTIN AND address
--                                                 must be on record (Rule 46(a)).
--   Composition                                → Bill of Supply, but the dealer IS registered:
--                                                 GSTIN AND address (Rule 49(a)).
--   Not registered (gst_registration =         → Bill of Supply (R-1529, BOS- series): no GSTIN
--   'unregistered', or registered with an        exists, so only the address is required
--   effective date after the document date)      (Rule 49(a): name, address).
--   Unregistered businesses ARE modelled (R-1529) — nothing new to build for them; this only
--   refuses the document that a business without the facts cannot lawfully issue.
--
-- ══ WHAT THIS MIGRATION DOES ══════════════════════════════════════════════════════════════
--   1. supplier_invoice_problem(tenant, on_date) → NULL when the company may issue its
--      document that day, else the §24 message (what is missing, the Settings → Company fix,
--      and the Bill of Supply way out). One rule, read by both paths below.
--   2. generate_invoice: refuses with that message BEFORE next_document_number — and the
--      whole call is one transaction, so nothing is saved and no number is spent. Every path
--      that issues through it is covered: Issue invoice on a quote, "Activate now, pay later",
--      online checkout (online-invoice.server.ts logs the reason on the lead), and
--      create_direct_invoice. Body = 20261019162652_r1686 + the R-1643 block only.
--   3. create_direct_invoice: the same check before it takes a QUOTE number (it would roll
--      back anyway; this refuses before any work). Body = 20261018022629_r1529 + the block.
--
-- NOT CHANGED: no stored row. Invoices already issued without the company's GSTIN stay as
-- they are (needsDecision on R-1643: list them per tenant and decide on revised invoices).
-- raise_subscription_billing / project invoices are not changed here (they do not call
-- generate_invoice) — needsDecision on the card.
--
-- Proof: supabase/tests/r1643_tax_invoice_needs_gstin.test.sql (one rollback, local Docker).

begin;

-- ── 1. the rule ──────────────────────────────────────────────────────────────────────────
create or replace function public.supplier_invoice_problem(p_tenant uuid, p_on date)
returns text
language plpgsql
stable
set search_path = public
as $$
/* R-1643: why this company cannot issue its sales document on p_on, or NULL when it can. */
declare
  v_gstin   text;
  v_address text;
  v_status  text;
  v_missing text;
  v_fix     constant text :=
    ' Add your company''s GSTIN and address in Settings → Company first, then issue the invoice. Nothing was saved and no number was used.';
begin
  select nullif(btrim(coalesce(t.gstin, '')), ''), nullif(btrim(coalesce(t.address, '')), '')
    into v_gstin, v_address
    from public.tenants t
   where t.id = p_tenant;
  if not found then
    return null;   -- the caller's own tenant checks answer a missing company
  end if;

  v_status := public.supplier_gst_status(p_tenant, coalesce(p_on, public.ist_today()));

  if v_status = 'unregistered' then
    if v_address is null then
      return 'Cannot issue a Bill of Supply: your company''s address is not on record, and a Bill of Supply must show it (CGST Rule 49).'
          || ' Add your company''s address in Settings → Company first, then issue it. Nothing was saved and no number was used.';
    end if;
    return null;
  end if;

  if v_gstin is not null and v_address is not null then
    return null;
  end if;
  v_missing := case
                 when v_gstin is null and v_address is null then 'GSTIN and address are'
                 when v_gstin is null then 'GSTIN is'
                 else 'address is'
               end;

  if v_status = 'composition' then
    return format('Cannot issue a Bill of Supply: your company''s %s not on record. A composition dealer is GST-registered, so the bill must show both (CGST Rule 49).', v_missing)
        || v_fix;
  end if;
  return format('Cannot issue a Tax Invoice: your company''s %s not on record, and a GST Tax Invoice must show both (CGST Rule 46).', v_missing)
      || v_fix
      || ' Not GST-registered? Choose "Not registered" under GST registration there — you will issue a Bill of Supply instead.';
end;
$$;
revoke all on function public.supplier_invoice_problem(uuid, date) from public, anon;
grant execute on function public.supplier_invoice_problem(uuid, date) to authenticated, service_role;

comment on function public.supplier_invoice_problem(uuid, date) is
  'R-1643: NULL when the company may issue its sales document on that date; else the §24 refusal. Tax Invoice / composition Bill of Supply need the company GSTIN + address (CGST Rules 46/49); an unregistered business''s Bill of Supply needs the address.';

-- ── 2. generate_invoice ──────────────────────────────────────────────────────────────────
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
         q.subtotal, q.discount_pct, q.tax_rate, q.payment_terms_days
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

  /* ── R-041 (Pardeep, 30 Sep 2026): an unknown place of supply used to mean CGST+SGST ──
     This read `(v_cust_st is not null and v_sell_st is not null and v_cust_st <> v_sell_st)`,
     so a NULL state_code on either side resolved to FALSE = intra-state = CGST+SGST. That
     is a missing fact turned into a confident tax head (AGENTS.md §2), and it is the
     expensive direction: an inter-state supply billed as CGST+SGST is tax paid to the wrong
     government, which GSTR-1 will not reconcile and which the customer cannot claim.
     23 of this tenant's customers have no state_code.

     EXPORT is the one case where no state is correct rather than missing: a recipient
     outside India has no Indian place of supply, and the supply is zero-rated under IGST
     Section 16 (LUT or with payment of tax). Those quotes already carry tax_rate 0, set by
     the same `isExportSupply` the app uses, so there is no split to get wrong.

     Everything else stops. §24: the message names the screen that fixes it. */
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
    -- THE ONE CHANGE: the fallback was 0, which made every termless invoice due on issue.
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

-- ── 3. create_direct_invoice ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_direct_invoice(p_customer_id uuid, p_line_items jsonb, p_notes text DEFAULT NULL::text, p_recurring boolean DEFAULT false)
 RETURNS TABLE(invoice_id text, quote_id text, net_payable integer, tax_rate integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_is_svc   boolean := auth.role() = 'service_role';
  v_cust     record;
  v_export   boolean;
  v_rate     integer;
  v_subtotal integer;
  v_gross    integer;
  v_qid      text;
  v_inv      record;
  v_commit   text := case when p_recurring then 'annual_yearly' else 'one_time' end;
  v_lines    jsonb;
  v_r1643_problem text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can create an invoice' using errcode = '42501';
  end if;
  if not v_is_svc and v_tenant is null then raise exception 'No tenant context'; end if;
  if p_customer_id is null then raise exception 'Customer required'; end if;
  if jsonb_typeof(p_line_items) <> 'array' or jsonb_array_length(p_line_items) = 0 then
    raise exception 'At least one line item is required';
  end if;

  select c.id, c.name, c.country, c.tenant_id into v_cust
    from public.customers c where c.id = p_customer_id;
  if not found then raise exception 'Customer not found'; end if;
  if not v_is_svc and v_cust.tenant_id is distinct from v_tenant then
    raise exception 'Customer is not in the caller''s tenant';
  end if;
  v_tenant := v_cust.tenant_id;

  /* R-1643: refuse before any number is taken (generate_invoice checks again). */
  v_r1643_problem := public.supplier_invoice_problem(v_tenant, public.ist_today());
  if v_r1643_problem is not null then
    raise exception '%', v_r1643_problem using errcode = 'check_violation';
  end if;

  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  /* R-1529: no GST on a Bill of Supply — a business that is not GST-registered (or is under
     composition) cannot charge it. 0 here, so the direct invoice becomes a Bill of Supply
     instead of being refused by tg_invoice_document_kind. */
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(v_tenant, public.ist_today()) in ('unregistered', 'composition') then 0
              else 18
            end;

  select coalesce(jsonb_agg(li || jsonb_build_object('commitment', v_commit)), '[]'::jsonb)
    into v_lines
    from jsonb_array_elements(p_line_items) li;

  select coalesce(sum( coalesce((li->>'qty')::int, 1) * coalesce((li->>'rate')::int, 0) ), 0)
    into v_subtotal
    from jsonb_array_elements(v_lines) li;
  if v_subtotal <= 0 then raise exception 'Invoice total must be greater than zero'; end if;
  v_gross := v_subtotal + round(v_subtotal * v_rate / 100.0)::int;

  v_qid := public.next_document_number('quote', v_tenant, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;

  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, is_one_off, created_date, notes
  ) values (
    v_qid, v_tenant, p_customer_id, v_cust.name, v_gross, v_subtotal, v_rate, 0,
    v_lines, 'accepted', 'awaiting', not p_recurring, public.ist_today(), p_notes
  );

  select gi.invoice_id, gi.net_payable into v_inv
    from public.generate_invoice(v_qid) gi;

  return query select v_inv.invoice_id, v_qid, v_inv.net_payable, v_rate;
end;
$function$;

commit;
