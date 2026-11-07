-- deploy-peek: to_regclass('public.bank_recon_run_lines') is not null and to_regprocedure('public.undo_bank_recon_run(uuid)') is not null and to_regprocedure('public.bank_recon_run_screen(uuid,uuid[])') is not null
-- deploy-key: r2535bankreconruns
--
-- R-2535 (7 Nov 2026, p1 money, G-RECON — RECON-SPEED research item 2). "Reconcile from Zoho" booked
-- the ticked rows one at a time from the browser, and every row reloaded the bank page. The booking
-- now runs on the server (POST /api/integrations/zoho-books/bulk-book) through the SAME booking
-- RPCs, in chunks, under a run id — this file is the database half of that run.
--
-- ─── WHAT THIS ADDS ───────────────────────────────────────────────────────────
--   bank_recon_runs / bank_recon_run_lines — one row per run (company, account, who, when, undone)
--     and one per line the run booked (what the line was matched to then, and the booking kind).
--     RLS: a company reads only its own; nobody writes them directly (only the functions below).
--   bank_recon_run_screen(account, txn ids) — per id: may a run book it? 'not_found' (not a line of
--     this company's account — another company's id looks exactly the same), 'matched' (already
--     reconciled — never booked twice), 'locked' (on or before the company's books lock date),
--     else ok with the line's own credit and date (the route books those amounts, never the browser's).
--   bank_recon_run_start(account) — a new run for the caller's own account.
--   bank_recon_run_record(run, txn, kind) — after a booking: records the line if it IS matched now
--     (else false); recording it again (double run, retry) adds nothing.
--   undo_bank_recon_run(run) — every recorded line of kind 'new_sale' still matched to what the run
--     matched it to goes back through unreconcile_bank_receipt(line, true) — the Reconcile sheet's own
--     "un-reconcile and undo the sale" (receipt removed, invoice voided / credited, quote rejected).
--     Each line in its own savepoint: a line changed since the run, booked another way (paid an open
--     item, opening invoice, several invoices — those are undone by hand on the line), or refused by
--     the books lock is LEFT and listed with the reason; nothing else is touched. Run again → 0.
--   All four: owner / accountant only (as Find in Zoho and the receipt delete), own company only.
-- Test: supabase/tests/r2535_bank_recon_runs.test.sql (begin … rollback; red without this file).
begin;

create table if not exists public.bank_recon_runs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  bank_account_id uuid not null references public.bank_accounts(id) on delete cascade,
  source          text not null default 'zoho_bulk' check (source in ('zoho_bulk')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  undone_at       timestamptz,
  undone_by       uuid
);
create index if not exists bank_recon_runs_tenant_idx on public.bank_recon_runs (tenant_id, bank_account_id, created_at desc);

create table if not exists public.bank_recon_run_lines (
  id              uuid primary key default gen_random_uuid(),
  run_id          uuid not null references public.bank_recon_runs(id) on delete cascade,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  txn_id          uuid not null references public.bank_transactions(id) on delete cascade,
  kind            text not null check (kind in ('new_sale', 'pay_item', 'opening', 'split', 'other')),
  matched_to_type text,
  matched_to_id   text,
  booked_at       timestamptz not null default now(),
  undone_at       timestamptz,
  unique (run_id, txn_id)
);
create index if not exists bank_recon_run_lines_txn_idx on public.bank_recon_run_lines (tenant_id, txn_id);

alter table public.bank_recon_runs enable row level security;
alter table public.bank_recon_run_lines enable row level security;
drop policy if exists bank_recon_runs_read on public.bank_recon_runs;
create policy bank_recon_runs_read on public.bank_recon_runs for select to authenticated
  using (tenant_id = public.current_tenant_id());
drop policy if exists bank_recon_run_lines_read on public.bank_recon_run_lines;
create policy bank_recon_run_lines_read on public.bank_recon_run_lines for select to authenticated
  using (tenant_id = public.current_tenant_id());
revoke all on public.bank_recon_runs, public.bank_recon_run_lines from public, anon;
grant select on public.bank_recon_runs, public.bank_recon_run_lines to authenticated, service_role;

/* The gate of all four: a signed-in owner / accountant of a company. Returns the company. */
create or replace function public._r2535_run_gate()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then
    raise exception 'No company on this login' using errcode = '42501';
  end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only an owner or accountant can book or undo a Reconcile-from-Zoho run' using errcode = '42501';
  end if;
  return v_tenant;
end;
$function$;
revoke all on function public._r2535_run_gate() from public, anon;
grant execute on function public._r2535_run_gate() to authenticated, service_role;

create or replace function public.bank_recon_run_screen(p_account_id uuid, p_txn_ids uuid[])
returns table(txn_id uuid, ok boolean, reason text, credit integer, txn_date date)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2535_run_gate(); v_lock date;
begin
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;
  return query
  select x.id,
         (bt.id is not null and bt.matched_to_type is null and (v_lock is null or bt.txn_date > v_lock)),
         case when bt.id is null then 'not_found'
              when bt.matched_to_type is not null then 'matched'
              when v_lock is not null and bt.txn_date <= v_lock then 'locked' end,
         case when bt.id is not null then bt.credit end,
         case when bt.id is not null then bt.txn_date end
    from unnest(coalesce(p_txn_ids, '{}'::uuid[])) with ordinality as x(id, i)
    left join public.bank_transactions bt
      on bt.id = x.id and bt.tenant_id = v_tenant and bt.bank_account_id = p_account_id
   order by x.i;
end;
$function$;
revoke all on function public.bank_recon_run_screen(uuid, uuid[]) from public, anon;
grant execute on function public.bank_recon_run_screen(uuid, uuid[]) to authenticated, service_role;

create or replace function public.bank_recon_run_start(p_account_id uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2535_run_gate(); v_id uuid;
begin
  if not exists (select 1 from public.bank_accounts ba where ba.id = p_account_id and ba.tenant_id = v_tenant) then
    raise exception 'Bank account not found' using errcode = 'no_data_found';
  end if;
  insert into public.bank_recon_runs (tenant_id, bank_account_id, created_by)
  values (v_tenant, p_account_id, public.current_user_id())
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.bank_recon_run_start(uuid) from public, anon;
grant execute on function public.bank_recon_run_start(uuid) to authenticated, service_role;

create or replace function public.bank_recon_run_record(p_run_id uuid, p_txn_id uuid, p_kind text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_tenant uuid := public._r2535_run_gate(); v_run public.bank_recon_runs; v_txn public.bank_transactions;
begin
  select * into v_run from public.bank_recon_runs r where r.id = p_run_id and r.tenant_id = v_tenant;
  if not found then raise exception 'Reconcile run not found' using errcode = 'no_data_found'; end if;
  if v_run.undone_at is not null then raise exception 'This run was undone — start a new one' using errcode = 'check_violation'; end if;
  select * into v_txn from public.bank_transactions bt
   where bt.id = p_txn_id and bt.tenant_id = v_tenant and bt.bank_account_id = v_run.bank_account_id;
  if not found then raise exception 'Bank line not found in this run''s account' using errcode = 'no_data_found'; end if;
  if v_txn.matched_to_type is null then return false; end if;
  insert into public.bank_recon_run_lines (run_id, tenant_id, txn_id, kind, matched_to_type, matched_to_id)
  values (p_run_id, v_tenant, p_txn_id,
          case when p_kind in ('new_sale', 'pay_item', 'opening', 'split') then p_kind else 'other' end,
          v_txn.matched_to_type, v_txn.matched_to_id)
  on conflict (run_id, txn_id) do nothing;
  return true;
end;
$function$;
revoke all on function public.bank_recon_run_record(uuid, uuid, text) from public, anon;
grant execute on function public.bank_recon_run_record(uuid, uuid, text) to authenticated, service_role;

create or replace function public.undo_bank_recon_run(p_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_tenant uuid := public._r2535_run_gate();
  v_run    public.bank_recon_runs;
  v_l      record;
  v_n      integer := 0;
  v_left   jsonb := '[]'::jsonb;
begin
  select * into v_run from public.bank_recon_runs r where r.id = p_run_id and r.tenant_id = v_tenant for update;
  if not found then raise exception 'Reconcile run not found' using errcode = 'no_data_found'; end if;

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
