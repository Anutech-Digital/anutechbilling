-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.allocate_project_receipt_with_tds(uuid,uuid,jsonb,jsonb,date,text)') and prosrc like '%R-1996%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.allocate_project_receipt(uuid,uuid,jsonb,date,text)') and prosrc like '%R-1996%')
-- deploy-key: r1996allocateprojectreceipttds
-- 20261027005624_r1996_allocate_project_receipt_tds.sql
--
-- R-1996 (27 Oct 2026, p1, goal G-RECON — R-1910 audit case 5). TDS inside the one-Save project
-- receipt (R-1995).
--
-- Before: a customer who pays kist 1 + kist 2 less TDS (₹2,12,400 in the bank for 2 × ₹1,18,000,
-- ₹23,600 withheld) had no path. allocate_project_receipt wants the kists to add up to the bank line
-- exactly, and record_project_receipt_with_tds takes ONE milestone only.
--
-- allocate_project_receipt_with_tds(bank line, project, [{milestone_id, amount, raise_invoice}],
--   p_tds {section, rate_pct, amount[, base]}, received_at, reference) — all or nothing:
--   * everything allocate_project_receipt did (R-1995 guards, splits, invoices, line reconciled once);
--   * `amount` per kist is what the kist SETTLES (bank part + TDS part). Bank line + TDS = the kists
--     ticked, to the rupee; more or less is refused, naming the TDS;
--   * the TDS is split pro-rata on what each kist settles (decision in the R-1910 audit: Zoho /
--     Tally / record_instalment_payment). One project rate of GST per project, so this is also
--     pro-rata on each kist's taxable value. Rounded down per kist, the remainder on the LAST kist,
--     so the parts add up exactly;
--   * per kist: the bank part is a project payment on the line; the TDS part a project payment with
--     method 'tds' and no bank line (the way record_project_receipt_with_tds books it — R-1992 keeps
--     it out of Undeposited funds); the invoice is raised after both, so it is born Paid; then ONE
--     tds_receivable row per kist, linked to that kist's invoice (the one raised now or the one it
--     already had — no more NULL invoice_id on a part payment that is invoiced in the same Save);
--   * the TDS base (gross_amount on tds_receivable) is `base` split the same way when given, else
--     each kist's taxable value (amount × 100 / (100 + project GST rate)).
--   p_tds null → no TDS, exactly the R-1995 behaviour.
--
-- allocate_project_receipt (5 arguments, R-1995) stays for its callers and now just calls this with
-- no TDS — one body, no drift.
--
-- Not here: undo of the TDS rows when the line is un-reconciled (R-1999), the TDS line in the
-- instalment-list UI (R-1998), leftover → advance (R-1997).
-- Test: supabase/tests/allocate_project_receipt_tds_r1996.test.sql

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
     Body of R-1995's allocate_project_receipt + the TDS part. */
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
    /* R-1996: what the kists settle = bank line + TDS, to the rupee. */
    if v_total <> v_txn.credit + v_tds then
      raise exception 'The instalments ticked add up to ₹%, but the bank line ₹% + TDS ₹% = ₹% (% by ₹%). Change the instalment amounts or the TDS so they match.',
        v_total, v_txn.credit, v_tds, v_txn.credit + v_tds,
        case when v_total > v_txn.credit + v_tds then 'short' else 'over' end, abs(v_total - (v_txn.credit + v_tds))
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
  else
    if v_total > v_txn.credit then
      raise exception 'The instalments add up to ₹%, more than this bank line (₹%). Lower the amounts to ₹% in all.', v_total, v_txn.credit, v_txn.credit
        using errcode = 'check_violation', hint = '/accounting/banking';
    end if;
    if v_total < v_txn.credit then
      raise exception 'The instalments add up to ₹%, but the bank line is ₹% — ₹% is not on any instalment. Tick the next instalment for the rest; money beyond the instalments due cannot be kept as an advance here yet.',
        v_total, v_txn.credit, v_txn.credit - v_total
        using errcode = 'check_violation', hint = '/projects/' || p_project_id::text;
    end if;
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

  return jsonb_build_object('bank_txn_id', p_bank_txn_id, 'project_id', p_project_id,
                            'total', v_total, 'bank', v_total - v_tds, 'tds', v_tds,
                            'allocations', v_out);
end;
$function$;

revoke all on function public.allocate_project_receipt_with_tds(uuid, uuid, jsonb, jsonb, date, text) from public, anon;
grant execute on function public.allocate_project_receipt_with_tds(uuid, uuid, jsonb, jsonb, date, text) to authenticated, service_role;

comment on function public.allocate_project_receipt_with_tds(uuid, uuid, jsonb, jsonb, date, text) is
  'R-1996: one bank receipt + the customer''s TDS shared across many milestones of one project, in one transaction — R-1995 guards, bank + TDS = the kists ticked, TDS split pro-rata (remainder on the last), method tds payments, one tds_receivable row per kist linked to its invoice.';

-- R-1995's entry point, kept for its callers: the same work with no TDS (one body — R-1996).
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
begin
  /* R-1995: one bank receipt → many project milestones, one transaction.
     R-1996: the body lives in allocate_project_receipt_with_tds; this is it with no TDS. */
  return public.allocate_project_receipt_with_tds(p_bank_txn_id, p_project_id, p_allocations, null, p_received_at, p_reference);
end;
$function$;

revoke all on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) from public, anon;
grant execute on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) to authenticated, service_role;

comment on function public.allocate_project_receipt(uuid, uuid, jsonb, date, text) is
  'R-1995: one bank receipt shared across many milestones of one project, in one transaction. R-1996: now allocate_project_receipt_with_tds with no TDS.';

commit;
