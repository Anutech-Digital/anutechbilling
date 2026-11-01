-- deploy-peek: to_regclass('public.bank_customer_refunds') is not null and to_regprocedure('public.reconcile_bank_debit_as_customer_refund(uuid,uuid,text)') is not null and to_regprocedure('public.customer_refundable_items(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.refund_payment(uuid,text)') and prosrc like '%R-2322%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.refund_credit_note_credit(uuid,integer,text)') and prosrc like '%R-2322%')
-- deploy-key: r2322bankcustrefund
-- 20261101013533_r2322_bank_customer_refund.sql
--
-- R-2322 (1 Nov 2026, p1, goal G-RECON): a customer refund on a money-out bank line.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   Staging money-out reconcile (R-2319, 31 Oct): a refund paid to a customer from the bank had
--   no "customer refund" choice in Banking → Reconcile, so the line could not be booked the way
--   Zoho booked it (refund against a credit note / an unused advance).
--
-- ─── WHAT IS REUSED (no new money rule) ──────────────────────────────────────────────────────
--   The app already refunds a customer in two ways (Payments → Refund):
--     · refund_credit_note_credit (R-1682) — part or all of the open CREDIT-NOTE credit on an
--       invoice (CGST s.34: the note carries the GST; the refund only pays the credit out);
--     · refund_payment (R-1563/R-1567/R-1747) — the whole payment; for an unused ADVANCE (a
--       payment whose whole amount is still the customer's open credit — R-1863 bank advances,
--       record_payment overpayments on an un-invoiced quote) that is the advance paid back.
--   Both book a numbered Refund Voucher (RFV), close the customer credit they pay out and
--   recompute invoice / quote / subscription — every report already reads that (customer
--   ledger: Refund on refunded_at; balance sheet: advances fall).
--   Both refused a payment whose RECEIPT is reconciled to a bank line ("un-reconcile first"):
--   right for a refund with no bank line, but here the refund has its own money-out line. They
--   now skip that one check only when app.bank_refund_payment (transaction-local) names the
--   payment — set only by the RPC below, inside its own transaction. Nothing else in either
--   function changes (bodies are the latest: 20261022044013_r1747 / 20261019132853_r1682).
--
-- ─── THE NEW PATH ────────────────────────────────────────────────────────────────────────────
--   customer_refundable_items(customer) — what can be refunded: per invoice with open credit-
--   note credit, its largest payment (up to min(cash, open credit)); each unused advance payment
--   (whole amount only, as refund_payment does).
--   reconcile_bank_debit_as_customer_refund(line, payment, reason) — one transaction (§17b):
--   tenant fail-closed, owner / manager / accountant (refund roles), line unmatched + money out,
--   amount = the bank debit to the rupee (≤ the refundable credit; an advance only whole), then
--   the existing refund, refunded_at = the BANK date, and the line matched ONCE
--   (matched_to_type 'customer_refund' → bank_customer_refunds row).
--   Undo = the existing un-reconcile (reconcile_bank_txn → null): a trigger takes the refund
--   back exactly — the rows the refund changed are restored from the snapshot taken when it
--   was booked, rows it added (split payment, split credit) are removed, and the RFV number is
--   kept in cancelled_vouchers (doc_type refund_voucher; the series is never reused, as R-1568
--   does for receipt vouchers). Refused (nothing changes) when any of those rows changed after
--   the refund (e.g. the credit was used again); a fail-closed check after the restore too.
--   GST: nothing added or reversed here — a credit-note refund's GST is on the note, an
--   advance refund is what refund_payment already books.
--
-- Test: supabase/tests/r2322_bank_customer_refund.test.sql (one rolled-back transaction).

begin;

-- ── 1. The link: one money-out line ↔ one refund ────────────────────────────────────────────
create table if not exists public.bank_customer_refunds (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references public.tenants(id) on delete cascade,
  bank_txn_id         uuid        not null unique references public.bank_transactions(id),
  customer_id         uuid        not null,
  kind                text        not null check (kind in ('credit_note', 'advance')),
  amount              integer     not null check (amount > 0),
  source_payment_id   uuid        not null,             -- the payment picked on the screen
  refunded_payment_id uuid        not null,             -- the row marked refunded (split part, or the payment)
  quote_id            text,
  invoice_id          text,
  refund_voucher_no   text,
  reason              text        not null,
  scope_before        jsonb       not null,             -- rows the refund changed, as they were
  scope_after         jsonb       not null,             -- the same rows + rows it added, right after
  scope_inserted      jsonb       not null,             -- {table: [ids]} the refund added
  created_by          uuid,
  created_at          timestamptz not null default now()
);
comment on table public.bank_customer_refunds is
  'R-2322: a customer refund booked from its money-out bank line (refund_credit_note_credit / refund_payment). Un-reconciling the line takes the refund back from the snapshot. Written only by reconcile_bank_debit_as_customer_refund.';
create index if not exists bank_customer_refunds_tenant_idx on public.bank_customer_refunds (tenant_id, customer_id);

alter table public.bank_customer_refunds enable row level security;
drop policy if exists "tenant isolation read" on public.bank_customer_refunds;
drop policy if exists zzz_service_role_all on public.bank_customer_refunds;
create policy "tenant isolation read" on public.bank_customer_refunds for select to authenticated
  using (tenant_id = (select public.current_tenant_id())
         and (select public.current_user_has_role('owner', 'manager', 'accountant')));
create policy zzz_service_role_all on public.bank_customer_refunds as permissive for all to service_role
  using (true) with check (true);
revoke all on table public.bank_customer_refunds from public, anon, authenticated;
grant select on table public.bank_customer_refunds to authenticated;
grant all on table public.bank_customer_refunds to service_role;

-- matched_to_type gains 'customer_refund' (R-1864 / R-2095 pattern: read the live list, add one).
do $$
declare v_def text; v_vals text[];
begin
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.bank_transactions'::regclass and c.conname = 'bank_transactions_matched_to_type_check';
  if v_def is null then raise exception 'bank_transactions_matched_to_type_check is missing'; end if;
  if v_def ~ '\{[a-z_,]+\}' then
    v_vals := string_to_array(substring(v_def from '\{([a-z_,]+)\}'), ',');
  else
    select array_agg(m[1] order by ord) into v_vals
      from regexp_matches(v_def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
  end if;
  if v_vals is null or cardinality(v_vals) = 0 then raise exception 'Could not read bank_transactions_matched_to_type_check: %', v_def; end if;
  if 'customer_refund' = any (v_vals) then return; end if;
  v_vals := array_append(v_vals, 'customer_refund'::text);
  execute 'alter table public.bank_transactions drop constraint bank_transactions_matched_to_type_check';
  execute format('alter table public.bank_transactions add constraint bank_transactions_matched_to_type_check check (matched_to_type = any (%L::text[]))', v_vals);
end $$;

-- A refund voucher number taken back stays in the series as cancelled (R-1568's table).
alter table public.cancelled_vouchers drop constraint if exists cancelled_vouchers_doc_type_check;
alter table public.cancelled_vouchers add constraint cancelled_vouchers_doc_type_check
  check (doc_type in ('receipt_voucher', 'refund_voucher'));

-- ── 2. The rows a refund can touch, as jsonb {table: {id: row}} (UTC, updated_at left out) ───
create or replace function public.r2322_refund_scope(p_tenant uuid, p_pay uuid, p_quote text, p_inv text, p_cust uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
set timezone = 'UTC'
as $$
  select jsonb_build_object(
    'payments', coalesce((select jsonb_object_agg(p.id::text, to_jsonb(p) - 'updated_at') from public.payments p
                           where p.tenant_id = p_tenant and (p.id = p_pay or (p_quote is not null and p.quote_id = p_quote))), '{}'::jsonb),
    'credits',  coalesce((select jsonb_object_agg(c.id::text, to_jsonb(c) - 'updated_at') from public.customer_credits c
                           where c.tenant_id = p_tenant
                             and (c.customer_id = p_cust or c.source_payment_id = p_pay or c.applied_payment_id = p_pay
                                  or (p_inv is not null and c.source_invoice_id = p_inv))), '{}'::jsonb),
    'tds',      coalesce((select jsonb_object_agg(t.id::text, to_jsonb(t) - 'updated_at') from public.tds_receivable t
                           where t.tenant_id = p_tenant and t.payment_id = p_pay), '{}'::jsonb),
    'invoices', coalesce((select jsonb_object_agg(i.id::text, to_jsonb(i) - 'updated_at') from public.invoices i
                           where i.tenant_id = p_tenant and p_inv is not null and i.id = p_inv), '{}'::jsonb),
    'quotes',   coalesce((select jsonb_object_agg(q.id::text, to_jsonb(q) - 'updated_at') from public.quotes q
                           where q.tenant_id = p_tenant and p_quote is not null and q.id = p_quote), '{}'::jsonb),
    'subs',     coalesce((select jsonb_object_agg(s.id::text, to_jsonb(s) - 'updated_at') from public.subscriptions s
                           where s.tenant_id = p_tenant and p_quote is not null and s.quote_id = p_quote), '{}'::jsonb));
$$;
revoke all on function public.r2322_refund_scope(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.r2322_refund_scope(uuid, uuid, text, text, uuid) to service_role;

-- ── 3. The two existing refunds: skip the "receipt is reconciled" check for this one call ────
CREATE OR REPLACE FUNCTION public.refund_payment(p_payment_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant     uuid := public.current_tenant_id();
  v_pay        record;
  v_quote      record;
  v_remaining  integer;
  v_expected   integer;
  v_new_status public.payment_status;
  v_rfv        text;
  v_bank_cnt   integer;
  v_credits    integer := 0;
  v_spent      integer := 0;
  v_spent_on   text;
  v_customer   uuid;
  v_restored   integer := 0;
  v_gap        integer := 0;
  v_row        record;
  v_tds        integer := 0;
  v_inv        record;
  v_inv_id     text;
  v_cash       integer := 0;
  v_own_open   integer := 0;
  v_need       integer := 0;
  v_cn_open    integer := 0;
  v_take       integer := 0;
  v_cn_closed  integer := 0;
  v_was_adv    boolean := false;
  v_adv        integer := 0;
  v_debits     integer := 0;
  v_credits_cn integer := 0;
  v_due        integer := 0;
  v_settled    integer := 0;
  v_open       record;              -- R-1747: the imported Zoho invoice of a quote-less payment
  v_open_after record;
begin
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_pay from public.payments where id = p_payment_id;
  if not found then raise exception 'Payment not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_pay.tenant_id is distinct from v_tenant) then
    raise exception 'Payment not in your tenant' using errcode = 'insufficient_privilege';
  end if;

  /* R-042: owner / manager / accountant only (see 20260930176000). A session with no JWT
     (psql, a migration, the SQL tests) is left alone, as the tenant check above does. */
  if coalesce(auth.role(), '') in ('anon', 'authenticated')
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception
      'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series and reopens the balance on that customer, so it is not a staff-level action. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = 'insufficient_privilege';
  end if;
  if v_pay.status = 'refunded' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = 'invalid_parameter_value';
  end if;

  select id, tenant_id, amount, invoice_id, is_add_seats, customer_id, customer_name
    into v_quote from public.quotes where id = v_pay.quote_id;

  /* ── R-1747: a payment on an invoice imported from Zoho Books (R-1739) ──────────────
     No quote; payments.invoice_id names the imported invoice. It cannot take a credit note
     here (its GST was filed in Zoho Books), so the refund is a plain one: the invoice's
     balance opens again by this payment (checked after the update below, fail-closed). */
  if v_pay.quote_id is null then
    select i.id, i.status, i.document_kind, i.paid_amount, i.amount, i.net_payable,
           coalesce(nullif(btrim(i.external_number), ''), i.id) as number
      into v_open
      from public.invoices i
     where i.id = v_pay.invoice_id and i.tenant_id = v_pay.tenant_id
     for update;
    if v_pay.invoice_id is null or not found or v_open.document_kind is distinct from 'opening_invoice' then
      raise exception 'This payment is not on a quote or on an invoice imported from Zoho Books in your company, so it cannot be refunded here. Refresh Payments; if it still shows, tell support.'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_open.status::text = 'void' then
      raise exception 'Invoice % is void, so refunding this payment would not reopen any balance. Refund refused.', v_open.number
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1563: a payment on an invoiced quote ─────────────────────────────────────────
     The invoice is a GST tax invoice: cash goes back only against a CREDIT NOTE (CGST s.34),
     never straight. issue_credit_note (R-1566) turns the part of a note that goes past what
     was still owed into open customer credit (source_invoice_id = this invoice). The refund
     is allowed when that open credit — plus this payment's own open overpayment credit,
     closed below as before — covers the cash going back; those rows are paid out. */
  if v_quote.invoice_id is not null then
    select i.id, i.amount, i.status, i.paid_amount, i.net_payable, i.adjusted_advances
      into v_inv
      from public.invoices i where i.id = v_quote.invoice_id and i.tenant_id = v_pay.tenant_id for update;
    if not found then
      raise exception 'Quote % points at invoice %, which is not in your company — refund refused.', v_pay.quote_id, v_quote.invoice_id
        using errcode = 'invalid_parameter_value';
    end if;
    v_inv_id := v_inv.id;
    v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);
    select coalesce(sum(amount), 0)::int into v_own_open
      from public.customer_credits
     where tenant_id = v_pay.tenant_id and source_payment_id = v_pay.id and status = 'open';
    v_need := greatest(0, v_cash - v_own_open);
    select coalesce(sum(amount), 0)::int into v_cn_open
      from public.customer_credits
     where tenant_id = v_pay.tenant_id and source_invoice_id = v_inv_id
       and source = 'credit_note' and status = 'open';
    if v_need > v_cn_open then
      raise exception 'Is quote par GST invoice % jaari hai — tax invoice ke against paisa seedha wapas nahi hota, pehle CREDIT NOTE chahiye. Is refund ke liye ₹% credit note se cover hona chahiye; abhi invoice % ke credit note(s) se ₹% credit khula hai. Invoices → % → Issue credit note se ₹% ka credit note banaiye, phir yahin Refund dabaiye.',
        v_inv_id, v_need, v_inv_id, v_cn_open, v_inv_id, v_need - v_cn_open
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  select count(*) into v_bank_cnt from public.bank_transactions
   where tenant_id = v_pay.tenant_id and matched_to_type = 'payment' and matched_to_id = v_pay.id::text;
  /* R-2322: a refund booked FROM its money-out bank line (reconcile_bank_debit_as_customer_refund)
     keeps the receipt's money-in line — the receipt really came in, the refund goes out on its
     own line. Only that RPC sets app.bank_refund_payment, for this one payment, inside its own
     transaction (no client can set it). */
  if v_bank_cnt > 0 and coalesce(current_setting('app.bank_refund_payment', true), '') is distinct from v_pay.id::text then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first, then refund.'
      using errcode = 'invalid_parameter_value';
  end if;

  if coalesce(v_quote.is_add_seats, false) then
    if exists (
      select 1 from public.subscriptions s
       where s.tenant_id = v_pay.tenant_id
         and ( (v_quote.customer_id is not null and s.customer_id = v_quote.customer_id)
            or (v_quote.customer_id is null and s.customer_name = v_quote.customer_name) )
    ) then
      raise exception 'Ye add-seats ki payment hai — pehle subscription par seats ghataiye, phir refund; warna seats mile hue aur paisa wapas dono ho jate.'
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1567: advance credit this payment CREATED that is already spent ─────────────
     A full refund would pay that money out a second time (it already settled another
     quote). Refund / delete the payment that used it first — that gives the credit back. */
  select coalesce(sum(cc.amount), 0)::int,
         string_agg(distinct coalesce(p.quote_id, 'kisi purani payment'), ', ')
    into v_spent, v_spent_on
    from public.customer_credits cc
    left join public.payments p on p.id = cc.applied_payment_id and p.tenant_id = cc.tenant_id
   where cc.tenant_id = v_pay.tenant_id and cc.source_payment_id = v_pay.id and cc.status = 'used';
  if v_spent > 0 then
    raise exception 'Ye refund nahi ho sakta: is payment se bana ₹% advance credit pehle hi quote % ki payment me lag chuka hai — poora refund karne se ye ₹% customer ko do baar milega. Pehle Payments me quote % wali payment ko refund ya delete kariye (credit wapas khul jayega), phir ye refund kariye.',
      v_spent, v_spent_on, v_spent, v_spent_on
      using errcode = 'invalid_parameter_value';
  end if;

  v_rfv := public.next_document_number('refund_voucher', v_pay.tenant_id);

  update public.payments
     set status = 'refunded',
         refunded_at = now(),
         refund_reason = trim(p_reason),
         refund_voucher_no = v_rfv
   where id = p_payment_id;

  /* Isi payment ki tairti overpayment-credit band — paisa wapas ja raha hai,
     credit ke roop me dobara kharch nahi ho sakta. */
  update public.customer_credits
     set status = 'refunded'
   where source_payment_id = p_payment_id and status = 'open' and tenant_id = v_pay.tenant_id;
  get diagnostics v_credits = row_count;

  /* ── R-1567: credit this payment APPLIED goes back to the customer ────────────────
     Only the cash part (amount − credit_applied) is refunded; the credit was never cash
     on this payment. Linked rows re-open; an older payment (before applied_payment_id)
     re-opens that customer's unlinked used rows that fit, then a new row for the rest. */
  if coalesce(v_pay.credit_applied, 0) > 0 then
    with r as (
      update public.customer_credits
         set status = 'open', applied_payment_id = null, used_at = null
       where tenant_id = v_pay.tenant_id and applied_payment_id = v_pay.id and status = 'used'
      returning amount)
    select coalesce(sum(amount), 0)::int into v_restored from r;

    v_gap := v_pay.credit_applied - v_restored;
    if v_gap > 0 then
      v_customer := coalesce(v_pay.customer_id, v_quote.customer_id);
      if v_customer is null then
        raise exception 'Is payment me ₹% advance credit laga tha, par payment par customer nahi hai — credit kise wapas jaye ye tay nahi. Pehle quote % par customer jodiye, phir refund kariye.',
          v_gap, v_pay.quote_id using errcode = 'invalid_parameter_value';
      end if;
      for v_row in
        select id, amount from public.customer_credits
         where tenant_id = v_pay.tenant_id and customer_id = v_customer
           and status = 'used' and applied_payment_id is null and used_at is null
         order by created_at desc
         for update
      loop
        exit when v_gap <= 0;
        if v_row.amount <= v_gap then
          update public.customer_credits set status = 'open' where id = v_row.id;
          v_gap := v_gap - v_row.amount;
          v_restored := v_restored + v_row.amount;
        end if;
      end loop;
      if v_gap > 0 then
        insert into public.customer_credits (tenant_id, customer_id, amount, source, source_quote_id, note, status)
        values (v_pay.tenant_id, v_customer, v_gap, 'restored', v_pay.quote_id,
                'Credit given back — payment on ' || v_pay.quote_id || ' refunded (' || v_rfv || ')', 'open');
        v_restored := v_restored + v_gap;
      end if;
    end if;
    if v_restored <> v_pay.credit_applied then
      raise exception 'R-1567: gave back ₹% of ₹% credit applied on payment % — nothing was refunded.', v_restored, v_pay.credit_applied, v_pay.id;
    end if;
  end if;

  /* ── R-1567: the TDS on a refunded payment is no longer receivable ────────────────
     Rows still on the books are reversed; claimed / written-off rows are already off them. */
  update public.tds_receivable
     set status = 'reversed',
         notes  = concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''), 'Reversed: payment refunded (' || v_rfv || ')')
   where tenant_id = v_pay.tenant_id and payment_id = v_pay.id
     and status in ('pending_cert', 'cert_received', 'verified_26as', 'disputed');
  get diagnostics v_tds = row_count;

  /* ── R-1563: the credit-note credit this refund pays out is closed ─────────────────
     (oldest first; a row used only in part is split — the paid-out part kept as a
     'refunded' row with the same note / invoice, so the credit stays traceable). */
  if v_inv_id is not null and v_need > 0 then
    v_take := v_need;
    for v_row in
      select id, amount, customer_id, source_quote_id, source_credit_note_id
        from public.customer_credits
       where tenant_id = v_pay.tenant_id and source_invoice_id = v_inv_id
         and source = 'credit_note' and status = 'open'
       order by created_at asc, id
       for update
    loop
      exit when v_take <= 0;
      if v_row.amount <= v_take then
        update public.customer_credits set status = 'refunded' where id = v_row.id;
        v_take := v_take - v_row.amount;
        v_cn_closed := v_cn_closed + v_row.amount;
      else
        update public.customer_credits set amount = amount - v_take where id = v_row.id;
        insert into public.customer_credits
          (tenant_id, customer_id, amount, source, source_quote_id, source_credit_note_id, source_invoice_id, note, status)
        values
          (v_pay.tenant_id, v_row.customer_id, v_take, 'credit_note', v_row.source_quote_id, v_row.source_credit_note_id, v_inv_id,
           'Paid out as cash — refund ' || v_rfv || ' of the payment on ' || v_pay.quote_id, 'refunded');
        v_cn_closed := v_cn_closed + v_take;
        v_take := 0;
      end if;
    end loop;
    if v_cn_closed <> v_need then
      raise exception 'R-1563: closed ₹% of ₹% credit-note credit on invoice % — nothing was refunded.', v_cn_closed, v_need, v_inv_id;
    end if;
  end if;

  /* ── R-1563: the invoice's settlement after the refund ─────────────────────────────
     paid_amount (money after the invoice) drops by this payment unless it was an advance the
     invoice adjusted (that one drops out because the payment is now refunded). The invoice
     must still be covered — fail closed otherwise (credit notes keep `due` ≤ `settled`). */
  if v_inv_id is not null then
    v_was_adv := exists (
      select 1 from jsonb_array_elements(case when jsonb_typeof(v_inv.adjusted_advances) = 'array'
                                              then v_inv.adjusted_advances else '[]'::jsonb end) adv
       where adv->>'payment_id' = v_pay.id::text);
    if not v_was_adv then
      update public.invoices
         set paid_amount = greatest(0, coalesce(paid_amount, 0) - v_pay.amount), updated_at = now()
       where id = v_inv_id;
    end if;

    select coalesce(sum((adv->>'amount')::int), 0)::int into v_adv
      from public.invoices i,
           jsonb_array_elements(case when jsonb_typeof(i.adjusted_advances) = 'array'
                                     then i.adjusted_advances else '[]'::jsonb end) adv
     where i.id = v_inv_id
       and not exists (select 1 from public.payments p
                        where p.id::text = adv->>'payment_id' and p.status = 'refunded');
    select coalesce(sum(amount), 0)::int into v_debits from public.debit_notes where invoice_id = v_inv_id;
    select coalesce(sum(amount), 0)::int into v_credits_cn from public.credit_notes where invoice_id = v_inv_id;
    v_due := greatest(0, coalesce(v_inv.amount, 0) + v_debits - v_credits_cn);
    select coalesce(paid_amount, 0) + v_adv into v_settled from public.invoices where id = v_inv_id;
    if v_inv.status = 'paid' and v_was_adv is false and coalesce(v_inv.paid_amount, 0) < v_pay.amount then
      /* An older invoice marked paid without paid_amount: its settlement is not on the row;
         the credit-note cover above is what keeps it whole. */
      v_settled := greatest(v_settled, v_due);
    end if;
    if v_settled < v_due then
      raise exception 'Ye refund invoice % ko ₹% baaki chhod deta — pehle us invoice par itne ka credit note banaiye, phir refund.', v_inv_id, v_due - v_settled
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  /* ── R-1747: the imported invoice reopened by exactly this payment — else refuse ─── */
  if v_pay.quote_id is null then
    select i.paid_amount, i.amount, i.net_payable, i.status into v_open_after
      from public.invoices i where i.id = v_open.id;
    if coalesce(v_open_after.paid_amount, 0) <> coalesce(v_open.paid_amount, 0) - v_pay.amount then
      raise exception 'R-1747: invoice % paid amount went from ₹% to ₹% on refunding ₹% — nothing was refunded.',
        v_open.number, coalesce(v_open.paid_amount, 0), coalesce(v_open_after.paid_amount, 0), v_pay.amount;
    end if;
    return jsonb_build_object(
      'refund_voucher_no', v_rfv,
      'payment_id', p_payment_id,
      'amount', v_pay.amount - coalesce(v_pay.credit_applied, 0),
      'settled_amount', v_pay.amount,
      'credit_restored', v_restored,
      'tds_reversed', v_tds,
      'quote_id', null,
      'new_payment_status', null,
      'credits_closed', v_credits,
      'invoice_id', v_open.id,
      'invoice_number', v_open.number,
      'opening_invoice', true,
      'invoice_due_after', greatest(0, coalesce(v_open_after.net_payable, v_open_after.amount) - coalesce(v_open_after.paid_amount, 0)),
      'credit_note_credit_paid_out', 0,
      'gateway_refunded', false
    );
  end if;

  select coalesce(sum(amount), 0) into v_remaining
    from public.payments where quote_id = v_pay.quote_id and status = 'received';
  v_expected := coalesce(v_quote.amount, 0);
  v_new_status := case
    when v_inv_id is not null       then 'invoiced'   -- R-1563: the invoice stands; the note settled it
    when v_remaining <= 0          then 'none'
    when v_remaining >= v_expected then 'received'
    else                                'partial' end::public.payment_status;

  update public.quotes
     set payment_status = v_new_status,
         payment_amount = v_remaining
   where id = v_pay.quote_id;

  update public.subscriptions
     set outstanding_amount = case when v_inv_id is not null
                                   then greatest(0, v_due - v_settled)       -- R-1563: what the invoice still owes
                                   else greatest(0, v_expected - v_remaining) end
   where tenant_id = v_pay.tenant_id and quote_id = v_pay.quote_id;

  return jsonb_build_object(
    'refund_voucher_no', v_rfv,
    'payment_id', p_payment_id,
    'amount', v_pay.amount - coalesce(v_pay.credit_applied, 0),
    'settled_amount', v_pay.amount,
    'credit_restored', v_restored,
    'tds_reversed', v_tds,
    'quote_id', v_pay.quote_id,
    'new_payment_status', v_new_status,
    'credits_closed', v_credits,
    'invoice_id', v_inv_id,
    'credit_note_credit_paid_out', v_cn_closed,
    'gateway_refunded', false
  );
end $function$;

create or replace function public.refund_credit_note_credit(
  p_payment_id uuid,
  p_amount     integer,
  p_reason     text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-1682: refund part of a payment, up to the open credit-note credit on its invoice. */
declare
  v_tenant   uuid := public.current_tenant_id();
  v_trusted  boolean;
  v_pay      record;
  v_inv_id   text;
  v_cash     integer;
  v_cn_open  integer;
  v_max      integer;
  v_new_id   uuid;
  v_r        jsonb;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null and not v_trusted then
    raise exception 'No company context — sign in again, then refund.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series. Ask one of them to record it (Payments → the payment → Refund).'
      using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Refund ki wajah likhiye (kam se kam 5 akshar) — ye voucher par darj hoti hai.'
      using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Enter the amount to refund (more than ₹0).' using errcode = '22023';
  end if;

  select p.* into v_pay from public.payments p where p.id = p_payment_id for update;
  if not found or (v_tenant is not null and v_pay.tenant_id <> v_tenant) then
    raise exception 'That payment was not found in your company. Refresh Payments and try again.'
      using errcode = '42501';
  end if;
  if v_pay.status <> 'received' then
    raise exception 'Ye payment pehle hi refund ho chuki hai (voucher %).', coalesce(v_pay.refund_voucher_no, '—')
      using errcode = '22023';
  end if;

  select q.invoice_id into v_inv_id
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_pay.tenant_id;
  if v_inv_id is null then
    raise exception 'This payment''s quote has no GST invoice, so there is no credit note to refund from. Use Refund for the whole payment instead.'
      using errcode = '22023';
  end if;

  if exists (select 1 from public.bank_transactions t
              where t.tenant_id = v_pay.tenant_id and t.matched_to_type = 'payment'
                and t.matched_to_id = v_pay.id::text)
     /* R-2322: not when booked from the refund's own money-out bank line (see refund_payment). */
     and coalesce(current_setting('app.bank_refund_payment', true), '') is distinct from v_pay.id::text then
    raise exception 'This payment is reconciled to a bank transaction — un-reconcile that bank line first (Banking), then refund.'
      using errcode = '22023';
  end if;

  v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);
  select coalesce(sum(cc.amount), 0)::int into v_cn_open
    from public.customer_credits cc
   where cc.tenant_id = v_pay.tenant_id and cc.source_invoice_id = v_inv_id
     and cc.source = 'credit_note' and cc.status = 'open';
  v_max := least(v_cash, v_cn_open);
  if v_cn_open <= 0 then
    raise exception 'Invoice % has no open credit from a credit note, so there is nothing to refund. Issue a credit note on it first (Invoices → % → Credit note).', v_inv_id, v_inv_id
      using errcode = '22023';
  end if;
  if p_amount > v_max then
    raise exception 'At most ₹% can be refunded here: ₹% credit-note credit is open on invoice %, and this payment brought ₹% in cash. Lower the amount to ₹% or less.',
      v_max, v_cn_open, v_inv_id, v_cash, v_max
      using errcode = '22023';
  end if;

  /* The whole cash part → the ordinary full refund (same checks, nothing split). */
  if p_amount = v_cash then
    v_r := public.refund_payment(v_pay.id, p_reason);
    return v_r || jsonb_build_object('split', false, 'kept_payment_id', null, 'kept_amount', 0);
  end if;

  /* Split: the original keeps the rest; the refunded part becomes its own row. */
  update public.payments
     set amount = amount - p_amount,
         notes  = left(concat_ws(' · ', nullif(trim(coalesce(notes, '')), ''),
                    format('₹%s of the ₹%s received was refunded (R-1682)', p_amount, v_pay.amount)), 1000)
   where id = v_pay.id;

  insert into public.payments (tenant_id, quote_id, customer_id, amount, method, reference, notes,
                               status, received_at, recorded_by, bank_account_id, credit_applied)
  values (v_pay.tenant_id, v_pay.quote_id, v_pay.customer_id, p_amount, v_pay.method,
          left(coalesce(nullif(trim(v_pay.reference), ''), 'payment') || ' · part refund', 200),
          format('Part of the ₹%s payment%s, split off to refund the credit note on %s',
                 v_pay.amount,
                 case when v_pay.receipt_voucher_no is not null then ' ' || v_pay.receipt_voucher_no else '' end,
                 v_inv_id),
          'received', v_pay.received_at, coalesce(auth.uid(), v_pay.recorded_by), v_pay.bank_account_id, 0)
  returning id into v_new_id;

  v_r := public.refund_payment(v_new_id, p_reason);

  return v_r || jsonb_build_object(
    'split', true,
    'kept_payment_id', v_pay.id,
    'kept_amount', v_pay.amount - p_amount,
    'credit_note_credit_left', v_cn_open - p_amount);
end;
$function$;

-- ── 4. What this customer can be refunded ────────────────────────────────────────────────────
create or replace function public.customer_refundable_items(p_customer_id uuid)
returns table (
  payment_id   uuid,
  kind         text,      -- 'credit_note' | 'advance'
  refundable   integer,   -- most this payment can take back (rupees)
  whole_only   boolean,   -- an advance goes back whole (refund_payment)
  invoice_id   text,
  credit_notes text,
  voucher_no   text,
  received_on  date
)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2322: the refundable list for Banking → Reconcile → Customer refund. Same rules as the RPC below. */
declare
  v_tenant  uuid := public.current_tenant_id();
  v_trusted boolean;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant.' using errcode = '42501';
  end if;

  return query
  select * from (
    select distinct on (q.invoice_id)
           p.id, 'credit_note'::text,
           least(p.amount - coalesce(p.credit_applied, 0), cn.open)::integer,
           false, q.invoice_id, cn.ids, p.receipt_voucher_no,
           (p.received_at at time zone 'Asia/Kolkata')::date
      from public.payments p
      join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
      join lateral (
        select sum(cc.amount)::integer as open, string_agg(distinct cc.source_credit_note_id, ', ') as ids
          from public.customer_credits cc
         where cc.tenant_id = p.tenant_id and cc.source_invoice_id = q.invoice_id
           and cc.source = 'credit_note' and cc.status = 'open') cn on cn.open > 0
     where p.tenant_id = v_tenant and p.status = 'received'
       and coalesce(p.customer_id, q.customer_id) = p_customer_id
       and q.invoice_id is not null
       and p.amount - coalesce(p.credit_applied, 0) > 0
     order by q.invoice_id, p.amount - coalesce(p.credit_applied, 0) desc, p.received_at desc, p.id
  ) cn_rows
  union all
  select p.id, 'advance'::text, p.amount, true, null::text, null::text, p.receipt_voucher_no,
         (p.received_at at time zone 'Asia/Kolkata')::date
    from public.payments p
    join public.quotes q on q.id = p.quote_id and q.tenant_id = p.tenant_id
   where p.tenant_id = v_tenant and p.status = 'received'
     and coalesce(p.customer_id, q.customer_id) = p_customer_id
     and q.invoice_id is null
     and coalesce(p.credit_applied, 0) = 0
     and (select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)
            from public.customer_credits cc
           where cc.tenant_id = p.tenant_id and cc.source_payment_id = p.id) = p.amount
     and not exists (select 1 from public.customer_credits cc
                      where cc.tenant_id = p.tenant_id and cc.source_payment_id = p.id and cc.status <> 'open');
end;
$$;
revoke all on function public.customer_refundable_items(uuid) from public, anon;
grant execute on function public.customer_refundable_items(uuid) to authenticated, service_role;

-- ── 5. Book the refund from its money-out bank line ──────────────────────────────────────────
create or replace function public.reconcile_bank_debit_as_customer_refund(p_txn_id uuid, p_payment_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
/* R-2322: a money-out bank line = a customer refund, through the existing refund RPCs. */
declare
  v_tenant    uuid := public.current_tenant_id();
  v_trusted   boolean;
  v_txn       public.bank_transactions;
  v_pay       public.payments;
  v_quote     record;
  v_cust      uuid;
  v_inv       text;
  v_cash      integer;
  v_cn_open   integer;
  v_own_open  integer;
  v_own_other integer;
  v_kind      text;
  v_max       integer;
  v_before    jsonb;
  v_after     jsonb;
  v_b         jsonb := '{}'::jsonb;
  v_a         jsonb := '{}'::jsonb;
  v_ins       jsonb := '{}'::jsonb;
  v_tbl       text;
  v_key       text;
  v_row       jsonb;
  v_r         jsonb;
  v_refunded  uuid;
  v_id        uuid := gen_random_uuid();
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if v_tenant is null then
    raise exception 'No company context — sign in again, then reconcile.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Refunds are for an owner, manager or accountant. A refund takes a numbered Refund Voucher from your GST series — ask one of them to reconcile this line.'
      using errcode = '42501';
  end if;
  if p_reason is null or length(trim(p_reason)) < 5 then
    raise exception 'Write why the money went back (at least 5 characters) — it is printed on the refund voucher.'
      using errcode = '22023';
  end if;

  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found or v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Bank line not found in your company.' using errcode = '42501';
  end if;
  if v_txn.matched_to_type is not null then
    raise exception 'This line is already reconciled.' using errcode = '22023';
  end if;
  if coalesce(v_txn.debit, 0) <= 0 or coalesce(v_txn.credit, 0) > 0 then
    raise exception 'A customer refund is money going out — pick a money-out line.' using errcode = '22023';
  end if;

  select * into v_pay from public.payments where id = p_payment_id for update;
  if not found or v_pay.tenant_id is distinct from v_tenant then
    raise exception 'That payment was not found in your company. Pick the customer again.' using errcode = '42501';
  end if;
  if v_pay.status <> 'received' then
    raise exception 'That payment is already refunded (voucher %).', coalesce(v_pay.refund_voucher_no, '—') using errcode = '22023';
  end if;
  select q.id, q.invoice_id, q.customer_id into v_quote
    from public.quotes q where q.id = v_pay.quote_id and q.tenant_id = v_tenant;
  if not found then
    raise exception 'That payment has no unused advance or credit-note credit to refund.' using errcode = '22023';
  end if;
  v_cust := coalesce(v_pay.customer_id, v_quote.customer_id);
  if v_cust is null then
    raise exception 'That payment has no customer — add the customer on quote % first.', v_quote.id using errcode = '22023';
  end if;
  v_inv  := v_quote.invoice_id;
  v_cash := v_pay.amount - coalesce(v_pay.credit_applied, 0);

  if v_inv is not null then
    select coalesce(sum(cc.amount), 0)::int into v_cn_open
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_invoice_id = v_inv
       and cc.source = 'credit_note' and cc.status = 'open';
    if v_cn_open <= 0 then
      raise exception 'Invoice % has no open credit-note credit to refund. Issue the credit note first (Invoices → % → Credit note), then reconcile this line.', v_inv, v_inv
        using errcode = '22023';
    end if;
    v_kind := 'credit_note';
    v_max  := least(v_cash, v_cn_open);
    if v_txn.debit > v_max then
      raise exception 'At most ₹% can be refunded against invoice % (open credit-note credit ₹%, this payment brought ₹%), but the bank line is ₹%. Issue a credit note for the rest first.',
        v_max, v_inv, v_cn_open, v_cash, v_txn.debit using errcode = '22023';
    end if;
  else
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
           coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
      into v_own_open, v_own_other
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_payment_id = v_pay.id;
    if coalesce(v_pay.credit_applied, 0) <> 0 or v_own_open <> v_pay.amount or v_own_other <> 0 then
      raise exception 'That payment has no unused advance or credit-note credit to refund.' using errcode = '22023';
    end if;
    v_kind := 'advance';
    v_max  := v_pay.amount;
    if v_txn.debit <> v_pay.amount then
      raise exception 'This advance is ₹% but the bank line is ₹%. An advance is refunded whole — pick the advance of the same amount.',
        v_pay.amount, v_txn.debit using errcode = '22023';
    end if;
  end if;

  v_before := public.r2322_refund_scope(v_tenant, v_pay.id, v_quote.id, v_inv, v_cust);

  perform set_config('app.bank_refund_payment', v_pay.id::text, true);
  if v_kind = 'credit_note' then
    v_r := public.refund_credit_note_credit(v_pay.id, v_txn.debit, trim(p_reason));
  else
    v_r := public.refund_payment(v_pay.id, trim(p_reason));
  end if;
  perform set_config('app.bank_refund_payment', '', true);

  v_refunded := (v_r->>'payment_id')::uuid;
  if coalesce((v_r->>'amount')::int, -1) <> v_txn.debit or v_refunded is null then
    raise exception 'R-2322: the refund came to ₹% but the bank line is ₹% — nothing was booked.', v_r->>'amount', v_txn.debit;
  end if;
  -- The refund left the bank on the line's date (the ledger shows Refund on refunded_at).
  update public.payments
     set refunded_at = (v_txn.txn_date::timestamp at time zone 'UTC')
   where id = v_refunded and tenant_id = v_tenant;

  v_after := public.r2322_refund_scope(v_tenant, v_pay.id, v_quote.id, v_inv, v_cust);
  for v_tbl in select jsonb_object_keys(v_before) loop
    for v_key, v_row in select * from jsonb_each(v_before->v_tbl) loop
      if not (v_after->v_tbl ? v_key) then
        raise exception 'R-2322: the refund removed % row % — nothing was booked.', v_tbl, v_key;
      end if;
      if v_after->v_tbl->v_key is distinct from v_row then
        v_b := jsonb_set(v_b, array[v_tbl], coalesce(v_b->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_row));
        v_a := jsonb_set(v_a, array[v_tbl], coalesce(v_a->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_after->v_tbl->v_key));
      end if;
    end loop;
    for v_key, v_row in select * from jsonb_each(v_after->v_tbl) loop
      if not (v_before->v_tbl ? v_key) then
        v_a   := jsonb_set(v_a, array[v_tbl], coalesce(v_a->v_tbl, '{}'::jsonb) || jsonb_build_object(v_key, v_row));
        v_ins := jsonb_set(v_ins, array[v_tbl], coalesce(v_ins->v_tbl, '[]'::jsonb) || to_jsonb(v_key));
      end if;
    end loop;
  end loop;

  insert into public.bank_customer_refunds
    (id, tenant_id, bank_txn_id, customer_id, kind, amount, source_payment_id, refunded_payment_id,
     quote_id, invoice_id, refund_voucher_no, reason, scope_before, scope_after, scope_inserted, created_by)
  values
    (v_id, v_tenant, v_txn.id, v_cust, v_kind, v_txn.debit, v_pay.id, v_refunded,
     v_quote.id, v_inv, v_r->>'refund_voucher_no', trim(p_reason), v_b, v_a, v_ins, auth.uid());

  update public.bank_transactions
     set matched_to_type = 'customer_refund', matched_to_id = v_id::text, match_confidence = 'manual',
         matched_at = now(), matched_by = auth.uid(), updated_at = now()
   where id = v_txn.id;

  return jsonb_build_object(
    'refund_id', v_id, 'kind', v_kind, 'amount', v_txn.debit,
    'refund_voucher_no', v_r->>'refund_voucher_no', 'refunded_payment_id', v_refunded,
    'invoice_id', v_inv, 'customer_id', v_cust,
    'split', coalesce((v_r->>'split')::boolean, false),
    'credit_note_credit_left', (v_r->>'credit_note_credit_left')::int);
end;
$$;
comment on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) is
  'R-2322: a money-out bank line booked as a customer refund — credit-note credit (refund_credit_note_credit) or an unused advance (refund_payment), amount = the line, refunded_at = the bank date, line matched once (customer_refund). Undo: un-reconcile the line. Owner/manager/accountant; tenant fail-closed.';
revoke all on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) from public, anon;
grant execute on function public.reconcile_bank_debit_as_customer_refund(uuid, uuid, text) to authenticated, service_role;

-- ── 6. Un-reconciling the line takes the refund back ─────────────────────────────────────────
create or replace function public.bank_customer_refund_undo(p_txn_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
/* R-2322: restore every row the refund changed, remove the rows it added, keep the RFV as cancelled. */
declare
  v_ref   public.bank_customer_refunds;
  v_now   jsonb;
  v_tbl   text;
  v_key   text;
  v_row   jsonb;
  v_b     jsonb;
begin
  select * into v_ref from public.bank_customer_refunds where bank_txn_id = p_txn_id for update;
  if not found then return; end if;

  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant') then
    raise exception 'Un-reconciling this line takes back the ₹% customer refund (%). Only an owner, manager or accountant can do that.',
      v_ref.amount, coalesce(v_ref.refund_voucher_no, 'refund') using errcode = '42501';
  end if;

  perform 1 from public.payments where tenant_id = v_ref.tenant_id
     and (id = v_ref.source_payment_id or quote_id = v_ref.quote_id) order by id for update;

  -- Nothing the refund touched may have moved since (fail-closed).
  v_now := public.r2322_refund_scope(v_ref.tenant_id, v_ref.source_payment_id, v_ref.quote_id, v_ref.invoice_id, v_ref.customer_id);
  for v_tbl in select jsonb_object_keys(v_ref.scope_after) loop
    for v_key, v_row in select * from jsonb_each(v_ref.scope_after->v_tbl) loop
      if v_now->v_tbl->v_key is distinct from v_row then
        raise exception 'This refund (%) cannot be taken back: the customer''s payments, credit or invoice changed after it (for example the credit was used, or another refund was booked). Undo that first, then un-reconcile this line.',
          coalesce(v_ref.refund_voucher_no, '₹' || v_ref.amount) using errcode = 'check_violation';
      end if;
    end loop;
  end loop;

  -- Refund voucher numbers stay in the series, marked cancelled (never re-issued).
  insert into public.cancelled_vouchers
    (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied, received_at, reason, cancelled_by)
  select v_ref.tenant_id, 'refund_voucher', a.value->>'refund_voucher_no', (a.value->>'id')::uuid, a.value->>'quote_id',
         v_ref.customer_id, (a.value->>'amount')::int, coalesce((a.value->>'credit_applied')::int, 0),
         (a.value->>'received_at')::timestamptz,
         'Customer refund taken back — bank line un-reconciled (R-2322)', auth.uid()
    from jsonb_each(coalesce(v_ref.scope_after->'payments', '{}'::jsonb)) a
   where a.value->>'status' = 'refunded' and a.value->>'refund_voucher_no' is not null
     and coalesce(v_ref.scope_before->'payments'->a.key->>'status', 'none') <> 'refunded'
  on conflict (tenant_id, doc_type, doc_no) do nothing;

  -- Rows the refund added go (credits first).
  delete from public.customer_credits
   where tenant_id = v_ref.tenant_id
     and id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(v_ref.scope_inserted->'credits', '[]'::jsonb)) x);
  delete from public.payments
   where tenant_id = v_ref.tenant_id
     and id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(v_ref.scope_inserted->'payments', '[]'::jsonb)) x);

  -- Rows it changed go back to how they were.
  update public.payments p
     set amount = (b.value->>'amount')::int, status = b.value->>'status',
         refunded_at = (b.value->>'refunded_at')::timestamptz, refund_reason = b.value->>'refund_reason',
         refund_voucher_no = b.value->>'refund_voucher_no', notes = b.value->>'notes'
    from jsonb_each(coalesce(v_ref.scope_before->'payments', '{}'::jsonb)) b
   where p.id = b.key::uuid and p.tenant_id = v_ref.tenant_id;
  update public.customer_credits c
     set amount = (b.value->>'amount')::int, status = b.value->>'status',
         applied_payment_id = (b.value->>'applied_payment_id')::uuid, used_at = (b.value->>'used_at')::timestamptz
    from jsonb_each(coalesce(v_ref.scope_before->'credits', '{}'::jsonb)) b
   where c.id = b.key::uuid and c.tenant_id = v_ref.tenant_id;
  update public.tds_receivable t
     set status = b.value->>'status', notes = b.value->>'notes'
    from jsonb_each(coalesce(v_ref.scope_before->'tds', '{}'::jsonb)) b
   where t.id::text = b.key and t.tenant_id = v_ref.tenant_id;
  update public.invoices i
     set paid_amount = (b.value->>'paid_amount')::int, paid_date = (b.value->>'paid_date')::date,
         status = (b.value->>'status')::public.invoice_status, net_payable = (b.value->>'net_payable')::int
    from jsonb_each(coalesce(v_ref.scope_before->'invoices', '{}'::jsonb)) b
   where i.id = b.key and i.tenant_id = v_ref.tenant_id;
  update public.quotes q
     set payment_status = (b.value->>'payment_status')::public.payment_status, payment_amount = (b.value->>'payment_amount')::int
    from jsonb_each(coalesce(v_ref.scope_before->'quotes', '{}'::jsonb)) b
   where q.id = b.key and q.tenant_id = v_ref.tenant_id;
  update public.subscriptions s
     set outstanding_amount = (b.value->>'outstanding_amount')::int
    from jsonb_each(coalesce(v_ref.scope_before->'subs', '{}'::jsonb)) b
   where s.id::text = b.key and s.tenant_id = v_ref.tenant_id;

  -- Fail-closed: every changed row is exactly as before, every added row is gone.
  v_now := public.r2322_refund_scope(v_ref.tenant_id, v_ref.source_payment_id, v_ref.quote_id, v_ref.invoice_id, v_ref.customer_id);
  for v_tbl in select jsonb_object_keys(v_ref.scope_before) loop
    for v_key, v_row in select * from jsonb_each(v_ref.scope_before->v_tbl) loop
      if v_now->v_tbl->v_key is distinct from v_row then
        raise exception 'R-2322: % row % did not go back to how it was before the refund — nothing was undone.', v_tbl, v_key;
      end if;
    end loop;
  end loop;
  for v_tbl in select jsonb_object_keys(v_ref.scope_inserted) loop
    for v_b in select * from jsonb_array_elements(v_ref.scope_inserted->v_tbl) loop
      if v_now->v_tbl ? (v_b #>> '{}') then
        raise exception 'R-2322: % row % the refund added is still there — nothing was undone.', v_tbl, v_b #>> '{}';
      end if;
    end loop;
  end loop;

  delete from public.bank_customer_refunds where id = v_ref.id;
end;
$$;
revoke all on function public.bank_customer_refund_undo(uuid) from public, anon, authenticated;
grant execute on function public.bank_customer_refund_undo(uuid) to service_role;

create or replace function public.tg_customer_refund_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
/* R-2322: un-reconciling a customer-refund line takes the refund back; nothing else makes one. */
begin
  if old.matched_to_type = 'customer_refund'
     and (new.matched_to_type is distinct from old.matched_to_type or new.matched_to_id is distinct from old.matched_to_id) then
    perform public.bank_customer_refund_undo(old.id);
  end if;
  if new.matched_to_type = 'customer_refund'
     and (old.matched_to_type is distinct from new.matched_to_type or old.matched_to_id is distinct from new.matched_to_id)
     and not exists (select 1 from public.bank_customer_refunds r
                      where r.id::text = new.matched_to_id and r.bank_txn_id = new.id) then
    raise exception 'A bank line becomes a customer refund only through Reconcile → Customer refund.' using errcode = '22023';
  end if;
  return null;
end;
$$;
revoke all on function public.tg_customer_refund_line() from public, anon, authenticated;

drop trigger if exists trg_customer_refund_line on public.bank_transactions;
create trigger trg_customer_refund_line
  after update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_customer_refund_line();

commit;
