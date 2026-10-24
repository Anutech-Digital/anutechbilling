-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.refund_payment(uuid,text)') and prosrc like '%R-1563%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_credit_note_core(text,integer,text,text,text,boolean)') and prosrc like '%R-1566%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-1566%')
-- deploy-key: r1563cnrefund
-- 20261018171947_r1563_credit_note_refund.sql
--
-- R-1563 + R-1566 (P1 money / GST, audit 18 Oct 2026): a credit note on a paid invoice put the
-- extra money nowhere, and a payment on an invoiced quote could never be refunded.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════
--   R-1566 issue_credit_note (20261011120000_r718_money_roles.sql:805-918)
--     · :904-905 only lowers invoices.net_payable (clamped at 0). Paid ₹1,00,000, credit note
--       ₹10,000 → the ₹10,000 the company now owes the customer is in no customer_credits row:
--       not spendable on the next quote, not refundable.
--     · status / paid_date never recomputed: ₹90,000 paid on ₹1,00,000, credit note ₹10,000 →
--       nothing due, still "Pending" → reminders chase money not owed.
--     · draft / void invoices accepted a credit (and debit, :921-990) note.
--   R-1563 refund_payment (20261018164416_r1567_refund_delete_payment_credit.sql:368-371)
--     refuses EVERY payment whose quote has an invoice, credit note or not. Payments page
--     (src/app/(app)/payments/page.tsx handleRefund) sends the user to the invoice "make a
--     credit note, then come back" — and on coming back shows the same dialog again.
--
-- ══ WHAT CHANGES (GST: CGST s.34 credit note first, then the refund) ═════════════
--   (1) customer_credits.source_credit_note_id / source_invoice_id: credit made by a note.
--   (2) issue_credit_note → issue_credit_note_core(…, p_settle). Same R-718 body plus:
--       · draft / void invoice → refused (also issue_debit_note);
--       · settled = paid_amount + advances adjusted on the invoice (refunded payments left
--         out; a Paid invoice counts as at least settled); due = amount + debit notes − credit
--         notes. If the note takes `due` below `settled`, the newly uncovered part becomes an
--         OPEN customer_credits row (source 'credit_note', the note, the invoice) — only the
--         part this note uncovers, so an earlier overpayment credit is not made twice;
--       · settled ≥ due after the note and the invoice is pending/overdue → Paid, paid_date
--         today (IST). The result carries customer_credit + invoice_paid.
--       The public issue_credit_note(text,integer,text,text,text) keeps its signature and calls
--       core with p_settle = true. unreconcile_bank_receipt (undo a bank sale) calls core with
--       p_settle = false: that sale's money is being taken back, so its note makes no credit.
--   (3) refund_payment on an invoiced quote: allowed when the cash to give back (amount −
--       credit_applied, R-1567) less this payment's own open overpayment credit is covered by
--       OPEN credit made by credit notes on that invoice. Those credit rows are closed
--       'refunded' (split when only part is used); the invoice's paid_amount drops by the
--       payment (unless it was an adjusted advance); fail-closed if the invoice would then owe
--       money; the quote stays 'invoiced'; subscription outstanding = what the invoice still
--       owes. Not covered → refused, naming the invoice and how much credit note is needed.
--   No backfill: credit notes issued before this migration made no credit row — such a
--   refund is refused until a credit note covers it (manager decision, see card R-1563).
--
-- Test: supabase/tests/r1563_credit_note_refund.test.sql (rolled back).

begin;

-- ── (1) credit made by a credit note is traceable ─────────────────────────────────
alter table public.customer_credits add column if not exists source_credit_note_id text;
alter table public.customer_credits add column if not exists source_invoice_id text;

comment on column public.customer_credits.source_credit_note_id is
  'R-1566: the credit note whose amount went past what the customer still owed on the invoice — that excess is this credit.';
comment on column public.customer_credits.source_invoice_id is
  'R-1566: the invoice of source_credit_note_id. refund_payment on that invoice''s quote pays this credit out (R-1563).';

create index if not exists customer_credits_source_invoice_idx
  on public.customer_credits (tenant_id, source_invoice_id) where source_invoice_id is not null;

-- ── (2) issue_credit_note_core — R-718 body + R-1566 credit / status / draft-void ─────
create or replace function public.issue_credit_note_core(
  p_invoice_id   text,
  p_gross_amount integer,
  p_reason_code  text,
  p_reason       text,
  p_notes        text,
  p_settle       boolean
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-1566: issue_credit_note's body. p_settle = true (every user path): money already paid
   past the new value becomes customer credit and a settled invoice becomes Paid.
   p_settle = false only for unreconcile_bank_receipt, which takes the sale's money back. */
declare
  v_inv             record;
  v_is_service      boolean;
  v_caller_tenant   uuid;
  v_already         integer;
  v_debits          integer;
  v_max_creditable  integer;
  v_rate            integer;
  v_taxable         integer;
  v_tax             integer;
  v_cn_id           text;
  v_supply_fy_end   text;
  v_s34_deadline    date;
  v_new_net         integer;
  v_adv             integer := 0;
  v_settled         integer := 0;
  v_due_before      integer := 0;
  v_due_after       integer := 0;
  v_credit          integer := 0;
  v_paid_now        boolean := false;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can issue a credit note' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Credit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  /* R-041 added i.invoice_date: the Section 34(2) deadline is measured from the FY of the
     SUPPLY, so the check below needs the invoice date rather than today. */
  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state, i.invoice_date, i.status, i.paid_amount, i.adjusted_advances,
         i.quote_id
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  /* R-1566: a credit note reduces an ISSUED invoice (CGST s.34). A draft is not issued — change
     the draft; a void invoice is already cancelled in full. */
  if v_inv.status in ('draft', 'void') then
    raise exception 'Invoice % is % — a credit note is only for an issued invoice. %', p_invoice_id, v_inv.status,
      case when v_inv.status = 'draft' then 'Change the draft instead.' else 'A void invoice is already cancelled in full.' end
      using errcode = 'check_violation';
  end if;

  select coalesce(sum(amount), 0) into v_already from public.credit_notes where invoice_id = p_invoice_id;
  v_max_creditable := coalesce(v_inv.amount, 0) - v_already;
  if p_gross_amount > v_max_creditable then
    raise exception 'Credit % exceeds the creditable balance % on invoice %',
      p_gross_amount, v_max_creditable, p_invoice_id using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  /* ── R-041: CGST Section 34(2) — a credit note has a deadline ──────────────────
     A credit note may be declared up to 30 NOVEMBER following the end of the financial
     year of the original supply (or the date the annual return is filed, whichever is
     earlier). Only the 30 November limb is enforced (the annual-return date is not in
     this database) — the permissive side of the rule, stated as such. */
  v_supply_fy_end := (public.indian_fiscal_year(coalesce(v_inv.invoice_date, public.ist_today())));
  v_s34_deadline  := make_date(2000 + substring(v_supply_fy_end from 5 for 2)::int, 11, 30);
  if public.ist_today() > v_s34_deadline then
    raise exception
      'Too late for a credit note against invoice %: it was supplied in FY %, and CGST Section 34(2) allows one only up to 30 November %. Raise a refund or a commercial adjustment instead — a credit note now cannot reduce the GST you already paid.',
      p_invoice_id, v_supply_fy_end, to_char(v_s34_deadline, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  /* ── R-1566: what the customer has paid on this invoice, and owes, before this note ──
     settled = paid_amount (money after the invoice) + advances the invoice adjusted, leaving
     out an advance whose payment was refunded. A Paid invoice is at least settled (older
     invoices were marked paid with paid_amount 0). due = amount + debit notes − credit notes. */
  if p_settle then
    select coalesce(sum((adv->>'amount')::int), 0)::int into v_adv
      from jsonb_array_elements(case when jsonb_typeof(v_inv.adjusted_advances) = 'array'
                                     then v_inv.adjusted_advances else '[]'::jsonb end) adv
     where not exists (select 1 from public.payments p
                        where p.id::text = adv->>'payment_id' and p.status = 'refunded');
    select coalesce(sum(amount), 0) into v_debits from public.debit_notes where invoice_id = p_invoice_id;
    v_due_before := coalesce(v_inv.amount, 0) + v_debits - v_already;
    v_settled    := coalesce(v_inv.paid_amount, 0) + v_adv;
    if v_inv.status = 'paid' then v_settled := greatest(v_settled, v_due_before); end if;
    v_due_after  := greatest(0, v_due_before - p_gross_amount);
    /* Only the part THIS note uncovers — anything already over `due` before it was made
       credit by whoever made it (an overpayment, or an earlier note). */
    v_credit := greatest(0, v_settled - v_due_after) - greatest(0, v_settled - greatest(0, v_due_before));
    if v_credit > 0 and v_inv.customer_id is null then
      raise exception 'Invoice % is already paid ₹% — this credit note leaves ₹% with the customer as credit, but the invoice has no customer to hold it. Link the invoice to a customer first, then issue the credit note.',
        p_invoice_id, v_settled, v_credit using errcode = 'check_violation';
    end if;
  end if;

  v_cn_id := public.next_document_number('credit_note', v_inv.tenant_id, public.ist_today());
  if v_cn_id is null then raise exception 'Could not allocate a credit note number'; end if;

  insert into public.credit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, credit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_cn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := greatest(0, coalesce(v_inv.net_payable, v_inv.amount) - p_gross_amount);
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  if p_settle then
    /* R-1566: the money paid past the new value is the customer's — as open credit, usable
       on the next quote or paid back through refund_payment (R-1563). */
    if v_credit > 0 then
      insert into public.customer_credits
        (tenant_id, customer_id, amount, source, source_quote_id, source_credit_note_id, source_invoice_id, note, status)
      values
        (v_inv.tenant_id, v_inv.customer_id, v_credit, 'credit_note', v_inv.quote_id, v_cn_id, p_invoice_id,
         'Credit note ' || v_cn_id || ' on paid invoice ' || p_invoice_id, 'open');
    end if;
    /* R-1566: nothing left to pay → Paid (no more reminders / dunning). */
    if v_settled >= v_due_after and v_inv.status in ('pending', 'overdue') then
      update public.invoices
         set status = 'paid'::invoice_status, paid_date = coalesce(paid_date, public.ist_today()), updated_at = now()
       where id = p_invoice_id;
      v_paid_now := true;
    end if;
  end if;

  return jsonb_build_object(
    'credit_note_id',  v_cn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net,
    'customer_credit', v_credit,
    'invoice_paid',    v_paid_now or (p_settle and v_inv.status = 'paid')
  );
end;
$function$;

comment on function public.issue_credit_note_core(text, integer, text, text, text, boolean) is
  'R-1566: credit note body. p_settle: excess over what is still owed → customer credit (source credit_note), settled invoice → Paid. Internal — called by issue_credit_note (p_settle true) and unreconcile_bank_receipt (false).';

revoke all on function public.issue_credit_note_core(text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.issue_credit_note_core(text, integer, text, text, text, boolean) to service_role;

CREATE OR REPLACE FUNCTION public.issue_credit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-718 role gate + R-1566 settle: both in issue_credit_note_core. */
begin
  return public.issue_credit_note_core(p_invoice_id, p_gross_amount, p_reason_code, p_reason, p_notes, true);
end;
$function$;

comment on function public.issue_credit_note(text, integer, text, text, text) is
  'CGST s.34 credit note on an issued invoice (R-1566: not draft/void). Lowers net_payable; money already paid past the new value → open customer credit (source credit_note); settled invoice → Paid. Owner/manager/accountant/billing.';

revoke all on function public.issue_credit_note(text, integer, text, text, text) from public, anon;
grant execute on function public.issue_credit_note(text, integer, text, text, text) to authenticated, service_role;

-- ── issue_debit_note — R-718 body + R-1566 draft / void refused ───────────────────────
CREATE OR REPLACE FUNCTION public.issue_debit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_inv           record;
  v_is_service    boolean;
  v_caller_tenant uuid;
  v_rate          integer;
  v_taxable       integer;
  v_tax           integer;
  v_dn_id         text;
  v_new_net       integer;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can issue a debit note' using errcode = '42501';
  end if;
  v_is_service := auth.role() = 'service_role';
  if not v_is_service then
    v_caller_tenant := public.current_tenant_id();
    if v_caller_tenant is null then raise exception 'No tenant context'; end if;
  end if;

  if p_gross_amount is null or p_gross_amount <= 0 then
    raise exception 'Debit amount must be greater than zero' using errcode = 'check_violation';
  end if;

  select i.id, i.tenant_id, i.customer_id, i.customer_name, i.amount, i.net_payable,
         i.tax_rate, i.inter_state, i.status
    into v_inv
    from public.invoices i where i.id = p_invoice_id for update;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;
  if not v_is_service and v_inv.tenant_id is distinct from v_caller_tenant then
    raise exception 'Invoice % is not in the caller''s tenant', p_invoice_id using errcode = 'insufficient_privilege';
  end if;

  /* R-1566: a debit note adds to an ISSUED invoice (CGST s.34(3)). */
  if v_inv.status in ('draft', 'void') then
    raise exception 'Invoice % is % — a debit note is only for an issued invoice. %', p_invoice_id, v_inv.status,
      case when v_inv.status = 'draft' then 'Change the draft instead.' else 'Raise a new invoice instead.' end
      using errcode = 'check_violation';
  end if;

  v_rate := coalesce(v_inv.tax_rate, 18);
  if v_rate = 0 then
    v_taxable := p_gross_amount;
    v_tax     := 0;
  else
    v_taxable := round(p_gross_amount * 100.0 / (100 + v_rate));
    v_tax     := p_gross_amount - v_taxable;
  end if;

  v_dn_id := public.next_document_number('debit_note', v_inv.tenant_id, public.ist_today());
  if v_dn_id is null then raise exception 'Could not allocate a debit note number'; end if;

  insert into public.debit_notes (
    id, tenant_id, invoice_id, customer_id, customer_name, debit_date,
    reason_code, reason, amount, taxable_value, tax_amount, tax_rate, inter_state, notes, created_by
  ) values (
    v_dn_id, v_inv.tenant_id, p_invoice_id, v_inv.customer_id, v_inv.customer_name, public.ist_today(),
    coalesce(p_reason_code, 'other'), p_reason, p_gross_amount, v_taxable, v_tax, v_rate,
    coalesce(v_inv.inter_state, false), p_notes, auth.uid()
  );

  v_new_net := coalesce(v_inv.net_payable, v_inv.amount) + p_gross_amount;
  update public.invoices set net_payable = v_new_net, updated_at = now() where id = p_invoice_id;

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net
  );
end;
$function$;

revoke all on function public.issue_debit_note(text, integer, text, text, text) from public, anon;
grant execute on function public.issue_debit_note(text, integer, text, text, text) to authenticated, service_role;

-- ── (3) refund_payment — R-1567 body + R-1563 refund on an invoiced quote ─────────────
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
  if v_bank_cnt > 0 then
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

comment on function public.refund_payment(uuid, text) is
  'Refund a payment in one transaction: RFV number, quote/subscription recompute, its open overpayment credit closed. R-1567: refused while credit it created is spent elsewhere; credit it applied is given back (RFV = cash part); its TDS receivable is reversed. R-1563: on an invoiced quote only the cash covered by credit-note credit on that invoice (that credit is paid out). Owner/manager/accountant.';

revoke all on function public.refund_payment(uuid, text) from public, anon;
grant execute on function public.refund_payment(uuid, text) to authenticated, service_role;

-- ── unreconcile_bank_receipt — R-718 body; its reversal note makes no credit (R-1566) ──
CREATE OR REPLACE FUNCTION public.unreconcile_bank_receipt(p_txn_id uuid, p_undo_sale boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_txn     public.bank_transactions;
  v_pay     public.payments;
  v_quote   record;
  v_inv     record;
  v_invoice text;
  v_cn      jsonb;
  v_voided  text;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  /* R-718: "undo the sale" deletes the receipt — a delete, so owner / accountant only. */
  if p_undo_sale and not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant user can delete a payment' using errcode = '42501';
  end if;
  if v_tenant is null then raise exception 'No tenant in context'; end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id for update;
  if not found then raise exception 'Bank transaction not found' using errcode = 'no_data_found'; end if;
  if v_txn.tenant_id is distinct from v_tenant then
    raise exception 'Not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;

  if p_undo_sale then
    if v_txn.matched_to_type is distinct from 'payment' or v_txn.matched_to_id is null then
      raise exception 'This line is not reconciled to a customer receipt — nothing to undo.';
    end if;
    select * into v_pay from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not found then raise exception 'The receipt this line points to no longer exists.'; end if;
    if v_pay.notes is distinct from 'Reconciled from bank receipt' then
      raise exception 'This receipt was recorded separately, not from this bank line — undo it from Payments instead.';
    end if;

    select id, invoice_id into v_quote from public.quotes where id = v_pay.quote_id for update;
    v_invoice := v_quote.invoice_id;
    if exists (select 1 from public.payments where quote_id = v_pay.quote_id and id <> v_pay.id) then
      raise exception 'This sale has other receipts too — undo it from the invoice, not from here.';
    end if;
    if v_invoice is not null and (
         exists (select 1 from public.credit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.debit_notes where invoice_id = v_invoice)
      or exists (select 1 from public.tds_receivable where invoice_id = v_invoice)
    ) then
      raise exception 'Invoice % has a credit/debit note or TDS entry — handle it from the invoice.', v_invoice;
    end if;
  end if;

  -- Free the line through the one reconcile path, so every other reversal still runs.
  perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

  if p_undo_sale then
    if v_invoice is not null then
      select id, status, amount into v_inv from public.invoices where id = v_invoice and tenant_id = v_tenant for update;
      if found then
        if v_inv.status = 'draft' then
          update public.invoices set status = 'void'::invoice_status, paid_date = null
           where id = v_invoice and tenant_id = v_tenant;
          v_voided := v_invoice;
        elsif v_inv.status = 'void' then
          -- R-1566: already cancelled in full — no credit note on a void invoice.
          null;
        else
          -- Issued: reverse with a full credit note; the invoice stays, nothing due.
          -- R-1566: p_settle = false — this sale's money is being taken back (the receipt is
          -- deleted below), so the note must not turn it into customer credit.
          v_cn := public.issue_credit_note_core(v_invoice, v_inv.amount, 'cancellation',
                    'Sale reversed — bank receipt un-reconciled',
                    'unreconcile_bank_receipt ' || p_txn_id::text, false);
          update public.invoices
             set status = 'pending'::invoice_status, paid_date = null, paid_amount = 0, net_payable = 0, updated_at = now()
           where id = v_invoice and tenant_id = v_tenant;
        end if;
      end if;
    end if;
    delete from public.payments where id = v_pay.id;
    update public.quotes
       set status = 'rejected'::quote_status,
           payment_status = 'none'::payment_status,
           payment_amount = 0,
           payment_method = null, payment_reference = null,
           payment_received_at = null, payment_notes = null
     where id = v_pay.quote_id and tenant_id = v_tenant;
  end if;

  return jsonb_build_object(
    'unreconciled', true,
    'invoice_voided', v_voided,
    'invoice_credited', case when v_cn is not null then v_invoice end,
    'credit_note_id', v_cn->>'credit_note_id',
    'receipt_removed', case when p_undo_sale then v_pay.id end
  );
end;
$function$
;

revoke all on function public.unreconcile_bank_receipt(uuid, boolean) from public, anon;
grant execute on function public.unreconcile_bank_receipt(uuid, boolean) to authenticated, service_role;

commit;
