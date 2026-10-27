-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.record_project_payment(uuid,integer,text,text,date,uuid)') and prosrc like '%R-1993%')
-- deploy-key: r1993projectpaymentbankline
-- 20261026183034_r1993_project_payment_bank_line_guards.sql
--
-- R-1993 (26 Oct 2026, p1, goal G-RECON — R-1910 audit case 1, break-mode B1/B2). Money safety on
-- Banking → Reconcile → "Project payment":
--   B1  record_project_payment never looked at the bank line: the SAME line (double click, second
--       tab, another user) booked a second milestone — two project payments on one bank credit, the
--       line re-pointed at the last one.
--   B2  a ₹5,00,000 payment was recorded against a ₹1,18,000 line (no check against its credit).
--
-- Fix — record_project_payment, when it is given a bank line:
--   * locks the line (FOR UPDATE), so two saves on one line run one after the other;
--   * refuses a line that is not in this company, a money-out line, a line already reconciled
--     (same wording as reconcile_bank_credit_as_advance, R-1863), and an amount that — with the
--     project payments already on that line — is more than the line's credit.
--   Every refusal says the next step and carries HINT = the page to do it on (§24).
-- record_project_receipt_with_tds books its bank part through record_project_payment (its TDS part
-- has no bank line), so it gets the same guards with no change of its own, and a refusal rolls the
-- whole TDS receipt back.
--
-- Redefined from its LATEST definition: 20261024030326_r1816_money_rpcs_ist_today (R-885 role gate,
-- R-1816 ist_today); only the bank-line block below is new.
-- Test: supabase/tests/r1993_project_payment_bank_line_guards.test.sql

begin;

CREATE OR REPLACE FUNCTION public.record_project_payment(p_milestone_id uuid, p_amount integer, p_method text, p_reference text, p_received_at date, p_bank_txn_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_ms       record;
  v_pay_id   uuid;
  v_paid     integer;
  v_txn      record;   -- R-1993
  v_on_line  integer;  -- R-1993
begin
  /* R-885: role gate (Pardeep's role table, 11 Oct 2026 — record group: owner, manager, accountant, billing).
     Trusted = service_role or a direct DB session with no request role (R-454 / R-714 /
     R-717 / R-718); everyone else needs the role. */
  if not (coalesce(auth.role(), '') = 'service_role'
          or (auth.role() is null
              and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
     and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a project payment' using errcode = '42501';
  end if;
  select * into v_ms from public.project_milestones where id = p_milestone_id for update;
  if not found then raise exception 'Milestone not found'; end if;
  if (v_tenant is null and coalesce(auth.role(), '') in ('anon', 'authenticated')) or (v_tenant is not null and v_ms.tenant_id is distinct from v_tenant) then
    raise exception 'Milestone not in caller''s tenant' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(p_amount, 0) <= 0 then raise exception 'Amount must be > 0'; end if;

  /* R-1993 (R-1910 B1/B2): one bank credit pays project money once, and never more than it holds.
     The line is locked first, so a double click / second tab waits and then sees it reconciled. */
  if p_bank_txn_id is not null then
    select * into v_txn from public.bank_transactions where id = p_bank_txn_id for update;
    if not found or v_txn.tenant_id is distinct from v_ms.tenant_id then
      raise exception 'This bank line was not found in your company — pick the line again on Banking and reconcile it from there.'
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
    if coalesce(v_txn.credit, 0) <= 0 then
      raise exception 'This bank line is money out, so it cannot be a project receipt — pick the money-in line the customer paid on Banking.'
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
    if v_txn.matched_to_type is not null then
      raise exception 'This bank line is already reconciled (%). Un-reconcile it first on Banking if it was matched wrongly, then record the project payment again.', v_txn.matched_to_type
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
    select coalesce(sum(amount), 0) into v_on_line from public.project_payments where bank_txn_id = p_bank_txn_id;
    if v_on_line + p_amount > v_txn.credit then
      raise exception 'Project payment ₹% is more than this bank line can cover (line ₹%, already on project payments ₹%). Record at most ₹% from this line; book the rest from the bank line it came on.',
        p_amount, v_txn.credit, v_on_line, greatest(v_txn.credit - v_on_line, 0)
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
  end if;

  insert into public.project_payments
    (tenant_id, project_id, milestone_id, amount, method, reference, received_at, bank_txn_id)
  values
    (v_ms.tenant_id, v_ms.project_id, p_milestone_id, p_amount,
     nullif(trim(coalesce(p_method,'')),''), nullif(trim(coalesce(p_reference,'')),''),
     coalesce(p_received_at, public.ist_today()), p_bank_txn_id)
  returning id into v_pay_id;

  select coalesce(sum(amount), 0) into v_paid
    from public.project_payments where milestone_id = p_milestone_id;
  if v_paid >= v_ms.total_amount then
    update public.project_milestones set status = 'paid' where id = p_milestone_id;
    if v_ms.invoice_id is not null then
      update public.invoices set status = 'paid'::invoice_status, paid_date = coalesce(p_received_at, public.ist_today())
       where id = v_ms.invoice_id;
    end if;
  end if;

  if p_bank_txn_id is not null then
    update public.bank_transactions
       set matched_to_type = 'project', matched_to_id = v_pay_id::text,
           matched_at = now(), match_confidence = 'manual'
     where id = p_bank_txn_id and tenant_id = v_ms.tenant_id;
  end if;

  return v_pay_id;
end;
$function$
;

commit;
