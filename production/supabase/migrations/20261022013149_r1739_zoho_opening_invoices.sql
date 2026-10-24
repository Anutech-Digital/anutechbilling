-- deploy-peek: to_regclass('public.invoice_import_batches') is not null and to_regprocedure('public.import_opening_invoices(jsonb,text)') is not null and to_regprocedure('public.remove_opening_invoice_import(uuid,text)') is not null and to_regprocedure('public.invoice_is_sale(text)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_multi_invoice_payment(uuid,date,text,uuid,text,integer,jsonb,boolean,text)') and prosrc like '%R-1739%')
-- deploy-key: r1739zohoopening
--
-- R-1739 (P1, 22 Oct 2026 — R-1737 decision B): the owner's OLD open invoices from Zoho Books
-- (Unpaid / Overdue / Partially Paid) come in from Zoho's invoice-export CSV, so their balances
-- show in dues, aging, statements and reminders and can take payments — WITHOUT being counted
-- again as GST (GSTR-1 / 3B were filed from Zoho), revenue / P&L, e-invoice / IRN, or in our
-- own invoice number series.
--
-- ══ WHAT THIS ADDS ═════════════════════════════════════════════════════════════════════
--   1. invoices.document_kind 'opening_invoice' (+ import_batch_id, opening_balance = what was
--      still due when imported, external_number = the Zoho number as printed; unique per
--      company, so a second import of the same CSV skips it). amount = Zoho Total,
--      net_payable = Total, paid_amount = Total − Balance, tax 0, taxable 0, never a quote.
--      Written only by import_opening_invoices() (trigger refuses any other writer).
--   2. invoice_import_batches — one row per Import click (who, when, file, rows, balance);
--      remove_opening_invoice_import() takes a whole batch back while nothing touched it
--      (no payment, no TDS, no late-fee bill, paid_amount unchanged); the row stays, marked.
--   3. ONE predicate, public.invoice_is_sale(document_kind) — false only for an opening
--      invoice. Every GST / revenue reader uses it (TS twin: lib/accounting/sale-documents.ts;
--      guard test src/lib/accounting/sale-documents.guard.test.ts lists them all):
--        report_pnl, report_pnl_monthly (revenue), report_balance_sheet (gst_output only —
--        receivables keep the balance), report_day_book (no Sales voucher),
--        get_partner_metrics (invoiced this month). report_party_ledger shows it as
--        'Opening balance' for opening_balance (the Zoho receipts before import are not here).
--      Credit / debit notes against an opening invoice are refused (they would be GST notes).
--      tg_mirror_invoice_to_child_vendor_bill does not mirror it (no child bill / ITC).
--   4. Payments: an opening invoice has no quote, so payments.quote_id may be NULL when
--      payments.invoice_id names an opening invoice (and only then — trigger + check).
--      record_multi_invoice_payment routes such a line to _record_opening_invoice_payment
--      (receipt voucher, TDS receivable, bank account, received date — same as other lines).
--      trg_payments_opening_invoice keeps invoices.paid_amount / status / paid_date equal to
--      (Total − Balance) + received payments after every insert / refund / delete.
--   Ledger (derived, no journal table here): Debtors Dr = the open balance is in
--   report_balance_sheet.receivables (status pending/overdue); the Cr side is the Balance
--   Sheet equity line "Opening Balance Adjustments" = sum(opening_balance), read in TS.
--   Account name to be confirmed by Hitesh (card needsDecision).
--
-- Cloud SQL: no extensions schema; auth.uid()/auth.role() rewritten by the deploy script.
-- Grants explicit (no PUBLIC EXECUTE). service_role policy (R-450).
-- Test: supabase/tests/zoho_opening_invoices.test.sql (rolled back).
-- Rollback: restore the previous bodies of the redefined functions (20261018180232 report_pnl /
--   report_pnl_monthly, 20261018184158 report_balance_sheet, 20261018044814 report_day_book /
--   report_party_ledger, 20261018225100 get_partner_metrics, 20261019125620
--   record_multi_invoice_payment, 20261018022629 tg_invoice_document_kind,
--   20260930171000 tg_invoices_block_delete_issued); drop the new functions, triggers, table
--   and columns (only after deleting opening invoices and their payments).

begin;

-- ── 1. Import batches ──────────────────────────────────────────────────────────────────
create table if not exists public.invoice_import_batches (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references public.tenants(id) on delete cascade,
  source        text        not null default 'zoho' check (source in ('zoho')),
  file_name     text        check (file_name is null or char_length(file_name) <= 300),
  row_count     integer     not null default 0 check (row_count >= 0),
  skipped_count integer     not null default 0 check (skipped_count >= 0),
  total_balance bigint      not null default 0 check (total_balance >= 0),
  created_by    uuid        references public.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  removed_at    timestamptz,
  removed_by    uuid        references public.users(id) on delete set null,
  remove_reason text        check (remove_reason is null or char_length(remove_reason) <= 500),
  removed_rows  integer     check (removed_rows is null or removed_rows >= 0)
);

comment on table public.invoice_import_batches is
  'R-1739: one row per "Import open invoices from Zoho" click. Written only by import_opening_invoices() / remove_opening_invoice_import(); a removed import keeps its row with removed_at.';

create index if not exists invoice_import_batches_tenant_idx
  on public.invoice_import_batches (tenant_id, created_at desc);

alter table public.invoice_import_batches enable row level security;
revoke all on table public.invoice_import_batches from public;
revoke all on table public.invoice_import_batches from anon;
revoke all on table public.invoice_import_batches from authenticated;
grant select on table public.invoice_import_batches to authenticated;
grant all on table public.invoice_import_batches to service_role;

drop policy if exists invoice_import_batches_select on public.invoice_import_batches;
create policy invoice_import_batches_select on public.invoice_import_batches as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.invoice_import_batches;
create policy zzz_service_role_all on public.invoice_import_batches
  as permissive for all to service_role using (true) with check (true);

-- ── 2. invoices: the opening-invoice kind ──────────────────────────────────────────────
alter table public.invoices add column if not exists import_batch_id uuid
  references public.invoice_import_batches(id) on delete restrict;
alter table public.invoices add column if not exists opening_balance integer;
alter table public.invoices add column if not exists external_number text;

alter table public.invoices drop constraint if exists invoices_document_kind_check;
alter table public.invoices add constraint invoices_document_kind_check
  check (document_kind in ('tax_invoice', 'bill_of_supply', 'opening_invoice'));

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'invoices_opening_invoice_shape') then
    alter table public.invoices add constraint invoices_opening_invoice_shape check (
      (document_kind = 'opening_invoice') = (opening_balance is not null)
      and (document_kind <> 'opening_invoice'
           or (opening_balance > 0 and opening_balance <= amount and quote_id is null
               and external_number is not null and import_batch_id is not null
               and coalesce(tax_amount, 0) = 0 and coalesce(tax_rate, 0) = 0)));
  end if;
end $$;

create unique index if not exists invoices_tenant_external_number_uq
  on public.invoices (tenant_id, upper(external_number)) where external_number is not null;
create index if not exists invoices_import_batch_idx
  on public.invoices (import_batch_id) where import_batch_id is not null;

comment on column public.invoices.opening_balance is
  'R-1739: an imported Zoho opening invoice — the Balance still due when it was imported (Total − Zoho receipts). NULL on every other invoice. Its sum is the Cr "Opening Balance Adjustments" of the derived ledger.';
comment on column public.invoices.external_number is
  'R-1739: the number printed on an imported Zoho invoice (unique per company — a second import skips it). id is the same number unless another company already holds that id.';
comment on column public.invoices.import_batch_id is
  'R-1739: the invoice_import_batches row that brought this opening invoice in.';

-- ── 3. payments: an opening invoice is paid without a quote ────────────────────────────
alter table public.payments add column if not exists invoice_id text
  references public.invoices(id) on delete restrict;
alter table public.payments alter column quote_id drop not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_quote_or_opening_invoice') then
    alter table public.payments add constraint payments_quote_or_opening_invoice
      check (quote_id is not null or invoice_id is not null);
  end if;
end $$;
create index if not exists payments_invoice_idx on public.payments (invoice_id) where invoice_id is not null;
create unique index if not exists payments_opening_invoice_idempotency_uq
  on public.payments (tenant_id, invoice_id, reference)
  where status = 'received' and quote_id is null;

comment on column public.payments.invoice_id is
  'R-1739: set only on a payment against an imported Zoho opening invoice (quote_id NULL). Every other payment is keyed by its quote.';

-- ── 4. The ONE predicate every GST / revenue reader uses ──────────────────────────────
create or replace function public.invoice_is_sale(p_document_kind text)
returns boolean
language sql
immutable
parallel safe
set search_path to 'public'
as $$
  /* R-1739: true for a document of OUR sales (tax invoice / bill of supply) — false for an
     imported Zoho opening invoice, whose GST and revenue were reported from Zoho Books. */
  select coalesce(p_document_kind, 'tax_invoice') <> 'opening_invoice'
$$;
comment on function public.invoice_is_sale(text) is
  'R-1739: the shared GST / revenue / IRN predicate — false only for document_kind opening_invoice. TS twin: lib/accounting/sale-documents.ts.';
revoke all on function public.invoice_is_sale(text) from public, anon;
grant execute on function public.invoice_is_sale(text) to authenticated, service_role;

-- ── 5. Credit / debit notes: never against an opening invoice ─────────────────────────
create or replace function public.tg_note_not_on_opening_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  /* R-1739 */
  if new.invoice_id is not null and exists (
       select 1 from public.invoices i
        where i.id = new.invoice_id and i.document_kind = 'opening_invoice') then
    raise exception 'Invoice % was imported from Zoho Books, so a % against it must be issued in Zoho Books (its GST was filed there). To reduce what the customer owes here, record the payment or ask your accountant.',
      new.invoice_id, case tg_table_name when 'credit_notes' then 'credit note' else 'debit note' end
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke all on function public.tg_note_not_on_opening_invoice() from public, anon, authenticated;

drop trigger if exists trg_credit_note_not_on_opening_invoice on public.credit_notes;
create trigger trg_credit_note_not_on_opening_invoice
  before insert or update of invoice_id on public.credit_notes
  for each row execute function public.tg_note_not_on_opening_invoice();
drop trigger if exists trg_debit_note_not_on_opening_invoice on public.debit_notes;
create trigger trg_debit_note_not_on_opening_invoice
  before insert or update of invoice_id on public.debit_notes
  for each row execute function public.tg_note_not_on_opening_invoice();

-- ── 6. Payments on an opening invoice: shape + the invoice's paid amount ──────────────
create or replace function public._opening_invoice_settle(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739: paid = (Total − Balance at import) + received payments on it. */
  v_inv   record;
  v_recv  bigint;
  v_last  date;
  v_paid  integer;
begin
  select i.id, i.tenant_id, i.amount, i.net_payable, i.opening_balance, i.due_date, i.status
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.document_kind = 'opening_invoice'
   for update;
  if not found or v_inv.status = 'void' then
    return;
  end if;
  select coalesce(sum(p.amount), 0), max((p.received_at at time zone 'Asia/Kolkata')::date)
    into v_recv, v_last
    from public.payments p
   where p.tenant_id = v_inv.tenant_id and p.invoice_id = v_inv.id and p.quote_id is null
     and p.status = 'received';
  v_paid := (v_inv.amount - v_inv.opening_balance + v_recv)::integer;
  update public.invoices
     set paid_amount = v_paid,
         status = case when v_paid >= coalesce(v_inv.net_payable, v_inv.amount) then 'paid'
                       when v_inv.due_date is not null and v_inv.due_date < public.ist_today() then 'overdue'
                       else 'pending' end::public.invoice_status,
         paid_date = case when v_paid >= coalesce(v_inv.net_payable, v_inv.amount) then coalesce(v_last, public.ist_today()) end
   where id = v_inv.id;
end;
$function$;
revoke all on function public._opening_invoice_settle(text) from public, anon, authenticated;

create or replace function public.tg_payments_opening_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739 */
  v_inv record;
begin
  if tg_op in ('INSERT', 'UPDATE') and tg_when = 'BEFORE' then
    if new.invoice_id is null then
      return new;
    end if;
    if new.quote_id is not null then
      raise exception 'A payment carries either its quote or (for an invoice imported from Zoho) its invoice — not both.'
        using errcode = 'check_violation';
    end if;
    select i.tenant_id, i.customer_id, i.document_kind into v_inv
      from public.invoices i where i.id = new.invoice_id;
    if not found or v_inv.tenant_id is distinct from new.tenant_id or v_inv.document_kind <> 'opening_invoice' then
      raise exception 'Invoice % is not an invoice imported from Zoho in your company, so it cannot take a payment without its quote.', new.invoice_id
        using errcode = 'check_violation';
    end if;
    if new.customer_id is not null and v_inv.customer_id is distinct from new.customer_id then
      raise exception 'Invoice % belongs to another customer.', new.invoice_id using errcode = '42501';
    end if;
    return new;
  end if;

  /* AFTER: keep the opening invoice's paid amount equal to its money. */
  if tg_op in ('UPDATE', 'DELETE') and old.invoice_id is not null and old.quote_id is null then
    perform public._opening_invoice_settle(old.invoice_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.invoice_id is not null and new.quote_id is null
     and (tg_op = 'INSERT' or new.invoice_id is distinct from old.invoice_id
          or new.amount is distinct from old.amount or new.status is distinct from old.status
          or new.received_at is distinct from old.received_at) then
    perform public._opening_invoice_settle(new.invoice_id);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;
revoke all on function public.tg_payments_opening_invoice() from public, anon, authenticated;

drop trigger if exists trg_payments_opening_invoice_check on public.payments;
create trigger trg_payments_opening_invoice_check
  before insert or update of invoice_id, quote_id, customer_id, tenant_id on public.payments
  for each row execute function public.tg_payments_opening_invoice();
drop trigger if exists trg_payments_opening_invoice_settle on public.payments;
create trigger trg_payments_opening_invoice_settle
  after insert or update or delete on public.payments
  for each row execute function public.tg_payments_opening_invoice();

-- ── 7. One payment line on an opening invoice (called by record_multi_invoice_payment) ─
create or replace function public._record_opening_invoice_payment(
  p_tenant          uuid,
  p_invoice_id      text,
  p_amount          integer,
  p_method          text,
  p_reference       text,
  p_notes           text,
  p_received_on     date,
  p_bank_account_id uuid,
  p_tds_amount      integer,
  p_tds_gross       integer,
  p_tds_section     text,
  p_tds_rate_pct    numeric,
  p_customer_tan    text,
  p_fiscal_year     text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739: not granted to any app role — reached only from record_multi_invoice_payment,
     which has already checked the role, the company, the customer and the amount. */
  v_inv    record;
  v_due    integer;
  v_rv     text;
  v_pay    uuid;
  v_status text;
  v_tds    boolean := false;
begin
  if p_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;
  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable, i.paid_amount, i.status
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id and i.tenant_id = p_tenant and i.document_kind = 'opening_invoice'
   for update;
  if not found then
    raise exception 'Invoice % is not an invoice imported from Zoho in your company.', p_invoice_id using errcode = '42501';
  end if;
  v_due := case when v_inv.status::text in ('paid', 'void') then 0
                else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
  if p_amount is null or p_amount <= 0 or p_amount > v_due then
    raise exception 'Invoice % has only ₹% due, but ₹% is applied to it. Lower that line.', p_invoice_id, v_due, coalesce(p_amount, 0);
  end if;

  v_rv := public.next_document_number('receipt_voucher', p_tenant, public.ist_today());
  insert into public.payments (tenant_id, quote_id, invoice_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (p_tenant, null, v_inv.id, v_inv.customer_id, p_amount, p_method, nullif(trim(coalesce(p_reference, '')), ''),
          nullif(trim(coalesce(p_notes, '')), ''), 'received',
          coalesce((p_received_on::timestamp at time zone 'UTC'), now()), v_rv, auth.uid(), p_bank_account_id)
  returning id into v_pay;

  if coalesce(p_tds_amount, 0) > 0 then
    insert into public.tds_receivable (
      id, tenant_id, invoice_id, payment_id, customer_id, customer_name,
      customer_tan, section, rate_pct, gross_amount, tds_amount, net_paid,
      fiscal_year, payment_received_date, status, notes
    ) values (
      'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 10)),
      p_tenant, v_inv.id, v_pay, v_inv.customer_id, coalesce(v_inv.customer_name, ''),
      nullif(trim(coalesce(p_customer_tan, '')), ''), coalesce(p_tds_section, '194J'),
      coalesce(p_tds_rate_pct, round(p_tds_amount::numeric * 100 / nullif(coalesce(nullif(p_tds_gross, 0), p_amount), 0), 2)),
      coalesce(nullif(p_tds_gross, 0), p_amount), p_tds_amount, p_amount - p_tds_amount,
      coalesce(p_fiscal_year, public.indian_fiscal_year(coalesce(p_received_on, public.ist_today()))),
      coalesce(p_received_on, public.ist_today()), 'pending_cert',
      'Auto-created with payment ' || v_pay::text || ' on imported Zoho invoice ' || v_inv.id
    );
    v_tds := true;
  end if;

  select status::text into v_status from public.invoices where id = v_inv.id;
  return jsonb_build_object('payment_id', v_pay, 'receipt_voucher_no', v_rv, 'applied', p_amount,
                            'invoice_paid', v_status = 'paid', 'overpaid_credit', 0, 'tds_saved', v_tds,
                            'already_recorded', false, 'idempotent_replay', false);
end;
$function$;
revoke all on function public._record_opening_invoice_payment(uuid, text, integer, text, text, text, date, uuid, integer, integer, text, numeric, text, text) from public, anon, authenticated;

-- ── 8. Import (one click = one batch, atomic) ──────────────────────────────────────────
create or replace function public.import_opening_invoices(p_rows jsonb, p_file_name text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739 */
  v_tenant   uuid := public.current_tenant_id();
  v_code     text;
  v_batch    uuid;
  v_row      jsonb;
  v_num      text;
  v_id       text;
  v_cust     record;
  v_total    numeric;
  v_bal      numeric;
  v_inv_date date;
  v_due_date date;
  v_cur      text;
  v_seen     text[] := array[]::text[];
  v_skipped  jsonb := '[]'::jsonb;
  v_n        integer := 0;
  v_sum      bigint := 0;
  v_i        integer := 0;
begin
  if v_tenant is null then
    raise exception 'Importing invoices needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Only an owner, manager or accountant can import invoices from Zoho. Ask one of them, or ask the owner to change your role in Team.'
      using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'There are no invoices to import. Upload the Zoho CSV again and press Import when the preview shows rows.'
      using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'Too many rows in one import (% — at most 5,000). Split the CSV in two.', jsonb_array_length(p_rows)
      using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(t.doc_code), ''), upper(left(replace(t.id::text, '-', ''), 4)))
    into v_code from public.tenants t where t.id = v_tenant;

  insert into public.invoice_import_batches (tenant_id, source, file_name, created_by)
  values (v_tenant, 'zoho', nullif(left(btrim(coalesce(p_file_name, '')), 300), ''), auth.uid())
  returning id into v_batch;

  perform set_config('app.opening_invoice_import', 'on', true);

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_i := v_i + 1;
    v_num := btrim(coalesce(v_row->>'number', ''));
    if v_num = '' or char_length(v_num) > 40 then
      raise exception 'Row %: the invoice number is empty or longer than 40 characters. Fix it in the CSV and import again.', v_i
        using errcode = '22023';
    end if;
    if upper(v_num) = any (v_seen) then
      raise exception 'Invoice % is in the file twice. Keep one row for it and import again.', v_num using errcode = '22023';
    end if;
    v_seen := v_seen || upper(v_num);

    begin
      v_total    := (v_row->>'total')::numeric;
      v_bal      := (v_row->>'balance')::numeric;
      v_inv_date := (v_row->>'invoice_date')::date;
      v_due_date := nullif(v_row->>'due_date', '')::date;
    exception when others then
      raise exception 'Invoice %: Total, Balance or a date could not be read. Fix the row in the CSV and import again.', v_num
        using errcode = '22023';
    end;
    v_cur := upper(coalesce(nullif(btrim(v_row->>'currency'), ''), 'INR'));
    if v_cur <> 'INR' then
      raise exception 'Invoice % is in % — only rupee (INR) invoices can be imported. Leave it out of the CSV.', v_num, v_cur
        using errcode = '22023';
    end if;
    if v_total is null or v_bal is null or v_inv_date is null then
      raise exception 'Invoice % needs a Total, a Balance and an Invoice Date.', v_num using errcode = '22023';
    end if;
    if v_total <> trunc(v_total) or v_bal <> trunc(v_bal) then
      raise exception 'Invoice %: use whole rupees (Total ₹%, Balance ₹%). Round them in the CSV and import again.', v_num, v_total, v_bal
        using errcode = '22023';
    end if;
    if v_bal <= 0 or v_total <= 0 or v_bal > v_total then
      raise exception 'Invoice %: Balance ₹% must be more than ₹0 and not more than the Total ₹%.', v_num, v_bal, v_total
        using errcode = '22023';
    end if;

    select c.id, c.name, c.gstin into v_cust
      from public.customers c
     where c.id = nullif(v_row->>'customer_id', '')::uuid and c.tenant_id = v_tenant;
    if not found then
      raise exception 'Invoice %: the customer was not found in your company. Create the customer first, then import again.', v_num
        using errcode = '42501';
    end if;

    if exists (select 1 from public.invoices i
                where i.tenant_id = v_tenant
                  and (upper(i.external_number) = upper(v_num)
                       or (i.document_kind = 'opening_invoice' and upper(i.id) = upper(v_num)))) then
      v_skipped := v_skipped || to_jsonb(v_num);
      continue;
    end if;

    v_id := v_num;
    if exists (select 1 from public.invoices i where i.id = v_id) then
      v_id := left(v_num, 40) || '-' || v_code;
      if exists (select 1 from public.invoices i where i.id = v_id) then
        raise exception 'Invoice % cannot be imported: that number is already used by another invoice. Leave it out of the CSV and tell support.', v_num;
      end if;
    end if;

    insert into public.invoices (
      id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
      invoice_date, due_date, taxable_value, tax_amount, tax_rate, line_items,
      customer_gstin, pos_state_code, document_kind, opening_balance, external_number, import_batch_id)
    values (
      v_id, v_tenant, v_cust.id, v_cust.name, v_total::int, v_total::int, (v_total - v_bal)::int,
      case when coalesce(v_due_date, v_inv_date) < public.ist_today() then 'overdue' else 'pending' end::public.invoice_status,
      v_inv_date, coalesce(v_due_date, v_inv_date), 0, 0, 0, '[]'::jsonb,
      coalesce(nullif(upper(btrim(v_row->>'gstin')), ''), v_cust.gstin),
      nullif(btrim(coalesce(v_row->>'pos_state_code', '')), ''),
      'opening_invoice', v_bal::int, v_num, v_batch);
    v_n := v_n + 1;
    v_sum := v_sum + v_bal::bigint;
  end loop;

  perform set_config('app.opening_invoice_import', '', true);

  update public.invoice_import_batches
     set row_count = v_n, skipped_count = jsonb_array_length(v_skipped), total_balance = v_sum
   where id = v_batch;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'opening_invoices.imported', 'invoice_import_batch', v_batch::text,
          left(format('Imported %s open invoices from Zoho (₹%s due)%s', v_n, v_sum,
                      case when nullif(btrim(coalesce(p_file_name, '')), '') is not null then ' — ' || btrim(p_file_name) else '' end), 120),
          jsonb_build_object('batch_id', v_batch, 'imported', v_n, 'skipped', v_skipped, 'total_balance', v_sum, 'file', p_file_name));

  return jsonb_build_object('batch_id', v_batch, 'imported', v_n, 'skipped', v_skipped, 'total_balance', v_sum);
end;
$function$;

comment on function public.import_opening_invoices(jsonb, text) is
  'R-1739: one "Import open invoices from Zoho" click — a batch row + its opening invoices (document_kind opening_invoice), atomically. A Zoho number already in the company is skipped and returned in "skipped". Owner/manager/accountant; company from current_tenant_id().';
revoke all on function public.import_opening_invoices(jsonb, text) from public;
revoke all on function public.import_opening_invoices(jsonb, text) from anon;
grant execute on function public.import_opening_invoices(jsonb, text) to authenticated, service_role;

-- ── 9. Take a whole import back (nothing may have touched it) ─────────────────────────
create or replace function public.remove_opening_invoice_import(p_batch_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739 */
  v_tenant uuid := public.current_tenant_id();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_batch  public.invoice_import_batches;
  v_ids    text[];
  v_bad    text;
  v_n      integer;
begin
  if v_tenant is null then
    raise exception 'Removing an import needs an active user who has finished sign-in. Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can remove an import. Ask one of them to do it.'
      using errcode = '42501';
  end if;
  if char_length(v_reason) < 3 then
    raise exception 'Write why you are removing this import (at least 3 characters) — it goes in the activity log.'
      using errcode = '22023';
  end if;
  select * into v_batch from public.invoice_import_batches
   where id = p_batch_id and tenant_id = v_tenant
   for update;
  if not found then
    raise exception 'That import was not found. Refresh the page and look at the imports list again.' using errcode = 'P0002';
  end if;
  if v_batch.removed_at is not null then
    raise exception 'This import was already removed on %. Nothing left to do.',
      to_char(v_batch.removed_at at time zone 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') using errcode = 'P0001';
  end if;

  select array_agg(i.id order by i.id) into v_ids
    from (select id from public.invoices
           where import_batch_id = p_batch_id and tenant_id = v_tenant
           for update) i;

  select string_agg(x.id, ', ' order by x.id) into v_bad
    from (select i.id from public.invoices i
           where i.id = any (coalesce(v_ids, '{}'::text[]))
             and (i.paid_amount <> i.amount - i.opening_balance
               or exists (select 1 from public.payments p where p.invoice_id = i.id)
               or exists (select 1 from public.tds_receivable t where t.invoice_id = i.id and t.status <> 'reversed')
               or exists (select 1 from public.late_charge_bills l where l.invoice_id = i.id)
               or exists (select 1 from public.credit_notes c where c.invoice_id = i.id)
               or exists (select 1 from public.debit_notes d where d.invoice_id = i.id))
           limit 20) x;
  if v_bad is not null then
    raise exception 'This import cannot be removed: a payment (or TDS / late fee) is already recorded on %. Delete that payment first (Payments), then remove the import.',
      v_bad using errcode = 'P0001';
  end if;

  perform set_config('app.opening_invoice_remove', p_batch_id::text, true);
  delete from public.invoices where id = any (coalesce(v_ids, '{}'::text[])) and tenant_id = v_tenant;
  get diagnostics v_n = row_count;
  perform set_config('app.opening_invoice_remove', '', true);

  update public.invoice_import_batches
     set removed_at = now(), removed_by = auth.uid(), remove_reason = left(v_reason, 500), removed_rows = v_n
   where id = p_batch_id;

  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'opening_invoices.import_removed', 'invoice_import_batch', p_batch_id::text,
          left(format('Removed Zoho import: %s invoices — %s', v_n, v_reason), 120),
          jsonb_build_object('batch_id', p_batch_id, 'removed', v_n, 'reason', v_reason, 'file', v_batch.file_name));

  return jsonb_build_object('removed', v_n, 'batch_id', p_batch_id);
end;
$function$;

comment on function public.remove_opening_invoice_import(uuid, text) is
  'R-1739: takes back one Zoho import — deletes its opening invoices only when none has a payment, TDS, late-fee bill or note and paid_amount is unchanged. Owner/accountant; writes activity_log; the batch row stays, marked removed.';
revoke all on function public.remove_opening_invoice_import(uuid, text) from public;
revoke all on function public.remove_opening_invoice_import(uuid, text) from anon;
grant execute on function public.remove_opening_invoice_import(uuid, text) to authenticated, service_role;

-- ── 10. Redefined: the GST / revenue readers, the invoice triggers, the payment path ───
-- Each body below is the newest definition as is, plus the lines marked R-1739.

CREATE OR REPLACE FUNCTION public.tg_invoice_document_kind()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    if old.document_kind in ('bill_of_supply', 'opening_invoice')  -- R-1739
       and (coalesce(new.tax_amount, 0) <> 0 or coalesce(new.tax_rate, 0) <> 0) then
      raise exception 'Bill of Supply % cannot carry GST — a business that is not GST-registered (or is under composition) cannot charge it.', old.id
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  /* R-1739: an imported Zoho opening invoice — only import_opening_invoices() may write one
     (app.opening_invoice_import, transaction-local). Not our series, not a GST document:
     no tax, no supplier status, never a Bill of Supply / Tax Invoice of ours. */
  if new.document_kind = 'opening_invoice' then
    if coalesce(current_setting('app.opening_invoice_import', true), '') <> 'on' then
      raise exception 'An opening invoice can only be added by Invoices → Import from Zoho.'
        using errcode = 'check_violation';
    end if;
    new.supplier_gst_status := null;
    if coalesce(new.tax_amount, 0) <> 0 or coalesce(new.tax_rate, 0) <> 0 then
      raise exception 'Imported opening invoice % cannot carry GST — its GST was filed in Zoho Books.', new.id
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
$function$;

CREATE OR REPLACE FUNCTION public.tg_mirror_invoice_to_child_vendor_bill()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_linked_tenant uuid;
  v_parent_tenant tenants%rowtype;
  v_parent_state  text;
  v_child_state   text;
  v_subtotal      integer;
  v_igst          integer;
  v_cgst          integer;
  v_sgst          integer;
  v_inter_state   boolean;
begin
  if NEW.customer_id is null then return NEW; end if;
  /* R-1739: an imported Zoho opening invoice is no new sale — the child's bill (and its ITC)
     was already booked in Zoho / by the child. */
  if NEW.document_kind = 'opening_invoice' then return NEW; end if;

  select linked_tenant_id into v_linked_tenant
  from public.customers
  where id = NEW.customer_id and tenant_id = NEW.tenant_id;

  if v_linked_tenant is null then return NEW; end if;

  if not exists (
    select 1 from public.tenants
    where id = v_linked_tenant and parent_tenant_id = NEW.tenant_id
  ) then return NEW; end if;

  if exists (
    select 1 from public.vendor_bills
    where tenant_id = v_linked_tenant and source_tenant_invoice_id = NEW.id
  ) then return NEW; end if;

  select * into v_parent_tenant from public.tenants where id = NEW.tenant_id;
  v_parent_state := v_parent_tenant.state_code;
  select state_code into v_child_state from public.tenants where id = v_linked_tenant;
  v_inter_state := v_parent_state is null or v_child_state is null or v_parent_state <> v_child_state;

  v_subtotal := round(NEW.amount::numeric / 1.18)::integer;
  if v_inter_state then
    v_igst := NEW.amount - v_subtotal;
    v_cgst := 0;
    v_sgst := 0;
  else
    v_igst := 0;
    v_cgst := round((NEW.amount - v_subtotal)::numeric / 2)::integer;
    v_sgst := (NEW.amount - v_subtotal) - v_cgst;
  end if;

  insert into public.vendor_bills (
    id, tenant_id, vendor_name, vendor_gstin, bill_no, bill_date, due_date,
    category, line_items, subtotal, cgst, sgst, igst, total, status,
    paid_amount, notes, source_tenant_invoice_id
  ) values (
    'VB-PARTNER-' || NEW.id,
    v_linked_tenant,
    v_parent_tenant.name,
    v_parent_tenant.gstin,
    NEW.id,
    NEW.invoice_date,
    NEW.due_date,
    'cloud_subscriptions',
    jsonb_build_array(jsonb_build_object(
      'description', 'Wholesale supply against invoice ' || NEW.id,
      'quantity',    1,
      'rate',        v_subtotal,
      'amount',      v_subtotal
    )),
    v_subtotal, v_cgst, v_sgst, v_igst, NEW.amount,
    'unpaid', 0,
    'Auto-imported from ' || v_parent_tenant.name || ' (your distributor).',
    NEW.id
  );

  return NEW;
end $function$;

CREATE OR REPLACE FUNCTION public.tg_invoices_block_delete_issued()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_reason text := nullif(btrim(coalesce(current_setting('app.invoice_amend_reason', true), '')), '');
begin
  if old.status = 'draft' then
    return old;
  end if;

  /* R-1739: remove_opening_invoice_import() takes back a whole Zoho import (no payment on it).
     Those numbers are Zoho's, not our GST series — no gap is left. Only that batch. */
  if old.document_kind = 'opening_invoice'
     and old.import_batch_id is not null
     and coalesce(current_setting('app.opening_invoice_remove', true), '') = old.import_batch_id::text then
    return old;
  end if;

  if v_reason is not null then
    raise notice '[invoices] % deleted under app.invoice_amend_reason=%', old.id, v_reason;
    return old;
  end if;

  raise exception
    'Invoice % is % and cannot be deleted. Its number is already spent from the GST series and deleting it leaves a permanent gap. To cancel it, raise a credit note against it (issue_credit_note) — that keeps both documents on the record, which is what CGST Section 34 requires.',
    old.id, old.status
    using errcode = 'restrict_violation';
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_pnl(p_from date, p_to date)
 RETURNS TABLE(inv_taxable bigint, inv_tax bigint, revenue_count integer, cn_taxable bigint, cn_tax bigint, dn_taxable bigint, dn_tax bigint, revenue_by_project jsonb, cogs bigint, cogs_count integer, bills_gst bigint, expense_groups jsonb, itc_groups jsonb, unassigned_by_category jsonb, project_expenses jsonb, commissions bigint, commissions_count integer, bill_itc_groups jsonb)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  /* R-1739 */
  v_tenant uuid := public.current_tenant_id();
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'P&L nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'P&L ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye — range dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

  return query
  with inv as (
    select i.id, i.amount::bigint as amount, i.tax_amount::bigint as tax_amount,
           coalesce(i.taxable_value::bigint,
             floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as taxable
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status in ('pending', 'paid', 'overdue')
       and public.invoice_is_sale(i.document_kind)  -- R-1739: an imported Zoho opening invoice is not revenue
  ), cn as (
    select c.invoice_id, c.taxable_value::bigint as taxable_value, c.tax_amount::bigint as tax_amount
      from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
  ), dn as (
    select d.invoice_id, d.taxable_value::bigint as taxable_value, d.tax_amount::bigint as tax_amount
      from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
  ), ms as (
    select distinct on (pm.invoice_id) pm.invoice_id, pm.project_id
      from public.project_milestones pm
     where pm.tenant_id = v_tenant and pm.invoice_id is not null
     order by pm.invoice_id, pm.project_id
  ), proj_rev as (
    select ms.project_id, inv.taxable as rev from inv join ms on ms.invoice_id = inv.id
    union all
    select ms.project_id, dn.taxable_value from dn join ms on ms.invoice_id = dn.invoice_id
    union all
    select ms.project_id, -cn.taxable_value from cn join ms on ms.invoice_id = cn.invoice_id
  ), bills as (
    select vb.subtotal, vb.cgst, vb.sgst, vb.igst, vb.document_type, vb.category, vb.vendor_gstin
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
       and vb.category like 'COGS-%'
  ), exps as (
    select e.amount::bigint as amount, e.gst_paid, e.category, e.vendor_name, e.expense_date, e.bill_type,
           e.project_id, e.description, v.gstin
      from public.expenses e
      left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
       -- R-1578: asset bana kharcha capitalised hai — P&L me sirf depreciation (register, TS) se.
       and not exists (select 1 from public.fixed_assets fa where fa.tenant_id = v_tenant and fa.expense_id = e.id)
    union all
    -- S45-SLICE2 (G1): settlement receipt se kam aaya — farq bank / gateway ka charge.
    select s.amount, 0, 'Bank Charges', 'Settlement short of receipt', s.txn_date, 'none',
           null::uuid, 'Bank line short of receipt' || coalesce(' ' || s.reference, ''), null::text
      from public.report_settlement_shortfalls(p_from, p_to) s
  ), comms as (
    select rc.gross_commission
      from public.referral_commissions rc
     where rc.tenant_id = v_tenant and rc.earned_date between p_from and p_to
       and rc.status <> 'cancelled'
  )
  select
    (select coalesce(sum(inv.taxable), 0)::bigint from inv),
    (select coalesce(sum(coalesce(inv.tax_amount, inv.amount - inv.taxable)), 0)::bigint from inv),
    (select count(*)::int from inv),
    (select coalesce(sum(cn.taxable_value), 0)::bigint from cn),
    (select coalesce(sum(cn.tax_amount), 0)::bigint from cn),
    (select coalesce(sum(dn.taxable_value), 0)::bigint from dn),
    (select coalesce(sum(dn.tax_amount), 0)::bigint from dn),
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', r.project_id, 'revenue', r.revenue) order by r.project_id), '[]'::jsonb)
       from (select pr.project_id, sum(pr.rev)::bigint as revenue from proj_rev pr group by pr.project_id) r),
    (select coalesce(sum(b.subtotal), 0)::bigint from bills b),
    (select count(*)::int from bills),
    (select coalesce(sum(b.cgst + b.sgst + b.igst), 0)::bigint from bills b),
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'vendor_name', g.vendor_name,
                                                  'month', g.month, 'amount', g.amount, 'n', g.n)), '[]'::jsonb)
       from (select x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM') as month,
                    sum(x.amount)::bigint as amount, count(*)::int as n
               from exps x group by x.category, x.vendor_name, to_char(x.expense_date, 'YYYY-MM')) g),
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select x.bill_type, x.category, x.gstin, sum(x.gst_paid)::bigint as gst, count(*)::int as n
               from exps x where x.gst_paid > 0 group by x.bill_type, x.category, x.gstin) g),
    (select coalesce(jsonb_agg(jsonb_build_object('category', g.category, 'amount', g.amount)), '[]'::jsonb)
       from (select x.category, sum(x.amount)::bigint as amount from exps x where x.project_id is null group by x.category) g),
    (select coalesce(jsonb_agg(jsonb_build_object('project_id', x.project_id, 'amount', x.amount, 'category', x.category,
                                                  'expense_date', x.expense_date, 'vendor_name', x.vendor_name,
                                                  'description', x.description)
                               order by x.expense_date, x.amount desc), '[]'::jsonb)
       from exps x where x.project_id is not null),
    (select coalesce(sum(c.gross_commission), 0)::bigint from comms c),
    (select count(*)::int from comms),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from bills b where b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g);
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_pnl_monthly(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  /* R-1739 */
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'P&L trend nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('month', m.month, 'revenue', m.revenue, 'expenses', m.expenses)
                            order by m.month), '[]'::jsonb)
    into v_out
    from (
      select k.month, sum(k.rev)::bigint as revenue, sum(k.exp)::bigint as expenses
        from (
          select to_char(i.invoice_date, 'YYYY-MM') as month,
                 coalesce(i.taxable_value::bigint,
                   floor(i.amount::numeric * 100 / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint) as rev,
                 0::bigint as exp
            from public.invoices i
           where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
             and i.status in ('pending', 'paid', 'overdue')
             and public.invoice_is_sale(i.document_kind)  -- R-1739
          union all
          select to_char(e.expense_date, 'YYYY-MM'), 0, e.amount::bigint
            from public.expenses e
           where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
             -- R-1578: report_pnl jaisa — asset bana kharcha trend me bhi kharcha nahi.
             and not exists (select 1 from public.fixed_assets fa where fa.tenant_id = v_tenant and fa.expense_id = e.id)
          union all
          -- S45-SLICE2 (G1): report_pnl jaisa settlement shortfall.
          select to_char(s.txn_date, 'YYYY-MM'), 0, s.amount
            from public.report_settlement_shortfalls(p_from, p_to) s
          union all
          select to_char(c.credit_date, 'YYYY-MM'), -coalesce(c.taxable_value, 0)::bigint, 0
            from public.credit_notes c
           where c.tenant_id = v_tenant and c.credit_date between p_from and p_to
          union all
          select to_char(d.debit_date, 'YYYY-MM'), coalesce(d.taxable_value, 0)::bigint, 0
            from public.debit_notes d
           where d.tenant_id = v_tenant and d.debit_date between p_from and p_to
        ) k
       group by k.month
    ) m;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_balance_sheet(p_as_of date DEFAULT NULL::date)
 RETURNS TABLE(as_of date, fy_start_year integer, fy_label text, cash_and_bank bigint, undeposited_funds bigint, credit_card_payable bigint, receivables bigint, advances_from_customers bigint, project_receivable bigint, tds_receivable bigint, employee_loans bigint, prepaid_advances bigint, emi_unregistered_cost bigint, emi_loans_payable bigint, business_loans_payable bigint, payables bigint, salary_payable bigint, dues_salary_tds bigint, dues_pf bigint, dues_esi bigint, dues_vendor_tds bigint, dues_paid jsonb, reimbursements_payable bigint, gst_output bigint, bills_gst bigint, itc_groups jsonb, fixed_assets jsonb, tax_payments jsonb, expenses_payable bigint, expenses_paid_unbanked bigint, salary_other_deductions bigint, bill_itc_groups jsonb, commissions_payable bigint)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
declare
  -- R-1580: commission TDS in dues_vendor_tds; commissions_payable.
  -- R-1739: gst_output skips imported Zoho opening invoices (receivables keep them).
  v_tenant  uuid := public.current_tenant_id();
  v_to      date := coalesce(p_as_of, (now() at time zone 'Asia/Kolkata')::date);
  v_fy_year int;
  v_cash    bigint;
  v_card    bigint;
  v_own_state text;
begin
  if v_tenant is null then
    raise exception 'Balance sheet nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Indian FY: April se pehle ke mahine pichhle saal ke FY me.
  v_fy_year := case when extract(month from v_to) < 4 then extract(year from v_to)::int - 1
                    else extract(year from v_to)::int end;

  -- Cash & bank: har account = opening + sum(credit − debit), ek hi pass me (N+1 khatam).
  -- Credit card liability hai: negative = card par bakaya; positive (overpaid) = cash.
  select coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then 0 else b.bal end), 0),
         coalesce(sum(case when b.account_type = 'credit_card' and b.bal < 0 then -b.bal else 0 end), 0)
    into v_cash, v_card
    from (
      select a.account_type,
             a.opening_balance::bigint + coalesce((
               select sum(t.credit - t.debit)
                 from public.bank_transactions t
                where t.bank_account_id = a.id and t.tenant_id = v_tenant), 0) as bal
        from public.bank_accounts a
       where a.tenant_id = v_tenant
    ) b;

  -- R-1576: hamara rajya (state check ke liye) — report.ts jaisa: state_code, warna GSTIN ke pehle 2.
  select coalesce(nullif(trim(t.state_code), ''), nullif(left(trim(coalesce(t.gstin, '')), 2), ''))
    into v_own_state from public.tenants t where t.id = v_tenant;

  return query
  select
    v_to,
    v_fy_year,
    'FY ' || v_fy_year || '-' || lpad(((v_fy_year + 1) % 100)::text, 2, '0'),
    v_cash,
    -- R-179: receipts jo kisi bank line se match nahi hue — paisa haath me, asset.
    -- S45-TB: payment.amount me customer ka kaata hua TDS bhi hai (record_payment_with_tds
    -- invoice ko gross se settle karta hai). Wo TDS paisa kabhi aaya hi nahi — tds_receivable
    -- me asset hai. Yahan bhi gina to ek hi ₹ do baar Dr. Isliye us payment ka TDS ghatao.
    -- R-1612: amount − credit_applied — advance credit inside a payment was money in on the
    -- payment that created it (R-1565), not again here.
    ((select coalesce(sum(p.amount - p.credit_applied - coalesce((select sum(t.tds_amount) from public.tds_receivable t
                                                where t.tenant_id = v_tenant and t.payment_id = p.id), 0)
                                  -- S45-SLICE2: Razorpay fee book ho chuki (EXP-RZPFEE-<id>, R-045) to wo
                                  -- paisa kabhi bank me nahi aayega — fee P&L me hai, yahan bhi gini to do baar.
                                  - coalesce((select e.amount from public.expenses e
                                               where e.tenant_id = v_tenant and e.id = 'EXP-RZPFEE-' || p.id::text), 0)), 0)
        from public.payments p
       where p.tenant_id = v_tenant and p.status = 'received'
         and not exists (select 1 from public.bank_transactions t
                          where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                            and t.matched_to_id = p.id::text))
   + (select coalesce(sum(pp.amount), 0)
        from public.project_payments pp
       where pp.tenant_id = v_tenant and pp.bank_txn_id is null))::bigint,
    v_card,
    -- Trade receivables (accrual): pending/overdue, project-milestone invoices CHHOD kar
    -- (wo project_receivable me hain — dono me gine to double count).
    -- S45-TB: net_payable − paid_amount. record_payment har part payment par paid_amount
    -- likhta hai (R-015) aur Aging bhi yahi padhta hai; poora net_payable ginne se ₹40,000
    -- ka part payment cash me bhi aur receivable me bhi — TB me utna farq.
    (select coalesce(sum(greatest(0, coalesce(i.net_payable, i.amount) - coalesce(i.paid_amount, 0))), 0)::bigint
       from public.invoices i
      where i.tenant_id = v_tenant
        and i.status in ('pending', 'overdue')
        and not exists (select 1 from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.invoice_id = i.id)),
    -- Customer advances: received payments jinke quote par abhi invoice nahi — liability.
    -- S45-TB: + invoice ke BAAD customer ka bakaaya paisa (overpayment, ya paid invoice par
    -- credit note): quote par mila − (invoice − credit notes + debit notes), jab > 0. Pehle
    -- ye kahin nahi tha — paisa cash me, deni-daari kahin nahi. Sirf quote ka apna ek hi
    -- invoice (split billing ke kai invoice wale quote chhode — wahan ye hisaab nahi banta).
    -- R-1612: (1) − the overpayment credit those payments opened (open credit is in (3); used
    -- credit sits in the payment that used it) − what is applied to the quote's raised
    -- instalment invoices (split billing: no invoice of its own, R-1564); (2) − the same
    -- credit; (3) + the customer's open (unused) credit.
    ((select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             - (select coalesce(sum(i.paid_amount), 0)
                  from public.subscriptions s
                  join public.subscription_billings b on b.subscription_id = s.id and b.tenant_id = v_tenant
                  join public.invoices i on i.id = b.invoice_id and i.tenant_id = v_tenant
                 where s.tenant_id = v_tenant and s.quote_id = q.id
                   and i.status in ('pending', 'paid', 'overdue')))), 0)
        from public.quotes q
       where q.tenant_id = v_tenant and q.invoice_id is null)
   + (select coalesce(sum(greatest(0,
               (select coalesce(sum(p.amount), 0) from public.payments p
                 where p.tenant_id = v_tenant and p.quote_id = q.id and p.status = 'received')
             - (i.amount
                - coalesce((select sum(c.amount) from public.credit_notes c
                             where c.tenant_id = v_tenant and c.invoice_id = i.id), 0)
                + coalesce((select sum(d.amount) from public.debit_notes d
                             where d.tenant_id = v_tenant and d.invoice_id = i.id), 0))
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                 join public.payments p on p.id = cc.source_payment_id and p.tenant_id = v_tenant
                where cc.tenant_id = v_tenant and cc.source in ('overpayment', 'redeemed_split')  -- R-1614: + the used part of a split
                  and p.quote_id = q.id and p.status = 'received')
             /* R-1563: the excess a credit note left on this invoice now sits in a
                customer_credits row (source_invoice_id) — open: counted in (3); used: inside the
                payment that used it; refunded: paid out with its payment. Not here again. */
             - (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                where cc.tenant_id = v_tenant and cc.source_invoice_id = i.id
                  and cc.status in ('open', 'used')))), 0)
        from public.quotes q
        join public.invoices i on i.id = q.invoice_id and i.tenant_id = v_tenant
       where q.tenant_id = v_tenant
         and i.status in ('pending', 'paid', 'overdue')
         and not exists (select 1 from public.invoices i2
                          where i2.tenant_id = v_tenant and i2.quote_id = q.id and i2.id <> i.id)
         and not exists (select 1 from public.project_milestones pm
                          where pm.tenant_id = v_tenant and pm.invoice_id = i.id))
   + (select coalesce(sum(cc.amount), 0)
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.status = 'open'))::bigint,
    -- Project receivable: har active/completed project ka max(0, invoiced milestones − received).
    (select coalesce(sum(greatest(0,
              coalesce((select sum(pm.total_amount) from public.project_milestones pm
                         where pm.tenant_id = v_tenant and pm.project_id = ps.id and pm.invoice_id is not null), 0)
            - coalesce((select sum(pp.amount) from public.project_payments pp
                         where pp.tenant_id = v_tenant and pp.project_id = ps.id), 0))), 0)::bigint
       from public.project_sales ps
      where ps.tenant_id = v_tenant and ps.status in ('active', 'completed')),
    (select coalesce(sum(t.tds_amount), 0)::bigint
       from public.tds_receivable t
      where t.tenant_id = v_tenant and t.status in ('pending_cert', 'cert_received', 'verified_26as')),
    -- Employee loans: KUL principal − KUL repayments (per-loan max(0) nahi — purana TS bhi
    -- total par karta tha; parity ke liye waise hi).
    greatest(0,
      (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = v_tenant)
    - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, pa.total_amount - pa.consumed_amount)), 0)::bigint
       from public.prepaid_advances pa where pa.tenant_id = v_tenant),
    -- EMI purchase jo abhi fixed-asset register me nahi — cost par (register wale WDV par, TS me).
    (select coalesce(sum(ep.total_cost), 0)::bigint
       from public.emi_purchases ep
      where ep.tenant_id = v_tenant
        and not exists (select 1 from public.fixed_assets fa
                         where fa.tenant_id = v_tenant and fa.emi_purchase_id = ep.id)),
    greatest(0,
      (select coalesce(sum(ep.financed), 0) from public.emi_purchases ep where ep.tenant_id = v_tenant)
    - (select coalesce(sum(em.principal_part), 0) from public.emi_payments em where em.tenant_id = v_tenant))::bigint,
    greatest(0,
      (select coalesce(sum(bl.principal), 0) from public.business_loans bl where bl.tenant_id = v_tenant)
    - (select coalesce(sum(bp.principal_part), 0) from public.business_loan_payments bp where bp.tenant_id = v_tenant))::bigint,
    (select coalesce(sum(greatest(0, vb.total - vb.paid_amount)), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.status <> 'paid'),
    (select coalesce(sum(greatest(0, s.net - s.paid_amount)), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant and s.paid_status <> 'paid'),
    -- Statutory dues ke hisse (har booked salary, paid ho ya nahi; employer share bhi) —
    -- statutoryDues() TS me jodta hai, taaki Payroll banner aur ye ek hi niyam rahein.
    (select coalesce(sum(s.tds), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.pf + s.pf_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    (select coalesce(sum(s.esi + s.esi_employer), 0)::bigint from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1580: + TDS kaata partner commission par (194H) — credit (earned) hote hi sarkar ka
    -- dena, commission paid ho ya nahi; cancelled me kuch kaata nahi. Challan dues_paid me.
    ((select coalesce(sum(e.tds_amount), 0) from public.expenses e where e.tenant_id = v_tenant and e.tds_amount > 0)
   + (select coalesce(sum(rc.tds_amount), 0) from public.referral_commissions rc
       where rc.tenant_id = v_tenant and rc.tds_amount > 0 and rc.status <> 'cancelled'))::bigint,
    (select coalesce(jsonb_agg(jsonb_build_object('kind', d.kind, 'amount', d.amount) order by d.kind), '[]'::jsonb)
       from (select sd.kind, sum(sd.amount)::bigint as amount
               from public.statutory_dues_payments sd where sd.tenant_id = v_tenant group by sd.kind) d),
    (select coalesce(sum(r.amount), 0)::bigint
       from public.reimbursements r where r.tenant_id = v_tenant and r.status = 'pending'),
    -- GST CUMULATIVE (≤ as_of): frozen tax_amount, purani row me amount se reverse-derive
    -- (rate ?? 18), phir credit note ghatao, debit note jodo.
    ((select coalesce(sum(coalesce(i.tax_amount,
               floor(i.amount::numeric * coalesce(i.tax_rate, 18) / (100 + coalesce(i.tax_rate, 18)) + 0.5)::bigint)), 0)
        from public.invoices i
       where i.tenant_id = v_tenant and i.invoice_date <= v_to and i.status in ('pending', 'paid', 'overdue')
         and public.invoice_is_sale(i.document_kind))  -- R-1739: no GST on an imported Zoho opening invoice
     - (select coalesce(sum(c.tax_amount), 0) from public.credit_notes c where c.tenant_id = v_tenant and c.credit_date <= v_to)
     + (select coalesce(sum(d.tax_amount), 0) from public.debit_notes d where d.tenant_id = v_tenant and d.debit_date <= v_to))::bigint,
    (select coalesce(sum(vb.cgst + vb.sgst + vb.igst), 0)::bigint
       from public.vendor_bills vb where vb.tenant_id = v_tenant and vb.bill_date <= v_to),
    -- ITC: expense GST ko (bill_type, category, vendor GSTIN) par group karke — eligibility
    -- splitItc() TS me hi tay karta hai. Sirf gst_paid > 0 rows (splitItc 0 ko chhod deta hai).
    (select coalesce(jsonb_agg(jsonb_build_object('bill_type', g.bill_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'gst_paid', g.gst, 'n', g.n)), '[]'::jsonb)
       from (select e.bill_type, e.category, v.gstin, sum(e.gst_paid)::bigint as gst, count(*)::int as n
               from public.expenses e
               left join public.vendors v on v.id = e.vendor_id and v.tenant_id = v_tenant
              where e.tenant_id = v_tenant and e.expense_date <= v_to and e.gst_paid > 0
              group by e.bill_type, e.category, v.gstin) g),
    -- Fixed-asset register (chhoti table) — WDV bookValueNow() TS me.
    (select coalesce(jsonb_agg(jsonb_build_object('id', fa.id, 'name', fa.name, 'block', fa.block, 'cost', fa.cost,
                                                  'put_to_use', fa.put_to_use, 'disposed_on', fa.disposed_on,
                                                  'disposal_value', fa.disposal_value, 'emi_purchase_id', fa.emi_purchase_id)
                               order by fa.put_to_use, fa.id), '[]'::jsonb)
       from public.fixed_assets fa where fa.tenant_id = v_tenant),
    -- Tax challans (GST + income tax) — kind/period/fy par jode hue.
    (select coalesce(jsonb_agg(jsonb_build_object('kind', t.kind, 'amount', t.amount, 'period', t.period, 'fy', t.fy)), '[]'::jsonb)
       from (select tp.kind, tp.period, tp.fy, sum(tp.amount)::bigint as amount
               from public.tax_payments tp where tp.tenant_id = v_tenant group by tp.kind, tp.period, tp.fy) t),
    -- S45-SLICE2 (G4): unpaid expenses — P&L me kharcha, ab tak koi payable nahi tha.
    -- amount − TDS (TDS dues_vendor_tds me pehle se). Bank line se match = paid, bahar.
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid = false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G2): "paid" expenses jinki koi bank line match nahi — cash / UPI jo bank
    -- me abhi dikha nahi. Paisa haath se gaya; undeposited funds ka aaina (cash ka ulta).
    -- Jinka Cr pehle se kahin hai wo bahar: payroll/statutory (salary payable + dues),
    -- reimbursement (reimbursements payable), emi (loan + apni bank line), advance
    -- (employee loan / prepaid), EXP-RZPFEE-* (undeposited se ghata).
    (select coalesce(sum(e.amount - coalesce(e.tds_amount, 0)), 0)::bigint
       from public.expenses e
      where e.tenant_id = v_tenant and e.paid is distinct from false and e.reconciled_txn_id is null
        and e.expense_date <= v_to
        and coalesce(e.payment_method, '') not in ('payroll', 'statutory', 'reimbursement', 'emi', 'advance', 'employee_advance')
        and e.prepaid_advance_id is null and e.id not like 'EXP-RZPFEE-%'
        and not public.report_expense_has_own_credit(v_tenant, e.id)),
    -- S45-SLICE2 (G3): salary se kaata "other" deduction — kharcha gross hai, net payable
    -- kam; ye raqam company ke paas rakhi hai (kisi ko dena / wapas). Pehle kahin nahi.
    (select coalesce(sum(s.other_deduction), 0)::bigint
       from public.salary_payments s where s.tenant_id = v_tenant),
    -- R-1576: bills ka GST bhi ITC niyam se (lib/gst/bill-itc.ts) — document_type, vendor GSTIN,
    -- heads (state check ke liye IGST / CGST+SGST alag group), category (s.17(5)). TS tay karta hai.
    (select coalesce(jsonb_agg(jsonb_build_object('document_type', g.document_type, 'category', g.category,
                                                  'vendorGstin', g.gstin, 'cgst', g.cgst, 'sgst', g.sgst, 'igst', g.igst,
                                                  'n', g.n, 'ownStateCode', v_own_state)), '[]'::jsonb)
       from (select b.document_type, b.category, b.vendor_gstin as gstin,
                    sum(b.cgst)::bigint as cgst, sum(b.sgst)::bigint as sgst, sum(b.igst)::bigint as igst, count(*)::int as n
               from public.vendor_bills b
              where b.tenant_id = v_tenant and b.bill_date <= v_to and b.cgst + b.sgst + b.igst > 0
              group by b.document_type, b.category, b.vendor_gstin, (b.igst > 0), (b.cgst + b.sgst > 0)) g),
    -- R-1580: partner commission earned par abhi diya nahi — P&L me gross kharcha, yahan net
    -- deni-daari (TDS upar dues_vendor_tds me). pay_referral_commission status 'paid' karta hai.
    (select coalesce(sum(rc.net_payable), 0)::bigint
       from public.referral_commissions rc
      where rc.tenant_id = v_tenant and rc.status = 'earned');
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_day_book(p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  /* R-1739 */
  v_tenant uuid := public.current_tenant_id();
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Day Book nahi ban sakti: aapka login kisi workspace se juda nahi hai. Dobara sign in karein; phir bhi ho to owner se Settings → Team me aapko jodne ko kahein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Day Book ki tareekh galat hai (% se % tak). "From" tareekh "To" se pehle ya barabar honi chahiye.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  if p_to - p_from > 366 then
    raise exception 'Day Book ek baar me zyada se zyada 366 din ki banti hai (aapne % din chune). Chhota period chunein — mahina ya FY.', p_to - p_from + 1
      using errcode = 'invalid_parameter_value';
  end if;

  with v as (
    select i.invoice_date as d, 'Sales'::text as voucher, i.id as ref, i.customer_name as party,
           null::text as narr, i.amount::bigint as amt, 1 as ord
      from public.invoices i
     where i.tenant_id = v_tenant and i.invoice_date between p_from and p_to
       and i.status not in ('draft', 'void')
       and public.invoice_is_sale(i.document_kind)  -- R-1739: an imported Zoho opening invoice is no Sales voucher
    union all
    select (p.received_at at time zone 'Asia/Kolkata')::date, 'Receipt',
           coalesce(p.receipt_voucher_no, p.id::text), c.name,
           nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
           (p.amount - p.credit_applied)::bigint, 2
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant
       -- R-1565: a Receipt is money in; advance credit applied was receipted when it came in.
       and p.amount - p.credit_applied > 0
       and (p.received_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select (p.refunded_at at time zone 'Asia/Kolkata')::date, 'Refund',
           coalesce(p.refund_voucher_no, coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded'), c.name,
           p.refund_reason, (p.amount - p.credit_applied)::bigint, 3
      from public.payments p
      left join public.customers c on c.id = p.customer_id and c.tenant_id = v_tenant
     where p.tenant_id = v_tenant and p.status = 'refunded' and p.refunded_at is not null
       and p.amount - p.credit_applied > 0
       and (p.refunded_at at time zone 'Asia/Kolkata')::date between p_from and p_to
    union all
    select pp.received_at, 'Receipt', coalesce(nullif(pp.reference, ''), pp.id::text), ps.customer_name,
           'Project: ' || ps.title, pp.amount::bigint, 2
      from public.project_payments pp
      join public.project_sales ps on ps.id = pp.project_id and ps.tenant_id = v_tenant
     where pp.tenant_id = v_tenant and pp.received_at between p_from and p_to
    union all
    select cn.credit_date, 'Credit Note', cn.id, cn.customer_name,
           coalesce(cn.reason, 'against ' || cn.invoice_id), cn.amount::bigint, 4
      from public.credit_notes cn
     where cn.tenant_id = v_tenant and cn.credit_date between p_from and p_to
    union all
    select dn.debit_date, 'Debit Note', dn.id, dn.customer_name,
           coalesce(dn.reason, 'against ' || dn.invoice_id), dn.amount::bigint, 4
      from public.debit_notes dn
     where dn.tenant_id = v_tenant and dn.debit_date between p_from and p_to
    union all
    -- Salary ka kharcha Journal hai (Tally: Salary A/c Dr / Salary Payable A/c Cr), Purchase nahi —
    -- CA ko Day Book me salary kharidari jaisi dikhe to wo galat ledger me jaati hai. Categories
    -- wahi jo app salary maanta hai: lib/accounting/project-cost.ts SALARY_CATEGORIES.
    select e.expense_date,
           case when e.category in ('Salaries', 'Director''s Remuneration') then 'Journal' else 'Purchase' end,
           coalesce(e.bill_no, e.id), e.vendor_name, e.category, e.amount::bigint, 5
      from public.expenses e
     where e.tenant_id = v_tenant and e.expense_date between p_from and p_to
    union all
    select vb.bill_date, 'Purchase', coalesce(vb.bill_no, vb.id), vb.vendor_name, vb.category, vb.total::bigint, 5
      from public.vendor_bills vb
     where vb.tenant_id = v_tenant and vb.bill_date between p_from and p_to
    union all
    select e.paid_date, 'Payment', coalesce(e.bill_no, e.id) || ' · paid', e.vendor_name,
           e.payment_method, e.amount::bigint, 6
      from public.expenses e
     where e.tenant_id = v_tenant and e.paid and e.paid_date between p_from and p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'date', to_char(v.d, 'YYYY-MM-DD'), 'voucher', v.voucher, 'reference', v.ref,
           'party', v.party, 'narration', v.narr, 'amount', v.amt)
         order by v.d, v.ord, v.ref), '[]'::jsonb)
    into v_out
    from v;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.report_party_ledger(p_kind text, p_party text, p_from date, p_to date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  /* R-1739 */
  v_tenant uuid := public.current_tenant_id();
  v_cust   uuid;
  v_out jsonb;
begin
  if v_tenant is null then
    raise exception 'Ledger nahi ban sakta: aapka login kisi workspace se juda nahi hai. Dobara sign in karein.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_kind not in ('customer', 'vendor') then
    raise exception 'Ledger ka prakaar "%" samajh nahi aaya — sirf customer ya vendor chalta hai.', p_kind
      using errcode = 'invalid_parameter_value';
  end if;
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Ledger ki tareekh galat hai (% se % tak). Period dobara chunein.', p_from, p_to
      using errcode = 'invalid_parameter_value';
  end if;
  -- Customer id pehle hi uuid bana lo — query ke andar cast karte to vendor ke naam par
  -- bhi cast chal sakta (planner constant-fold karta hai) aur index bhi na lagta.
  if p_kind = 'customer' then
    begin
      v_cust := p_party::uuid;
    exception when invalid_text_representation then
      raise exception 'Customer id "%" sahi nahi hai. Customer list se dobara chunein.', p_party
        using errcode = 'invalid_parameter_value';
    end;
  end if;

  with e as (
    select * from (
      -- Customer: Sales (Dr), Receipt (Cr), Refund (Dr), Credit Note (Cr), Debit Note (Dr).
      /* R-1739: an imported Zoho opening invoice is the customer's opening balance — only what
         was still due when it was imported (opening_balance); its Zoho receipts were never here. */
      select i.invoice_date as d, i.id as ref,
             case when public.invoice_is_sale(i.document_kind) then 'Sales' else 'Opening balance' end::text as voucher,
             case when public.invoice_is_sale(i.document_kind) then null else 'Imported from Zoho Books' end::text as narr,
             case when public.invoice_is_sale(i.document_kind) then i.amount else coalesce(i.opening_balance, 0) end::bigint as amt, true as up
        from public.invoices i
       where p_kind = 'customer' and i.tenant_id = v_tenant
         and i.customer_id = v_cust and i.status <> 'void'
      union all
      select (p.received_at at time zone 'Asia/Kolkata')::date, coalesce(p.receipt_voucher_no, p.id::text), 'Receipt',
             nullif(concat_ws(' · ', nullif(p.method, ''), nullif(p.reference, '')), ''),
             (p.amount - p.credit_applied)::bigint, false
        from public.payments p
       -- R-1565: the customer's credit was already a Receipt on the payment that created it.
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.amount - p.credit_applied > 0
      union all
      select (p.refunded_at at time zone 'Asia/Kolkata')::date,
             coalesce(p.receipt_voucher_no, p.id::text) || ' · refunded', 'Refund',
             'Payment returned to the customer', (p.amount - p.credit_applied)::bigint, true
        from public.payments p
       where p_kind = 'customer' and p.tenant_id = v_tenant and p.customer_id = v_cust
         and p.status = 'refunded' and p.refunded_at is not null
         and p.amount - p.credit_applied > 0
      union all
      select c.credit_date, c.id, 'Credit Note',
             coalesce(c.reason, case when coalesce(c.invoice_id, '') <> '' then 'against ' || c.invoice_id end),
             c.amount::bigint, false
        from public.credit_notes c
       where p_kind = 'customer' and c.tenant_id = v_tenant and c.customer_id = v_cust
      union all
      select d.debit_date, d.id, 'Debit Note',
             coalesce(d.reason, case when coalesce(d.invoice_id, '') <> '' then 'against ' || d.invoice_id end),
             d.amount::bigint, true
        from public.debit_notes d
       where p_kind = 'customer' and d.tenant_id = v_tenant and d.customer_id = v_cust
      union all
      -- Vendor: expenses hi bill hain (vendor_name par — vendor_id zyaadatar khaali hai).
      select x.expense_date, coalesce(x.bill_no, x.id), 'Purchase', x.category, x.amount::bigint, true
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
      union all
      select x.paid_date, coalesce(x.bill_no, x.id) || ' · paid', 'Payment', x.payment_method, x.amount::bigint, false
        from public.expenses x
       where p_kind = 'vendor' and x.tenant_id = v_tenant and x.vendor_name = p_party
         and x.paid and x.paid_date is not null
    ) u
    where u.d is not null
  )
  select jsonb_build_object(
    'opening', (select coalesce(sum(case when e.up then e.amt else -e.amt end), 0) from e where e.d < p_from),
    'entries', (select coalesce(jsonb_agg(jsonb_build_object(
                  'date', to_char(e.d, 'YYYY-MM-DD'), 'reference', e.ref, 'voucher', e.voucher,
                  'narration', e.narr, 'amount', e.amt, 'increasesLiability', e.up)
                  order by e.d, e.up desc, e.ref), '[]'::jsonb)
                  from e where e.d between p_from and p_to)
  ) into v_out;
  return v_out;
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_partner_metrics()
 RETURNS TABLE(tenant_id uuid, tenant_name text, tenant_gstin text, active_subscriptions integer, total_seats_sold integer, mrr integer, invoiced_this_month integer, paid_this_month integer, renewals_due_30d integer, renewal_revenue_30d integer, last_invoice_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  /* R-1615: current_tenant_id() — no rows for a deactivated user / half-signed-in MFA session. */
  with caller as (
    select public.current_tenant_id() as tenant_id
  ),
  month_start as (
    select date_trunc('month', current_date)::date as d
  ),
  children as (
    select t.id, t.name, t.gstin
    from public.tenants t
    where t.parent_tenant_id = (select tenant_id from caller)
  )
  select
    c.id, c.name, c.gstin,
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(seats)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(mrr)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'), 0),
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.invoice_date >= (select d from month_start)
        and public.invoice_is_sale(i.document_kind)), 0),  -- R-1739
    coalesce((select sum(amount)::int from public.invoices i
      where i.tenant_id = c.id and i.status = 'paid' and i.paid_date is not null
        and public.invoice_is_sale(i.document_kind)  -- R-1739
        and i.paid_date >= (select d from month_start)), 0),
    coalesce((select count(*)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    coalesce((select sum(mrr * 12)::int from public.subscriptions s
      where s.tenant_id = c.id and s.status = 'active'
        and s.renewal_date is not null and s.renewal_date <= current_date + interval '30 days'), 0),
    (select max(invoice_date) from public.invoices i where i.tenant_id = c.id and public.invoice_is_sale(i.document_kind))
  from children c
  order by c.name;
$function$;

CREATE OR REPLACE FUNCTION public.record_multi_invoice_payment(p_customer_id uuid, p_received_on date, p_method text, p_bank_account_id uuid, p_reference text, p_received integer, p_allocations jsonb, p_excess_to_credit boolean DEFAULT true, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-1525: one receipt → several invoices of one customer, via record_desk_payment per line.
   R-1564: an instalment invoice (no quote of its own) goes through record_instalment_payment.
   R-1676: its lines share one UTR on purpose — app.payment_ref_batch lets them past
   trg_payments_ref_once for the loop only.
   R-1739: an imported Zoho opening invoice (no quote) is settled by _record_opening_invoice_payment. */
declare
  v_open       boolean;
  v_inst       boolean;
  v_inst_q     text[] := array[]::text[];
  v_tenant     uuid := public.current_tenant_id();
  v_trusted    boolean;
  v_n          integer;
  v_alloc      jsonb;
  v_ids        text[] := array[]::text[];
  v_inv        record;
  v_quote      record;
  v_received   integer;
  v_inv_due    integer;
  v_q_due      integer;
  v_due        integer;
  v_amt        numeric;
  v_tds        numeric;
  v_lines      jsonb := '[]'::jsonb;
  v_line       jsonb;
  v_sum        integer := 0;
  v_excess     integer;
  v_carrier    integer := null;
  v_replays    integer := 0;
  v_idx        integer;
  v_settle     integer;
  v_r          jsonb;
  v_out        jsonb := '[]'::jsonb;
  v_credit     integer;
  v_credit_inv text := null;
  v_notes      text;
  v_gross      integer;
  v_want       integer;
begin
  /* R-718 role gate — same as record_payment / record_desk_payment. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a payment. Ask one of them to record it.'
      using errcode = '42501';
  end if;
  /* §17c fail-closed: no company → nothing. */
  if v_tenant is null then
    raise exception 'No company context — sign in again, then record the payment.' using errcode = '28000';
  end if;

  if p_customer_id is null
     or not exists (select 1 from public.customers where id = p_customer_id and tenant_id = v_tenant) then
    raise exception 'That customer is not in your company. Open the customer from Customers and try again.'
      using errcode = '42501';
  end if;
  if p_received is null or p_received <= 0 then
    raise exception 'Enter the amount received (more than ₹0).';
  end if;
  if p_received_on is null then
    raise exception 'Enter the date the money was received.';
  end if;
  if p_method is null or p_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
    raise exception 'Choose how the money came in (UPI, bank transfer, cheque, cash…).';
  end if;
  if p_reference is null or length(trim(p_reference)) = 0 then
    raise exception 'Enter a reference (UTR / cheque no. / receipt no.) so this payment can be matched later.';
  end if;
  if p_bank_account_id is not null
     and not exists (select 1 from public.bank_accounts where id = p_bank_account_id and tenant_id = v_tenant) then
    raise exception 'That bank account is not in your company. Choose one of your bank accounts.' using errcode = '42501';
  end if;
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Choose at least one invoice to apply this payment to.';
  end if;
  v_n := jsonb_array_length(p_allocations);
  if v_n > 200 then
    raise exception 'Too many invoices in one payment (% — at most 200). Record it in two parts.', v_n;
  end if;

  /* Shape + no duplicates, then lock every invoice in id order before reading any due. */
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    if jsonb_typeof(v_alloc) <> 'object' or coalesce(v_alloc->>'invoice_id', '') = '' then
      raise exception 'Each line needs an invoice. Refresh the list and try again.';
    end if;
    if (v_alloc->>'invoice_id') = any(v_ids) then
      raise exception 'Invoice % is listed twice. Keep it once with the full amount.', v_alloc->>'invoice_id';
    end if;
    v_ids := v_ids || (v_alloc->>'invoice_id');
  end loop;
  perform 1 from public.invoices
   where id = any(v_ids) and tenant_id = v_tenant
   order by id
   for update;

  v_idx := 0;
  for v_alloc in select value from jsonb_array_elements(p_allocations) loop
    begin
      v_amt := coalesce((v_alloc->>'amount')::numeric, 0);
      v_tds := coalesce((v_alloc->>'tds_amount')::numeric, 0);
    exception when others then
      raise exception 'The amount for invoice % is not a number.', v_alloc->>'invoice_id';
    end;
    if v_amt <> trunc(v_amt) or v_tds <> trunc(v_tds) then
      raise exception 'Use whole rupees for invoice % (no paise).', v_alloc->>'invoice_id';
    end if;
    if v_amt < 0 or v_tds < 0 then
      raise exception 'The amount for invoice % cannot be negative.', v_alloc->>'invoice_id';
    end if;
    if v_amt + v_tds <= 0 then
      raise exception 'Invoice % has ₹0 against it. Enter an amount or remove the line.', v_alloc->>'invoice_id';
    end if;

    select i.id, i.tenant_id, i.customer_id, i.amount, i.net_payable, i.paid_amount, i.status,
           i.quote_id, i.taxable_value, i.document_kind
      into v_inv
      from public.invoices i
     where i.id = v_alloc->>'invoice_id' and i.tenant_id = v_tenant;
    if not found then
      raise exception 'Invoice % was not found in your company. Refresh the list and try again.', v_alloc->>'invoice_id'
        using errcode = '42501';
    end if;
    if v_inv.customer_id is distinct from p_customer_id then
      raise exception 'Invoice % belongs to another customer. Record its payment from that customer.', v_inv.id
        using errcode = '42501';
    end if;

    v_inst := false;
    v_open := v_inv.document_kind = 'opening_invoice';
    if v_open then
      select null::text as id, null::integer as amount, null::text as invoice_id into v_quote;
    else
    select q.id, q.amount, q.invoice_id
      into v_quote
      from public.quotes q
     where q.id = v_inv.quote_id and q.tenant_id = v_tenant and q.invoice_id = v_inv.id;
    if not found then
      /* R-1564: a subscription instalment — its money is recorded on the subscription's quote
         and applied to this invoice by record_instalment_payment. */
      select q.id, q.amount, q.invoice_id
        into v_quote
        from public.subscription_billings b
        join public.subscriptions s on s.id = b.subscription_id and s.tenant_id = v_tenant
        join public.quotes q on q.id = s.quote_id and q.tenant_id = v_tenant and q.invoice_id is null
       where b.invoice_id = v_inv.id and b.tenant_id = v_tenant
       limit 1;
      if not found then
        raise exception 'Invoice % has no quote of its own (a project invoice). Record its payment from the project.', v_inv.id;
      end if;
      v_inst := true;
      /* Two instalments of one subscription share its quote, and quote + reference is the
         replay key — the second line would read as a retry of the first. */
      if v_quote.id = any(v_inst_q) then
        raise exception 'Invoice % is another instalment of the same subscription as an invoice above. Keep one instalment per subscription here, or record this receipt on the oldest instalment from the invoice page — what is over its due goes to the next instalment of that subscription.', v_inv.id;
      end if;
      v_inst_q := v_inst_q || v_quote.id;
    end if;
    end if;  -- R-1739 v_open

    /* Replay: this quote already holds a received payment with this reference. */
    if exists (select 1 from public.payments p
                where p.tenant_id = v_tenant
                  and case when v_open then p.quote_id is null and p.invoice_id = v_inv.id
                           else p.quote_id = v_quote.id end
                  and p.reference = p_reference and p.status = 'received') then
      v_replays := v_replays + 1;
      v_due := null;
    else
      if v_inv.status::text in ('paid', 'void') then
        v_inv_due := 0;
      else
        v_inv_due := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0));
      end if;
      if v_inst or v_open then
        /* R-1564: an instalment owes its own due; the year's quote total is not the limit. */
        v_due := v_inv_due;
      else
        select coalesce(sum(amount), 0)::int into v_received
          from public.payments where quote_id = v_quote.id and tenant_id = v_tenant and status = 'received';
        v_q_due := greatest(0, coalesce(v_quote.amount, 0) - v_received);
        v_due := least(v_inv_due, v_q_due);
      end if;
      if v_amt + v_tds > v_due then
        raise exception 'Invoice % has only ₹% due, but ₹% is applied to it. Lower that line; the rest can stay as advance credit.',
          v_inv.id, v_due, (v_amt + v_tds)::int;
      end if;
    end if;

    v_sum := v_sum + v_amt::int;
    v_lines := v_lines || jsonb_build_object(
      'invoice_id', v_inv.id, 'quote_id', v_quote.id, 'instalment', v_inst, 'opening', v_open,
      'amount', v_amt::int, 'tds_amount', v_tds::int, 'due', v_due,
      'tds_gross', coalesce(nullif(v_alloc->>'tds_gross', '')::int, v_inv.taxable_value, v_inv.amount),
      'tds_section', nullif(trim(coalesce(v_alloc->>'tds_section', '')), ''),
      'tds_rate_pct', nullif(v_alloc->>'tds_rate_pct', '')::numeric,
      'customer_tan', nullif(trim(coalesce(v_alloc->>'customer_tan', '')), ''));
    /* The last line that pays its invoice IN FULL carries any excess. R-1564: never an
       instalment — record_instalment_payment keeps its excess for the next instalment,
       not as customer credit. */
    if v_due is not null and v_amt + v_tds = v_due and not v_inst and not v_open then
      v_carrier := v_idx;
    end if;
    v_idx := v_idx + 1;
  end loop;

  /* Whole retry → nothing new; partial retry → refused. */
  if v_replays = v_n then
    select coalesce(jsonb_agg(jsonb_build_object(
             'invoice_id', l->>'invoice_id', 'quote_id', l->>'quote_id', 'payment_id', p.id,
             'amount', p.amount, 'invoice_paid', null)), '[]'::jsonb)
      into v_out
      from jsonb_array_elements(v_lines) l
      join public.payments p
        on p.tenant_id = v_tenant
       and case when coalesce((l->>'opening')::boolean, false) then p.quote_id is null and p.invoice_id = l->>'invoice_id'
                else p.quote_id = l->>'quote_id' end
       and p.reference = p_reference and p.status = 'received';
    return jsonb_build_object('idempotent_replay', true, 'already_recorded', true,
                              'received', p_received, 'allocated', v_sum, 'excess_credit', 0,
                              'credit_invoice_id', null, 'lines', v_out);
  elsif v_replays > 0 then
    raise exception 'Reference % is already recorded on % of these invoices. Use the bank''s own reference for this payment, or leave those invoices out.',
      p_reference, v_replays;
  end if;

  v_excess := p_received - v_sum;
  if v_excess < 0 then
    raise exception 'The invoice lines add up to ₹% but only ₹% was received. Lower a line so they add up to the amount received.',
      v_sum, p_received;
  end if;
  if v_excess > 0 and not coalesce(p_excess_to_credit, false) then
    raise exception '₹% of the ₹% received is not applied to any invoice. Apply it to an invoice, or keep it as advance credit.',
      v_excess, p_received;
  end if;
  if v_excess > 0 and v_carrier is null then
    raise exception '₹% would be left as advance credit while every chosen invoice is still part-paid (a subscription instalment never carries it). Pay at least one regular invoice in full first (oldest first), then keep the rest as advance — or lower the amount received to what the invoices take.',
      v_excess;
  end if;

  v_notes := nullif(concat_ws(' · ',
               nullif(trim(coalesce(p_notes, '')), ''),
               'One payment of ₹' || p_received || ' across ' || v_n || ' invoice' || case when v_n = 1 then '' else 's' end || ' (ref ' || trim(p_reference) || ')'), '');

  /* R-1676: one transfer → several invoices is the one place a UTR may repeat — but only
     among THIS call's lines: the reference must not already be on an earlier payment. */
  perform public.assert_payment_ref_unused(v_tenant, p_method, p_reference);
  perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(p_method, p_reference), ''), true);

  v_idx := 0;
  for v_line in select value from jsonb_array_elements(v_lines) loop
    v_want   := case when v_idx = v_carrier then v_excess else 0 end;
    v_settle := (v_line->>'amount')::int + (v_line->>'tds_amount')::int + v_want;
    v_gross := (v_line->>'tds_gross')::int;

    if coalesce((v_line->>'opening')::boolean, false) then
      /* R-1739: an imported Zoho opening invoice — the payment carries the invoice, no quote. */
      v_r := public._record_opening_invoice_payment(
        v_tenant, v_line->>'invoice_id', v_settle, p_method, p_reference, v_notes,
        p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        public.indian_fiscal_year(p_received_on));
    elsif coalesce((v_line->>'instalment')::boolean, false) then
      /* R-1564: same arguments, keyed by the instalment invoice. */
      v_r := public.record_instalment_payment(
        v_line->>'invoice_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        public.indian_fiscal_year(p_received_on));
      if not coalesce((v_r->>'already_recorded')::boolean, false)
         and not coalesce((v_r->>'idempotent_replay')::boolean, false)
         and coalesce((v_r->>'applied')::int, -1) <> v_settle then
        raise exception 'Amounts for invoice % are out of step (applied ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
          v_line->>'invoice_id', coalesce((v_r->>'applied')::int, 0), v_settle;
      end if;
    else
      v_r := public.record_desk_payment(
        v_line->>'quote_id', v_settle, p_method, p_reference, v_notes,
        null, 0, p_received_on, p_bank_account_id,
        (v_line->>'tds_amount')::int,
        case when (v_line->>'tds_amount')::int > 0 then v_gross else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'amount')::int else 0 end,
        case when (v_line->>'tds_amount')::int > 0 then coalesce(v_line->>'tds_section', '194J') end,
        case when (v_line->>'tds_amount')::int > 0 then (v_line->>'tds_rate_pct')::numeric end,
        case when (v_line->>'tds_amount')::int > 0 then v_line->>'customer_tan' end,
        v_line->>'invoice_id',
        public.indian_fiscal_year(p_received_on));
    end if;

    if coalesce((v_r->>'already_recorded')::boolean, false)
       or coalesce((v_r->>'idempotent_replay')::boolean, false) then
      raise exception 'Invoice % already had this reference recorded a moment ago. Nothing was saved — refresh and check before trying again.',
        v_line->>'invoice_id';
    end if;
    v_credit := coalesce((v_r->>'overpaid_credit')::int, 0);
    if v_credit <> v_want then
      raise exception 'Amounts for invoice % are out of step (advance credit ₹%, expected ₹%). Nothing was saved — refresh the page and try again.',
        v_line->>'invoice_id', v_credit, v_want;
    end if;
    if v_idx = v_carrier and v_excess > 0 then
      v_credit_inv := v_line->>'invoice_id';
    end if;
    if (v_line->>'tds_amount')::int > 0 and not coalesce((v_r->>'tds_saved')::boolean, false) then
      raise exception 'The TDS for invoice % could not be saved. Nothing was saved — try again.', v_line->>'invoice_id';
    end if;

    v_out := v_out || jsonb_build_object(
      'invoice_id', v_line->>'invoice_id', 'quote_id', v_line->>'quote_id',
      'payment_id', v_r->>'payment_id', 'amount', v_settle,
      'tds_amount', (v_line->>'tds_amount')::int,
      'invoice_paid', coalesce((v_r->>'invoice_paid')::boolean, false));
    v_idx := v_idx + 1;
  end loop;
  perform set_config('app.payment_ref_batch', '', true);

  return jsonb_build_object(
    'idempotent_replay', false, 'already_recorded', false,
    'received', p_received, 'allocated', v_sum, 'excess_credit', v_excess,
    'credit_invoice_id', v_credit_inv, 'lines', v_out);
end;
$function$;

commit;
