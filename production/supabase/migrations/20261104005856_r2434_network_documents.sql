-- deploy-peek: to_regclass('public.network_documents') is not null and exists(select 1 from pg_proc where proname = 'tg_mirror_invoice_to_child_vendor_bill' and prosrc like '%R-2434%')
-- deploy-key: r2434networkdocuments
-- 20261104005856_r2434_network_documents.sql
--
-- R-2434 (goal G-NETWORK, slice N2 part 1, 4 Nov 2026): my issued invoice lands as a PENDING
-- copy in my connected customer's app; the customer Accepts (→ one bill), Rejects (with a reason
-- I see) or leaves it Pending — like GST IMS. Our Accept files nothing on the GST portal.
-- Spec: docs/specs/g-network.md. Screens come in R-2449 (buyer: Purchases → Inbox "From
-- network") and R-2450 (seller: status on the invoice).
--
-- ══ RULES KEPT ═════════════════════════════════════════════════════════════════════════
--   * A copy goes only when the seller shares 'invoices' with the buyer on an ACCEPTED connection
--     (network_has_scope) AND both GSTINs are owner-proved NOW (network_gstin_owned — also on an
--     operator-set parent link, which network_has_scope alone lets through) AND the invoice's
--     seller GSTIN is the seller's proved GSTIN AND the invoice's customer GSTIN (frozen at issue)
--     is the buyer's proved GSTIN.
--   * The buyer gets a COPY frozen at issue (lines without the seller's cost / list price, HSN/SAC,
--     GST split, totals, PDF link, IRN) — never a live link; a later seller edit does not change it.
--   * Dedupe: one copy per seller GSTIN + kind + document number + FY (unique index). On accept, a
--     bill the buyer already typed with the same seller GSTIN + number + FY is LINKED, not doubled.
--   * Accepted = locked on both sides: the seller cannot void or change the invoice (not even with
--     app.invoice_amend_reason; the seller's internal line cost may still be filled in) or change /
--     delete an accepted credit / debit note; the buyer cannot change the amounts, number, date or
--     GSTIN of a bill an accept made, nor delete any bill an accepted copy points at. Changes come
--     only as a credit / debit note. The buyer keeps its own choices: category (drives ITC through
--     lib/gst/bill-itc), notes, due date, vendor record, payments.
--   * Undo: the buyer may take back an Accept of an invoice / debit note while its bill is
--     untouched (nothing paid or linked, books not locked, no accepted note on it) → pending again
--     (network_undo_accept) — like IMS, an action can change until it is acted upon.
--   * Reject is final for that copy (the seller corrects with a credit note + a fresh invoice).
--   * Void → the pending / rejected copy (and pending note copies on it) is cancelled. A deleted or
--     changed note whose copy is still pending → that copy is cancelled.
--   * Credit note on a copied invoice → its own pending copy; accepting it lowers the accepted bill
--     on the BILL's heads (as R-2432 does), never below what is already paid on it, never inside
--     the buyer's locked books. Debit note → its own pending copy; accepting it makes a NEW bill
--     dated the debit note (bill no. = the note number), so its ITC falls in the note's month.
--   * Every cross-company read / write is SECURITY DEFINER with current_tenant_id() + role.
--     Writes (deliver, accept, reject) re-check the live scope + proof. Reads of a document
--     already delivered (buyer inbox, seller status) do not — the spec: revoke stops future sync,
--     delivered copies stay readable.
--   * The table has RLS on and NO grant to anon / authenticated.
--   * For a connected pair the R-2432 mirror (tg_mirror_invoice_to_child_vendor_bill, redefined
--     here from its latest body 20261103192959) no longer makes a bill on issue — the network copy
--     replaces it. Old parent links without such a connection keep the mirror.
--
-- Known limits (written down, not hidden): accepting a credit note changes the bill in place (as
-- R-2432) rather than booking a dated vendor credit — so it is refused while the bill's date is
-- inside the buyer's locked books; the copy is not refreshed by an amendment the seller makes
-- before the buyer answers; an accepted credit note cannot be undone (the seller issues a debit
-- note instead).
--
-- Test: supabase/tests/r2434_network_documents.test.sql (rolled back; red without this file).
-- Idempotent: if not exists / create or replace / drop trigger if exists.

begin;

-- ── table ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.network_documents (
  id                    uuid primary key default gen_random_uuid(),
  kind                  text not null,
  seller_tenant_id      uuid not null references public.tenants(id) on delete cascade,
  buyer_tenant_id       uuid not null references public.tenants(id) on delete cascade,
  connection_id         uuid references public.tenant_connections(id) on delete set null,
  seller_invoice_id     text not null,
  seller_note_id        text,
  parent_document_id    uuid references public.network_documents(id) on delete cascade,
  seller_gstin          text not null,
  buyer_gstin           text not null,
  seller_name           text not null,
  doc_number            text not null,
  doc_date              date not null,
  fy                    text not null,
  document_type         text not null default 'tax_invoice',
  taxable_value         integer not null,
  cgst                  integer not null default 0,
  sgst                  integer not null default 0,
  igst                  integer not null default 0,
  total                 integer not null,
  currency              text not null default 'INR',
  fx_rate               numeric not null default 1,
  payload               jsonb not null default '{}'::jsonb,
  status                text not null default 'pending',
  reject_reason         text,
  responded_by          uuid,
  responded_at          timestamptz,
  vendor_bill_id        text,
  linked_existing       boolean not null default false,
  apply_note            text,
  cancelled_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint network_documents_kind_check check (kind in ('invoice', 'credit_note', 'debit_note')),
  constraint network_documents_status_check check (status in ('pending', 'accepted', 'rejected', 'cancelled')),
  constraint network_documents_doc_type_check check (document_type in ('tax_invoice', 'bill_of_supply', 'other')),
  constraint network_documents_not_self check (seller_tenant_id <> buyer_tenant_id),
  constraint network_documents_reject_reason check (status <> 'rejected' or nullif(btrim(coalesce(reject_reason, '')), '') is not null),
  constraint network_documents_note_ref check (kind = 'invoice' or (seller_note_id is not null and parent_document_id is not null))
);

/* Dedupe: seller GSTIN + kind + number + FY (an invoice and a note may share a number). */
create unique index if not exists network_documents_dedupe_uq
  on public.network_documents (seller_gstin, kind, upper(btrim(doc_number)), fy);
create index if not exists network_documents_buyer_idx on public.network_documents (buyer_tenant_id, status);
create index if not exists network_documents_seller_inv_idx on public.network_documents (seller_tenant_id, seller_invoice_id);
create index if not exists network_documents_seller_note_idx on public.network_documents (seller_tenant_id, seller_note_id) where seller_note_id is not null;
create index if not exists network_documents_bill_idx on public.network_documents (buyer_tenant_id, vendor_bill_id) where vendor_bill_id is not null;

alter table public.network_documents enable row level security;
revoke all on public.network_documents from public, anon, authenticated;
grant all on public.network_documents to service_role;
/* R-450: Cloud SQL has no BYPASSRLS — the server (service_role) client needs its own policy. */
drop policy if exists network_documents_service_role on public.network_documents;
create policy network_documents_service_role on public.network_documents
  for all to service_role using (true) with check (true);

-- ── helpers ───────────────────────────────────────────────────────────────────────────
/* Indian financial year of a date: 2026-04-01 … 2027-03-31 → '2026-27'. */
create or replace function public.network_fy(p_date date)
returns text
language sql
immutable
set search_path to 'public'
as $function$
  select case when extract(month from p_date) >= 4
              then extract(year from p_date)::int::text || '-' || lpad(((extract(year from p_date)::int + 1) % 100)::text, 2, '0')
              else (extract(year from p_date)::int - 1)::text || '-' || lpad((extract(year from p_date)::int % 100)::text, 2, '0')
         end;
$function$;

/* The buyer company a document from p_seller may go to, or NULL. The ONE gate for every network
   document write: seller shares 'invoices' with the buyer on an accepted connection, both
   GSTINs owner-proved now (even on a parent link), the document's seller GSTIN is the seller's
   proved one and its buyer GSTIN the buyer's proved one. */
create or replace function public.network_invoice_buyer(p_seller uuid, p_seller_gstin text, p_buyer_gstin text)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_s     text;
  v_b     text := upper(btrim(coalesce(p_buyer_gstin, '')));
  v_buyer uuid;
begin
  if p_seller is null or v_b = '' or not public.network_gstin_owned(p_seller) then
    return null;
  end if;
  select gstin_owner_verified_gstin into v_s from public.tenants where id = p_seller;
  if v_s is null or upper(btrim(coalesce(p_seller_gstin, ''))) <> v_s then
    return null;
  end if;
  select t.id into v_buyer from public.tenants t
   where t.gstin_owner_verified_at is not null and t.gstin_owner_verified_gstin = v_b and t.id <> p_seller;
  if v_buyer is null or not public.network_gstin_owned(v_buyer) then
    return null;
  end if;
  if not public.network_has_scope(p_seller, v_buyer, 'invoices') then
    return null;
  end if;
  return v_buyer;
end $function$;

/* Same gate, for an invoice row: GSTINs as frozen on the invoice, else today's. */
create or replace function public.network_invoice_buyer_of(p_inv public.invoices)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2434 */
  select public.network_invoice_buyer(
    p_inv.tenant_id,
    coalesce(nullif(btrim(p_inv.seller_gstin), ''), (select t.gstin from public.tenants t where t.id = p_inv.tenant_id)),
    coalesce(nullif(btrim(p_inv.customer_gstin), ''),
             (select c.gstin from public.customers c where c.id = p_inv.customer_id and c.tenant_id = p_inv.tenant_id)));
$function$;

/* Invoice lines as the buyer may see them: description, HSN/SAC, qty, rate, amount — never the
   seller's cost, list price or internal ids. */
create or replace function public.network_copy_lines(p_lines jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $function$
  /* R-2434 */
  select coalesce(jsonb_agg(jsonb_build_object(
           'description', coalesce(nullif(btrim(e ->> 'name'), ''), nullif(btrim(e ->> 'description'), ''), 'Item'),
           'detail',      case when nullif(btrim(e ->> 'name'), '') is not null then nullif(btrim(e ->> 'description'), '') end,
           'hsn_sac',     coalesce(nullif(btrim(e ->> 'hsn'), ''), nullif(btrim(e ->> 'hsn_sac'), ''), '998313'),
           'quantity',    q.qty,
           'rate',        q.rate,
           'amount',      round(q.qty * q.rate)::bigint
         ) order by x.ord), '[]'::jsonb)
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality as x(e, ord)
    cross join lateral (select
        case when (e ->> 'qty') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e ->> 'qty')::numeric
             when (e ->> 'quantity') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e ->> 'quantity')::numeric else 1 end as qty,
        case when (e ->> 'rate') ~ '^-?[0-9]+(\.[0-9]+)?$' then (e ->> 'rate')::numeric else 0 end as rate) q;
$function$;

-- ── deliver: issued invoice → pending copy ────────────────────────────────────────────
create or replace function public.network_send_invoice(p_inv public.invoices)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_buyer    uuid := public.network_invoice_buyer_of(p_inv);
  v_seller   public.tenants;
  v_conn     uuid;
  v_taxable  integer;
  v_tax      integer := 0;
  v_cgst     integer := 0;
  v_sgst     integer := 0;
  v_igst     integer := 0;
  v_inter    boolean;
  v_doc_type text;
  v_frozen   boolean := p_inv.taxable_value is not null and p_inv.tax_amount is not null;
  v_id       uuid;
begin
  if v_buyer is null then return null; end if;
  select * into v_seller from public.tenants where id = p_inv.tenant_id;
  select c.id into v_conn from public.tenant_connections c
   where c.status = 'accepted'
     and least(c.a_tenant_id, c.b_tenant_id) = least(p_inv.tenant_id, v_buyer)
     and greatest(c.a_tenant_id, c.b_tenant_id) = greatest(p_inv.tenant_id, v_buyer)
   limit 1;

  if v_frozen then
    v_taxable := p_inv.taxable_value;
    v_tax := p_inv.tax_amount;
    v_inter := coalesce(p_inv.inter_state, p_inv.seller_state_code is distinct from p_inv.pos_state_code);
    if v_inter then
      v_igst := v_tax;
    else
      v_cgst := round(v_tax::numeric / 2)::integer;
      v_sgst := v_tax - v_cgst;
    end if;
    v_doc_type := case p_inv.document_kind when 'bill_of_supply' then 'bill_of_supply' else 'tax_invoice' end;
  else
    v_taxable := p_inv.amount;
    v_doc_type := 'other';
  end if;

  insert into public.network_documents (
    kind, seller_tenant_id, buyer_tenant_id, connection_id, seller_invoice_id,
    seller_gstin, buyer_gstin, seller_name, doc_number, doc_date, fy, document_type,
    taxable_value, cgst, sgst, igst, total, currency, fx_rate, payload)
  values (
    'invoice', p_inv.tenant_id, v_buyer, v_conn, p_inv.id,
    v_seller.gstin_owner_verified_gstin,
    (select gstin_owner_verified_gstin from public.tenants where id = v_buyer),
    v_seller.name, p_inv.id, p_inv.invoice_date, public.network_fy(p_inv.invoice_date), v_doc_type,
    v_taxable, v_cgst, v_sgst, v_igst, coalesce(p_inv.amount, v_taxable + v_tax),
    coalesce(p_inv.currency, 'INR'), coalesce(p_inv.fx_rate, 1),
    jsonb_strip_nulls(jsonb_build_object(
      'invoice_id',        p_inv.id,
      'invoice_date',      p_inv.invoice_date,
      'due_date',          p_inv.due_date,
      'document_kind',     p_inv.document_kind,
      'seller_name',       v_seller.name,
      'seller_gstin',      v_seller.gstin_owner_verified_gstin,
      'seller_state_code', p_inv.seller_state_code,
      'buyer_name',        p_inv.customer_name,
      'billing_address',   p_inv.billing_address,
      'place_of_supply',   p_inv.pos_state_code,
      'tax_rate',          p_inv.tax_rate,
      'inter_state',       v_inter,
      'gst_split_frozen',  v_frozen,
      'irn',               p_inv.gst_irn,
      'pdf_url',           p_inv.pdf_url,
      'lines',             public.network_copy_lines(p_inv.line_items))))
  on conflict do nothing
  returning id into v_id;
  return v_id;
end $function$;

create or replace function public.tg_network_invoice_issue()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  /* R-2434 */
  if TG_OP = 'UPDATE' and NEW.status = 'void' and OLD.status is distinct from 'void' then
    -- seller voided (an accepted copy refuses the void — tg_network_invoice_lock): every copy
    -- not accepted (pending / rejected invoice copy, pending notes) is cancelled
    update public.network_documents
       set status = 'cancelled', cancelled_at = now(), updated_at = now()
     where seller_tenant_id = NEW.tenant_id and seller_invoice_id = NEW.id and status in ('pending', 'rejected');
    return NEW;
  end if;
  if NEW.status not in ('pending', 'paid', 'overdue') then return NEW; end if;
  if TG_OP = 'UPDATE' and OLD.status is distinct from 'draft' then return NEW; end if;
  if NEW.document_kind = 'opening_invoice' then return NEW; end if;   -- no new sale (R-1739)
  perform public.network_send_invoice(NEW);
  return NEW;
end $function$;

drop trigger if exists trg_network_invoice_issue on public.invoices;
create trigger trg_network_invoice_issue
  after insert or update of status on public.invoices
  for each row execute function public.tg_network_invoice_issue();

-- ── deliver: credit / debit note on a copied invoice → pending copy ───────────────────
/* One trigger function for credit_notes and debit_notes (same columns; the date column differs). */
create or replace function public.tg_network_note_issue()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_kind    text := case TG_TABLE_NAME when 'debit_notes' then 'debit_note' else 'credit_note' end;
  v_row     jsonb := to_jsonb(NEW);
  v_inv     public.network_documents;
  v_amount  integer := NEW.amount;
  v_taxable integer;
  v_tax     integer;
  v_cgst    integer := 0;
  v_sgst    integer := 0;
  v_igst    integer := 0;
  v_date    date := coalesce(nullif(v_row ->> (case TG_TABLE_NAME when 'debit_notes' then 'debit_date' else 'credit_date' end), '')::date,
                             public.ist_today());
begin
  -- only the invoice's own company, and only for a copy still live with the buyer (a rejected
  -- invoice copy booked nothing, so a note on it has nothing to correct)
  select * into v_inv from public.network_documents
   where kind = 'invoice' and seller_tenant_id = NEW.tenant_id and seller_invoice_id = NEW.invoice_id
     and status in ('pending', 'accepted');
  if v_inv.id is null then return NEW; end if;
  if public.network_invoice_buyer(NEW.tenant_id, v_inv.seller_gstin, v_inv.buyer_gstin) is distinct from v_inv.buyer_tenant_id then
    return NEW;   -- connection revoked / scope off / proof gone: nothing new flows
  end if;

  if v_inv.cgst + v_inv.sgst + v_inv.igst = 0 then
    v_taxable := v_amount;            -- invoice copy without GST: value only
    v_tax := 0;
  elsif NEW.taxable_value is null then
    -- an old note without a frozen split: split the gross at the invoice copy's own proportion
    v_taxable := round(v_amount::numeric * v_inv.taxable_value / nullif(v_inv.taxable_value + v_inv.cgst + v_inv.sgst + v_inv.igst, 0))::integer;
    v_tax := v_amount - v_taxable;
  else
    v_taxable := NEW.taxable_value;
    v_tax := coalesce(NEW.tax_amount, 0);
  end if;
  -- heads follow the invoice copy
  if v_tax = 0 then
    null;
  elsif v_inv.igst > 0 then
    v_igst := v_tax;
  else
    v_cgst := round(v_tax::numeric / 2)::integer;
    v_sgst := v_tax - v_cgst;
  end if;

  insert into public.network_documents (
    kind, seller_tenant_id, buyer_tenant_id, connection_id, seller_invoice_id, seller_note_id,
    parent_document_id, seller_gstin, buyer_gstin, seller_name, doc_number, doc_date, fy, document_type,
    taxable_value, cgst, sgst, igst, total, currency, fx_rate, payload)
  values (
    v_kind, NEW.tenant_id, v_inv.buyer_tenant_id, v_inv.connection_id, NEW.invoice_id, NEW.id,
    v_inv.id, v_inv.seller_gstin, v_inv.buyer_gstin, v_inv.seller_name, NEW.id, v_date, public.network_fy(v_date),
    v_inv.document_type, v_taxable, v_cgst, v_sgst, v_igst, v_taxable + v_cgst + v_sgst + v_igst,
    v_inv.currency, v_inv.fx_rate,
    jsonb_strip_nulls(jsonb_build_object(
      'note_id',     NEW.id,
      'note_date',   v_date,
      'invoice_id',  NEW.invoice_id,
      'reason',      NEW.reason,
      'reason_code', NEW.reason_code,
      'amount',      NEW.amount)))
  on conflict do nothing;
  return NEW;
end $function$;

drop trigger if exists trg_network_note_issue on public.credit_notes;
create trigger trg_network_note_issue
  after insert on public.credit_notes
  for each row execute function public.tg_network_note_issue();
drop trigger if exists trg_network_note_issue on public.debit_notes;
create trigger trg_network_note_issue
  after insert on public.debit_notes
  for each row execute function public.tg_network_note_issue();

-- ── locks: accepted documents ─────────────────────────────────────────────────────────
create or replace function public.tg_network_invoice_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434: an invoice the customer ACCEPTED is locked — not even app.invoice_amend_reason. */
  v_doc public.network_documents;
begin
  select * into v_doc from public.network_documents
   where seller_tenant_id = OLD.tenant_id and seller_invoice_id = OLD.id and kind = 'invoice' and status = 'accepted';
  if v_doc.id is null then return NEW; end if;
  if (NEW.status is distinct from OLD.status and NEW.status in ('void', 'draft'))
     -- lines compared as the buyer sees them: the seller's internal cost may still be filled in
     or (NEW.id, NEW.tenant_id, NEW.invoice_date, NEW.amount, NEW.customer_id, NEW.customer_name, NEW.taxable_value,
         NEW.tax_amount, NEW.tax_rate, NEW.inter_state, public.network_copy_lines(NEW.line_items), NEW.due_date,
         NEW.customer_gstin, NEW.seller_gstin, NEW.pos_state_code, NEW.seller_state_code, NEW.document_kind, NEW.gst_treatment)
        is distinct from
        (OLD.id, OLD.tenant_id, OLD.invoice_date, OLD.amount, OLD.customer_id, OLD.customer_name, OLD.taxable_value,
         OLD.tax_amount, OLD.tax_rate, OLD.inter_state, public.network_copy_lines(OLD.line_items), OLD.due_date,
         OLD.customer_gstin, OLD.seller_gstin, OLD.pos_state_code, OLD.seller_state_code, OLD.document_kind, OLD.gst_treatment) then
    raise exception 'Invoice % was accepted by your customer % on % — it is locked on both sides. Correct it with a credit note (and a fresh invoice if needed).',
      OLD.id, (select name from public.tenants where id = v_doc.buyer_tenant_id),
      to_char(v_doc.responded_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  return NEW;
end $function$;

drop trigger if exists trg_network_invoice_lock on public.invoices;
create trigger trg_network_invoice_lock
  before update on public.invoices
  for each row execute function public.tg_network_invoice_lock();

/* A credit / debit note whose copy the customer ACCEPTED is locked; one whose copy is still
   PENDING may change or go — its copy is then cancelled, so the buyer can never accept a note the
   seller no longer has. */
create or replace function public.tg_network_note_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_kind  text := case TG_TABLE_NAME when 'debit_notes' then 'debit_note' else 'credit_note' end;
  v_label text := case TG_TABLE_NAME when 'debit_notes' then 'Debit note' else 'Credit note' end;
  v_keys  text[] := array['id', 'tenant_id', 'invoice_id', 'credit_date', 'debit_date', 'amount', 'taxable_value', 'tax_amount', 'inter_state'];
  v_doc   public.network_documents;
  v_same  boolean;
begin
  select * into v_doc from public.network_documents
   where seller_tenant_id = OLD.tenant_id and seller_note_id = OLD.id and kind = v_kind and status in ('pending', 'accepted');
  if v_doc.id is null then return coalesce(NEW, OLD); end if;
  if TG_OP = 'DELETE' then
    if not exists (select 1 from public.tenants where id = OLD.tenant_id) then return OLD; end if;   -- company deleted
    v_same := false;
  else
    select coalesce(bool_and((to_jsonb(NEW) -> k) is not distinct from (to_jsonb(OLD) -> k)), true) into v_same
      from unnest(v_keys) k;
    if v_same then return NEW; end if;
  end if;
  if v_doc.status = 'pending' then
    update public.network_documents set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = v_doc.id;
    return coalesce(NEW, OLD);
  end if;
  raise exception '% % was accepted by your customer — it is locked. Issue another note (or a fresh invoice) instead.', v_label, OLD.id
    using errcode = 'check_violation';
end $function$;

drop trigger if exists trg_network_note_lock on public.credit_notes;
create trigger trg_network_note_lock
  before update or delete on public.credit_notes
  for each row execute function public.tg_network_note_lock();
drop trigger if exists trg_network_note_lock on public.debit_notes;
create trigger trg_network_note_lock
  before update or delete on public.debit_notes
  for each row execute function public.tg_network_note_lock();

/* A bill an Accept MADE (invoice or debit note) keeps the seller's amounts and cannot be deleted.
   A bill the buyer typed itself that an accept only LINKED stays the buyer's own record (its
   amounts may be corrected) but cannot be deleted while the accepted copy points at it — undo the
   accept first (network_undo_accept). */
create or replace function public.tg_network_bill_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_doc public.network_documents;
begin
  if coalesce(current_setting('app.network_bill_write', true), '') = 'R-2434' then
    return coalesce(NEW, OLD);   -- network_accept_document / network_undo_accept at work
  end if;
  select * into v_doc from public.network_documents
   where buyer_tenant_id = OLD.tenant_id and vendor_bill_id = OLD.id and kind in ('invoice', 'debit_note')
     and status = 'accepted'
   order by linked_existing   -- a bill an accept made wins over a link
   limit 1;
  if v_doc.id is null then return coalesce(NEW, OLD); end if;
  if TG_OP = 'DELETE' then
    if not exists (select 1 from public.tenants where id = OLD.tenant_id) then return OLD; end if;   -- company deleted
    raise exception 'Bill % is linked to % document % that you accepted — undo that accept first (From network → Undo accept), then delete the bill.',
      OLD.id, v_doc.seller_name, v_doc.doc_number
      using errcode = 'check_violation';
  elsif v_doc.linked_existing then
    return NEW;   -- the buyer's own typed bill: amounts stay the buyer's to correct
  elsif (NEW.id, NEW.tenant_id, NEW.bill_no, NEW.bill_date, NEW.vendor_gstin, NEW.subtotal, NEW.cgst, NEW.sgst, NEW.igst,
         NEW.total, NEW.line_items, NEW.currency, NEW.fx_rate, NEW.document_type, NEW.source_tenant_invoice_id)
        is not distinct from
        (OLD.id, OLD.tenant_id, OLD.bill_no, OLD.bill_date, OLD.vendor_gstin, OLD.subtotal, OLD.cgst, OLD.sgst, OLD.igst,
         OLD.total, OLD.line_items, OLD.currency, OLD.fx_rate, OLD.document_type, OLD.source_tenant_invoice_id) then
    return NEW;
  end if;
  raise exception 'Bill % is your accepted copy of % invoice % — its number, date, GSTIN and amounts are locked. A change comes only as a credit note from the seller. (Category, notes, due date and payments stay yours to change.)',
    OLD.id, v_doc.seller_name, v_doc.doc_number
    using errcode = 'check_violation';
end $function$;

drop trigger if exists trg_network_bill_lock on public.vendor_bills;
create trigger trg_network_bill_lock
  before update or delete on public.vendor_bills
  for each row execute function public.tg_network_bill_lock();

-- ── buyer: accept / reject ────────────────────────────────────────────────────────────
create or replace function public.network_doc_actor()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null then
    raise exception 'Answering a document from a connected business needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only the owner, a manager or an accountant can accept or reject a document from a connected business.'
      using errcode = '42501';
  end if;
  return v_t;
end $function$;

create or replace function public.network_accept_document(p_id uuid, p_category text default null)
returns table (document_id uuid, status text, vendor_bill_id text, linked_existing boolean, note text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_t        uuid := public.network_doc_actor();
  v_d        public.network_documents;
  v_inv      public.network_documents;
  v_b        public.vendor_bills;
  v_vendor   uuid;
  v_vcat     text;
  v_vname    text;
  v_lock     date;
  v_date     date;
  v_note     text;
  v_bill_id  text;
  v_linked   boolean := false;
  v_lines    jsonb;
  v_tax      integer;
  v_taxable  integer;
  v_cgst     integer := 0;
  v_sgst     integer := 0;
  v_igst     integer := 0;
  v_new_tot  integer;
  v_paid     integer;
begin
  select * into v_d from public.network_documents d where d.id = p_id and d.buyer_tenant_id = v_t for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_d.status = 'accepted' then
    raise exception 'This document is already accepted (bill %).', coalesce(v_d.vendor_bill_id, '—') using errcode = '22023';
  end if;
  if v_d.status = 'cancelled' then
    raise exception 'The seller cancelled (voided) % — there is nothing to accept.', v_d.doc_number using errcode = '22023';
  end if;
  if v_d.status = 'rejected' then
    raise exception 'You rejected % — the seller corrects it with a credit note and a fresh invoice, which you accept instead.', v_d.doc_number
      using errcode = '22023';
  end if;
  if public.network_invoice_buyer(v_d.seller_tenant_id, v_d.seller_gstin, v_d.buyer_gstin) is distinct from v_t then
    raise exception 'Your connection with % no longer shares invoices (or a GSTIN is no longer proved) — record this document by hand from the copy.',
      v_d.seller_name using errcode = '42501';
  end if;
  select books_locked_until into v_lock from public.tenants where id = v_t;

  if v_d.kind <> 'invoice' then
    -- a note corrects an invoice the buyer has booked
    select * into v_inv from public.network_documents where id = v_d.parent_document_id and buyer_tenant_id = v_t;
    if v_inv.status is distinct from 'accepted' or v_inv.vendor_bill_id is null then
      raise exception 'Accept invoice % first (or reject this note).', v_d.seller_invoice_id using errcode = '22023';
    end if;
  end if;

  if v_d.kind in ('invoice', 'debit_note') then
    -- 1. a bill the buyer already typed: same seller GSTIN + number + FY, not linked to another copy
    select b.* into v_b from public.vendor_bills b
     where b.tenant_id = v_t
       and upper(btrim(coalesce(b.vendor_gstin, ''))) = v_d.seller_gstin
       and upper(btrim(coalesce(b.bill_no, ''))) = upper(btrim(v_d.doc_number))
       and public.network_fy(b.bill_date) = v_d.fy
       and not exists (select 1 from public.network_documents x
                        where x.buyer_tenant_id = v_t and x.vendor_bill_id = b.id and x.kind in ('invoice', 'debit_note') and x.status = 'accepted')
     order by b.created_at
     limit 1
     for update;
    if v_b.id is not null then
      v_bill_id := v_b.id;
      v_linked := true;
      if (v_b.subtotal, v_b.cgst + v_b.sgst + v_b.igst) is distinct from (v_d.taxable_value, v_d.cgst + v_d.sgst + v_d.igst) then
        v_note := format('Linked to your bill %s, which says taxable ₹%s + GST ₹%s; the seller''s invoice says ₹%s + ₹%s — correct your bill.',
                         v_b.id, v_b.subtotal, v_b.cgst + v_b.sgst + v_b.igst, v_d.taxable_value, v_d.cgst + v_d.sgst + v_d.igst);
      else
        v_note := format('Linked to your bill %s (same number, amounts match).', v_b.id);
      end if;
    else
      -- 2. a new bill. Vendor: by GSTIN, else same name with no other GSTIN, else new.
      select v.id, v.default_category into v_vendor, v_vcat from public.vendors v
       where v.tenant_id = v_t and upper(btrim(coalesce(v.gstin, ''))) = v_d.seller_gstin
       order by v.created_at limit 1;
      if v_vendor is null then
        select v.id, v.default_category into v_vendor, v_vcat from public.vendors v
         where v.tenant_id = v_t and lower(btrim(v.name)) = lower(btrim(v_d.seller_name))
           and nullif(btrim(coalesce(v.gstin, '')), '') is null
         order by v.created_at limit 1;
        if v_vendor is not null then
          update public.vendors set gstin = v_d.seller_gstin, updated_at = now() where id = v_vendor;
        end if;
      end if;
      if v_vendor is null then
        v_vname := btrim(v_d.seller_name);
        if exists (select 1 from public.vendors v where v.tenant_id = v_t and lower(btrim(v.name)) = lower(v_vname)) then
          v_vname := v_vname || ' (' || v_d.seller_gstin || ')';
        end if;
        insert into public.vendors (tenant_id, name, gstin, pan, notes)
        values (v_t, v_vname, v_d.seller_gstin,
                case when substr(v_d.seller_gstin, 3, 10) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then substr(v_d.seller_gstin, 3, 10) end,
                'Connected business on ResellerOS — added when you accepted its invoice.')
        returning id into v_vendor;
      end if;

      v_date := v_d.doc_date;
      if v_lock is not null and v_date <= v_lock then
        v_date := v_lock + 1;
        v_note := format('%s dated %s; your books are locked till %s, so this bill is dated %s.',
          case v_d.kind when 'debit_note' then 'Debit note' else 'Invoice' end,
          to_char(v_d.doc_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'), to_char(v_date, 'DD Mon YYYY'));
      end if;

      -- the seller's lines when they add up to the taxable value, else one summary line
      v_lines := v_d.payload -> 'lines';
      if v_lines is null or jsonb_typeof(v_lines) <> 'array' or jsonb_array_length(v_lines) = 0
         or (select coalesce(sum((l ->> 'amount')::numeric), 0) from jsonb_array_elements(v_lines) l) <> v_d.taxable_value then
        v_lines := jsonb_build_array(jsonb_build_object(
          'description', case v_d.kind when 'debit_note' then format('Debit note %s on invoice %s', v_d.doc_number, v_d.seller_invoice_id)
                                       else 'Supply against invoice ' || v_d.doc_number end,
          'quantity', 1, 'rate', v_d.taxable_value, 'amount', v_d.taxable_value));
      else
        v_lines := (select jsonb_agg(jsonb_build_object(
                       'description', l ->> 'description', 'hsn_sac', l ->> 'hsn_sac',
                       'quantity', (l ->> 'quantity')::numeric, 'rate', (l ->> 'rate')::numeric,
                       'amount', (l ->> 'amount')::numeric) order by o)
                      from jsonb_array_elements(v_lines) with ordinality as z(l, o));
      end if;

      v_bill_id := 'VB-NET-' || upper(substr(replace(v_d.id::text, '-', ''), 1, 12));
      insert into public.vendor_bills (
        id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
        category, line_items, subtotal, cgst, sgst, igst, total, status, paid_amount, notes,
        source_tenant_invoice_id, document_type, currency, fx_rate)
      values (
        v_bill_id, v_t, v_vendor, v_d.seller_name, v_d.seller_gstin, v_d.doc_number, v_date,
        coalesce(nullif(v_d.payload ->> 'due_date', '')::date, v_date),
        coalesce(nullif(btrim(p_category), ''), nullif(btrim(v_vcat), ''), 'cloud_subscriptions'),
        v_lines, v_d.taxable_value, v_d.cgst, v_d.sgst, v_d.igst,
        v_d.taxable_value + v_d.cgst + v_d.sgst + v_d.igst, 'unpaid', 0,
        concat_ws(E'\n', format('From %s (GSTIN %s) through your business network — accepted %s.',
                                v_d.seller_name, v_d.seller_gstin, to_char(public.ist_today(), 'DD Mon YYYY')), v_note),
        -- one bill per source invoice (ux_vendor_bills_source_tenant_invoice): a debit-note bill carries none
        case v_d.kind when 'invoice' then v_d.seller_invoice_id end, v_d.document_type, v_d.currency, v_d.fx_rate);
    end if;

  else
    -- credit note: lowers the accepted bill of its invoice (in place, as R-2432 does)
    select * into v_b from public.vendor_bills b where b.id = v_inv.vendor_bill_id and b.tenant_id = v_t for update;
    if v_b.id is null then
      raise exception 'The bill for invoice % is gone — record this credit note by hand.', v_d.seller_invoice_id using errcode = 'P0002';
    end if;
    if v_lock is not null and v_b.bill_date <= v_lock then
      raise exception 'Your books are locked till %, and bill % is dated % — this credit note cannot change it. Unlock that period (Settings → Books lock) and accept again, or ask your CA how to record it in the open month.',
        to_char(v_lock, 'DD Mon YYYY'), v_b.id, to_char(v_b.bill_date, 'DD Mon YYYY') using errcode = '22023';
    end if;
    v_tax := v_d.cgst + v_d.sgst + v_d.igst;
    v_taxable := v_d.taxable_value;
    if v_b.cgst + v_b.sgst + v_b.igst = 0 then
      v_taxable := v_d.total;    -- bill booked without GST: reduce the value only
      v_tax := 0;
    end if;
    -- heads follow the BILL (how its ITC was booked)
    if v_tax = 0 then
      null;
    elsif v_b.igst > 0 then
      v_igst := v_tax;
    else
      v_cgst := round(v_tax::numeric / 2)::integer;
      v_sgst := v_tax - v_cgst;
    end if;
    if v_b.subtotal < v_taxable or v_b.cgst < v_cgst or v_b.sgst < v_sgst or v_b.igst < v_igst then
      raise exception 'Credit note % (₹%) is more than bill % on some head — check both with the seller.', v_d.doc_number, v_d.total, v_b.id
        using errcode = '22023';
    end if;
    v_new_tot := v_b.total - (v_taxable + v_cgst + v_sgst + v_igst);
    v_paid := coalesce(v_b.paid_amount, 0) + coalesce(v_b.advance_applied, 0);
    if v_new_tot < v_paid then
      raise exception 'Bill % already has ₹% paid, more than the ₹% it would be after credit note %. The seller owes you the difference — reduce or undo that payment first, then accept.',
        v_b.id, v_paid, v_new_tot, v_d.doc_number using errcode = '22023';
    end if;
    perform set_config('app.network_bill_write', 'R-2434', true);
    update public.vendor_bills b
       set subtotal = b.subtotal - v_taxable,
           cgst = b.cgst - v_cgst,
           sgst = b.sgst - v_sgst,
           igst = b.igst - v_igst,
           total = v_new_tot,
           status = case when v_paid >= v_new_tot then 'paid' when v_paid > 0 then 'partial' else 'unpaid' end,
           line_items = coalesce(b.line_items, '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
             'description', 'Less: credit note ' || v_d.doc_number, 'quantity', 1,
             'rate', -v_taxable, 'amount', -v_taxable)),
           notes = concat_ws(E'\n', nullif(b.notes, ''),
             format('Reduced by credit note %s from %s (₹%s), accepted %s.', v_d.doc_number, v_d.seller_name, v_d.total,
                    to_char(public.ist_today(), 'DD Mon YYYY')))
     where b.id = v_b.id;
    perform set_config('app.network_bill_write', '', true);
    v_bill_id := v_b.id;
  end if;

  update public.network_documents d
     set status = 'accepted', responded_by = auth.uid(), responded_at = now(), reject_reason = null,
         vendor_bill_id = v_bill_id, linked_existing = v_linked, apply_note = v_note, updated_at = now()
   where d.id = v_d.id;

  return query select v_d.id, 'accepted'::text, v_bill_id, v_linked, v_note;
end $function$;

/* Take an Accept back (a wrong click): the bill it made goes (only while untouched and in open
   books) or the bill it linked is unlinked; the copy is pending again. Not for a credit note
   (it changed the bill in place — the seller issues a debit note instead). */
create or replace function public.network_undo_accept(p_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_t    uuid := public.network_doc_actor();
  v_d    public.network_documents;
  v_b    public.vendor_bills;
  v_lock date;
begin
  select * into v_d from public.network_documents d where d.id = p_id and d.buyer_tenant_id = v_t for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_d.status <> 'accepted' then
    raise exception 'Only an accepted document can be undone (this one is %).', v_d.status using errcode = '22023';
  end if;
  if v_d.kind = 'credit_note' then
    raise exception 'An accepted credit note cannot be undone — it already lowered bill %. Ask the seller for a debit note.', v_d.vendor_bill_id
      using errcode = '22023';
  end if;
  if exists (select 1 from public.network_documents n where n.parent_document_id = v_d.id and n.status = 'accepted') then
    raise exception 'A credit / debit note on % is already accepted, so the invoice stays accepted.', v_d.doc_number using errcode = '22023';
  end if;
  if public.network_invoice_buyer(v_d.seller_tenant_id, v_d.seller_gstin, v_d.buyer_gstin) is distinct from v_t then
    raise exception 'Your connection with % no longer shares invoices — the accept stays as it is.', v_d.seller_name using errcode = '42501';
  end if;

  select * into v_b from public.vendor_bills b where b.id = v_d.vendor_bill_id and b.tenant_id = v_t for update;
  if v_b.id is not null and not v_d.linked_existing then
    if not public.r2432_partner_bill_untouched(v_b) then
      raise exception 'Bill % already has a payment, an advance or a bank / PO link — undo that first, then undo the accept.', v_b.id
        using errcode = '22023';
    end if;
    select books_locked_until into v_lock from public.tenants where id = v_t;
    if v_lock is not null and v_b.bill_date <= v_lock then
      raise exception 'Your books are locked till %, and bill % is dated % — it cannot be removed.', to_char(v_lock, 'DD Mon YYYY'), v_b.id,
        to_char(v_b.bill_date, 'DD Mon YYYY') using errcode = '22023';
    end if;
    perform set_config('app.network_bill_write', 'R-2434', true);
    delete from public.vendor_bills b where b.id = v_b.id;
    perform set_config('app.network_bill_write', '', true);
  end if;

  update public.network_documents d
     set status = 'pending', responded_by = null, responded_at = null, vendor_bill_id = null,
         linked_existing = false, apply_note = null, updated_at = now()
   where d.id = v_d.id;
  return 'pending';
end $function$;

create or replace function public.network_reject_document(p_id uuid, p_reason text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434 */
  v_t      uuid := public.network_doc_actor();
  v_d      public.network_documents;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_d from public.network_documents d where d.id = p_id and d.buyer_tenant_id = v_t for update;
  if not found then
    raise exception 'Document not found.' using errcode = 'P0002';
  end if;
  if v_reason is null then
    raise exception 'Write the reason — the seller sees it on their invoice.' using errcode = '22023';
  end if;
  if v_d.status <> 'pending' then
    raise exception 'Only a pending document can be rejected (this one is %).', v_d.status using errcode = '22023';
  end if;
  if public.network_invoice_buyer(v_d.seller_tenant_id, v_d.seller_gstin, v_d.buyer_gstin) is distinct from v_t then
    raise exception 'Your connection with % no longer shares invoices — tell the seller directly.', v_d.seller_name
      using errcode = '42501';
  end if;
  update public.network_documents d
     set status = 'rejected', reject_reason = left(v_reason, 500), responded_by = auth.uid(), responded_at = now(), updated_at = now()
   where d.id = v_d.id;
  return 'rejected';
end $function$;

-- ── reads (delivered documents stay readable after a revoke) ─────────────────────────
create or replace function public.network_inbox(p_status text default null)
returns table (
  id uuid, kind text, status text, seller_name text, seller_gstin text, doc_number text, doc_date date, fy text,
  document_type text, taxable_value integer, cgst integer, sgst integer, igst integer, total integer,
  currency text, fx_rate numeric, payload jsonb, parent_document_id uuid, seller_invoice_id text,
  reject_reason text, vendor_bill_id text, linked_existing boolean, apply_note text,
  created_at timestamptz, responded_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434: the buyer's owner / manager / accountant; anyone else sees nothing. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return;
  end if;
  return query
  select d.id, d.kind, d.status, d.seller_name, d.seller_gstin, d.doc_number, d.doc_date, d.fy,
         d.document_type, d.taxable_value, d.cgst, d.sgst, d.igst, d.total, d.currency, d.fx_rate, d.payload,
         d.parent_document_id, d.seller_invoice_id, d.reject_reason, d.vendor_bill_id, d.linked_existing,
         d.apply_note, d.created_at, d.responded_at
    from public.network_documents d
   where d.buyer_tenant_id = v_t
     and (p_status is null or d.status = p_status)
   order by case d.status when 'pending' then 0 else 1 end, d.doc_date desc, d.created_at desc;
end $function$;

create or replace function public.network_seller_documents(p_invoice_id text default null)
returns table (
  id uuid, kind text, seller_invoice_id text, seller_note_id text, doc_number text,
  buyer_name text, buyer_gstin text, status text, reject_reason text, responded_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2434: the seller's owner / manager / accountant see what their customers answered. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return;
  end if;
  return query
  select d.id, d.kind, d.seller_invoice_id, d.seller_note_id, d.doc_number,
         b.name::text, d.buyer_gstin, d.status, d.reject_reason, d.responded_at, d.created_at
    from public.network_documents d
    join public.tenants b on b.id = d.buyer_tenant_id
   where d.seller_tenant_id = v_t
     and (p_invoice_id is null or d.seller_invoice_id = p_invoice_id)
   order by d.created_at desc;
end $function$;

-- ── R-2432 mirror: not for a connected pair (from 20261103192959, one added check) ────
CREATE OR REPLACE FUNCTION public.tg_mirror_invoice_to_child_vendor_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  /* R-2432: mirror on issue, frozen GST split, document_type, vendor_id, void follow-through.
     R-2434: a connected pair (seller shares invoices, both GSTINs owner-proved) gets a pending
     network copy the buyer accepts instead — no bill made here on issue. */
  v_linked_tenant uuid;
  v_parent        tenants%rowtype;
  v_child_lock    date;
  v_bill          vendor_bills%rowtype;
  v_vendor        uuid;
  v_gstin         text;
  v_subtotal      integer;
  v_tax           integer;
  v_igst          integer := 0;
  v_cgst          integer := 0;
  v_sgst          integer := 0;
  v_inter_state   boolean;
  v_doc_type      text;
  v_bill_date     date;
  v_note          text;
  v_vname         text;
begin
  -- The bill this invoice already made (found by the invoice, not by today's link — a link
  -- changed since must not stop a void from reaching it).
  select * into v_bill from public.vendor_bills
   where id = 'VB-PARTNER-' || NEW.id and source_tenant_invoice_id = NEW.id;

  -- Void: take the mirrored bill back.
  if TG_OP = 'UPDATE' and NEW.status = 'void' and OLD.status is distinct from 'void' then
    if v_bill.id is null then return NEW; end if;
    select books_locked_until into v_child_lock from public.tenants where id = v_bill.tenant_id;
    if v_child_lock is not null and v_bill.bill_date <= v_child_lock then return NEW; end if;
    if public.r2432_partner_bill_untouched(v_bill) then
      delete from public.vendor_bills where id = v_bill.id;
    else
      update public.vendor_bills
         set notes = concat_ws(E'\n', nullif(notes, ''),
               format('Distributor voided invoice %s on %s — this bill is already paid/linked, so it was kept. Ask the distributor for a refund or credit note.',
                      NEW.id, to_char(public.ist_today(), 'DD Mon YYYY')))
       where id = v_bill.id;
    end if;
    return NEW;
  end if;

  -- Only an issued invoice becomes a bill: inserted issued, or draft → issued.
  if NEW.status not in ('pending', 'paid', 'overdue') then return NEW; end if;
  if TG_OP = 'UPDATE' and OLD.status is distinct from 'draft' then return NEW; end if;
  if NEW.customer_id is null then return NEW; end if;
  /* R-1739: an imported Zoho opening invoice is no new sale — the child's bill (and its ITC)
     was already booked in Zoho / by the child. */
  if NEW.document_kind = 'opening_invoice' then return NEW; end if;
  /* R-2434: connected pair → the network copy (trg_network_invoice_issue) replaces this bill. */
  if public.network_invoice_buyer_of(NEW) is not null then return NEW; end if;

  select linked_tenant_id into v_linked_tenant
  from public.customers
  where id = NEW.customer_id and tenant_id = NEW.tenant_id;
  if v_linked_tenant is null then return NEW; end if;

  if not exists (
    select 1 from public.tenants
    where id = v_linked_tenant and parent_tenant_id = NEW.tenant_id
  ) then return NEW; end if;

  select books_locked_until into v_child_lock from public.tenants where id = v_linked_tenant;

  if v_bill.id is not null then
    -- A bill the OLD trigger made while this invoice was a draft (no document_type, /1.18 guess):
    -- rebuild it from the issued invoice if the reseller has not touched it; else keep it.
    if TG_OP = 'UPDATE' and v_bill.document_type is null and v_bill.tenant_id = v_linked_tenant
       and (v_child_lock is null or v_bill.bill_date > v_child_lock)
       and public.r2432_partner_bill_untouched(v_bill) then
      delete from public.vendor_bills where id = v_bill.id;
    else
      return NEW;
    end if;
  end if;

  select * into v_parent from public.tenants where id = NEW.tenant_id;
  v_gstin := upper(coalesce(nullif(btrim(NEW.seller_gstin), ''), nullif(btrim(v_parent.gstin), '')));

  -- GST split frozen on the invoice — never a guess.
  if NEW.taxable_value is not null and NEW.tax_amount is not null then
    v_subtotal := NEW.taxable_value;
    v_tax := NEW.tax_amount;
    v_inter_state := coalesce(NEW.inter_state,
      NEW.seller_state_code is distinct from NEW.pos_state_code);
    if v_inter_state then
      v_igst := v_tax;
    else
      v_cgst := round(v_tax::numeric / 2)::integer;
      v_sgst := v_tax - v_cgst;
    end if;
    v_doc_type := case NEW.document_kind when 'bill_of_supply' then 'bill_of_supply' else 'tax_invoice' end;
  else
    v_subtotal := NEW.amount;
    v_doc_type := 'other';
    v_note := 'The distributor invoice carries no frozen GST split — booked without GST (no ITC). Check the invoice and correct this bill.';
  end if;

  -- The reseller's vendor for this distributor: by GSTIN, else by name, else a new one.
  select id into v_vendor from public.vendors
   where tenant_id = v_linked_tenant and v_gstin is not null and upper(btrim(gstin)) = v_gstin
   order by created_at limit 1;
  if v_vendor is null then
    -- same name, but never a vendor carrying a DIFFERENT GSTIN
    select id into v_vendor from public.vendors
     where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(btrim(v_parent.name))
       and (v_gstin is null or nullif(btrim(gstin), '') is null or upper(btrim(gstin)) = v_gstin)
     order by created_at limit 1;
  end if;
  if v_vendor is null then
    v_vname := btrim(v_parent.name);
    if exists (select 1 from public.vendors
                where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(v_vname)) then
      v_vname := v_vname || ' (' || coalesce(v_gstin, 'distributor') || ')';
    end if;
    insert into public.vendors (tenant_id, name, gstin, pan, default_category, notes)
    values (v_linked_tenant, v_vname, v_gstin,
            case when substr(v_gstin, 3, 10) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then substr(v_gstin, 3, 10) end,
            'cloud_subscriptions', 'Your distributor — added automatically from its invoices.')
    on conflict do nothing
    returning id into v_vendor;
    if v_vendor is null then   -- made by a parallel issue a moment ago
      select id into v_vendor from public.vendors
       where tenant_id = v_linked_tenant and lower(btrim(name)) = lower(v_vname);
    end if;
  end if;

  v_bill_date := NEW.invoice_date;
  if v_child_lock is not null and v_bill_date <= v_child_lock then
    v_bill_date := v_child_lock + 1;
    v_note := concat_ws(E'\n', v_note, format('Invoice dated %s; your books are locked till %s, so this bill is dated %s.',
      to_char(NEW.invoice_date, 'DD Mon YYYY'), to_char(v_child_lock, 'DD Mon YYYY'), to_char(v_bill_date, 'DD Mon YYYY')));
  end if;

  insert into public.vendor_bills (
    id, tenant_id, vendor_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
    category, line_items, subtotal, cgst, sgst, igst, total, status,
    paid_amount, notes, source_tenant_invoice_id, document_type, currency, fx_rate
  ) values (
    'VB-PARTNER-' || NEW.id,
    v_linked_tenant,
    v_vendor,
    v_parent.name,
    v_gstin,
    NEW.id,
    v_bill_date,
    NEW.due_date,
    'cloud_subscriptions',
    jsonb_build_array(jsonb_build_object(
      'description', 'Wholesale supply against invoice ' || NEW.id,
      'quantity',    1,
      'rate',        v_subtotal,
      'amount',      v_subtotal
    )),
    v_subtotal, v_cgst, v_sgst, v_igst, v_subtotal + v_cgst + v_sgst + v_igst,
    'unpaid', 0,
    concat_ws(E'\n', 'Auto-imported from ' || v_parent.name || ' (your distributor).', v_note),
    NEW.id,
    v_doc_type,
    coalesce(NEW.currency, 'INR'),
    coalesce(NEW.fx_rate, 1)
  )
  on conflict do nothing;   -- an id taken already (never block the distributor's issue)

  return NEW;
end $function$;

-- ── grants ────────────────────────────────────────────────────────────────────────────
revoke all on function public.network_fy(date) from public, anon;
revoke all on function public.network_invoice_buyer(uuid, text, text) from public, anon, authenticated;
revoke all on function public.network_invoice_buyer_of(public.invoices) from public, anon, authenticated;
revoke all on function public.network_copy_lines(jsonb) from public, anon;
revoke all on function public.network_send_invoice(public.invoices) from public, anon, authenticated;
revoke all on function public.tg_network_invoice_issue() from public, anon, authenticated;
revoke all on function public.tg_network_note_issue() from public, anon, authenticated;
revoke all on function public.tg_network_invoice_lock() from public, anon, authenticated;
revoke all on function public.tg_network_note_lock() from public, anon, authenticated;
revoke all on function public.tg_network_bill_lock() from public, anon, authenticated;
revoke all on function public.network_doc_actor() from public, anon, authenticated;
revoke all on function public.network_accept_document(uuid, text) from public, anon;
revoke all on function public.network_reject_document(uuid, text) from public, anon;
revoke all on function public.network_undo_accept(uuid) from public, anon;
revoke all on function public.network_inbox(text) from public, anon;
revoke all on function public.network_seller_documents(text) from public, anon;

grant execute on function public.network_fy(date) to authenticated, service_role;
grant execute on function public.network_copy_lines(jsonb) to authenticated, service_role;   -- pure; invoker functions need an explicit grant on Cloud SQL (R-401)
grant execute on function public.network_accept_document(uuid, text) to authenticated;
grant execute on function public.network_reject_document(uuid, text) to authenticated;
grant execute on function public.network_undo_accept(uuid) to authenticated;
grant execute on function public.network_inbox(text) to authenticated;
grant execute on function public.network_seller_documents(text) to authenticated;

commit;
