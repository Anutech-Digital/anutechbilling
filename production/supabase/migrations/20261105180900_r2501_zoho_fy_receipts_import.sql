-- deploy-peek: to_regclass('public.zoho_fy_receipts') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.import_zoho_fy_receipts(text,jsonb,boolean)') and prosrc like '%R-2501%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.record_multi_invoice_payment(uuid,date,text,uuid,text,integer,jsonb,boolean,text)') and prosrc like '%R-2501%') and exists(select 1 from pg_proc where oid = to_regprocedure('public._opening_invoice_settle(text)') and prosrc like '%R-2501%')
-- deploy-key: r2501zohofyreceipts
--
-- R-2501 (goal G-FY2526, 5 Nov 2026): Excel's FY 2025-26 customer payments from Zoho (receipts + the
-- TDS the customer kept back) onto the FY sales R-2499 imported as Zoho's own invoices, and — where
-- the bank line is already in the app — that bank line matched to the receipt.
--
-- ══ WHY THE PAYMENT PATH CHANGES ═══════════════════════════════════════════════════════════════
--   An R-2499 sale has no quote (invoices_zoho_sale_shape). In the app a receipt hangs on its quote;
--   the ONE quote-less path is R-1739's, for an imported Zoho opening invoice: the payment carries the
--   invoice (payments.invoice_id), _record_opening_invoice_payment writes the receipt voucher + the TDS
--   receivable row, trg_payments_opening_invoice keeps invoices.paid_amount / status equal to the money.
--   Without this file an imported sale could not take ANY payment (Record payment refuses it: "no quote
--   of its own"), so it would stay unpaid in AR for ever. This file lets the SAME path take an
--   imported Zoho sale (invoices.zoho_invoice_id is not null) — no new receipt / TDS formula:
--     _opening_invoice_settle(text)        ← 20261022013149_r1739 (only definition): paid = Total −
--         opening balance + receipts; an imported sale has no opening balance → paid = receipts.
--     tg_payments_opening_invoice()        ← r1739 (only definition): accepts an imported sale too.
--     _record_opening_invoice_payment(...) ← r1739 (only definition): accepts an imported sale too.
--     record_multi_invoice_payment(...)    ← r1739 (latest; checked all anutech/* branches): an
--         imported sale's line goes to _record_opening_invoice_payment, as an opening invoice's does.
--         Everything else is the R-1739 body unchanged.
--   Not changed here (follow-up, card R-2501 review `left`): bank_credit_open_items /
--   bank_credit_pay_item (the Reconcile sheet's "This money is for") still list only opening invoices.
--
-- ══ WHAT THIS ADDS ═════════════════════════════════════════════════════════════════════════════
--   1. The R-2499 FY import framework takes kind 'customerpayments' (Zoho's customer payments list):
--      the three tables' kind checks widened; the scan stores each payment's facts in WHOLE RUPEES
--      (lib/integrations/zoho-books/receipts-import/normalise.ts).
--   2. zoho_fy_receipts — one row per Zoho payment booked (idempotent: primary key tenant + Zoho id),
--      the receipts it made and the bank line it is matched to (null = "bank match later").
--   3. import_zoho_fy_receipts(fy, picks, dry_run) — OWNER / ACCOUNTANT. picks = [{zoho_payment_id,
--      bank_account_id}] — NO money: every amount comes from the server's scan (zoho_fy_scan).
--      Per payment, skipped with a reason when: Zoho problems (not INR, bank charges, totals not
--      adding up, TDS not split by invoice); outside the FY; no books start / before it; inside the
--      books lock; no invoice applied (an advance — by hand); an applied invoice that is not an
--      imported FY sale of this company (opening invoices wait for R-2504); invoices of two
--      customers; void invoice; more than its due (₹1 rounding is capped at the due); the account
--      not this company's; any refusal of the receipt RPCs (UTR already on another receipt, …).
--      Booked with record_multi_invoice_payment (Record payment's own call: receipt voucher, the
--      Zoho TDS as TDS receivable — only Zoho's tax_amount_withheld, never worked out), the money
--      Zoho left unapplied as an advance (holder quote + receipt + customer credit, exactly as
--      bank_credit_book_advance makes one), then the bank line: one unmatched credit of exactly
--      that amount in that account within 3 days, by Zoho's reference in its narration (or the only
--      one that day) → reconcile_bank_txn to the first receipt + payments.bank_txn_id on all (the
--      R-2098 split shape). None / several → booked now, matched on a later run once the statement
--      is in (a rerun matches already-booked receipts that still have no bank line).
--      Each payment in its own sub-transaction: one refusal never half-books it.
--      dry_run (default) = the same work, rolled back (R2501 raised at the end), nothing written.
--      One zoho_fy_import_batches row (kind customerpayments) + one activity_log row per part.
--
-- Cloud SQL: no extensions schema; auth.uid()/auth.role() rewritten by the deploy script.
-- Grants explicit. service_role policy (R-450).
-- Test: supabase/tests/r2501_zoho_fy_receipts_import.test.sql (rolled back; red without this file).
-- Rollback: drop import_zoho_fy_receipts, _zoho_fy_receipt_advance, _zoho_fy_receipt_bank_line and
--   zoho_fy_receipts (only after taking the receipts back by hand); restore the four functions from
--   20261022013149_r1739_zoho_opening_invoices.sql; narrow the kind checks back.

begin;

-- ── 1. FY import framework: kind 'customerpayments' ─────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['zoho_fy_import_batches', 'zoho_fy_scan_runs', 'zoho_fy_scan'] loop
    execute format('alter table public.%I drop constraint if exists %I', t, t || '_kind_check');
    execute format($c$alter table public.%I add constraint %I check (kind in ('invoices', 'creditnotes', 'bills', 'expenses', 'vendorpayments', 'customerpayments'))$c$, t, t || '_kind_check');
  end loop;
end $$;

-- ── 2. Which Zoho payment became which receipts ────────────────────────────────────────────────
create table if not exists public.zoho_fy_receipts (
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  zoho_payment_id  text        not null check (char_length(zoho_payment_id) between 1 and 40),
  fy               text        not null check (fy ~ '^\d{4}-\d{2}$'),
  batch_id         uuid        not null references public.zoho_fy_import_batches(id) on delete restrict,
  customer_id      uuid        not null references public.customers(id) on delete restrict,
  received_on      date        not null,
  bank_account_id  uuid        not null references public.bank_accounts(id) on delete restrict,
  received_paise   bigint      not null check (received_paise > 0),
  cash             integer     not null check (cash >= 0),
  tds              integer     not null check (tds >= 0),
  advance          integer     not null default 0 check (advance >= 0),
  reference        text        not null,
  payment_ids      uuid[]      not null,
  bank_txn_id      uuid        references public.bank_transactions(id) on delete set null,
  created_at       timestamptz not null default now(),
  banked_at        timestamptz,
  primary key (tenant_id, zoho_payment_id)
);
comment on table public.zoho_fy_receipts is
  'R-2501: one row per Zoho customer payment booked by import_zoho_fy_receipts (a rerun skips it): its receipts (payment_ids) and the bank line matched to them (null = match on a later run). Written only by that function.';
create index if not exists zoho_fy_receipts_unbanked_idx on public.zoho_fy_receipts (tenant_id) where bank_txn_id is null;

alter table public.zoho_fy_receipts enable row level security;
revoke all on table public.zoho_fy_receipts from public, anon, authenticated;
grant select on table public.zoho_fy_receipts to authenticated;
grant all on table public.zoho_fy_receipts to service_role;
drop policy if exists zoho_fy_receipts_select on public.zoho_fy_receipts;
create policy zoho_fy_receipts_select on public.zoho_fy_receipts as permissive for select to authenticated
  using (tenant_id = ( select public.current_tenant_id() ));
drop policy if exists zzz_service_role_all on public.zoho_fy_receipts;
create policy zzz_service_role_all on public.zoho_fy_receipts as permissive for all to service_role using (true) with check (true);

-- ── 3. The quote-less receipt path takes an imported Zoho sale too ─────────────────────────────
-- ← 20261022013149_r1739_zoho_opening_invoices.sql (only definition) + the R-2501 kind test.
create or replace function public._opening_invoice_settle(p_invoice_id text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739: paid = (Total − Balance at import) + received payments on it.
     R-2501: an FY sale imported from Zoho (zoho_invoice_id) has no balance at import → paid = receipts. */
  v_inv   record;
  v_recv  bigint;
  v_last  date;
  v_paid  integer;
begin
  select i.id, i.tenant_id, i.amount, i.net_payable, i.opening_balance, i.due_date, i.status
    into v_inv
    from public.invoices i
   where i.id = p_invoice_id
     and (i.document_kind = 'opening_invoice' or i.zoho_invoice_id is not null)
   for update;
  if not found or v_inv.status = 'void' then
    return;
  end if;
  select coalesce(sum(p.amount), 0), max((p.received_at at time zone 'Asia/Kolkata')::date)
    into v_recv, v_last
    from public.payments p
   where p.tenant_id = v_inv.tenant_id and p.invoice_id = v_inv.id and p.quote_id is null
     and p.status = 'received';
  v_paid := (v_inv.amount - coalesce(v_inv.opening_balance, v_inv.amount) + v_recv)::integer;
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

-- ← r1739 (only definition) + R-2501.
create or replace function public.tg_payments_opening_invoice()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1739; R-2501: an FY sale imported from Zoho takes its receipt the same way. */
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
    select i.tenant_id, i.customer_id, i.document_kind, i.zoho_invoice_id into v_inv
      from public.invoices i where i.id = new.invoice_id;
    if not found or v_inv.tenant_id is distinct from new.tenant_id
       or not (v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null) then
      raise exception 'Invoice % is not an invoice imported from Zoho in your company, so it cannot take a payment without its quote.', new.invoice_id
        using errcode = 'check_violation';
    end if;
    if new.customer_id is not null and v_inv.customer_id is distinct from new.customer_id then
      raise exception 'Invoice % belongs to another customer.', new.invoice_id using errcode = '42501';
    end if;
    return new;
  end if;

  /* AFTER: keep the imported invoice's paid amount equal to its money. */
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

-- ← r1739 (only definition) + R-2501.
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
     which has already checked the role, the company, the customer and the amount.
     R-2501: an FY sale imported from Zoho (zoho_invoice_id) takes its receipt here too. */
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
   where i.id = p_invoice_id and i.tenant_id = p_tenant
     and (i.document_kind = 'opening_invoice' or i.zoho_invoice_id is not null)
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

-- ← 20261022013149_r1739_zoho_opening_invoices.sql (latest) + R-2501: v_open also for an imported Zoho sale.
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
   R-1739: an imported Zoho opening invoice (no quote) is settled by _record_opening_invoice_payment.
   R-2501: so is an FY sale imported from Zoho (invoices.zoho_invoice_id — no quote either). */
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
  /* R-2501: public.current_request_role() in place of the raw auth.role() (R-2487 rule) — the same answer. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
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
           i.quote_id, i.taxable_value, i.document_kind, i.zoho_invoice_id
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
    v_open := v_inv.document_kind = 'opening_invoice' or v_inv.zoho_invoice_id is not null;   -- R-2501
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

-- ── 4. The money Zoho left unapplied → the customer's advance ─────────────────────────────────
-- The same three rows bank_credit_book_advance (R-2098 / R-2430) writes for a bank line's advance —
-- a ₹0 "Advance on account" holder quote, the receipt, the customer credit — without a bank line
-- (the Zoho payment may have none yet). Not granted to any app role: reached only from
-- import_zoho_fy_receipts, which has checked the role, the company, the customer and the amount.
create or replace function public._zoho_fy_receipt_advance(
  p_tenant uuid, p_customer_id uuid, p_amount integer, p_received_on date, p_method text,
  p_reference text, p_bank_account_id uuid, p_zoho_number text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 */
  v_cust      record;
  v_export    boolean;
  v_rate      integer;
  v_qid       text;
  v_voucher   text;
  v_pay_id    uuid;
  v_credit_id uuid;
begin
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'An advance must be more than ₹0.' using errcode = '22023';
  end if;
  select c.id, c.name, c.country into v_cust from public.customers c where c.id = p_customer_id and c.tenant_id = p_tenant;
  if not found then
    raise exception 'Customer not found in your company.' using errcode = 'no_data_found';
  end if;
  v_export := coalesce(nullif(lower(trim(v_cust.country)), ''), 'india') not in ('india','in','ind','bharat');
  v_rate := case
              when v_export then 0
              when public.supplier_gst_status(p_tenant, p_received_on) in ('unregistered', 'composition') then 0
              else 18
            end;

  v_qid := public.next_document_number('quote', p_tenant, public.ist_today());
  if v_qid is null then raise exception 'Could not allocate a quote number'; end if;
  insert into public.quotes (
    id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, tax_rate, discount_pct,
    line_items, status, payment_status, payment_amount, payment_method, payment_reference,
    payment_received_at, is_one_off, billing_cycle, created_date, notes
  ) values (
    v_qid, p_tenant, p_customer_id, v_cust.name, 'Advance on account', 0, 0, 0, v_rate, 0,
    '[]'::jsonb, 'accepted', 'received', p_amount, p_method, p_reference,
    (p_received_on::timestamp at time zone 'UTC'), true, 'yearly', public.ist_today(),
    'Advance from Zoho payment ' || coalesce(p_zoho_number, '') || ' of ' || to_char(p_received_on, 'DD Mon YYYY')
      || ' — not applied to any invoice in Zoho, kept as customer credit (R-2501).'
  );

  v_voucher := public.next_document_number('receipt_voucher', p_tenant, public.ist_today());
  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, receipt_voucher_no, recorded_by, bank_account_id)
  values (p_tenant, v_qid, p_customer_id, p_amount, p_method, p_reference,
          'Advance on account — Zoho payment ' || coalesce(p_zoho_number, ''),
          'received', (p_received_on::timestamp at time zone 'UTC'), v_voucher, auth.uid(), p_bank_account_id)
  returning id into v_pay_id;

  insert into public.customer_credits
    (tenant_id, customer_id, amount, source, source_payment_id, source_quote_id, note, status)
  values
    (p_tenant, p_customer_id, p_amount, 'overpayment', v_pay_id, v_qid,
     'Advance received ' || to_char(p_received_on, 'DD Mon YYYY') || ' (Zoho payment ' || coalesce(p_zoho_number, '') || ') — nothing invoiced', 'open')
  returning id into v_credit_id;

  return jsonb_build_object('quote_id', v_qid, 'payment_id', v_pay_id, 'receipt_voucher_no', v_voucher, 'credit_id', v_credit_id);
end;
$function$;
revoke all on function public._zoho_fy_receipt_advance(uuid, uuid, integer, date, text, text, uuid, text) from public, anon, authenticated;

-- ── 5. The bank line a Zoho payment came in on (if the statement is in) ───────────────────────
-- An unmatched credit of exactly the money (to the paisa) in that account, dated within 3 days, on
-- no receipt yet: the one whose reference / narration carries Zoho's reference → 'exact'; else, when
-- it is the ONLY such line and dated the same day → 'high'; anything else → none (match later / by hand).
create or replace function public._zoho_fy_receipt_bank_line(
  p_tenant uuid, p_bank_account_id uuid, p_received_paise bigint, p_received_on date, p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 */
  v_ref   text := upper(btrim(coalesce(p_reference, '')));
  v_hits  uuid[];
  v_all   uuid[];
  v_same  uuid[];
  v_taken record;
begin
  select coalesce(array_agg(t.id order by t.txn_date, t.id), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (where t.txn_date = p_received_on), '{}'),
         coalesce(array_agg(t.id order by t.id) filter (
           where char_length(v_ref) >= 6
             and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0), '{}')
    into v_all, v_same, v_hits
    from public.bank_transactions t
   where t.tenant_id = p_tenant
     and t.bank_account_id = p_bank_account_id
     and coalesce(t.credit, 0) > 0
     and round(t.credit * 100)::bigint = p_received_paise
     and t.txn_date between p_received_on - 3 and p_received_on + 3
     and t.matched_to_type is null
     and not exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id);
  if cardinality(v_hits) = 1 then
    return jsonb_build_object('txn_id', v_hits[1], 'confidence', 'exact');
  end if;
  if cardinality(v_hits) = 0 and cardinality(v_all) = 1 and cardinality(v_same) = 1 then
    return jsonb_build_object('txn_id', v_same[1], 'confidence', 'high');
  end if;
  /* Review: no free line, but THE line (same money, Zoho's reference in it, or the same day) is
     already reconciled to something else (an advance / new sale booked on the Reconcile sheet) —
     the money is in the books already: the caller refuses, never a second receipt. */
  if cardinality(v_all) = 0 then
    select t.id, coalesce(t.matched_to_type, 'split receipt') as matched_to_type, t.txn_date into v_taken
      from public.bank_transactions t
     where t.tenant_id = p_tenant
       and t.bank_account_id = p_bank_account_id
       and coalesce(t.credit, 0) > 0
       and round(t.credit * 100)::bigint = p_received_paise
       and t.txn_date between p_received_on - 3 and p_received_on + 3
       and (t.matched_to_type is not null
            or exists (select 1 from public.payments p where p.tenant_id = p_tenant and p.bank_txn_id = t.id))
       and ((char_length(v_ref) >= 6 and strpos(upper(coalesce(t.reference, '') || ' ' || coalesce(t.description, '')), v_ref) > 0)
            or t.txn_date = p_received_on)
     order by t.txn_date, t.id
     limit 1;
    if found then
      return jsonb_build_object('txn_id', null, 'taken_txn', v_taken.id, 'taken_as', v_taken.matched_to_type, 'taken_on', v_taken.txn_date);
    end if;
  end if;
  return jsonb_build_object('txn_id', null, 'candidates', cardinality(v_all));
end;
$function$;
revoke all on function public._zoho_fy_receipt_bank_line(uuid, uuid, bigint, date, text) from public, anon, authenticated;

-- ── 6. Import (and dry run) ────────────────────────────────────────────────────────────────────
create or replace function public.import_zoho_fy_receipts(p_fy text, p_picks jsonb, p_dry_run boolean default true)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $function$
declare
  /* R-2501 */
  v_tenant   uuid := public.current_tenant_id();
  v_start    date;
  v_lock     date;
  v_fy_from  date;
  v_fy_to    date;
  v_batch    uuid;
  v_pick     jsonb;
  v_scan     public.zoho_fy_scan;
  v_p        jsonb;
  v_zid      text;
  v_num      text;
  v_date     date;
  v_acct     uuid;
  v_paise    bigint;
  v_excess   integer;
  v_ref      text;
  v_method   text;
  v_line     jsonb;
  v_inv      record;
  v_cust     uuid;
  v_settle   integer;
  v_tds      integer;
  v_cash     integer;
  v_due      integer;
  v_alloc    jsonb;
  v_sum_cash integer;
  v_sum_tds  integer;
  v_r        jsonb;
  v_adv      jsonb;
  v_pays     uuid[];
  v_bank     jsonb;
  v_txn      uuid;
  v_done_row public.zoho_fy_receipts;
  v_reason   text;
  v_seen     text[] := array[]::text[];
  v_used     uuid[] := array[]::uuid[];
  v_done     jsonb := '[]'::jsonb;
  v_skipped  jsonb := '[]'::jsonb;
  v_already  integer := 0;
  v_banked   integer := 0;
  v_later    integer := 0;
  v_n        integer := 0;
  v_tot_cash bigint := 0;
  v_tot_tds  bigint := 0;
  v_tot_adv  bigint := 0;
begin
  if v_tenant is null then
    raise exception 'Importing receipts needs an active user who has finished sign-in (including the authenticator code). Sign in again and retry.'
      using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or an accountant can import FY receipts from Zoho. Ask one of them.'
      using errcode = '42501';
  end if;
  if p_fy is null or p_fy !~ '^\d{4}-\d{2}$'
     or right(p_fy, 2)::int <> (left(p_fy, 4)::int + 1) % 100 then
    raise exception 'Choose a financial year like 2025-26.' using errcode = '22023';
  end if;
  if p_picks is null or jsonb_typeof(p_picks) <> 'array' or jsonb_array_length(p_picks) = 0 then
    raise exception 'There are no payments to import. Read from Zoho again and preview first.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_picks) > 500 then
    raise exception 'Too many payments in one part (% — at most 500).', jsonb_array_length(p_picks) using errcode = '22023';
  end if;

  v_fy_from := make_date(left(p_fy, 4)::int, 4, 1);
  v_fy_to   := make_date(left(p_fy, 4)::int + 1, 3, 31);
  v_start   := public.books_start_for(v_tenant);
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;

  /* One block: a dry run raises R2501 at the end, so every receipt, TDS row, advance, bank match,
     the batch row and the log roll back — the preview ran the real thing. */
  begin
  insert into public.zoho_fy_import_batches (tenant_id, kind, fy, created_by)
  values (v_tenant, 'customerpayments', p_fy, auth.uid())
  returning id into v_batch;

  for v_pick in select value from jsonb_array_elements(p_picks) loop
    v_zid := btrim(coalesce(v_pick->>'zoho_payment_id', ''));
    v_reason := null;
    v_num := v_zid;
    v_scan := null;

    if v_zid = '' or v_zid = any (v_seen) then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', 'Listed twice or with no Zoho id.');
      continue;
    end if;
    v_seen := v_seen || v_zid;

    /* Already booked (a rerun) — first, so a later lock or Zoho change never calls it "refused".
       Review: bank_txn_id follows the books — the line its receipts are on NOW (matched by hand, or
       un-reconciled since) — and a receipt on no line is matched if its line has come in since. */
    select * into v_done_row from public.zoho_fy_receipts r where r.tenant_id = v_tenant and r.zoho_payment_id = v_zid for update;
    if found then
      v_already := v_already + 1;
      select coalesce(
               (select p.bank_txn_id from public.payments p
                 where p.tenant_id = v_tenant and p.id = any (v_done_row.payment_ids) and p.bank_txn_id is not null limit 1),
               (select t.id from public.bank_transactions t
                 where t.tenant_id = v_tenant and t.matched_to_type = 'payment'
                   and t.matched_to_id = any (v_done_row.payment_ids::text[]) limit 1))
        into v_txn;
      if v_txn is distinct from v_done_row.bank_txn_id then
        update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = case when v_txn is not null then now() end
         where tenant_id = v_tenant and zoho_payment_id = v_zid;
      end if;
      if v_txn is null then
        v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_done_row.bank_account_id, v_done_row.received_paise,
                                                    v_done_row.received_on, v_done_row.reference);
        v_txn := nullif(v_bank->>'txn_id', '')::uuid;
        if v_txn is not null and not (v_txn = any (v_used)) then
          begin
            perform 1 from public.bank_transactions t where t.id = v_txn and t.tenant_id = v_tenant and t.matched_to_type is null for update;
            if found and not exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.bank_txn_id = v_txn) then
              perform public.reconcile_bank_txn(v_txn, 'payment', v_done_row.payment_ids[1]::text, v_bank->>'confidence');
              if cardinality(v_done_row.payment_ids) > 1 then
                update public.payments set bank_txn_id = v_txn where tenant_id = v_tenant and id = any (v_done_row.payment_ids);
              end if;
              update public.zoho_fy_receipts set bank_txn_id = v_txn, banked_at = now()
               where tenant_id = v_tenant and zoho_payment_id = v_zid;
              v_used := v_used || v_txn;
              v_banked := v_banked + 1;
              v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_done_row.reference,
                                                     'bank_txn_id', v_txn, 'matched_later', true);
            end if;
          exception when others then
            v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_zid,
              'reason', 'Booked earlier; its bank line could not be matched: ' || sqlerrm);
          end;
        end if;
      end if;
      continue;
    end if;

    select * into v_scan from public.zoho_fy_scan s
     where s.tenant_id = v_tenant and s.kind = 'customerpayments' and s.zoho_id = v_zid and s.fy = p_fy;
    if not found or v_scan.payload is null then
      v_reason := 'Not read from Zoho yet — press Read from Zoho, then preview again.';
    else
      v_p   := v_scan.payload;
      v_num := btrim(coalesce(v_p->>'number', v_zid));
      begin
        v_date   := (v_p->>'date')::date;
        v_paise  := (v_p->>'receivedPaise')::bigint;
        v_excess := coalesce((v_p->>'excess')::integer, 0);
        v_acct   := nullif(v_pick->>'bank_account_id', '')::uuid;
      exception when others then
        v_reason := 'Its date, amount or account could not be read — read it from Zoho again.';
      end;
    end if;

    if v_reason is null then
      v_method := coalesce(nullif(v_p->>'method', ''), 'other');
      v_ref := left(coalesce(nullif(btrim(v_p->>'reference'), ''), 'ZOHO-PAY-' || v_num), 100);
      if jsonb_typeof(v_p->'problems') = 'array' and jsonb_array_length(v_p->'problems') > 0 then
        v_reason := v_p->'problems'->>0;
      elsif v_date is null or v_date < v_fy_from or v_date > v_fy_to then
        v_reason := format('Dated %s, outside FY %s.', coalesce(v_date::text, '?'), p_fy);
      elsif v_start is null then
        v_reason := 'The books start date is not set (Accounting → Overview → Books start).';
      elsif v_date < v_start then
        v_reason := format('Dated %s, before the books start (%s).', to_char(v_date, 'DD Mon YYYY'), to_char(v_start, 'DD Mon YYYY'));
      elsif v_lock is not null and v_date <= v_lock then
        v_reason := format('Dated %s, inside the books lock (till %s). Unlock the books first.', to_char(v_date, 'DD Mon YYYY'), to_char(v_lock, 'DD Mon YYYY'));
      elsif v_paise is null or v_paise <= 0 or v_excess < 0 then
        v_reason := 'Zoho shows no money received on this payment.';
      elsif v_method not in ('upi', 'razorpay', 'bank_transfer', 'cheque', 'cash', 'other') then
        v_reason := 'Its payment mode could not be read — read it from Zoho again.';
      elsif jsonb_typeof(v_p->'lines') <> 'array' or jsonb_array_length(v_p->'lines') = 0 then
        v_reason := 'Not applied to any invoice in Zoho (an advance) — record it by hand on the right customer.';
      elsif v_acct is null or not exists (select 1 from public.bank_accounts b where b.id = v_acct and b.tenant_id = v_tenant) then
        v_reason := format('Choose the app account for Zoho''s "%s".', coalesce(nullif(v_p->>'depositAccountName', ''), 'no account'));
      end if;
    end if;

    /* Each line: an FY sale imported from Zoho, of one customer, with the money due. */
    v_alloc := '[]'::jsonb;
    v_cust := null;
    v_sum_cash := 0;
    v_sum_tds := 0;
    if v_reason is null then
      for v_line in select value from jsonb_array_elements(v_p->'lines') loop
        select i.id, i.customer_id, i.status, i.amount, i.net_payable, i.paid_amount, i.document_kind into v_inv
          from public.invoices i
         where i.tenant_id = v_tenant and i.zoho_invoice_id = v_line->>'zohoInvoiceId';
        if not found then
          if exists (select 1 from public.invoices i where i.tenant_id = v_tenant and i.document_kind = 'opening_invoice'
                      and upper(i.external_number) = upper(btrim(coalesce(v_line->>'invoiceNumber', '')))) then
            v_reason := format('%s is an opening invoice here — its balance already leaves this receipt out (re-stated by R-2504 first).', v_line->>'invoiceNumber');
          else
            v_reason := format('%s is not an FY sale imported from Zoho here — import FY sales first (Invoices → FY 2025-26 sales from Zoho).', coalesce(v_line->>'invoiceNumber', '?'));
          end if;
          exit;
        end if;
        if v_cust is not null and v_inv.customer_id is distinct from v_cust then
          v_reason := 'Its invoices belong to different customers here.';
          exit;
        end if;
        v_cust := v_inv.customer_id;
        if v_inv.status::text = 'void' then
          v_reason := format('%s is void here.', v_inv.id);
          exit;
        end if;
        begin
          v_settle := (v_line->>'settle')::integer;
          v_tds    := coalesce((v_line->>'tds')::integer, 0);
        exception when others then
          v_reason := 'Its amounts could not be read — read it from Zoho again.';
          exit;
        end;
        v_due := case when v_inv.status::text = 'paid' then 0
                      else greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - coalesce(v_inv.paid_amount, 0)) end;
        /* ₹1 over is the two roundings (invoice total, this payment): capped at the due; that rupee is
           money received too, so it joins the advance — the receipts still equal what came in. */
        if v_settle > v_due and v_settle - v_due <= 1 and v_due > 0 then
          v_excess := v_excess + (v_settle - v_due);
          v_settle := v_due;
        end if;
        if v_settle is null or v_settle <= 0 or v_tds < 0 or v_tds > v_settle then
          v_reason := format('%s: Zoho''s amounts on it could not be booked (settles ₹%s, TDS ₹%s, due ₹%s).', v_inv.id, coalesce(v_settle, 0), v_tds, v_due);
          exit;
        end if;
        if v_settle > v_due then
          v_reason := format('%s has only ₹%s due here, but Zoho settles ₹%s with this payment.', v_inv.id, v_due, v_settle);
          exit;
        end if;
        v_cash := v_settle - v_tds;
        v_sum_cash := v_sum_cash + v_cash;
        v_sum_tds := v_sum_tds + v_tds;
        v_alloc := v_alloc || jsonb_build_object('invoice_id', v_inv.id, 'amount', v_cash, 'tds_amount', v_tds);
      end loop;
      if v_reason is null and v_sum_cash <= 0 then
        v_reason := 'Zoho booked only TDS on this payment, no money — record it by hand.';
      end if;
    end if;

    /* Its bank line, looked up BEFORE booking: already reconciled to something else → the money is in
       the books already (an advance / sale on the Reconcile sheet) — refused, never a second receipt. */
    if v_reason is null then
      v_bank := public._zoho_fy_receipt_bank_line(v_tenant, v_acct, v_paise, v_date, v_p->>'reference');
      if nullif(v_bank->>'taken_txn', '') is not null then
        v_reason := format('Its bank line (%s, ₹%s) is already reconciled as %s — check that line before importing this payment.',
                           to_char((v_bank->>'taken_on')::date, 'DD Mon YYYY'), round(v_paise / 100.0, 2), replace(v_bank->>'taken_as', '_', ' '));
      end if;
    end if;

    if v_reason is not null then
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', v_reason);
      continue;
    end if;

    /* Book it — its own sub-transaction: any refusal undoes only this payment. */
    begin
      v_r := public.record_multi_invoice_payment(
        v_cust, v_date, v_method, v_acct, v_ref, v_sum_cash, v_alloc, false,
        'FY ' || p_fy || ' receipt from Zoho (payment ' || v_num || ')');
      if coalesce((v_r->>'idempotent_replay')::boolean, false) then
        raise exception 'Reference % is already recorded on these invoices — booked by hand already?', v_ref;
      end if;
      select coalesce(array_agg((l->>'payment_id')::uuid), '{}') into v_pays
        from jsonb_array_elements(v_r->'lines') l where nullif(l->>'payment_id', '') is not null;

      v_adv := null;
      if v_excess > 0 then
        perform set_config('app.payment_ref_batch', coalesce(public.payment_ref_key(v_method, v_ref), ''), true);
        v_adv := public._zoho_fy_receipt_advance(v_tenant, v_cust, v_excess, v_date, v_method, v_ref, v_acct, v_num);
        perform set_config('app.payment_ref_batch', '', true);
        v_pays := v_pays || (v_adv->>'payment_id')::uuid;
      end if;

      v_txn := null;
      if nullif(v_bank->>'txn_id', '') is not null and not ((v_bank->>'txn_id')::uuid = any (v_used)) then
        v_txn := (v_bank->>'txn_id')::uuid;
        /* Review: locked, then checked again — matched meanwhile (by hand / auto) → left for a later run,
           never moved off the other receipt. */
        perform 1 from public.bank_transactions t
         where t.id = v_txn and t.tenant_id = v_tenant and t.matched_to_type is null for update;
        if not found or exists (select 1 from public.payments p where p.tenant_id = v_tenant and p.bank_txn_id = v_txn) then
          v_txn := null;
        else
          perform public.reconcile_bank_txn(v_txn, 'payment', v_pays[1]::text, v_bank->>'confidence');
          if cardinality(v_pays) > 1 then
            update public.payments set bank_txn_id = v_txn where tenant_id = v_tenant and id = any (v_pays);
          end if;
          v_used := v_used || v_txn;
        end if;
      end if;

      insert into public.zoho_fy_receipts (tenant_id, zoho_payment_id, fy, batch_id, customer_id, received_on, bank_account_id,
                                           received_paise, cash, tds, advance, reference, payment_ids, bank_txn_id, banked_at)
      values (v_tenant, v_zid, p_fy, v_batch, v_cust, v_date, v_acct, v_paise, v_sum_cash + v_excess, v_sum_tds, v_excess,
              v_ref, v_pays, v_txn, case when v_txn is not null then now() end);
    exception when others then
      perform set_config('app.payment_ref_batch', '', true);
      v_skipped := v_skipped || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'reason', sqlerrm);
      continue;
    end;

    v_n := v_n + 1;
    if v_txn is not null then v_banked := v_banked + 1; else v_later := v_later + 1; end if;
    v_tot_cash := v_tot_cash + v_sum_cash + v_excess;
    v_tot_tds := v_tot_tds + v_sum_tds;
    v_tot_adv := v_tot_adv + v_excess;
    v_done := v_done || jsonb_build_object('zoho_payment_id', v_zid, 'number', v_num, 'date', v_date, 'customer_id', v_cust,
      'cash', v_sum_cash + v_excess, 'tds', v_sum_tds, 'advance', v_excess, 'payment_ids', to_jsonb(v_pays), 'bank_txn_id', v_txn);
  end loop;

  /* Batch totals: amount = money received, tax = TDS booked, taxable = the part kept as advance. */
  update public.zoho_fy_import_batches
     set imported_count = v_n, skipped_count = jsonb_array_length(v_skipped), already_count = v_already,
         taxable_total = v_tot_adv, tax_total = v_tot_tds, amount_total = v_tot_cash, skipped = v_skipped
   where id = v_batch;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes)
  values (v_tenant, auth.uid(), 'zoho_fy_receipts.imported', 'zoho_fy_import_batch', v_batch::text,
          left(format('Imported %s FY %s receipts from Zoho (₹%s, TDS ₹%s, %s on bank lines); %s skipped', v_n, p_fy, v_tot_cash, v_tot_tds, v_banked, jsonb_array_length(v_skipped)), 120),
          jsonb_build_object('batch_id', v_batch, 'fy', p_fy, 'imported', v_n, 'already', v_already, 'banked', v_banked,
                             'bank_later', v_later, 'skipped', jsonb_array_length(v_skipped),
                             'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv));

  if coalesce(p_dry_run, true) then
    raise exception using errcode = 'R2501', message = 'dry run — rolled back';
  end if;
  exception when sqlstate 'R2501' then
    v_batch := null;   -- dry run: nothing written
  end;

  return jsonb_build_object('dry_run', v_batch is null, 'batch_id', v_batch, 'fy', p_fy,
    'imported', v_n, 'already', v_already, 'banked', v_banked, 'bank_later', v_later,
    'skipped', v_skipped, 'done', v_done,
    'received', v_tot_cash, 'tds', v_tot_tds, 'advance', v_tot_adv);
end;
$function$;

comment on function public.import_zoho_fy_receipts(text, jsonb, boolean) is
  'R-2501: FY customer payments from Zoho as receipts (+ Zoho''s TDS, excess → advance) on the FY sales imported from Zoho, matched to the bank line when it is in (else on a later run). Money from zoho_fy_scan; picks = Zoho id + app account. dry_run (default) writes nothing. Owner / accountant.';
revoke all on function public.import_zoho_fy_receipts(text, jsonb, boolean) from public, anon;
grant execute on function public.import_zoho_fy_receipts(text, jsonb, boolean) to authenticated, service_role;

commit;
