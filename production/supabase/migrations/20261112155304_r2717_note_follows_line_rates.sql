-- deploy-peek: to_regprocedure('public.invoice_note_gst_split(text,integer)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_credit_note_core(text,integer,text,text,text,boolean)') and prosrc like '%invoice_note_gst_split%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_debit_note(text,integer,text,text,text)') and prosrc like '%invoice_note_gst_split%') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'credit_notes' and column_name = 'tax_rate' and is_nullable = 'YES') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'debit_notes' and column_name = 'tax_rate' and is_nullable = 'YES')
-- deploy-key: r2717notelinerates
-- R-2717 — a credit / debit note on an invoice whose LINES carry different GST rates.
--
-- An invoice can now carry a GST rate per line (invoices.line_items[].tax_rate; a Zoho invoice
-- with a 0% line and an 18% line). Such an invoice has invoices.tax_rate NULL — no single rate.
-- issue_credit_note_core and issue_debit_note backed the note's tax out at
-- `coalesce(invoice.tax_rate, 18)`: a ₹16,800 credit on ₹30,000 + ₹3,600 GST became
-- ₹14,237 + ₹2,563 at "18%" instead of ₹15,000 + ₹1,800 — GST reversed that was never charged.
--
-- What changes (and nothing else in either function — bodies are r1563's issue_credit_note_core
-- and r2178's issue_debit_note with ONLY the rate block replaced):
--   1. invoice_note_gst_split(invoice, gross) — the one rule both notes use:
--        · lines at ONE rate (every invoice before this card): the old rule, unchanged —
--          rate = coalesce(invoices.tax_rate, 18), taxable = round(gross × 100 / (100 + rate)).
--        · lines at DIFFERENT rates: the note follows the invoice it amends — taxable =
--          round(gross × invoice taxable ÷ (invoice taxable + invoice GST)), GST = the rest,
--          rate NULL. The GST report then splits the note by the invoice's line rates
--          (src/lib/gst/line-rates.ts; the TS twin of this split is mixedRateNoteSplit).
--        · different rates but no taxable / GST on the invoice → refused (never guessed at 18%).
--      "Different rates" = more than one distinct rate among lines with value (qty × rate > 0,
--      not a Zoho adjustment line); a line with no rate of its own counts as the invoice's rate.
--   2. credit_notes.tax_rate / debit_notes.tax_rate may be NULL (= follows the invoice's lines).
--
-- Money rules: G17 (a Zoho sale is kept as filed — the invoice's own taxable / GST drive the split).

alter table public.credit_notes alter column tax_rate drop not null;
alter table public.debit_notes  alter column tax_rate drop not null;

comment on column public.credit_notes.tax_rate is
  'GST % of the note. NULL (R-2717) = issued on an invoice whose lines carry different GST rates: the note is split like that invoice (taxable_value / tax_amount are its own figures).';
comment on column public.debit_notes.tax_rate is
  'GST % of the note. NULL (R-2717) = issued on an invoice whose lines carry different GST rates: the note is split like that invoice (taxable_value / tax_amount are its own figures).';

create or replace function public.invoice_note_gst_split(p_invoice_id text, p_gross integer)
returns table (taxable integer, tax integer, rate integer)
language plpgsql
stable
security definer
set search_path = public
as $$
/* R-2717: taxable + GST of a credit / debit note of p_gross on this invoice. Internal — called
   by issue_credit_note_core / issue_debit_note, which have already checked role and tenant. */
declare
  v_inv   record;
  v_rates integer;
begin
  select i.tax_rate, i.taxable_value, i.tax_amount, i.line_items
    into v_inv
    from public.invoices i where i.id = p_invoice_id;
  if not found then raise exception 'Invoice % not found', p_invoice_id using errcode = 'no_data_found'; end if;

  /* Distinct GST rates among the lines that carry value. −1 stands for "the invoice's rate"
     (a line with no usable rate of its own), so [0%, no rate] is two rates and [no rate,
     no rate] is one — the same reading as lineOwnRate / rateSlices in lib/gst/line-rates.ts. */
  select count(distinct coalesce(
           case when jsonb_typeof(l->'tax_rate') = 'number' and (l->>'tax_rate')::numeric >= 0
                then (l->>'tax_rate')::numeric end, -1))
    into v_rates
    from jsonb_array_elements(case when jsonb_typeof(v_inv.line_items) = 'array' then v_inv.line_items else '[]'::jsonb end) l
   where jsonb_typeof(l) = 'object'
     and coalesce(l->>'kind', '') <> 'adjustment'
     and coalesce(case when jsonb_typeof(l->'qty')  = 'number' then (l->>'qty')::numeric  end, 0)
       * coalesce(case when jsonb_typeof(l->'rate') = 'number' then (l->>'rate')::numeric end, 0) > 0;

  if v_rates > 1 then
    if v_inv.taxable_value is null or v_inv.tax_amount is null
       or v_inv.taxable_value < 0 or v_inv.tax_amount < 0
       or v_inv.taxable_value + v_inv.tax_amount <= 0 then
      raise exception 'Invoice % has lines at different GST rates but no taxable value and GST on record — the note cannot be split. Correct the invoice first.', p_invoice_id
        using errcode = 'check_violation';
    end if;
    taxable := round(p_gross::numeric * v_inv.taxable_value / (v_inv.taxable_value + v_inv.tax_amount));
    tax     := p_gross - taxable;
    rate    := null;
    return next;
    return;
  end if;

  -- One rate: the rule issue_credit_note / issue_debit_note always used.
  rate := coalesce(v_inv.tax_rate, 18);
  if rate = 0 then
    taxable := p_gross;
    tax     := 0;
  else
    taxable := round(p_gross * 100.0 / (100 + rate));
    tax     := p_gross - taxable;
  end if;
  return next;
end;
$$;

comment on function public.invoice_note_gst_split(text, integer) is
  'R-2717: taxable + GST + rate of a credit / debit note of that gross on the invoice. One line rate → invoices.tax_rate (else 18%) as before; lines at different GST rates → the invoice''s own taxable : GST proportion, rate NULL. Internal (issue_credit_note_core / issue_debit_note).';

revoke all on function public.invoice_note_gst_split(text, integer) from public, anon, authenticated;
grant execute on function public.invoice_note_gst_split(text, integer) to service_role;

-- ── issue_credit_note_core — R-1563 / R-1566 body (20261018171947) + R-2717 split ─────────
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

  /* R-2717: the note's taxable + GST by the one rule in invoice_note_gst_split — the invoice's
     rate as before; an invoice whose lines carry different GST rates → its own taxable : GST
     proportion, and the note stores no single rate (tax_rate NULL). */
  select s.taxable, s.tax, s.rate into v_taxable, v_tax, v_rate
    from public.invoice_note_gst_split(p_invoice_id, p_gross_amount) s;

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

-- ── issue_debit_note — R-1573 / R-2178 body (20261031032023) + R-2717 split ───────────────
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
  v_reopened      boolean := false;  -- R-1573
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

  /* R-2717: the note's taxable + GST by the one rule in invoice_note_gst_split — the invoice's
     rate as before; an invoice whose lines carry different GST rates → its own taxable : GST
     proportion, and the note stores no single rate (tax_rate NULL). */
  select s.taxable, s.tax, s.rate into v_taxable, v_tax, v_rate
    from public.invoice_note_gst_split(p_invoice_id, p_gross_amount) s;

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

  /* R-1573: a PAID invoice owes the note now — Pending, so Invoices / Aging / Collections /
     dunning ask for it and record_payment settles it. paid_amount = what was settled before
     the note (the old net_payable), so due = net_payable − paid_amount = the note: never the
     whole invoice again (an advance-adjusted or pre-R-015 paid invoice has paid_amount 0),
     and an overpayment already given as customer credit is not counted twice. */
  if v_inv.status = 'paid' then
    update public.invoices
       set status      = 'pending'::invoice_status,
           paid_date   = null,
           paid_amount = greatest(0, coalesce(v_inv.net_payable, v_inv.amount)),
           updated_at  = now()
     where id = p_invoice_id;
    v_reopened := true;
  end if;

  /* R-2178: a debit note (also how a credit note is undone) — the subscription follows the invoice. */
  perform public.sync_invoice_subscription_outstanding(p_invoice_id);

  return jsonb_build_object(
    'debit_note_id',   v_dn_id,
    'invoice_id',      p_invoice_id,
    'amount',          p_gross_amount,
    'taxable_value',   v_taxable,
    'tax_amount',      v_tax,
    'tax_rate',        v_rate,
    'inter_state',     coalesce(v_inv.inter_state, false),
    'new_net_payable', v_new_net,
    'invoice_reopened', v_reopened
  );
end;
$function$;

comment on function public.issue_debit_note(text, integer, text, text, text) is
  'CGST s.34(3) debit note on an issued invoice (R-1566: not draft/void). Raises net_payable; R-1573: a Paid invoice goes back to Pending with the note as the amount due. R-2178: re-syncs the linked subscription''s outstanding. Owner/manager/accountant/billing.';

revoke all on function public.issue_debit_note(text, integer, text, text, text) from public, anon;
grant execute on function public.issue_debit_note(text, integer, text, text, text) to authenticated, service_role;
