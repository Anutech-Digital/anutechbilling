-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.apply_bs_loan_move(jsonb,bigint)') and prosrc like '%R-2604%') and to_regclass('public.bs_loan_moves') is not null
-- deploy-key: r2604movebsloans
--
-- R-2604 (8 Nov 2026): before R-2603, Reconcile → "I am GIVING a loan/advance" (book_bank_advance) wrote a
-- Balance Sheet line "Advance/loan given · <name>" (and "Advance/loan returned · <name>" for money back)
-- instead of a Loans given row. Staging Excel Technologies has 7 such lines (₹37,84,500), names typed by
-- hand (Aakash Deep / aakash deep). This is the owner's tool to move them — one store for one thing.
--
--   preview_bs_loan_move()  — "Check first": read only. Groups the tenant's asset rows labelled
--       'Advance/loan given|returned · <name>' by name (case / spaces ignored), net = given − returned,
--       and says where each group goes:
--         loan_given  → Accounting → Loans given (a new one_shot 0% loan, or ADDED to the person's open
--                       one_shot 0% loan so repayments land on one loan — R-2603 review LOW; an
--                       interest-bearing loan is never topped up);
--         employee    → only suggested (name = an employee's name, or one word = ONE employee's first
--                       name, e.g. 'Pardeep' → Pardeep Sharma); the owner confirms it in Check first;
--         skip        → no name / net ≤ 0 — stays on the Balance Sheet, reason shown.
--       Returns total_now: Balance Sheet "Advance/loan" rows + Loans given + Employee loans (the move keeps it).
--   apply_bs_loan_move(p_employee_links, p_expected_net) — one transaction, groups read once: refuses if the
--       movable net no longer equals what Check first showed; per group writes the loan (loans_given or
--       employee_loans, NEVER with bank_txn_id — delete_loan_given / delete_employee_loan would delete a
--       hand-typed line with it), re-matches ONLY the lines still booked to those rows (bs_item + row id,
--       or the pre-R-2570 'manual') to the loan, deletes the rows and refuses unless what left them equals
--       what the loan got (Balance Sheet total unchanged), and writes one bs_loan_moves row (audit).
--       A second run finds nothing = no-op.
--   tg_bs_loan_moved_line_guard — a moved bank line cannot be un-reconciled / re-matched while its loan
--       exists (the loan carries its amount): "delete the loan to undo".
--   tg_bs_loan_moved_loan_deleted — deleting a moved / merged-into loan = UNDO: its Balance Sheet rows come
--       back (same ids) and their lines are booked to them again; the move is marked undone_at.
--   tg_bs_loan_moved_employee_loan_edit — a moved employee loan's amount / date / account stay (edit_employee_loan
--       would otherwise add a second payout line: the loan has no cash line of its own).
--   MONEY: Dr Loans given / Employee loans (asset) ↑ = Balance Sheet "Advance/loan" asset rows ↓.
--   No P&L, no new bank line, cash unchanged.
-- Running it on staging / live = data repair → Pardeep's yes first (given 8 Nov, after Check first).
-- Proof: supabase/tests/r2604_move_bs_loans.test.sql (one rollback).

begin;

create table if not exists public.bs_loan_moves (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  person_key    text not null,
  person_name   text not null,
  target_type   text not null check (target_type in ('loan_given', 'employee_loan')),
  target_id     uuid not null,
  merged        boolean not null default false,
  amount        integer not null check (amount > 0),
  bs_items      jsonb not null,
  bank_txn_ids  uuid[] not null default '{}',
  line_matches  jsonb not null default '[]'::jsonb,
  undone_at     timestamptz,
  moved_by      uuid,
  moved_at      timestamptz not null default now()
);
create index if not exists bs_loan_moves_tenant_idx on public.bs_loan_moves (tenant_id, moved_at);
create index if not exists bs_loan_moves_lines_idx on public.bs_loan_moves using gin (bank_txn_ids);
alter table public.bs_loan_moves enable row level security;
drop policy if exists bs_loan_moves_read on public.bs_loan_moves;
create policy bs_loan_moves_read on public.bs_loan_moves for select to authenticated
  using (tenant_id = public.current_tenant_id() and public.current_user_has_role('owner', 'accountant'));
drop policy if exists zzz_service_role_all on public.bs_loan_moves;
create policy zzz_service_role_all on public.bs_loan_moves as permissive for all to service_role using (true) with check (true);
revoke all on public.bs_loan_moves from anon;
revoke insert, update, delete on public.bs_loan_moves from authenticated;
grant select on public.bs_loan_moves to authenticated;

-- Internal: the groups (no grant). Callers check the role first.
create or replace function public.bs_loan_move_groups(p_tenant uuid)
returns table (person_key text, person_name text, given bigint, returned bigint, net bigint,
               rows jsonb, line_ids uuid[], first_date date,
               target text, skip_reason text,
               employee_id uuid, employee_name text,
               merge_loan_id uuid, merge_loan_principal integer, known_spelling text)
language sql
stable
security definer
set search_path = public
as $$
  -- R-2604
  with src as (
    select b.id, b.label, b.amount, b.bank_txn_id, b.created_at,
           (regexp_match(b.label, '^Advance/loan (given|returned)'))[1] as dir,
           nullif(regexp_replace(trim(coalesce((regexp_match(b.label, '^Advance/loan (?:given|returned)\s*[·\-–]\s*(.+)$'))[1], '')), '\s+', ' ', 'g'), '') as nm,
           t.txn_date
      from public.balance_sheet_items b
      left join public.bank_transactions t on t.id = b.bank_txn_id and t.tenant_id = b.tenant_id
     where b.tenant_id = p_tenant and b.section = 'asset'
       and b.label ~ '^Advance/loan (given|returned)'
  ), g as (
    select coalesce(lower(nm), '') as k,
           (array_agg(nm order by created_at, id))[1] as nm,
           sum(case when amount > 0 then amount else 0 end)::bigint as given,
           sum(case when amount < 0 then -amount else 0 end)::bigint as returned,
           sum(amount)::bigint as net,
           jsonb_agg(jsonb_build_object('id', id, 'label', label, 'amount', amount, 'bank_txn_id', bank_txn_id,
                                        'date', coalesce(txn_date, created_at::date)) order by coalesce(txn_date, created_at::date), id) as rows,
           coalesce(array_agg(bank_txn_id) filter (where bank_txn_id is not null), '{}') as line_ids,
           min(coalesce(txn_date, created_at::date)) as first_date
      from src group by 1
  )
  select g.k, coalesce(g.nm, '(no name)'), g.given, g.returned, g.net, g.rows, g.line_ids, g.first_date,
         case when g.k = '' or g.net <= 0 then 'skip'
              when e.id is not null then 'employee'
              else 'loan_given' end,
         case when g.k = '' then 'No name on the line — rename it on the Balance Sheet first'
              when g.net <= 0 then 'Returned is as much as given or more — nothing is still owed; check it by hand'
         end,
         e.id, e.name, m.id, m.principal, kn.borrower_name
    from g
    left join lateral (
      select x.id, x.name from (
        select emp.id, emp.name, 1 as pri, emp.is_active, emp.created_at
          from public.employees emp
         where emp.tenant_id = p_tenant and lower(regexp_replace(trim(emp.name), '\s+', ' ', 'g')) = g.k
        union all
        select emp.id, emp.name, 2, emp.is_active, emp.created_at
          from public.employees emp
         where emp.tenant_id = p_tenant and g.k !~ ' '
           and lower(split_part(regexp_replace(trim(emp.name), '\s+', ' ', 'g'), ' ', 1)) = g.k
           and (select count(*) from public.employees e2
                 where e2.tenant_id = p_tenant
                   and lower(split_part(regexp_replace(trim(e2.name), '\s+', ' ', 'g'), ' ', 1)) = g.k) = 1
      ) x
      where g.k <> ''
      order by x.pri, x.is_active desc nulls last, x.created_at
      limit 1
    ) e on true
    left join lateral (
      select l.id, l.principal from public.loans_given l
       where l.tenant_id = p_tenant and l.status = 'open' and l.repayment_plan = 'one_shot' and l.interest_rate = 0
         and lower(regexp_replace(trim(l.borrower_name), '\s+', ' ', 'g')) = g.k
       order by l.created_at limit 1
    ) m on g.k <> ''
    left join lateral (
      select l.borrower_name from public.loans_given l
       where l.tenant_id = p_tenant and lower(regexp_replace(trim(l.borrower_name), '\s+', ' ', 'g')) = g.k
       order by l.created_at limit 1
    ) kn on g.k <> ''
   order by g.net desc, g.k;
$$;
revoke all on function public.bs_loan_move_groups(uuid) from public, anon, authenticated;

-- Internal: the three stores' asset total for a tenant (Balance Sheet "Advance/loan" rows + Loans given + Employee loans).
create or replace function public.bs_loan_move_stores_total(p_tenant uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  -- R-2604
  select (select coalesce(sum(b.amount), 0) from public.balance_sheet_items b
           where b.tenant_id = p_tenant and b.section = 'asset' and b.label ~ '^Advance/loan (given|returned)')
       + (select coalesce(sum(l.principal), 0) from public.loans_given l where l.tenant_id = p_tenant)
       - (select coalesce(sum(r.principal_part), 0) from public.loan_repayments r where r.tenant_id = p_tenant)
       + (select coalesce(sum(l.principal), 0) from public.employee_loans l where l.tenant_id = p_tenant)
       - (select coalesce(sum(r.amount), 0) from public.employee_loan_repayments r where r.tenant_id = p_tenant);
$$;
revoke all on function public.bs_loan_move_stores_total(uuid) from public, anon, authenticated;

create or replace function public.preview_bs_loan_move()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_total  bigint;
begin
  -- R-2604
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can move Balance Sheet loans — ask your owner to do it.'
      using errcode = '42501';
  end if;
  v_total := public.bs_loan_move_stores_total(v_tenant);
  return jsonb_build_object(
    'groups', coalesce((select jsonb_agg(jsonb_build_object(
        'key', g.person_key, 'name', coalesce(g.known_spelling, g.person_name),
        'given', g.given, 'returned', g.returned, 'net', g.net,
        'rows', g.rows, 'lines', cardinality(g.line_ids), 'first_date', g.first_date,
        'target', g.target, 'skip_reason', g.skip_reason,
        'employee', case when g.employee_id is null then null
                         else jsonb_build_object('id', g.employee_id, 'name', g.employee_name) end,
        'merge_loan', case when g.merge_loan_id is null then null
                           else jsonb_build_object('id', g.merge_loan_id, 'principal', g.merge_loan_principal) end))
      from public.bs_loan_move_groups(v_tenant) g), '[]'::jsonb),
    'movable_net', coalesce((select sum(g.net) from public.bs_loan_move_groups(v_tenant) g where g.target <> 'skip'), 0),
    'total_now', v_total);
end;
$$;
revoke all on function public.preview_bs_loan_move() from public, anon;
grant execute on function public.preview_bs_loan_move() to authenticated, service_role;

-- p_employee_links: {"<person key>": "<employee id>"} — the employee groups the owner confirmed in Check
-- first. Any other movable group goes to Loans given. p_expected_net: Check first's movable_net.
create or replace function public.apply_bs_loan_move(p_employee_links jsonb, p_expected_net bigint)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_links   jsonb := coalesce(p_employee_links, '{}'::jsonb);
  v_groups  jsonb;
  v_net     bigint;
  v_g       jsonb;
  v_emp     public.employees;
  v_emp_id  uuid;
  v_loan    uuid;
  v_merged  boolean;
  v_type    text;
  v_name    text;
  v_moved   jsonb := '[]'::jsonb;
  v_key     text;
  v_note    text;
  v_removed bigint;
  v_lines   uuid[];
  v_matches jsonb;
begin
  -- R-2604
  if v_tenant is null then raise exception 'No company context — sign in again.'; end if;
  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can move Balance Sheet loans — ask your owner to do it.'
      using errcode = '42501';
  end if;
  if jsonb_typeof(v_links) <> 'object' then raise exception 'Employee links must be a list of name → employee.'; end if;

  -- Two tabs / double click: the second waits here, then finds nothing left (or a changed total).
  perform 1 from public.balance_sheet_items b
   where b.tenant_id = v_tenant and b.section = 'asset' and b.label ~ '^Advance/loan (given|returned)'
   for update;

  -- The groups once (same rows for the check and the move).
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) into v_groups
    from public.bs_loan_move_groups(v_tenant) g where g.target <> 'skip';
  select coalesce(sum((x->>'net')::bigint), 0) into v_net from jsonb_array_elements(v_groups) x;

  if v_net = 0 then
    return jsonb_build_object('moved', '[]'::jsonb, 'moved_net', 0, 'nothing_to_move', true);
  end if;
  if p_expected_net is distinct from v_net then
    raise exception 'The Balance Sheet loan lines changed since Check first (₹% then, ₹% now) — run Check first again. Nothing was moved.',
      coalesce(p_expected_net, 0), v_net using errcode = '40001';
  end if;
  for v_key in select jsonb_object_keys(v_links) loop
    if not exists (select 1 from jsonb_array_elements(v_groups) x where x->>'person_key' = v_key) then
      raise exception 'No Balance Sheet loan line for "%" can be moved — run Check first again. Nothing was moved.', v_key;
    end if;
  end loop;

  for v_g in select x from jsonb_array_elements(v_groups) x loop
    v_merged := false;
    v_loan := null;
    v_note := left('Moved from the Balance Sheet (R-2604) on ' || to_char(public.ist_today(), 'DD Mon YYYY') || ': '
                   || (select string_agg(r->>'label' || ' ₹' || (r->>'amount'), '; ') from jsonb_array_elements(v_g->'rows') r), 1000);

    if v_links ? (v_g->>'person_key') then
      v_emp_id := case when (v_links->>(v_g->>'person_key')) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                       then (v_links->>(v_g->>'person_key'))::uuid end;
      select * into v_emp from public.employees where id = v_emp_id and tenant_id = v_tenant;
      if not found then
        raise exception 'The employee picked for "%" is not in your company. Nothing was moved.', v_g->>'person_name';
      end if;
      v_type := 'employee_loan';
      v_name := v_emp.name;
      -- No bank_account_id / bank_txn_id: delete_employee_loan would delete or reverse a line it did not
      -- make; its amount / date / account are locked (tg_bs_loan_moved_employee_loan_edit).
      insert into public.employee_loans (tenant_id, employee_name, principal, disbursed_on, kind, notes, created_by)
      values (v_tenant, v_emp.name, (v_g->>'net')::integer, (v_g->>'first_date')::date, 'loan', v_note, public.current_user_id())
      returning id into v_loan;
    else
      v_type := 'loan_given';
      v_name := coalesce(v_g->>'known_spelling', v_g->>'person_name');
      if v_g->>'merge_loan_id' is not null then
        update public.loans_given
           set principal = principal + (v_g->>'net')::integer,
               notes = left(concat_ws(E'\n', notes, v_note), 1000),
               updated_at = now()
         where id = (v_g->>'merge_loan_id')::uuid and tenant_id = v_tenant and status = 'open'
           and repayment_plan = 'one_shot' and interest_rate = 0
        returning id, borrower_name into v_loan, v_name;
        v_merged := v_loan is not null;
        v_name := coalesce(v_name, v_g->>'known_spelling', v_g->>'person_name');
      end if;
      if not v_merged then
        insert into public.loans_given
          (tenant_id, borrower_name, borrower_type, principal, given_on, interest_rate, repayment_plan,
           notes, status, created_by)
        values
          (v_tenant, v_name, 'person', (v_g->>'net')::integer, (v_g->>'first_date')::date, 0, 'one_shot',
           v_note, 'open', auth.uid())
        returning id into v_loan;
      end if;
    end if;

    -- Only lines still booked to these rows (bs_item + row id, or the old 'manual' with no id) move.
    with r as (
      select (x->>'id')::uuid as id, nullif(x->>'bank_txn_id', '')::uuid as txn from jsonb_array_elements(v_g->'rows') x
    ), upd as (
      update public.bank_transactions t
         set matched_to_type = v_type, matched_to_id = v_loan::text,
             matched_at = now(), matched_by = public.current_user_id(), match_confidence = 'manual',
             updated_at = now()
        from r
       where t.tenant_id = v_tenant and t.id = r.txn
         and ((t.matched_to_type = 'bs_item' and t.matched_to_id = r.id::text)
              or (t.matched_to_type = 'manual' and t.matched_to_id is null))
      returning t.id, r.id as row_id
    )
    select coalesce(array_agg(upd.id), '{}'), coalesce(jsonb_agg(jsonb_build_object('txn', upd.id, 'row', upd.row_id)), '[]'::jsonb)
      into v_lines, v_matches from upd;

    with del as (
      delete from public.balance_sheet_items
       where tenant_id = v_tenant and id in (select (r->>'id')::uuid from jsonb_array_elements(v_g->'rows') r)
      returning amount
    ) select coalesce(sum(amount), 0) into v_removed from del;
    -- Balance Sheet total unchanged: what left the Balance Sheet rows is exactly what the loan got.
    if v_removed <> (v_g->>'net')::bigint then
      raise exception 'The Balance Sheet lines for % changed while moving (₹% vs ₹%) — nothing was moved. Run Check first again.',
        v_name, v_removed, v_g->>'net' using errcode = '40001';
    end if;

    insert into public.bs_loan_moves
      (tenant_id, person_key, person_name, target_type, target_id, merged, amount, bs_items, bank_txn_ids, line_matches, moved_by)
    values
      (v_tenant, v_g->>'person_key', v_name, v_type, v_loan, v_merged, (v_g->>'net')::integer, v_g->'rows', v_lines, v_matches,
       public.current_user_id());

    v_moved := v_moved || jsonb_build_object('name', v_name, 'target', v_type, 'loan_id', v_loan, 'merged', v_merged,
                                             'amount', (v_g->>'net')::bigint, 'rows', jsonb_array_length(v_g->'rows'),
                                             'lines', cardinality(v_lines));
  end loop;

  return jsonb_build_object('moved', v_moved, 'moved_net', v_net, 'nothing_to_move', false);
end;
$$;
revoke all on function public.apply_bs_loan_move(jsonb, bigint) from public, anon;
grant execute on function public.apply_bs_loan_move(jsonb, bigint) to authenticated, service_role;

-- A moved line belongs to its loan: no un-reconcile / re-match while that loan exists.
create or replace function public.tg_bs_loan_moved_line_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m public.bs_loan_moves;
begin
  -- R-2604
  if old.matched_to_type is not distinct from new.matched_to_type and old.matched_to_id is not distinct from new.matched_to_id then
    return new;
  end if;
  if old.matched_to_type is null or old.matched_to_type not in ('loan_given', 'employee_loan') or old.matched_to_id is null then
    return new;
  end if;
  select * into v_m from public.bs_loan_moves m
   where m.tenant_id = old.tenant_id and m.bank_txn_ids @> array[old.id] and m.target_id::text = old.matched_to_id
     and m.undone_at is null
   order by m.moved_at desc limit 1;
  if not found then return new; end if;
  if (v_m.target_type = 'loan_given' and exists (select 1 from public.loans_given where id = v_m.target_id))
     or (v_m.target_type = 'employee_loan' and exists (select 1 from public.employee_loans where id = v_m.target_id)) then
    raise exception 'This line was moved from the Balance Sheet into the loan to % (₹%) — to undo it, delete that loan on Accounting → % (the Balance Sheet line comes back).',
      v_m.person_name, v_m.amount, case v_m.target_type when 'loan_given' then 'Loans given' else 'Loans' end
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_bs_loan_moved_line_guard on public.bank_transactions;
create trigger trg_bs_loan_moved_line_guard before update of matched_to_type, matched_to_id on public.bank_transactions
  for each row execute function public.tg_bs_loan_moved_line_guard();

-- Deleting a moved (or merged-into) loan = undo: its Balance Sheet rows come back and their lines are
-- booked to them again (bs_item + row id), so nothing is lost.
create or replace function public.tg_bs_loan_moved_loan_deleted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_m public.bs_loan_moves;
begin
  -- R-2604
  for v_m in
    select * from public.bs_loan_moves m
     where m.tenant_id = old.tenant_id and m.target_id = old.id and m.undone_at is null
       and m.target_type = case tg_table_name when 'loans_given' then 'loan_given' else 'employee_loan' end
     for update
  loop
    insert into public.balance_sheet_items (id, tenant_id, section, label, amount, bank_txn_id, notes)
    select (r->>'id')::uuid, v_m.tenant_id, 'asset', r->>'label', (r->>'amount')::integer,
           nullif(r->>'bank_txn_id', '')::uuid, 'Back from Loans given (R-2604 undo)'
      from jsonb_array_elements(v_m.bs_items) r
    on conflict (id) do nothing;
    update public.bank_transactions t
       set matched_to_type = 'bs_item', matched_to_id = lm->>'row', matched_at = now(), match_confidence = 'manual',
           updated_at = now()
      from jsonb_array_elements(v_m.line_matches) lm
     where t.tenant_id = v_m.tenant_id and t.id = (lm->>'txn')::uuid
       and t.matched_to_type = v_m.target_type and t.matched_to_id = old.id::text;
    update public.bs_loan_moves set undone_at = now() where id = v_m.id;
  end loop;
  return null;
end;
$$;
drop trigger if exists trg_bs_loan_moved_loan_deleted on public.loans_given;
create trigger trg_bs_loan_moved_loan_deleted after delete on public.loans_given
  for each row execute function public.tg_bs_loan_moved_loan_deleted();
drop trigger if exists trg_bs_loan_moved_loan_deleted on public.employee_loans;
create trigger trg_bs_loan_moved_loan_deleted after delete on public.employee_loans
  for each row execute function public.tg_bs_loan_moved_loan_deleted();

-- A moved employee loan has no cash line of its own (its line is the old statement line): edit_employee_loan
-- would add a second payout line when its amount / date / account changes. Those stay as moved.
create or replace function public.tg_bs_loan_moved_employee_loan_edit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- R-2604
  if (new.principal is distinct from old.principal or new.disbursed_on is distinct from old.disbursed_on
      or new.bank_account_id is distinct from old.bank_account_id)
     and exists (select 1 from public.bs_loan_moves m
                  where m.tenant_id = old.tenant_id and m.target_id = old.id and m.target_type = 'employee_loan'
                    and m.undone_at is null) then
    raise exception 'This loan to % was moved from the Balance Sheet — its amount, date and account stay as they were. To change them, delete the loan (the Balance Sheet line comes back) and give it again.',
      old.employee_name using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_bs_loan_moved_employee_loan_edit on public.employee_loans;
create trigger trg_bs_loan_moved_employee_loan_edit before update on public.employee_loans
  for each row execute function public.tg_bs_loan_moved_employee_loan_edit();

commit;
