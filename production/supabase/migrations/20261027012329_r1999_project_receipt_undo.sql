-- deploy-peek: to_regprocedure('public.project_receipt_undo_preview(uuid)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-1999%')
-- deploy-key: r1999projectreceiptundo
-- 20261027012329_r1999_project_receipt_undo.sql
--
-- R-1999 (27 Oct 2026, p1, goal G-RECON — R-1910 audit case 8): undo a wrong project-receipt match
-- in ONE place.
--
-- ─── THE GAP ─────────────────────────────────────────────────────────────────────────────────
--   Banking → a line booked as a project payment → Un-reconcile freed only the bank line. The dialog
--   said "remove the payment on the project page" — that page has no remove button. The wrong
--   project's payment stayed (kist Paid, invoice paid), now with no bank line, so the GL counted it
--   as Undeposited funds; booking the line again to the right project counted the same ₹ twice.
--   R-1995 / R-1996 (allocate_project_receipt[_with_tds]) put ONE line on SEVERAL kists, plus a
--   method 'tds' payment and a tds_receivable row per kist — the old preview read only the first
--   payment (matched_to_id).
--
-- ─── THE FIX ─────────────────────────────────────────────────────────────────────────────────
--   1. project_receipt_line_rows(txn) — internal: every project payment the line booked (bank part:
--      bank_txn_id = the line, or the payment matched_to_id names) and, through the tds_receivable
--      rows that name them ("project payments <bank> (bank) + <tds> (TDS)" — the note both
--      record_project_receipt_with_tds and allocate_project_receipt_with_tds write), the TDS
--      payments and TDS receivable rows of the same booking.
--   2. unreconcile_bank_receipt — from its LATEST body (R-1863, 20261024144118) + one branch: a
--      'project' line takes back the whole booking, atomically: the TDS receivable rows, the TDS
--      payments and the bank payments go; each kist's status is worked out again (paid / invoiced /
--      pending) and its invoice's paid_amount / status follow (trigger sync_project_invoice_paid);
--      the line is freed. Pardeep's decision D3 (26 Oct): every INVOICE STAYS — no credit note, the
--      GST series is never broken; the invoice simply shows as due again. A kist that a Save split
--      (split_project_milestone) is not joined back (its record stays).
--      Refused, nothing written, with a HINT = the page to fix it on: a TDS row whose certificate is
--      already in (cert_received / verified_26as …), a referral commission already PAID on one of
--      these payments, and a user who may not remove payments (owner / accountant, as the advance
--      branch — R-718 delete rule).
--   3. project_receipt_undo_preview(txn) — R-1920's pattern: per kist the state before, then the SAME
--      un-reconcile run inside a savepoint that is always rolled back; the "after" is what the undo
--      really does, a refusal comes back as {blocked, block_message, block_href}.
--
-- allocate_project_receipt / allocate_project_receipt_with_tds are NOT redefined (R-1996 owns them);
-- only their rows are read.
-- Test: supabase/tests/r1999_project_receipt_undo.test.sql

begin;

-- ── 1. What one project-receipt line booked ──────────────────────────────────────────────────
create or replace function public.project_receipt_line_rows(p_txn_id uuid)
returns table (payment_id uuid, kind text, tds_receivable_id text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_txn public.bank_transactions;
begin
  /* R-1999: the bank payments on the line, then the TDS payment + TDS receivable row the same
     booking wrote for each (linked only through the tds_receivable note, as written by
     record_project_receipt_with_tds and allocate_project_receipt_with_tds). */
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found then return; end if;

  return query
  with bank as (
    select pp.id
      from public.project_payments pp
     where pp.tenant_id = v_txn.tenant_id
       and (pp.bank_txn_id = p_txn_id
            or (v_txn.matched_to_type = 'project' and pp.id::text = v_txn.matched_to_id
                and pp.bank_txn_id is null and coalesce(pp.method, '') <> 'tds'))
  ),
  tds as (
    select t.id as tds_id, m[1]::uuid as bank_pay, m[2]::uuid as tds_pay
      from public.tds_receivable t
      cross join lateral regexp_match(coalesce(t.notes, ''),
        'project payments ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \(bank\) \+ ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) \(TDS\)') m
     where t.tenant_id = v_txn.tenant_id
       and t.notes like '%(bank) + %(TDS)%'
  )
  select b.id, 'bank'::text, null::text from bank b
  union all
  select pp.id, 'tds'::text, t.tds_id
    from tds t
    join bank b on b.id = t.bank_pay
    join public.project_payments pp on pp.id = t.tds_pay and pp.tenant_id = v_txn.tenant_id and pp.method = 'tds'
  union all
  /* a TDS row whose TDS payment is already gone still belongs to this booking */
  select null::uuid, 'tds_row'::text, t.tds_id
    from tds t
    join bank b on b.id = t.bank_pay
   where not exists (select 1 from public.project_payments pp where pp.id = t.tds_pay);
end;
$$;

revoke all on function public.project_receipt_line_rows(uuid) from public, anon, authenticated;
grant execute on function public.project_receipt_line_rows(uuid) to service_role;

comment on function public.project_receipt_line_rows(uuid) is
  'R-1999: every project payment one bank line booked (bank parts + the TDS payments and tds_receivable rows of the same booking). Internal — used by unreconcile_bank_receipt and project_receipt_undo_preview.';

-- ── 2. unreconcile_bank_receipt — R-1863 body + the project branch (R-1999) ──────────────────
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
  v_adv     public.payments;
  v_adv_open integer;
  v_adv_bad  integer;
  -- R-1999: the project branch
  v_pp_ids   uuid[];
  v_tds_rows text[];
  v_ms_ids   uuid[];
  v_inv_ids  text[];
  v_pp_bank  integer;
  v_pp_tds   integer;
  v_pp_n     integer;
  v_bad      record;
begin
  /* R-718: role gate (Pardeep's role table, 11 Oct 2026). Trusted = service_role or a direct
     DB session with no request role (R-454 / R-714 / R-717); everyone else needs the role. */
  if not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  /* R-718: "undo the sale" deletes the receipt — a delete, so owner / accountant only. */
  if p_undo_sale and not (coalesce(public.current_request_role(), '') = 'service_role'
          or (public.current_request_role() is null
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


  /* R-1999 (R-1910 c8, D3): a line booked as a PROJECT receipt — un-reconciling takes back the
     whole booking (every kist's bank part, its TDS payment and TDS receivable row), works each
     kist's status out again and frees the line, in this one transaction. Every invoice STAYS
     (D3: no credit note, the GST series is never broken) and shows as due again. */
  if v_txn.matched_to_type = 'project' then
    select array_agg(r.payment_id) filter (where r.payment_id is not null),
           array_agg(r.tds_receivable_id) filter (where r.tds_receivable_id is not null)
      into v_pp_ids, v_tds_rows
      from public.project_receipt_line_rows(p_txn_id) r;

    if coalesce(cardinality(v_pp_ids), 0) > 0 or coalesce(cardinality(v_tds_rows), 0) > 0 then
      perform 1 from public.project_payments where id = any(v_pp_ids) order by id for update;
      select coalesce(sum(amount) filter (where coalesce(method, '') <> 'tds'), 0)::int,
             coalesce(sum(amount) filter (where method = 'tds'), 0)::int,
             count(*)::int
        into v_pp_bank, v_pp_tds, v_pp_n
        from public.project_payments where id = any(v_pp_ids);

      if not (coalesce(public.current_request_role(), '') = 'service_role'
              or (public.current_request_role() is null
                  and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
         and not public.current_user_has_role('owner', 'accountant') then
        raise exception 'Un-reconciling this line removes the ₹% project payment it booked%. Only an owner or accountant can remove a payment — ask them to un-reconcile this line.',
          v_pp_bank, case when v_pp_tds > 0 then format(' (and ₹%s TDS)', v_pp_tds) else '' end
          using errcode = '42501';
      end if;

      /* A TDS the customer has already reported (certificate in / seen in 26AS) is not taken off here. */
      select t.id, t.tds_amount, t.status into v_bad
        from public.tds_receivable t
       where t.id = any(v_tds_rows) and t.status is distinct from 'pending_cert'
       order by t.id limit 1;
      if found then
        raise exception 'The ₹% TDS on this receipt (%) is already marked "%" on TDS receivable — the customer has reported it. Check it there (with your CA) before un-reconciling this line.',
          v_bad.tds_amount, v_bad.id, replace(v_bad.status, '_', ' ')
          using errcode = 'check_violation', hint = '/accounting/tds-receivable';
      end if;

      /* A referral commission already PAID out on one of these payments would be left with nothing behind it. */
      select rc.gross_commission as amount into v_bad
        from public.referral_commissions rc
       where rc.project_payment_id = any(v_pp_ids) and rc.status = 'paid'
       limit 1;
      if found then
        raise exception 'A referral commission of ₹% is already paid on this project payment. Undo that commission payment first (Referrals), then un-reconcile this line.',
          v_bad.amount using errcode = 'check_violation', hint = '/referrals';
      end if;

      select array_agg(distinct pp.milestone_id) filter (where pp.milestone_id is not null)
        into v_ms_ids
        from public.project_payments pp where pp.id = any(v_pp_ids);
      perform 1 from public.project_milestones where id = any(v_ms_ids) order by id for update;
      select array_agg(distinct m.invoice_id) filter (where m.invoice_id is not null)
        into v_inv_ids
        from public.project_milestones m where m.id = any(v_ms_ids);

      delete from public.tds_receivable where id = any(v_tds_rows) and tenant_id = v_tenant;
      -- the invoice's paid_amount / status follow through trg_project_payment_sync_invoice
      delete from public.project_payments where id = any(v_pp_ids) and tenant_id = v_tenant;

      update public.project_milestones m
         set status = case
               when (select coalesce(sum(pp.amount), 0) from public.project_payments pp where pp.milestone_id = m.id) >= m.total_amount then 'paid'
               when m.invoice_id is not null then 'invoiced'
               else 'pending' end
       where m.id = any(v_ms_ids);

      -- D3: the invoice stays; once it is not paid in full it has no paid date
      update public.invoices
         set paid_date = null, updated_at = now()
       where id = any(v_inv_ids) and tenant_id = v_tenant and status is distinct from 'paid'::invoice_status;

      select array_agg(i.id order by i.id) into v_inv_ids
        from public.invoices i where i.id = any(v_inv_ids) and i.status is distinct from 'paid'::invoice_status;

      update public.project_sales set updated_at = now()
       where id in (select distinct m.project_id from public.project_milestones m where m.id = any(v_ms_ids));
    end if;

    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', null,
      'project_payments_removed', coalesce(v_pp_n, 0),
      'project_amount_removed', coalesce(v_pp_bank, 0),
      'project_tds_removed', coalesce(v_pp_tds, 0),
      'invoices_due_again', coalesce(to_jsonb(v_inv_ids), '[]'::jsonb));
  end if;

  /* R-1863: a line booked as a customer's ADVANCE — un-reconciling takes the advance back:
     its receipt and its credit go, so the money is not counted with no bank line behind it. */
  if v_txn.matched_to_type = 'payment' and v_txn.matched_to_id is not null
     and public.bank_advance_payment(v_txn.matched_to_id::uuid) then
    select * into v_adv from public.payments where id = v_txn.matched_to_id::uuid for update;
    if not (coalesce(public.current_request_role(), '') = 'service_role'
            or (public.current_request_role() is null
                and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
       and not public.current_user_has_role('owner', 'accountant') then
      raise exception 'Un-reconciling this line removes the ₹% advance it booked (receipt %). Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
        v_adv.amount, coalesce(v_adv.receipt_voucher_no, v_adv.id::text) using errcode = '42501';
    end if;
    perform 1 from public.customer_credits cc
      where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id for update;
    select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
           coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
      into v_adv_open, v_adv_bad
      from public.customer_credits cc
     where cc.tenant_id = v_tenant and cc.source_payment_id = v_adv.id;
    if v_adv_bad > 0 or v_adv_open <> v_adv.amount then
      raise exception 'This line''s ₹% advance has ₹% already used or refunded, so it cannot be taken back. Undo that first: on the customer''s Payments, delete or refund the payment that used the credit (the credit opens again), then un-reconcile this line.',
        v_adv.amount, v_adv.amount - v_adv_open using errcode = 'check_violation';
    end if;

    perform public.reconcile_bank_txn(p_txn_id, null, null, 'manual');
    perform public.delete_payment(v_adv.id);
    update public.quotes
       set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
           payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
     where id = v_adv.quote_id and tenant_id = v_tenant;

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', v_adv.id, 'advance_removed', v_adv.amount);
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
    /* R-1863: the receipt voucher number stays in the record, marked cancelled (CGST 31(3)(d)
       series — never deleted or re-issued), as delete_payment does since R-1568. */
    if v_pay.receipt_voucher_no is not null then
      insert into public.cancelled_vouchers
        (tenant_id, doc_type, doc_no, payment_id, quote_id, customer_id, amount, credit_applied,
         received_at, reason, cancelled_by)
      values
        (v_pay.tenant_id, 'receipt_voucher', v_pay.receipt_voucher_no, v_pay.id, v_pay.quote_id,
         v_pay.customer_id, v_pay.amount, coalesce(v_pay.credit_applied, 0),
         v_pay.received_at, 'Bank sale undone — bank line un-reconciled', public.current_user_id());
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
$function$;

revoke all on function public.unreconcile_bank_receipt(uuid, boolean) from public, anon;
grant execute on function public.unreconcile_bank_receipt(uuid, boolean) to authenticated, service_role;

-- ── 3. What un-reconciling this project line will do — the Undo preview (R-1920 pattern) ────
create or replace function public.project_receipt_undo_preview(p_txn_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_trusted boolean;
  v_tenant  uuid;
  v_txn     public.bank_transactions;
  v_rows    jsonb := '[]'::jsonb;
  v_out     jsonb := '[]'::jsonb;
  v_row     jsonb;
  v_after   jsonb;
  v_blocked boolean := false;
  v_msg     text;
  v_hint    text;
  v_cust    text;
  v_proj    text;
  i         integer;
begin
  /* R-1999: same gate as un-reconciling (R-718 money roles); reads only — the dry run below is
     always rolled back. */
  v_trusted := coalesce(public.current_request_role(), '') = 'service_role'
               or (public.current_request_role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_tenant := public.current_tenant_id();
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in again.' using errcode = '28000';
  end if;
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can un-match a bank line' using errcode = '42501';
  end if;
  select * into v_txn from public.bank_transactions where id = p_txn_id;
  if not found or (v_tenant is not null and v_txn.tenant_id is distinct from v_tenant) then
    raise exception 'Bank transaction not found' using errcode = 'no_data_found';
  end if;
  if v_txn.matched_to_type is distinct from 'project' then
    raise exception 'This line is not a project payment.' using errcode = '22023';
  end if;

  -- Before: per kist, what this line put on it (bank + TDS) and how it stands now.
  select coalesce(jsonb_agg(s.x order by s.o_title, s.o_seq, s.o_id), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'milestone_id', m.id,
               'label', m.label,
               'project_id', ps.id,
               'project_title', ps.title,
               'customer_name', ps.customer_name,
               'total', m.total_amount,
               'bank', coalesce(sum(pp.amount) filter (where r.kind = 'bank'), 0),
               'tds', coalesce(sum(pp.amount) filter (where r.kind = 'tds'), 0),
               'before_paid', (select coalesce(sum(q.amount), 0) from public.project_payments q where q.milestone_id = m.id),
               'before_status', m.status,
               'invoice_id', m.invoice_id,
               'invoice_status_before', (select i.status::text from public.invoices i where i.id = m.invoice_id),
               'href', '/projects/' || ps.id::text) as x,
             ps.title as o_title, m.seq as o_seq, m.id as o_id
        from public.project_receipt_line_rows(p_txn_id) r
        join public.project_payments pp on pp.id = r.payment_id
        join public.project_milestones m on m.id = pp.milestone_id
        join public.project_sales ps on ps.id = m.project_id
       group by m.id, ps.id
    ) s;

  if jsonb_array_length(v_rows) > 0 then
    v_cust := v_rows->0->>'customer_name';
    v_proj := v_rows->0->>'project_title';
  end if;

  -- After: run the real un-reconcile (it is the single writer) and always roll it back.
  begin
    perform public.unreconcile_bank_receipt(p_txn_id, false);
    for i in 0 .. jsonb_array_length(v_rows) - 1 loop
      v_row := v_rows->i;
      select jsonb_build_object(
               'after_paid', (select coalesce(sum(q.amount), 0) from public.project_payments q where q.milestone_id = m.id),
               'after_status', m.status,
               'invoice_status_after', (select iv.status::text from public.invoices iv where iv.id = m.invoice_id))
        into v_after
        from public.project_milestones m where m.id = (v_row->>'milestone_id')::uuid;
      v_out := v_out || (v_row || coalesce(v_after, '{}'::jsonb));
    end loop;
    raise exception 'R-1999 dry run' using errcode = 'R1999';
  exception
    when sqlstate 'R1999' then
      null;
    when others then
      get stacked diagnostics v_msg = message_text, v_hint = pg_exception_hint;
      v_blocked := true;
      v_out := v_rows;
  end;

  return jsonb_build_object(
    'txn_id', v_txn.id, 'credit', v_txn.credit, 'txn_date', v_txn.txn_date,
    'customer_name', v_cust, 'project_title', v_proj,
    'rows', v_out,
    'bank_total', (select coalesce(sum((x->>'bank')::int), 0) from jsonb_array_elements(v_rows) x),
    'tds_total', (select coalesce(sum((x->>'tds')::int), 0) from jsonb_array_elements(v_rows) x),
    'blocked', v_blocked,
    'block_message', v_msg,
    'block_href', nullif(v_hint, ''));
end;
$$;

revoke all on function public.project_receipt_undo_preview(uuid) from public, anon;
grant execute on function public.project_receipt_undo_preview(uuid) to authenticated, service_role;

comment on function public.project_receipt_undo_preview(uuid) is
  'R-1999: what un-reconciling a project-receipt bank line does — per kist before / after (from a rolled-back dry run of unreconcile_bank_receipt), or {blocked, block_message, block_href}.';

commit;
