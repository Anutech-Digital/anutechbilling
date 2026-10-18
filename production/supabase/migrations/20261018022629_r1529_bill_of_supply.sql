-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_invoice_document_kind') and exists(select 1 from pg_proc where oid = to_regprocedure('public.next_document_number(text,uuid,date)') and prosrc like '%R-1529%')
-- deploy-key: r1529billofsupply
-- 20261018022629_r1529_bill_of_supply.sql
--
-- R-1529 (P1, Pardeep 17-18 Oct 2026): a business that is NOT GST-registered cannot issue a
-- Tax Invoice — it issues a BILL OF SUPPLY (CGST Section 31(3)(c) + Rule 49), with no GST on
-- it. Same for a COMPOSITION taxable person (Section 10), whose bill must also say
-- "composition taxable person, not eligible to collect tax on supplies".
--
-- Owner's decisions on the card (q1–q5) are the spec:
--   q1 Unregistered = no GSTIN; composition is its OWN option in Settings.
--   q2 Bill of Supply has its own series BOS-<code>-<YY>-<NNNN> via next_document_number.
--   q3 Rule 49 fields on the document (PDF — app side).
--   q4 From the registration effective date: Tax Invoice. Earlier Bills of Supply stay as
--      they are (the revised-invoice reminder is R-1531).
--   q5 Unregistered: sale in P&L, nothing in GST, no GSTR. Composition: no GST on the bill;
--      the business pays tax on turnover itself (CMP-08 report is R-1530).
--
-- ══ WHAT THIS MIGRATION DOES ═════════════════════════════════════════════════════
--  1. tenants: gst_registration ('registered' | 'unregistered' | 'composition'; NULL = not
--     chosen = treated as registered, i.e. exactly today's behaviour), gst_composition_rate
--     (% of turnover, default 6 — services), gst_registered_from (registration effective
--     date). An 'unregistered' business cannot also hold a GSTIN.
--  2. supplier_gst_status(tenant, on_date): the one place that answers "what was this
--     business on that day". Registered with an effective date LATER than the document's
--     date → 'unregistered' for that document (q4).
--  3. document_series + next_document_number: new doc_type 'bill_of_supply' (prefix BOS).
--     next_document_number('invoice') for an unregistered/composition business returns the
--     next BOS number instead — so every invoice path (generate_invoice, create_direct_invoice,
--     project/milestone invoices, subscription billing) gets the right series without each
--     one changing. INV and BOS are separate counters; neither leaves a gap in the other.
--  4. invoices.document_kind ('tax_invoice' | 'bill_of_supply', NOT NULL, default
--     'tax_invoice' — every row issued so far WAS a tax invoice) and supplier_gst_status
--     (frozen at issue). Set by trigger tg_invoice_document_kind, never by the caller.
--     FAIL-CLOSED: a Bill of Supply with any GST on it is refused (§24 message: set the
--     quote's GST to 0%) — the tax is never silently moved into the price; a BOS number on
--     a registered business's invoice, or an INV number on an unregistered one's, is refused;
--     document_kind / supplier_gst_status can never change after issue, and a Bill of
--     Supply can never gain GST later.
--  5. create_direct_invoice: 0% GST for an unregistered/composition business (was a fixed
--     18% for every Indian customer).
--
-- NOT CHANGED: no issued invoice is altered or renumbered (the new column's default is a
-- constant — no rewrite, no UPDATE, no trigger fires). generate_invoice is unchanged: the
-- quote's own GST rate already flows through it, so a 0% quote gives a Bill of Supply.
--
-- Proof: supabase/tests/bill_of_supply.test.sql (one rollback, see its header).

begin;

-- ── 1. tenants ────────────────────────────────────────────────────────────────
alter table public.tenants add column if not exists gst_registration text;
alter table public.tenants add column if not exists gst_composition_rate numeric(4,2) not null default 6;
alter table public.tenants add column if not exists gst_registered_from date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_registration_check') then
    alter table public.tenants add constraint tenants_gst_registration_check
      check (gst_registration is null or gst_registration in ('registered', 'unregistered', 'composition'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_composition_rate_check') then
    alter table public.tenants add constraint tenants_gst_composition_rate_check
      check (gst_composition_rate > 0 and gst_composition_rate <= 10);
  end if;
  /* q1: unregistered = no GSTIN. Holding one while saying "not registered" is a
     contradiction the invoice would print one way or the other — refuse the save. */
  if not exists (select 1 from pg_constraint where conname = 'tenants_unregistered_no_gstin_check') then
    alter table public.tenants add constraint tenants_unregistered_no_gstin_check
      check (gst_registration is distinct from 'unregistered' or nullif(btrim(coalesce(gstin, '')), '') is null)
      not valid;
  end if;
end $$;
alter table public.tenants validate constraint tenants_unregistered_no_gstin_check;

comment on column public.tenants.gst_registration is
  'R-1529: GST registration status. registered | unregistered (no GSTIN — issues Bills of Supply) | composition (Section 10 — Bills of Supply, pays tax on turnover itself). NULL = not chosen = registered (behaviour before R-1529).';
comment on column public.tenants.gst_composition_rate is
  'R-1529: composition tax rate, % of turnover (services 6). Used by the CMP-08 report (R-1530); never charged to a customer.';
comment on column public.tenants.gst_registered_from is
  'R-1529: registration effective date. A registered business issues Tax Invoices from this date; a document dated earlier is a Bill of Supply (q4).';

-- ── 2. supplier_gst_status ───────────────────────────────────────────────────
create or replace function public.supplier_gst_status(p_tenant uuid, p_on date)
returns text
language sql
stable
set search_path = public
as $$
  /* R-1529: what this business was, GST-wise, on p_on. NULL setting = registered (today's
     behaviour). Registered but the effective date is after p_on → unregistered on that day. */
  select case
           when t.gst_registration in ('unregistered', 'composition') then t.gst_registration
           when t.gst_registered_from is not null and p_on is not null and p_on < t.gst_registered_from then 'unregistered'
           else 'registered'
         end
    from public.tenants t
   where t.id = p_tenant;
$$;
revoke all on function public.supplier_gst_status(uuid, date) from public, anon;
grant execute on function public.supplier_gst_status(uuid, date) to authenticated, service_role;

-- ── 3. numbering: doc_type bill_of_supply, prefix BOS ─────────────────────────
alter table public.document_series drop constraint if exists document_series_doc_type_check;
alter table public.document_series add constraint document_series_doc_type_check
  check (doc_type = any (array['invoice', 'bill_of_supply', 'receipt_voucher', 'refund_voucher', 'credit_note',
                               'debit_note', 'quote', 'purchase_order', 'campaign']));

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
    when 'purchase_order'  then 'PO'
    when 'campaign'        then 'CAMP'
    else upper(p_doc_type)
  end;
$function$;
grant execute on function public.default_doc_prefix(text) to authenticated, service_role;


-- next_document_number: body as installed by 20261010190000_tenant_guard_fail_closed, plus the R-1529 routing.
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
               or (auth.role() is null
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

  if p_doc_type not in ('invoice','bill_of_supply','receipt_voucher','refund_voucher','credit_note','debit_note','quote','purchase_order','campaign') then
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


-- ── 5. create_direct_invoice: body as in 20261011120000_r718_money_roles, plus 0% for a Bill of Supply ──
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


-- ── 4. invoices.document_kind + supplier_gst_status, set and guarded by trigger ──
alter table public.invoices add column if not exists document_kind text not null default 'tax_invoice';
alter table public.invoices add column if not exists supplier_gst_status text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_document_kind_check') then
    alter table public.invoices add constraint invoices_document_kind_check
      check (document_kind in ('tax_invoice', 'bill_of_supply'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'invoices_supplier_gst_status_check') then
    alter table public.invoices add constraint invoices_supplier_gst_status_check
      check (supplier_gst_status is null or supplier_gst_status in ('registered', 'unregistered', 'composition'));
  end if;
end $$;

comment on column public.invoices.document_kind is
  'R-1529: tax_invoice (CGST Rule 46) | bill_of_supply (Rule 49 — no GST; BOS- series). Set by trg_invoice_document_kind from the supplier''s GST status on the invoice date; frozen after issue. Bills of Supply never go into GSTR-1 / GST payable.';
comment on column public.invoices.supplier_gst_status is
  'R-1529: the supplier''s GST status on the invoice date (registered | unregistered | composition), frozen at issue. NULL = issued before R-1529 (all tax invoices).';

create or replace function public.tg_invoice_document_kind()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if tg_op = 'UPDATE' then
    /* An issued document's kind is a legal fact about it — never rewritten (R-1529). */
    if new.document_kind is distinct from old.document_kind
       or new.supplier_gst_status is distinct from old.supplier_gst_status then
      raise exception 'Invoice % is already issued as a % — its document type cannot change. Issue a credit note and a new document instead.',
        old.id, replace(old.document_kind, '_', ' ')
        using errcode = 'check_violation';
    end if;
    if old.document_kind = 'bill_of_supply'
       and (coalesce(new.tax_amount, 0) <> 0 or coalesce(new.tax_rate, 0) <> 0) then
      raise exception 'Bill of Supply % cannot carry GST — a business that is not GST-registered (or is under composition) cannot charge it.', old.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  v_status := public.supplier_gst_status(new.tenant_id, coalesce(new.invoice_date, public.ist_today()));
  new.supplier_gst_status := v_status;

  if v_status in ('unregistered', 'composition') then
    new.document_kind := 'bill_of_supply';
    if new.id !~ '^BOS-' then
      raise exception 'Cannot issue % as a Bill of Supply: its number is not from the Bill of Supply (BOS) series. Numbers come only from next_document_number.', new.id
        using errcode = 'check_violation';
    end if;
    if coalesce(new.tax_amount, 0) <> 0 or coalesce(new.tax_rate, 0) <> 0
       or (new.taxable_value is not null and new.amount is not null and new.taxable_value <> new.amount) then
      raise exception 'Cannot issue this bill with GST: your business is set as % in Settings → Company → GST registration, so it issues a Bill of Supply and cannot charge GST. Set the GST rate on the quote to 0%%, then issue it again — or, if you are now registered, change the GST registration in Settings first.',
        case v_status when 'composition' then 'a composition taxable person' else 'not GST-registered' end
        using errcode = 'check_violation';
    end if;
  else
    new.document_kind := 'tax_invoice';
    if new.id ~ '^BOS-' then
      raise exception 'Cannot issue % as a Tax Invoice: a Bill of Supply (BOS) number belongs to an unregistered business''s series.', new.id
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.tg_invoice_document_kind() from public, anon;

drop trigger if exists trg_invoice_document_kind on public.invoices;
create trigger trg_invoice_document_kind
  before insert or update of document_kind, supplier_gst_status, tax_amount, tax_rate
  on public.invoices
  for each row execute function public.tg_invoice_document_kind();

commit;
