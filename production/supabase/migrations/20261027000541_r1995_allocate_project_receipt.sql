-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.allocate_project_receipt(uuid,uuid,jsonb,date,text)') and prosrc like '%R-1995%')
-- deploy-key: r1995allocateprojectreceipt
-- 20261027000541_r1995_allocate_project_receipt.sql
--
-- R-1995 (27 Oct 2026, p1, goal G-RECON — R-1910 audit cases 2, 3 and 4). ONE bank receipt pays
-- MANY project instalments, in ONE transaction (production/CLAUDE.md §17b).
--
-- Before: Banking → Reconcile → "Project payment" let the owner pick ONE milestone. A ₹2,36,000
-- receipt for kist 1 + kist 2 was booked whole on kist 1 (record_project_payment has no ceiling);
-- kist 2 stayed "due". The client also chained 2–5 separate RPCs (split → record → invoice), so a
-- failure half-way left half the work behind.
--
-- allocate_project_receipt(bank line, project, [{milestone_id, amount, raise_invoice}], received_at,
-- reference) — all or nothing:
--   * role gate (owner / manager / accountant / billing — same as record_project_payment, R-885);
--   * the bank line: locked FOR UPDATE; in this company; money in; not already reconciled; no project
--     payment on it yet (the R-1993 guards, same words);
--   * the allocations: at least one; each milestone once, of THIS project, in this company; amount > 0
--     and never more than the milestone's balance (part payment is fine);
--   * the allocations add up to EXACTLY the line. More than the line is refused. Less is refused too:
--     extra / early money becomes the customer's advance (decision D1) — that is R-1997, not built
--     yet, so the line cannot be left half-explained.
--   Then, in the order given (the client sends FIFO, R-1998), for each allocation:
--   * a part payment that is to be invoiced, on a milestone with no invoice and no payment yet, is
--     first carved out with split_project_milestone (so the invoice is for the money received);
--   * record_project_payment writes the payment (milestone status, invoice status — the same path as
--     a single receipt); the payment carries the bank line;
--   * raise_project_milestone_invoice raises the tax invoice when asked and none exists; its
--     paid_amount / status are then set from the milestone's payments (R-1910 case 3B — an invoice
--     raised after the money was received must not show it as due).
--   Finally the bank line is reconciled once (matched_to project → the first payment).
--
-- Not here: TDS inside the allocation (R-1996), leftover → advance (R-1997), undo of a multi-
-- instalment line (R-1999), the instalment-list UI (R-1998).
-- Test: supabase/tests/allocate_project_receipt_r1995.test.sql

begin;

create or replace function public.allocate_project_receipt(
  p_bank_txn_id  uuid,
  p_project_id   uuid,
  p_allocations  jsonb,
  p_received_at  date default null,
  p_reference    text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1995: one bank receipt → many project milestones, one transaction. */
  v_tenant    uuid := public.current_tenant_id();
  v_trusted   boolean;
  v_company   uuid;
  v_txn       record;
  v_proj      record;
  v_ms        record;
  v_ids       uuid[];
  v_amts      numeric[];
  v_raises    boolean[];
  v_on_line   integer;
  v_total     bigint := 0;
  v_paid      integer;
  v_target    uuid;
  v_pay_id    uuid;
  v_first_pay uuid;
  v_inv       text;
  v_inv_amt   integer;
  v_inv_paid  integer;
  v_date      date;
  v_ref       text;
  v_out       jsonb := '[]'::jsonb;
  v_raise     boolean;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted and not public.current_user_has_role('owner', 'manager', 'accountant', 'billing') then
    raise exception 'Only an owner, manager, accountant or billing user can record a project payment' using errcode = '42501';
  end if;
  if v_tenant is null and not v_trusted then
    raise exception 'No company on this login — sign in as a user of the company' using errcode = '28000';
  end if;

  -- ── the bank line (R-1993 guards, same words) ────────────────────────────────────────────
  select * into v_txn from public.bank_transactions where id = p_bank_txn_id for update;
  v_company := coalesce(v_tenant, v_txn.tenant_id);
  if p_bank_txn_id is null or v_txn.id is null or v_txn.tenant_id is distinct from v_company then
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
  if v_on_line > 0 then
    raise exception 'This bank line already carries project payments of ₹%. Un-reconcile it first on Banking, then share it across the instalments again.', v_on_line
      using errcode = 'check_violation', hint = '/accounting/banking';
  end if;

  -- ── the project ──────────────────────────────────────────────────────────────────────────
  select * into v_proj from public.project_sales where id = p_project_id for update;
  if v_proj.id is null or v_proj.tenant_id is distinct from v_company then
    raise exception 'Project not found in your company — pick the project again.'
      using errcode = 'insufficient_privilege', hint = '/projects';
  end if;
  if v_proj.status = 'cancelled' then
    raise exception 'Project "%" is cancelled, so it cannot take a payment — reopen it on the project page first.', v_proj.title
      using errcode = 'check_violation', hint = '/projects/' || p_project_id::text;
  end if;

  -- ── the allocations: shape, each milestone once, of this project, within its balance ────
  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 then
    raise exception 'Tick at least one instalment to put this receipt on.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from jsonb_array_elements(p_allocations) a
              where jsonb_typeof(a) <> 'object' or nullif(btrim(coalesce(a->>'milestone_id', '')), '') is null) then
    raise exception 'Every instalment line needs its milestone — pick the instalment again.' using errcode = 'check_violation';
  end if;
  /* Parsed into arrays in the given order (the client's FIFO order is kept). */
  select array_agg(nullif(btrim(e.a->>'milestone_id'), '')::uuid order by e.n),
         array_agg(coalesce(nullif(btrim(coalesce(e.a->>'amount', '')), '')::numeric, 0) order by e.n),
         array_agg(coalesce((e.a->>'raise_invoice')::boolean, false) order by e.n)
    into v_ids, v_amts, v_raises
    from jsonb_array_elements(p_allocations) with ordinality as e(a, n);

  if (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
    raise exception 'The same instalment is ticked twice — put its whole amount on one line.' using errcode = 'check_violation';
  end if;
  if exists (select 1 from unnest(v_amts) x where x <= 0 or x <> trunc(x)) then
    raise exception 'Every ticked instalment needs a whole-rupee amount more than ₹0 — untick the ones that get nothing.' using errcode = 'check_violation';
  end if;

  -- lock every milestone in one fixed order (no deadlock between two saves)
  perform 1 from public.project_milestones where id = any(v_ids) order by id for update;

  for i in 1 .. cardinality(v_ids) loop
    select * into v_ms from public.project_milestones where id = v_ids[i];
    if v_ms.id is null or v_ms.tenant_id is distinct from v_company or v_ms.project_id is distinct from p_project_id then
      raise exception 'An instalment does not belong to project "%" — pick the instalments of this project only.', v_proj.title
        using errcode = 'insufficient_privilege', hint = '/projects/' || p_project_id::text;
    end if;
    select coalesce(sum(amount), 0) into v_paid from public.project_payments where milestone_id = v_ms.id;
    if v_amts[i]::integer > v_ms.total_amount - v_paid then
      raise exception 'Instalment "%" has only ₹% left to pay (₹% of ₹% already received) — ₹% is more than that. Put the rest on the next instalment.',
        v_ms.label, greatest(v_ms.total_amount - v_paid, 0), v_paid, v_ms.total_amount, v_amts[i]::integer
        using errcode = 'check_violation', hint = '/projects/' || p_project_id::text;
    end if;
    v_total := v_total + v_amts[i]::integer;
  end loop;

  if v_total > v_txn.credit then
    raise exception 'The instalments add up to ₹%, more than this bank line (₹%). Lower the amounts to ₹% in all.', v_total, v_txn.credit, v_txn.credit
      using errcode = 'check_violation', hint = '/accounting/banking';
  end if;
  if v_total < v_txn.credit then
    raise exception 'The instalments add up to ₹%, but the bank line is ₹% — ₹% is not on any instalment. Tick the next instalment for the rest; money beyond the instalments due cannot be kept as an advance here yet.',
      v_total, v_txn.credit, v_txn.credit - v_total
      using errcode = 'check_violation', hint = '/projects/' || p_project_id::text;
  end if;

  -- ── write: per allocation, the same path as one receipt ─────────────────────────────────
  v_date := coalesce(p_received_at, v_txn.txn_date, public.ist_today());
  v_ref  := coalesce(nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(v_txn.reference, '')), ''));

  for i in 1 .. cardinality(v_ids) loop
    select * into v_ms from public.project_milestones where id = v_ids[i];
    v_target := v_ms.id;
    v_raise  := v_raises[i] and v_ms.invoice_id is null;

    /* Part payment to be invoiced on an untouched milestone: carve it out first, so the invoice
       is for the money received (split_project_milestone — same rule as the single receipt). */
    if v_raise and v_amts[i]::integer < v_ms.total_amount
       and not exists (select 1 from public.project_payments where milestone_id = v_ms.id) then
      v_target := public.split_project_milestone(v_ms.id, v_amts[i]::integer,
                    v_ms.label || ' — kist ' || to_char(v_date, 'YYYY-MM-DD'));
    end if;

    /* The payment through the one existing path. The line is attached below, after the R-1993
       guard in record_project_payment would otherwise see the line as already reconciled by the
       first allocation. */
    v_pay_id := public.record_project_payment(v_target, v_amts[i]::integer, 'bank_transfer', v_ref, v_date, null);
    update public.project_payments set bank_txn_id = p_bank_txn_id where id = v_pay_id;
    v_first_pay := coalesce(v_first_pay, v_pay_id);

    v_inv := null;
    if v_raise then
      v_inv := public.raise_project_milestone_invoice(v_target);
      /* R-1910 case 3B: the invoice is born after the payments — take paid_amount / status from
         them (the same sum sync_project_invoice_paid keeps on later payments). */
      select amount into v_inv_amt from public.invoices where id = v_inv;
      select coalesce(sum(pp.amount), 0) into v_inv_paid
        from public.project_payments pp
        join public.project_milestones m on m.id = pp.milestone_id
       where m.invoice_id = v_inv;
      update public.invoices
         set paid_amount = v_inv_paid,
             status      = (case when v_inv_paid >= coalesce(v_inv_amt, 0) then 'paid' else 'pending' end)::invoice_status
       where id = v_inv;
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'milestone_id', v_target, 'from_milestone_id', v_ms.id, 'amount', v_amts[i]::integer,
      'payment_id', v_pay_id, 'invoice_id', v_inv));
  end loop;

  -- ── the bank line, reconciled once ──────────────────────────────────────────────────────
  update public.bank_transactions
     set matched_to_type = 'project', matched_to_id = v_first_pay::text,
         matched_at = now(), match_confidence = 'manual'
   where id = p_bank_txn_id;

  return jsonb_build_object('bank_txn_id', p_bank_txn_id, 'project_id', p_project_id,
                            'total', v_total, 'allocations', v_out);
end;
$function$;

revoke all on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) from public, anon;
grant execute on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) to authenticated, service_role;

comment on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) is
  'R-1995: one bank receipt shared across many milestones of one project, in one transaction — line guards, per-milestone ceiling, split for invoiced part payments, payments, invoices (paid_amount from payments), line reconciled.';

commit;
