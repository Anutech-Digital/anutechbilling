-- deploy-peek: to_regprocedure('public.razorpay_batch_run_start(uuid)') is not null and to_regprocedure('public.reconcile_razorpay_settlement_in_run(uuid,uuid,jsonb)') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.undo_bank_recon_run(uuid)') and prosrc like '%R-2654%')
-- deploy-key: r2654razorpaymonthbatch
-- 20261110054124_r2654_razorpay_month_batch.sql
--
-- R-2654 (10 Nov 2026, p0 money, G-RECON plan N2): HDFC 4523 has 138 open Razorpay settlement lines and
-- R-2099's settlement path books them one line at a time (3-4 min each). The bank page now reads a whole
-- month of Razorpay settlements once (src/lib/razorpay/settlement-batch*.ts), pairs each open Razorpay line
-- by settlement UTR / amount, and books every READY line in one run with a run id and "Undo this run".
-- This file is the database half of that run, on R-2535's run tables (bank_recon_runs / _lines):
--
--   bank_recon_runs.source       + 'razorpay_batch'      (was 'zoho_bulk' only)
--   bank_recon_run_lines.kind    + 'razorpay_settlement'
--   razorpay_batch_run_start(account)  - a new Razorpay-batch run for the caller's own account
--                                        (R-2535's gate: owner / accountant, own company).
--   reconcile_razorpay_settlement_in_run(run, txn, settlement) - ONE transaction: the line is booked by
--     R-2099's reconcile_razorpay_settlement (unchanged - every number re-checked there; it only links
--     the EXISTING receipts and books the unbooked fee remainder, never a sale or an invoice, so R-2621 /
--     R-2627 / R-2631's filed-GST rules are not touched) AND recorded on the run. A line another live run
--     holds, a run that is undone / of another account / not a Razorpay batch is refused before anything
--     is written. Booking twice is refused by R-2099 itself (line already reconciled; settlement and
--     Razorpay ids are unique).
--   undo_bank_recon_run(run) <- 20261107043907_r2535_bank_recon_runs (its only body). New branch: a line
--     of kind 'razorpay_settlement' still matched as the run left it goes back through
--     unreconcile_bank_receipt(line, false) - the Reconcile sheet's own plain un-reconcile; R-2099's
--     trigger removes the settlement rows and its EXP-RZPFEE-STL fee expense, R-2098's frees the
--     receipts (they stay, waiting for their bank line again; R-2565's per-payment fees stay). Each line
--     in its own savepoint; a line changed since the run or refused (books lock) is LEFT with the reason.
--     Messages no longer name only "Reconcile from Zoho". Everything else is unchanged.
-- Test: supabase/tests/r2654_razorpay_month_batch.test.sql (begin ... rollback; red without this file).

begin;

alter table public.bank_recon_runs drop constraint if exists bank_recon_runs_source_check;
alter table public.bank_recon_runs add constraint bank_recon_runs_source_check
  check (source in ('zoho_bulk', 'razorpay_batch'));

alter table public.bank_recon_run_lines drop constraint if exists bank_recon_run_lines_kind_check;
alter table public.bank_recon_run_lines add constraint bank_recon_run_lines_kind_check
  check (kind in ('new_sale', 'pay_item', 'opening', 'split', 'other', 'razorpay_settlement'));

-- ── A new Razorpay-batch run ────────────────────────────────────────────────────────────────
create or replace function public.razorpay_batch_run_start(p_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2535_run_gate(); v_id uuid;
begin
  if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
    raise exception 'This bank account is not in your company — reload the bank page and start again.' using errcode = 'no_data_found';
  end if;
  insert into public.bank_recon_runs (tenant_id, bank_account_id, source, created_by)
  values (v_tenant, p_account_id, 'razorpay_batch', public.current_user_id())
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.razorpay_batch_run_start(uuid) from public, anon;
grant execute on function public.razorpay_batch_run_start(uuid) to authenticated, service_role;

-- ── Book one settlement line inside a run (book + record = one transaction) ────────────────────
create or replace function public.reconcile_razorpay_settlement_in_run(p_run_id uuid, p_txn_id uuid, p_settlement jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2535_run_gate();
  v_run    public.bank_recon_runs;
  v_txn    public.bank_transactions;
  v_res    jsonb;
begin
  select * into v_run from public.bank_recon_runs r where r.id = p_run_id and r.tenant_id = v_tenant for share;
  if not found then
    raise exception 'This Razorpay settlements run is not in your company — reload the page and press Reconcile all ready again.' using errcode = 'no_data_found';
  end if;
  if v_run.source is distinct from 'razorpay_batch' then
    raise exception 'This run is not a Razorpay settlements run — reload the page and press Reconcile all ready again.' using errcode = '22023';
  end if;
  if v_run.undone_at is not null then
    raise exception 'This run was undone — press Reconcile all ready again (a new run starts).' using errcode = 'check_violation';
  end if;
  select * into v_txn from public.bank_transactions bt
   where bt.id = p_txn_id and bt.tenant_id = v_tenant and bt.bank_account_id = v_run.bank_account_id;
  if not found then
    raise exception 'This bank line is not in the run''s account — reload the bank page.' using errcode = 'no_data_found';
  end if;
  if exists (select 1 from public.bank_recon_run_lines o
              where o.tenant_id = v_tenant and o.txn_id = p_txn_id and o.run_id <> p_run_id and o.undone_at is null) then
    raise exception 'Another run already booked this bank line — undo that run or un-reconcile the line first.' using errcode = 'check_violation';
  end if;

  /* R-2099's one booking path — it locks the line, refuses a reconciled line / used settlement, and
     re-checks every amount against the app's own rows. */
  v_res := public.reconcile_razorpay_settlement(p_txn_id, p_settlement);

  select * into v_txn from public.bank_transactions bt where bt.id = p_txn_id;
  insert into public.bank_recon_run_lines (run_id, tenant_id, txn_id, kind, matched_to_type, matched_to_id)
  values (p_run_id, v_tenant, p_txn_id, 'razorpay_settlement', v_txn.matched_to_type, v_txn.matched_to_id)
  on conflict (run_id, txn_id) do nothing;
  return v_res || jsonb_build_object('run_id', p_run_id);
end;
$function$;
revoke all on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) from public, anon;
grant execute on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) to authenticated, service_role;
comment on function public.reconcile_razorpay_settlement_in_run(uuid, uuid, jsonb) is
  'R-2654: reconcile_razorpay_settlement (R-2099, unchanged) + record the line on a razorpay_batch run of bank_recon_runs, in one transaction — so "Undo this run" can take it back. Owner/accountant, own company.';

-- ── Undo this run (from 20261107043907_r2535_bank_recon_runs — its only body) ─────────────────
create or replace function public.undo_bank_recon_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
/* R-2654: also undoes a Razorpay settlements run — kind 'razorpay_settlement' goes back through
   unreconcile_bank_receipt(line, false) (R-2099's trigger removes the settlement + its fee expense,
   R-2098's frees the receipts). */
declare
  v_tenant uuid := public._r2535_run_gate();
  v_run    public.bank_recon_runs;
  v_l      record;
  v_n      integer := 0;
  v_left   jsonb := '[]'::jsonb;
begin
  select * into v_run from public.bank_recon_runs r where r.id = p_run_id and r.tenant_id = v_tenant for update;
  if not found then raise exception 'This run is not in your company — reload the page and try again.' using errcode = 'no_data_found'; end if;

  for v_l in
    select l.id, l.txn_id, l.kind, l.matched_to_type, l.matched_to_id, bt.matched_to_type as now_type,
           bt.matched_to_id as now_id, bt.txn_date, bt.credit
      from public.bank_recon_run_lines l
      join public.bank_transactions bt on bt.id = l.txn_id and bt.tenant_id = v_tenant
     where l.run_id = p_run_id and l.undone_at is null
     order by bt.txn_date, l.txn_id
     for update of l, bt
  loop
    if v_l.now_type is distinct from v_l.matched_to_type or v_l.now_id is distinct from v_l.matched_to_id then
      v_left := v_left || jsonb_build_object('txn_id', v_l.txn_id, 'txn_date', v_l.txn_date, 'credit', v_l.credit,
        'reason', 'Changed since the run (re-matched or un-reconciled by hand) — left as it is.');
      continue;
    end if;
    if v_l.kind = 'razorpay_settlement' then
      begin
        perform public.unreconcile_bank_receipt(v_l.txn_id, false);
        update public.bank_recon_run_lines set undone_at = now() where id = v_l.id;
        v_n := v_n + 1;
      exception when others then
        v_left := v_left || jsonb_build_object('txn_id', v_l.txn_id, 'txn_date', v_l.txn_date, 'credit', v_l.credit, 'reason', sqlerrm);
      end;
      continue;
    end if;
    if v_l.kind <> 'new_sale' then
      v_left := v_left || jsonb_build_object('txn_id', v_l.txn_id, 'txn_date', v_l.txn_date, 'credit', v_l.credit,
        'reason', 'Booked as a payment of an existing invoice / several invoices — un-reconcile this line by hand.');
      continue;
    end if;
    begin
      perform public.unreconcile_bank_receipt(v_l.txn_id, true);
      update public.bank_recon_run_lines set undone_at = now() where id = v_l.id;
      v_n := v_n + 1;
    exception when others then
      v_left := v_left || jsonb_build_object('txn_id', v_l.txn_id, 'txn_date', v_l.txn_date, 'credit', v_l.credit, 'reason', sqlerrm);
    end;
  end loop;

  if jsonb_array_length(v_left) = 0 and v_run.undone_at is null then
    update public.bank_recon_runs set undone_at = now(), undone_by = public.current_user_id() where id = p_run_id;
  end if;
  return jsonb_build_object('run_id', p_run_id, 'undone', v_n, 'left', v_left);
end;
$function$;
revoke all on function public.undo_bank_recon_run(uuid) from public, anon;
grant execute on function public.undo_bank_recon_run(uuid) to authenticated, service_role;

commit;
