-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'customers' and column_name = 'gst_treatment') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name = 'gst_treatment') and exists(select 1 from pg_proc where oid = to_regprocedure('public.tg_invoice_snapshot_parties()') and prosrc like '%R-1736%')
-- ============================================================================
-- R-1736 (22 Oct 2026) — a customer's GST treatment (Zoho style), SEZ taxed as IGST, PAN.
--
-- THE HOLE: customers had no GST treatment. The app guessed — GSTIN → registered, none →
-- unregistered, country not India → export — and there was no way to record an SEZ unit.
-- A supply to an SEZ unit/developer is ALWAYS inter-state (IGST Act §7(5)(b)), so a Delhi
-- SEZ customer of a Delhi seller was invoiced CGST + SGST: the wrong head. No PAN either,
-- although a GSTIN's characters 3–12 ARE the PAN (needed for the TDS / 26AS match).
--
-- WHAT THIS DOES
--   1. customers.gst_treatment (8 values; never null — filled by trigger) and customers.pan.
--   2. One rule, three users: customer_gst_treatment_default() — the backfill, the trigger
--      that fills a customer inserted without a treatment (lead conversion, imports), and
--      the same rule as suggestGstTreatment() in src/lib/gst/customer-gst-treatment.ts:
--        country not India → overseas; GSTIN → registered_regular;
--        individual → consumer; else (business) → unregistered_business.
--      pan_from_gstin(): characters 3–12 of a CHECKSUM-VALID GSTIN, else null.
--   3. invoices.gst_treatment — the customer's treatment frozen at issue (YES to a snapshot:
--      invoices already freeze customer_gstin / pos_state_code / inter_state (R-043), and a
--      later customer edit must never change how an issued invoice was taxed). Filled by
--      the existing BEFORE INSERT trigger, so every invoice path (generate_invoice,
--      raise_subscription_billing, project and direct invoices, future ones) is covered
--      without copying their bodies. NULL on an invoice = issued before R-1736.
--   4. The SEZ rule in SQL, in that same trigger: treatment sez_* → inter_state = true
--      (IGST). The tax AMOUNT is unchanged — only the head. Mirrors
--      treatmentIsAlwaysInterState() in src/lib/gst/place-of-supply.ts.
--   5. tg_invoices_freeze_issued: gst_treatment joins the ONCE-SET tier. Body is the
--      latest definition (20261001170000_invoice_party_snapshot) with one line added.
--
-- NOT DONE (needsDecision, Hitesh): zero-rating sez_without_payment / overseas only under
-- a valid LUT (tenants.lut_number / lut_valid_upto exist). Until then sez_without_payment
-- is IGST at the quote's rate and overseas keeps today's export behaviour.
-- ============================================================================

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table public.customers
  add column if not exists gst_treatment text,
  add column if not exists pan           text;

alter table public.customers drop constraint if exists customers_gst_treatment_check;
alter table public.customers add constraint customers_gst_treatment_check
  check (gst_treatment in ('registered_regular', 'registered_composition', 'unregistered_business',
                           'consumer', 'overseas', 'sez_with_payment', 'sez_without_payment', 'deemed_export'));
alter table public.customers drop constraint if exists customers_pan_format_check;
alter table public.customers add constraint customers_pan_format_check
  check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$');

comment on column public.customers.gst_treatment is
  'R-1736: GST treatment (Zoho style). sez_* = always IGST. Filled by trigger from country/GSTIN/customer_type when not given.';
comment on column public.customers.pan is
  'R-1736: PAN (10 chars). From GSTIN characters 3–12 when the GSTIN is valid; typed for an unregistered customer.';

alter table public.invoices add column if not exists gst_treatment text;
alter table public.invoices drop constraint if exists invoices_gst_treatment_check;
alter table public.invoices add constraint invoices_gst_treatment_check
  check (gst_treatment is null or gst_treatment in ('registered_regular', 'registered_composition', 'unregistered_business',
                           'consumer', 'overseas', 'sez_with_payment', 'sez_without_payment', 'deemed_export'));
comment on column public.invoices.gst_treatment is
  'R-1736: the customer''s GST treatment frozen at issue. NULL = issued before R-1736 (not recorded).';

-- ── 2. The rule, once ───────────────────────────────────────────────────────
-- Same mod-36 checksum as validateGstin() in src/lib/utils.ts.
create or replace function public.gstin_checksum_ok(p_gstin text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  g     text := upper(btrim(coalesce(p_gstin, '')));
  chars constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  s     integer := 0;
  f     integer := 2;
  p     integer;
  i     integer;
begin
  if g !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
    return false;
  end if;
  for i in reverse 14..1 loop
    p := (strpos(chars, substr(g, i, 1)) - 1) * f;
    s := s + p / 36 + p % 36;
    f := case when f = 2 then 1 else 2 end;
  end loop;
  return substr(chars, ((36 - s % 36) % 36) + 1, 1) = substr(g, 15, 1);
end $$;

create or replace function public.pan_from_gstin(p_gstin text)
returns text
language sql
immutable
set search_path = public
as $$
  select case when public.gstin_checksum_ok(p_gstin)
              then substring(upper(btrim(p_gstin)) from 3 for 10) end
$$;

create or replace function public.customer_gst_treatment_default(p_country text, p_gstin text, p_customer_type text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when nullif(btrim(coalesce(p_country, '')), '') is not null
         and lower(btrim(p_country)) not in ('india', 'in', 'ind', 'bharat') then 'overseas'
    when nullif(btrim(coalesce(p_gstin, '')), '') is not null then 'registered_regular'
    when p_customer_type = 'individual' then 'consumer'
    else 'unregistered_business'
  end
$$;

revoke all on function public.gstin_checksum_ok(text) from public, anon;
revoke all on function public.pan_from_gstin(text) from public, anon;
revoke all on function public.customer_gst_treatment_default(text, text, text) from public, anon;
grant execute on function public.gstin_checksum_ok(text) to authenticated, service_role;
grant execute on function public.pan_from_gstin(text) to authenticated, service_role;
grant execute on function public.customer_gst_treatment_default(text, text, text) to authenticated, service_role;

-- A customer saved without a treatment / PAN (any path) gets them by the rule above.
-- SECURITY DEFINER so it works for every role that may insert a customer (incl. the
-- in-process gateway role); it reads nothing but NEW.
create or replace function public.tg_customers_gst_treatment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- R-1736
  new.pan := nullif(upper(btrim(coalesce(new.pan, ''))), '');
  -- A new GSTIN carries its own PAN: a PAN that was only the OLD GSTIN's is re-derived.
  if tg_op = 'UPDATE' and new.gstin is distinct from old.gstin
     and new.pan is not distinct from old.pan
     and old.pan is not distinct from public.pan_from_gstin(old.gstin) then
    new.pan := null;
  end if;
  if new.gst_treatment is null then
    new.gst_treatment := public.customer_gst_treatment_default(new.country, new.gstin, new.customer_type);
  end if;
  if new.pan is null then
    new.pan := public.pan_from_gstin(new.gstin);
  end if;
  return new;
end $$;
revoke all on function public.tg_customers_gst_treatment() from public, anon, authenticated;

drop trigger if exists trg_customers_gst_treatment on public.customers;
create trigger trg_customers_gst_treatment
  before insert or update of gst_treatment, pan, gstin, country, customer_type on public.customers
  for each row execute function public.tg_customers_gst_treatment();

-- ── 3. Backfill existing customers ──────────────────────────────────────────
update public.customers c
   set gst_treatment = public.customer_gst_treatment_default(c.country, c.gstin, c.customer_type)
 where c.gst_treatment is null;
update public.customers c
   set pan = public.pan_from_gstin(c.gstin)
 where c.pan is null and public.pan_from_gstin(c.gstin) is not null;

/* No NOT NULL on purpose: the trigger above fills it on EVERY insert and on every update
   of the facts it depends on, so it is never null — and inserts (lead conversion, imports,
   the typed Insert in database.generated.ts) need not name it. */

-- ── 4. Invoice snapshot + the SEZ head ──────────────────────────────────────
create or replace function public.tg_invoice_snapshot_parties()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare s record;
  v_treatment text;
begin
  if new.customer_id is null then return new; end if;
  select * into s from public.invoice_party_snapshot(new.tenant_id, new.customer_id);
  new.customer_gstin    := coalesce(new.customer_gstin,    s.customer_gstin);
  new.billing_address   := coalesce(new.billing_address,   s.billing_address);
  new.customer_country  := coalesce(new.customer_country,  s.customer_country);
  new.pos_state_code    := coalesce(new.pos_state_code,    s.pos_state_code);
  new.seller_gstin      := coalesce(new.seller_gstin,      s.seller_gstin);
  new.seller_state_code := coalesce(new.seller_state_code, s.seller_state_code);

  /* R-1736: the customer's GST treatment, frozen at issue — and the one SQL home of the
     SEZ rule: a supply to an SEZ unit/developer is inter-state (IGST) even in the seller's
     own state (IGST Act §7(5)(b)). Every invoice path inserts through here, so none of
     them has to repeat it. The tax amount is untouched — only the head. */
  select cu.gst_treatment into v_treatment
    from public.customers cu where cu.id = new.customer_id and cu.tenant_id = new.tenant_id;
  new.gst_treatment := coalesce(new.gst_treatment, v_treatment);
  if new.gst_treatment in ('sez_with_payment', 'sez_without_payment') then
    new.inter_state := true;
  end if;
  return new;
end $$;
revoke all on function public.tg_invoice_snapshot_parties() from public, anon, authenticated;

-- ── 5. Freeze: gst_treatment is ONCE-SET on an issued invoice ───────────────
CREATE OR REPLACE FUNCTION public.tg_invoices_freeze_issued()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* An escape hatch that has to be spelled out. A guard with no legitimate override is
     a guard somebody eventually drops; one that needs a stated REASON cannot be set by
     reflex, is transaction-scoped (`set local`), and leaves the reason in the log beside
     the change. No application code path sets this — it is for a reviewed maintenance
     script, the same shape as the files under supabase/maintenance.

     (Do not write that path with a glob. Postgres block comments NEST, so a stray
     slash-star inside one opens a second comment and the entire function body becomes
     unterminated. This file failed to parse for exactly that reason on the first
     attempt, and the error points at the comment rather than at the glob.) */
  v_reason  text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
  v_changed text[] := '{}';

  /* Two tiers, because "changed" is not one question.

     STRICT — the identity of the document. There is no story in which these move on an
     issued invoice, including from null.

     ONCE-SET — a particular that may legitimately be FILLED IN later. taxable_value,
     tax_amount, tax_rate and inter_state arrived in a later migration, so invoices
     issued before it hold nulls, and a backfill completes the record rather than
     amending it. Null -> value is allowed; value -> a different value is not. */
begin
  -- ── STRICT ──────────────────────────────────────────────────────────────
  if new.id            is distinct from old.id            then v_changed := v_changed || 'id (the invoice number)'::text; end if;
  if new.tenant_id     is distinct from old.tenant_id     then v_changed := v_changed || 'tenant_id (the supplier)'::text; end if;
  if new.invoice_date  is distinct from old.invoice_date  then v_changed := v_changed || 'invoice_date'::text; end if;
  if new.amount        is distinct from old.amount        then v_changed := v_changed || 'amount'::text; end if;
  if new.customer_name is distinct from old.customer_name then v_changed := v_changed || 'customer_name'::text; end if;

  -- ── ONCE-SET: null may be filled, a value may not be replaced ───────────
  if old.customer_id   is not null and new.customer_id   is distinct from old.customer_id   then v_changed := v_changed || 'customer_id'::text; end if;
  if old.taxable_value is not null and new.taxable_value is distinct from old.taxable_value then v_changed := v_changed || 'taxable_value'::text; end if;
  if old.tax_amount    is not null and new.tax_amount    is distinct from old.tax_amount    then v_changed := v_changed || 'tax_amount'::text; end if;
  if old.tax_rate      is not null and new.tax_rate      is distinct from old.tax_rate      then v_changed := v_changed || 'tax_rate'::text; end if;
  if old.inter_state   is not null and new.inter_state   is distinct from old.inter_state   then v_changed := v_changed || 'inter_state (this is the CGST+SGST vs IGST switch)'::text; end if;
  if old.line_items    is not null and new.line_items    is distinct from old.line_items    then v_changed := v_changed || 'line_items'::text; end if;
  if old.quote_id      is not null and new.quote_id      is distinct from old.quote_id      then v_changed := v_changed || 'quote_id'::text; end if;
  if old.due_date      is not null and new.due_date      is distinct from old.due_date      then v_changed := v_changed || 'due_date'::text; end if;
  -- R-043: the parties as they stood on the day of issue (CGST Rule 46).
  if old.customer_gstin    is not null and new.customer_gstin    is distinct from old.customer_gstin    then v_changed := v_changed || 'customer_gstin'::text; end if;
  if old.billing_address   is not null and new.billing_address   is distinct from old.billing_address   then v_changed := v_changed || 'billing_address'::text; end if;
  if old.customer_country  is not null and new.customer_country  is distinct from old.customer_country  then v_changed := v_changed || 'customer_country'::text; end if;
  if old.pos_state_code    is not null and new.pos_state_code    is distinct from old.pos_state_code    then v_changed := v_changed || 'pos_state_code (place of supply)'::text; end if;
  if old.seller_gstin      is not null and new.seller_gstin      is distinct from old.seller_gstin      then v_changed := v_changed || 'seller_gstin'::text; end if;
  if old.seller_state_code is not null and new.seller_state_code is distinct from old.seller_state_code then v_changed := v_changed || 'seller_state_code'::text; end if;
  -- R-1736: the GST treatment the invoice was taxed under.
  if old.gst_treatment     is not null and new.gst_treatment     is distinct from old.gst_treatment     then v_changed := v_changed || 'gst_treatment'::text; end if;

  /* Everything not listed above is deliberately mutable, because it is the invoice's
     LIFECYCLE rather than the document: status, paid_date, paid_amount, overdue_days,
     razorpay_id, pdf_url, updated_at — and gst_irn, which by definition arrives from the
     IRP only AFTER the invoice is issued, so freezing it would break e-invoicing.

     adjusted_advances / net_payable / first_advance_at are mutable too, and that is a
     considered carve-out rather than an omission: adjusting a customer advance against
     an invoice is a real post-issue settlement under CGST Section 31(3)(d), and the
     feature that does it (migration 0209) would break if this froze them. */

  if array_length(v_changed, 1) is null then
    return new;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % amended under app.invoice_amend_reason=%: %',
      old.id, v_reason, array_to_string(v_changed, ', ');
    return new;
  end if;

  /* Reason, then the next step, then where to do it — CLAUDE.md §24. A bare "not
     allowed" on a money guard sends the operator to the database. */
  raise exception
    'Invoice % has been issued, so its % cannot be changed. Under CGST Section 34 a mistake on an issued invoice is corrected with a CREDIT NOTE plus a fresh invoice, not an edit — the buyer has already claimed input credit against the copy they hold. Open the invoice and use "Issue credit note".',
    old.id, array_to_string(v_changed, ', ');
end;
$function$;
