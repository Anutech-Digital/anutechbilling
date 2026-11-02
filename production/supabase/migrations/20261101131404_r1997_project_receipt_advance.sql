-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.allocate_project_receipt_with_tds(uuid,uuid,jsonb,jsonb,date,text)') and prosrc like '%R-1997%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.unreconcile_bank_receipt(uuid,boolean)') and prosrc like '%R-1997%')
-- deploy-key: r1997projectreceiptadvance
-- 20261101131404_r1997_project_receipt_advance.sql
--
-- R-1997 (1 Nov 2026, p1, goal G-RECON — R-1910 audit case 4). Money beyond the instalments of a
-- project receipt becomes the customer's ADVANCE (Pardeep's decision D1, 26 Oct: extra / early money
-- = the customer's advance credit, like Zoho — a liability in the books, used later in one click).
--
-- Before: ₹1,50,000 in the bank against a ₹1,18,000 instalment was refused ("money beyond the
-- instalments due cannot be kept as an advance here yet") — the ₹32,000 had no home.
--
-- WHAT CHANGES
--   1. allocate_project_receipt_with_tds — from its LATEST body (R-1996, 20261027005624) + the
--      leftover: L = bank line + TDS − the instalments ticked. L > 0 → after the instalments,
--      bank_credit_book_advance (R-2098 — R-1863's ₹0 "Advance on account" holder quote + receipt
--      voucher + ONE open customer_credits row, source 'overpayment', source_payment_id) for the
--      project's customer, and that receipt carries payments.bank_txn_id = the line (set AFTER the
--      line is reconciled — trg_bank_split_line_unmatched clears it on a match change). So:
--        * the Balance Sheet reads it as R-1863 / R-2098 do: banked (not Undeposited funds — the
--          line already counts in the bank), Advances from customers + L;
--        * Record payment → "Use advance" (record_desk_payment → redeem_customer_credits) uses it,
--          unchanged.
--      The UI still fills the instalments oldest first (R-1998), so L > 0 only when the owner ticks
--      fewer than the money settles. With TDS and L > 0, a TDS more than its rate on the
--      instalments ticked (+₹1 rounding) is refused — then it is a typo, not an advance.
--      A project with no customer cannot keep an advance → refused with the old words.
--      The result gains advance, advance_payment_id, advance_credit_id, advance_receipt_voucher_no.
--   2. unreconcile_bank_receipt — from its LATEST body (R-1999, 20261027012329) + in the project
--      branch: the line's advance receipts (payments.bank_txn_id = the line, bank_advance_payment)
--      are taken back with the kists — R-1863's rule: refused while any of that credit is used or
--      refunded (nothing changed); else delete_payment (receipt voucher kept as cancelled, credit
--      removed) and the holder quote rejected. project_receipt_undo_preview runs this same function
--      in a rolled-back savepoint, so its "blocked" follows by itself.
--   allocate_project_receipt (5 arguments) is unchanged — it calls the _with_tds body.
-- Test: supabase/tests/r1997_project_receipt_advance.test.sql

begin;

create or replace function public.allocate_project_receipt_with_tds(
  p_bank_txn_id  uuid,
  p_project_id   uuid,
  p_allocations  jsonb,
  p_tds          jsonb,
  p_received_at  date default null,
  p_reference    text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1996: one bank receipt (+ the customer's TDS) → many project milestones, one transaction.
     Body of R-1995's allocate_project_receipt + the TDS part.
     R-1997: money beyond the instalments ticked → the customer's advance (decision D1). */
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
  -- R-1996: TDS
  v_tds       integer := 0;
  v_tds_num   numeric;
  v_rate      numeric;
  v_section   text;
  v_base_num  numeric;
  v_base      bigint;
  v_shares    integer[] := '{}';
  v_bases     integer[] := '{}';
  v_sum_share integer := 0;
  v_sum_base  bigint := 0;
  v_tds_pay   uuid;
  v_tds_row   text;
  v_n         integer;
  -- R-1997: money beyond the instalments → the customer's advance
  v_left      integer := 0;
  v_adv       jsonb;
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

  -- ── the TDS the customer withheld (R-1996) — read first, nothing written yet ───────────────
  if p_tds is not null and jsonb_typeof(p_tds) <> 'null' then
    if jsonb_typeof(p_tds) <> 'object' then
      raise exception 'The TDS line is not readable — tick "TDS deducted?" again and fill the section and amount.' using errcode = 'check_violation';
    end if;
    begin
      v_tds_num  := nullif(btrim(coalesce(p_tds->>'amount', '')), '')::numeric;
      v_rate     := nullif(btrim(coalesce(p_tds->>'rate_pct', '')), '')::numeric;
      v_base_num := nullif(btrim(coalesce(p_tds->>'base', '')), '')::numeric;
    exception when invalid_text_representation then
      raise exception 'The TDS amount, rate and base must be numbers.' using errcode = 'check_violation';
    end;
    if v_tds_num is null or v_tds_num <= 0 or v_tds_num <> trunc(v_tds_num) then
      raise exception 'TDS must be a whole-rupee amount more than ₹0 (the customer''s TDS on this receipt) — or untick "TDS deducted?".' using errcode = 'check_violation';
    end if;
    if v_rate is null or v_rate <= 0 or v_rate > 100 then
      raise exception 'Pick the TDS section and rate the customer deducted at (for example 194J · 10%%).' using errcode = 'check_violation';
    end if;
    if v_base_num is not null and (v_base_num <= 0 or v_base_num <> trunc(v_base_num)) then
      raise exception 'The TDS base must be a whole-rupee amount more than ₹0.' using errcode = 'check_violation';
    end if;
    v_tds     := v_tds_num::integer;
    v_base    := v_base_num::bigint;
    v_section := coalesce(nullif(btrim(coalesce(p_tds->>'section', '')), ''), '194J');
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

  if v_tds > 0 then
    /* R-1996: what the kists settle = bank line + TDS. R-1997: less is fine — the rest is the
       customer's advance; more is still refused. */
    if v_total > v_txn.credit + v_tds then
      raise exception 'The instalments ticked add up to ₹%, but the bank line ₹% + TDS ₹% = ₹% (% by ₹%). Change the instalment amounts or the TDS so they match.',
        v_total, v_txn.credit, v_tds, v_txn.credit + v_tds,
        'short', v_total - (v_txn.credit + v_tds)
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
    /* R-1997: with money left over, a TDS more than its rate on the instalments it is deducted on
       is a typo (it would turn into advance), not an advance. ₹1 for rounding. */
    if v_total < v_txn.credit + v_tds and v_tds > ceil(v_total * v_rate / 100) + 1 then
      raise exception 'TDS ₹% is more than % %% of the instalments ticked (₹%), and ₹% would be left over as an advance. Check the TDS amount (as on the customer''s Form 16A), or tick the instalments it was deducted on.',
        v_tds, v_rate, v_total, v_txn.credit + v_tds - v_total
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
  else
    if v_total > v_txn.credit then
      raise exception 'The instalments add up to ₹%, more than this bank line (₹%). Lower the amounts to ₹% in all.', v_total, v_txn.credit, v_txn.credit
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
  end if;

  /* R-1997 (D1): money beyond the instalments ticked is the customer's advance. */
  v_left := (v_txn.credit + v_tds - v_total)::integer;
  if v_left > 0 and v_proj.customer_id is null then
    raise exception 'The instalments add up to ₹%, but the bank line is ₹% — ₹% is not on any instalment, and project "%" has no customer to keep it as an advance for. Tick the next instalment for the rest, or set the project''s customer first.',
      v_total, v_txn.credit + v_tds, v_left, v_proj.title
      using errcode = 'check_violation', hint = '/projects/' || p_project_id::text;
  end if;

  -- ── R-1996: the TDS split, pro-rata on what each kist settles; remainder on the last ─────
  v_n := cardinality(v_ids);
  for i in 1 .. v_n loop
    if i < v_n then
      v_shares := v_shares || floor(v_tds::numeric * v_amts[i] / v_total)::integer;
      v_bases  := v_bases  || (case when v_base is not null then floor(v_base::numeric * v_amts[i] / v_total)
                                    else round(v_amts[i] * 100 / (100 + coalesce(v_proj.gst_rate, 0))) end)::integer;
    else
      v_shares := v_shares || (v_tds - v_sum_share);
      v_bases  := v_bases  || (case when v_base is not null then v_base - v_sum_base
                                    else round(v_amts[i] * 100 / (100 + coalesce(v_proj.gst_rate, 0))) end)::integer;
    end if;
    v_sum_share := v_sum_share + v_shares[i];
    v_sum_base  := v_sum_base + v_bases[i];
    if v_shares[i] >= v_amts[i]::integer then
      raise exception 'TDS ₹% on instalment "%" would leave nothing from the bank for it (it settles ₹%). Check the TDS amount.',
        v_shares[i], (select label from public.project_milestones where id = v_ids[i]), v_amts[i]::integer
        using errcode = 'check_violation';
    end if;
  end loop;

  -- ── write: per allocation, the same path as one receipt ─────────────────────────────────
  v_date := coalesce(p_received_at, v_txn.txn_date, public.ist_today());
  v_ref  := coalesce(nullif(btrim(coalesce(p_reference, '')), ''), nullif(btrim(coalesce(v_txn.reference, '')), ''));

  for i in 1 .. v_n loop
    select * into v_ms from public.project_milestones where id = v_ids[i];
    v_target := v_ms.id;
    v_raise  := v_raises[i] and v_ms.invoice_id is null;

    /* Part payment to be invoiced on an untouched milestone: carve it out first, so the invoice
       is for the money settled (bank + TDS) (split_project_milestone — same rule as one receipt). */
    if v_raise and v_amts[i]::integer < v_ms.total_amount
       and not exists (select 1 from public.project_payments where milestone_id = v_ms.id) then
      v_target := public.split_project_milestone(v_ms.id, v_amts[i]::integer,
                    v_ms.label || ' — kist ' || to_char(v_date, 'YYYY-MM-DD'));
    end if;

    /* The bank part through the one existing path. The line is attached below, after the R-1993
       guard in record_project_payment would otherwise see the line as already reconciled by the
       first allocation. */
    v_pay_id := public.record_project_payment(v_target, v_amts[i]::integer - v_shares[i], 'bank_transfer', v_ref, v_date, null);
    update public.project_payments set bank_txn_id = p_bank_txn_id where id = v_pay_id;
    v_first_pay := coalesce(v_first_pay, v_pay_id);

    /* R-1996: the TDS part — a project payment with method 'tds' and no bank line, the way
       record_project_receipt_with_tds books it (R-1992 keeps it out of Undeposited funds). */
    v_tds_pay := null;
    if v_shares[i] > 0 then
      v_tds_pay := public.record_project_payment(v_target, v_shares[i], 'tds',
                     format('TDS %s @ %s%% on ₹%s', v_section, v_rate, v_bases[i]), v_date, null);
    end if;

    v_inv := null;
    if v_raise then
      v_inv := public.raise_project_milestone_invoice(v_target);
      /* R-1910 case 3B: the invoice is born after the payments — take paid_amount / status from
         them (the same sum sync_project_invoice_paid keeps on later payments; TDS part included). */
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

    /* R-1996: one TDS receivable row per kist, linked to its invoice (raised now or already there). */
    v_tds_row := null;
    if v_shares[i] > 0 then
      v_tds_row := 'TDS-' || upper(substr(md5(random()::text || clock_timestamp()::text || i::text), 1, 10));
      insert into public.tds_receivable (
        id, tenant_id, invoice_id, payment_id, customer_id, customer_name, section, rate_pct,
        gross_amount, tds_amount, net_paid, fiscal_year, payment_received_date, status, notes
      ) values (
        v_tds_row, v_company,
        coalesce(v_inv, (select invoice_id from public.project_milestones where id = v_target)),
        null, v_proj.customer_id, coalesce(v_proj.customer_name, ''), v_section, v_rate,
        v_bases[i], v_shares[i], v_amts[i]::integer - v_shares[i],
        public.indian_fiscal_year(v_date), v_date, 'pending_cert',
        format('Project %s · milestone "%s" · project payments %s (bank) + %s (TDS) · bank line %s',
               v_proj.title, v_ms.label, v_pay_id, v_tds_pay, p_bank_txn_id)
      );
    end if;

    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'milestone_id', v_target, 'from_milestone_id', v_ms.id, 'amount', v_amts[i]::integer,
      'bank', v_amts[i]::integer - v_shares[i], 'tds', v_shares[i],
      'payment_id', v_pay_id, 'tds_payment_id', v_tds_pay, 'tds_receivable', v_tds_row,
      'invoice_id', coalesce(v_inv, case when v_tds_row is not null
                                         then (select invoice_id from public.project_milestones where id = v_target) end)));
  end loop;

  -- ── the bank line, reconciled once ──────────────────────────────────────────────────────
  update public.bank_transactions
     set matched_to_type = 'project', matched_to_id = v_first_pay::text,
         matched_at = now(), match_confidence = 'manual'
   where id = p_bank_txn_id;

  /* R-1997 (D1): the rest → the customer's advance — R-1863's receipt + open credit (source
     'overpayment'), through R-2098's one booking. The receipt hangs on this line by
     payments.bank_txn_id, set AFTER the line is matched (trg_bank_split_line_unmatched clears it
     on a match change): banked, not Undeposited funds; taken back by un-reconcile. */
  if v_left > 0 then
    v_adv := public.bank_credit_book_advance(p_bank_txn_id, v_proj.customer_id, v_left);
    update public.payments set bank_txn_id = p_bank_txn_id
     where id = (v_adv->>'payment_id')::uuid and tenant_id = v_company;
  end if;

  return jsonb_build_object('bank_txn_id', p_bank_txn_id, 'project_id', p_project_id,
                            'total', v_total, 'bank', v_total - v_tds, 'tds', v_tds,
                            'allocations', v_out,
                            'advance', v_left,
                            'advance_payment_id', v_adv->>'payment_id',
                            'advance_credit_id', v_adv->>'credit_id',
                            'advance_receipt_voucher_no', v_adv->>'receipt_voucher_no',
                            'customer_name', coalesce(v_adv->>'customer_name', v_proj.customer_name));
end;
$function$;

revoke all on function public.allocate_project_receipt_with_tds(uuid, uuid, jsonb, jsonb, date, text) from public, anon;
grant execute on function public.allocate_project_receipt_with_tds(uuid, uuid, jsonb, jsonb, date, text) to authenticated, service_role;


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
  -- R-1997: the line's advance receipts
  v_adv_ids   uuid[];
  v_adv_total integer;
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

    /* R-1997: the money this line kept as the customer's ADVANCE (allocate_project_receipt_with_tds
       — R-1863's receipt + credit, payments.bank_txn_id = the line) goes back with the kists.
       R-1863's rule: refused while any of that credit is used or refunded; owner / accountant
       (removing a receipt). Read now — un-matching the line clears bank_txn_id (R-2098 trigger). */
    select array_agg(p.id order by p.id), coalesce(sum(p.amount), 0)::int
      into v_adv_ids, v_adv_total
      from public.payments p
     where p.tenant_id = v_tenant and p.bank_txn_id = p_txn_id
       and public.bank_advance_payment(p.id);
    if coalesce(cardinality(v_adv_ids), 0) > 0 then
      perform 1 from public.payments where id = any(v_adv_ids) order by id for update;
      if not (coalesce(public.current_request_role(), '') = 'service_role'
              or (public.current_request_role() is null
                  and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime')))
         and not public.current_user_has_role('owner', 'accountant') then
        raise exception 'Un-reconciling this line removes the ₹% advance it kept for the customer. Only an owner or accountant can remove a receipt — ask them to un-reconcile this line.',
          v_adv_total using errcode = '42501';
      end if;
      perform 1 from public.customer_credits cc
        where cc.tenant_id = v_tenant and cc.source_payment_id = any(v_adv_ids) order by cc.id for update;
      select coalesce(sum(cc.amount) filter (where cc.status = 'open'), 0)::int,
             coalesce(sum(cc.amount) filter (where cc.status <> 'open'), 0)::int
        into v_adv_open, v_adv_bad
        from public.customer_credits cc
       where cc.tenant_id = v_tenant and cc.source_payment_id = any(v_adv_ids);
      if v_adv_bad > 0 or v_adv_open <> v_adv_total then
        raise exception 'This line''s ₹% advance has ₹% already used or refunded, so it cannot be taken back. Undo that first: on the customer''s Payments, delete or refund the payment that used the credit (the credit opens again), then un-reconcile this line.',
          v_adv_total, v_adv_total - v_adv_open using errcode = 'check_violation', hint = '/payments';
      end if;
    end if;

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

    /* R-1997: the advance receipt(s) go as R-1863's do — delete_payment (voucher kept as
       cancelled, open credit removed), holder quote rejected. */
    if coalesce(cardinality(v_adv_ids), 0) > 0 then
      for i in 1 .. cardinality(v_adv_ids) loop
        select * into v_adv from public.payments where id = v_adv_ids[i];
        perform public.delete_payment(v_adv.id);
        update public.quotes
           set status = 'rejected'::quote_status, payment_status = 'none'::payment_status, payment_amount = 0,
               payment_method = null, payment_reference = null, payment_received_at = null, payment_notes = null
         where id = v_adv.quote_id and tenant_id = v_tenant;
      end loop;
    end if;

    return jsonb_build_object(
      'unreconciled', true, 'invoice_voided', null, 'invoice_credited', null, 'credit_note_id', null,
      'receipt_removed', null,
      'advance_removed', coalesce(v_adv_total, 0),
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

commit;
