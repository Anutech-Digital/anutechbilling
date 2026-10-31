-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.sync_invoice_subscription_outstanding(text)') and prosrc like '%R-2178%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_credit_note(text,integer,text,text,text)') and prosrc like '%R-2178%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.issue_debit_note(text,integer,text,text,text)') and prosrc like '%R-2178%')
-- deploy-key: r2178cnsyncsubscription
-- 20261031032023_r2178_credit_note_syncs_subscription.sql
--
-- R-2178 (31 Oct 2026, staging reconcile — LOOK BOOK FLY, Q-A378-27-0241): a credit note did not
-- refresh the subscription's stored balance.
--
-- ─── WHAT WAS WRONG ───────────────────────────────────────────────────────────────────────
--   record_payment stores subscriptions.outstanding_amount = quotes.amount − received on the quote's
--   first subscription (₹1,78,416 − ₹14,868 = ₹1,63,548). CN-A378-27-0003 (₹1,63,548) went through
--   issue_credit_note → issue_credit_note_core, which lowers invoices.net_payable and marks the
--   invoice Paid — and never touches the subscription. So the invoice said ₹14,868 paid, nothing
--   due, while the subscription list, customer page, dashboard and renewal-risk still showed
--   ₹1,63,548 owed. subscription_dues_drift() (R-2154) listed the quote. A debit note (the way a
--   credit note is reversed — a CN itself cannot be deleted from the app) had the same gap.
--
-- ─── WHAT THIS ADDS ───────────────────────────────────────────────────────────────────────
--   sync_invoice_subscription_outstanding(invoice) — NO new formula. It re-runs the two rules the
--   app already stores balances by (the same two subscription_dues_drift() checks against):
--     · a subscription billed in parts → sync_split_outstanding(sub) (R-527 / R-2092), for every
--       subscription whose part this invoice bills or billed, and for the quote's first one;
--     · otherwise the quote's FIRST subscription (where record_payment / activate_quote_on_credit
--       keep the quote's balance) ← quote_open_balance(quote) (R-1686: invoiced → what the live
--       invoices still say is payable, net of credit / debit notes).
--     Written-off or not-active subscriptions are left alone (as sync_split_outstanding does).
--   issue_credit_note  = R-1566 wrapper (20261018171947) + the sync after the note.
--   issue_debit_note   = R-1573 body (20261018224237) + the sync after the note — the undo.
--   issue_credit_note_core is NOT changed: unreconcile_bank_receipt (undo a bank sale) calls it
--   directly and handles the quote / subscription itself.
--
-- ─── DECIDED (R-2178, Pardeep delegated) ───────────────────────────────────────────────────
--   The quote total does NOT reflect credit notes: the quote stays as sold, the credit note is the
--   correction. Dues read net figures: quote_open_balance(s) (quotes list), invoices
--   net_payable − paid_amount (aging, collections) and now subscriptions.outstanding_amount.
--
-- Not covered: a credit note on a RENEWAL quote's invoice (the subscription's quote_id is the sale
-- quote; record_payment keeps R-1703's prior-dues rule there) — unchanged, as before.
-- Test: supabase/tests/r2178_credit_note_syncs_subscription.test.sql

begin;

create or replace function public.sync_invoice_subscription_outstanding(p_invoice_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
/* R-2178: after a credit / debit note, the subscriptions this invoice bills carry what the app
   says they owe — sync_split_outstanding for parts, quote_open_balance otherwise. Returns how
   many subscriptions were synced. */
declare
  v_inv   record;
  v_sub   record;
  v_first record;
  v_owed  integer;
  v_n     integer := 0;
begin
  select i.id, i.tenant_id, i.quote_id into v_inv from public.invoices i where i.id = p_invoice_id;
  if not found then return 0; end if;

  -- Billed in parts: the subscriptions whose part this invoice bills (or billed, R-2095).
  for v_sub in
    select distinct s.id
      from public.subscriptions s
      join public.subscription_billings b on b.subscription_id = s.id
     where s.tenant_id = v_inv.tenant_id
       and (b.invoice_id = p_invoice_id or p_invoice_id = any(b.credited_invoice_ids))
  loop
    if public.sync_split_outstanding(v_sub.id) is not null then v_n := v_n + 1; end if;
  end loop;

  if v_inv.quote_id is null then return v_n; end if;

  -- The quote's balance rides on its FIRST subscription (record_payment, R-2092).
  select s.id, s.status, s.written_off_at, s.outstanding_amount into v_first
    from public.subscriptions s
   where s.tenant_id = v_inv.tenant_id and s.quote_id = v_inv.quote_id
   order by s.created_at, s.id limit 1;
  if not found then return v_n; end if;

  if public.sync_split_outstanding(v_first.id) is not null then
    return v_n + 1;   -- a quote billed in parts: done by R-527's rule
  end if;
  if v_first.status <> 'active' or v_first.written_off_at is not null then
    return v_n;
  end if;
  v_owed := public.quote_open_balance(v_inv.quote_id);
  if v_owed is not null and v_owed is distinct from coalesce(v_first.outstanding_amount, 0) then
    update public.subscriptions set outstanding_amount = v_owed where id = v_first.id;
    v_n := v_n + 1;
  end if;
  return v_n;
end;
$$;

comment on function public.sync_invoice_subscription_outstanding(text) is
  'R-2178: re-syncs subscriptions.outstanding_amount for the subscriptions an invoice bills, after a credit/debit note — sync_split_outstanding (parts) or quote_open_balance on the quote''s first subscription. Internal.';
revoke all on function public.sync_invoice_subscription_outstanding(text) from public, anon, authenticated;
grant execute on function public.sync_invoice_subscription_outstanding(text) to service_role;

CREATE OR REPLACE FUNCTION public.issue_credit_note(p_invoice_id text, p_gross_amount integer, p_reason_code text DEFAULT 'other'::text, p_reason text DEFAULT NULL::text, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
/* R-718 role gate + R-1566 settle: both in issue_credit_note_core.
   R-2178: then the subscription's stored balance follows the invoice, as after a receipt. */
declare
  v_r jsonb;
begin
  v_r := public.issue_credit_note_core(p_invoice_id, p_gross_amount, p_reason_code, p_reason, p_notes, true);
  perform public.sync_invoice_subscription_outstanding(p_invoice_id);
  return v_r;
end;
$function$;

comment on function public.issue_credit_note(text, integer, text, text, text) is
  'CGST s.34 credit note on an issued invoice (R-1566: not draft/void). Lowers net_payable; money already paid past the new value → open customer credit (source credit_note); settled invoice → Paid. R-2178: re-syncs the linked subscription''s outstanding. Owner/manager/accountant/billing.';

revoke all on function public.issue_credit_note(text, integer, text, text, text) from public, anon;
grant execute on function public.issue_credit_note(text, integer, text, text, text) to authenticated, service_role;

-- ── issue_debit_note — R-1573 body (20261018224237) + R-2178 sync ─────────────────────────
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

commit;
