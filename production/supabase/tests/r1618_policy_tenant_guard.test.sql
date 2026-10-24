-- R-1618 — catalog-wide guard for row-level-security POLICIES in schema public, plus an attack
-- test on the policies migration 20261019003408_r1618_policy_tenant_gate.sql re-created.
--
-- R-1560 guards SECURITY DEFINER functions; nothing guarded table policies. A policy written as
--     tenant_id = (select tenant_id from users where id = auth.uid())
-- skips public.current_tenant_id()'s gate — R-722 (is_active) and R-731 (session_mfa_ok()) —
-- so a deactivated user or a password-only (aal1) session of an MFA user keeps reading and
-- writing that table. 32 policies on 22 tables did this (prepaid_advances_all among them).
--
-- Rules, checked on USING and WITH CHECK separately:
--   a_users_by_uid_no_gate  the expression reads public.users by auth.uid() and never calls
--                           current_tenant_id() — tenant (or access) comes from the caller's
--                           own row, ungated;
--   b_tenant_from_users     the expression selects tenant_id FROM users at all — even next to
--                           current_tenant_id() (e.g. `... or tenant_id = current_tenant_id()`)
--                           it is a second, ungated tenant source.
-- Reading users only for a role / employee check NEXT TO tenant_id = current_tenant_id() is fine
-- (current_tenant_id() is already NULL for inactive / non-MFA callers).
--
--   1. Self-check: planted bad policies are caught, a clean one is not.
--   2. The real catalog is clean apart from the allowlist.
--   3. Attack: deactivated owner and MFA owner on aal1 see 0 rows and cannot write
--      prepaid_advances / compliance_log / tenant_secrets; a plain owner, an MFA owner on aal2
--      still work; another company's owner sees nothing; a sales user cannot see tenant_secrets.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r1618_policy_tenant_guard.test.sql

begin;

create function pg_temp.r1618_policy_violations()
returns table (rule text, tbl text, pol text, part text)
language sql stable
as $$
  with e as (
    select tablename::text as tbl, policyname::text as pol, 'using' as part, qual as x
      from pg_policies where schemaname = 'public' and qual is not null
    union all
    select tablename::text, policyname::text, 'check', with_check
      from pg_policies where schemaname = 'public' and with_check is not null
  )
  select 'a_users_by_uid_no_gate', tbl, pol, part from e
   where x ~* '\mfrom\s+(public\.)?users\M'
     and x ~* 'auth\.uid\(\)'
     and x !~* 'current_tenant_id\(\)'
  union all
  select 'b_tenant_from_users', tbl, pol, part from e
   where x ~* '\mselect\s+(\w+\.)?tenant_id\s+from\s+(public\.)?users\M';
$$;

-- ── 1. Self-check: planted policies ──────────────────────────────────────────────────────
create table public.__t_r1618 (id int, tenant_id uuid);
alter table public.__t_r1618 enable row level security;
create policy t_bad on public.__t_r1618 for select
  using (tenant_id = (select tenant_id from public.users where id = auth.uid()));
create policy t_sneaky on public.__t_r1618 for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id()
              or tenant_id = (select u.tenant_id from public.users u where u.id = auth.uid()));
create policy t_role_ungated on public.__t_r1618 for delete
  using (exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));
create policy t_clean on public.__t_r1618 for insert
  with check (tenant_id = public.current_tenant_id()
              and exists (select 1 from public.users u where u.id = auth.uid() and u.role = 'owner'));

do $$
begin
  if not exists (select 1 from pg_temp.r1618_policy_violations()
                  where tbl = '__t_r1618' and pol = 't_bad' and rule = 'a_users_by_uid_no_gate') then
    raise exception 'SELF-CHECK a: the planted users-by-auth.uid() policy was not caught';
  end if;
  if not exists (select 1 from pg_temp.r1618_policy_violations()
                  where tbl = '__t_r1618' and pol = 't_bad' and rule = 'b_tenant_from_users') then
    raise exception 'SELF-CHECK b: the planted tenant-from-users policy was not caught';
  end if;
  if not exists (select 1 from pg_temp.r1618_policy_violations()
                  where tbl = '__t_r1618' and pol = 't_sneaky' and part = 'check' and rule = 'b_tenant_from_users') then
    raise exception 'SELF-CHECK b: tenant-from-users hidden next to current_tenant_id() was not caught';
  end if;
  if exists (select 1 from pg_temp.r1618_policy_violations()
              where tbl = '__t_r1618' and pol = 't_sneaky' and part = 'using') then
    raise exception 'SELF-CHECK: the clean USING of t_sneaky was flagged';
  end if;
  if not exists (select 1 from pg_temp.r1618_policy_violations()
                  where tbl = '__t_r1618' and pol = 't_role_ungated' and rule = 'a_users_by_uid_no_gate') then
    raise exception 'SELF-CHECK a: a role check with no current_tenant_id() gate was not caught';
  end if;
  if exists (select 1 from pg_temp.r1618_policy_violations() where tbl = '__t_r1618' and pol = 't_clean') then
    raise exception 'SELF-CHECK: a clean policy (current_tenant_id() + role check) was flagged';
  end if;
end $$;

drop table public.__t_r1618;

-- ── 2. The real catalog ──────────────────────────────────────────────────────────────────
do $$
declare
  -- Tables whose policies another card is rewriting right now. Do NOT fix them here.
  v_other_card_tables text[] := array[
    'customers',   -- R-1004 in progress (customer / contact read RLS)
    'contacts'     -- R-1004 in progress
  ];
  -- LEGITIMATE 'table.policy' exceptions, each with its reason. (A policy on users letting a
  -- user read their own row compares id = auth.uid() and never selects FROM users, so it is
  -- not flagged and needs no entry.) Currently none.
  v_ok text[] := '{}'::text[];
  v_bad   text;
  v_stale text;
begin
  select string_agg(rule || ': ' || tbl || '.' || pol || ' (' || part || ')', E'\n  '
                    order by tbl, pol, part, rule) into v_bad
    from pg_temp.r1618_policy_violations()
   where tbl not like '\_\_t\_%'
     and not (tbl = any (v_other_card_tables))
     and not ((tbl || '.' || pol) = any (v_ok));
  if v_bad is not null then
    raise exception E'R-1618: RLS policies take the tenant from users by auth.uid():\n  %', v_bad
      using hint = 'Use tenant_id = (select public.current_tenant_id()) and, for a role, '
                   || 'public.current_user_has_role(...) — they honour is_active (R-722) and MFA (R-731).';
  end if;

  select string_agg(x, ', ') into v_stale
    from unnest(v_ok) x
   where not exists (select 1 from pg_temp.r1618_policy_violations() v where v.tbl || '.' || v.pol = x);
  if v_stale is not null then
    raise notice 'R-1618: allowlist entries no longer needed (remove them): %', v_stale;
  end if;

  select string_agg(distinct tbl || '.' || pol, ', ') into v_stale
    from pg_temp.r1618_policy_violations() where tbl = any (v_other_card_tables);
  raise notice 'R-1618 policy guard: catalog clean (% allowlisted; other-card tables still flagged: %)',
    cardinality(v_ok), coalesce(v_stale, 'none');
end $$;

-- ── 3. Attack: inactive / aal1 see nothing and write nothing ────────────────────────────
insert into auth.users (id, email) values
  ('c1618000-0000-0000-0000-0000000000a1', 'r1618-plain@example.test'),
  ('c1618000-0000-0000-0000-0000000000a2', 'r1618-mfa@example.test'),
  ('c1618000-0000-0000-0000-0000000000a3', 'r1618-gone@example.test'),
  ('c1618000-0000-0000-0000-0000000000a4', 'r1618-sales@example.test'),
  ('c1618000-0000-0000-0000-0000000000b1', 'r1618-other@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1618000-0000-0000-0000-0000000000f1', 'R1618 Co',    'r1618c@example.test', '07', 'R168C'),
  ('c1618000-0000-0000-0000-0000000000f2', 'R1618 Other', 'r1618o@example.test', '07', 'R168O');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1618000-0000-0000-0000-0000000000a1', 'c1618000-0000-0000-0000-0000000000f1', 'r1618-plain@example.test', 'R1618 Plain', 'owner', true),
  ('c1618000-0000-0000-0000-0000000000a2', 'c1618000-0000-0000-0000-0000000000f1', 'r1618-mfa@example.test',   'R1618 Mfa',   'owner', true),
  ('c1618000-0000-0000-0000-0000000000a3', 'c1618000-0000-0000-0000-0000000000f1', 'r1618-gone@example.test',  'R1618 Gone',  'owner', false),
  ('c1618000-0000-0000-0000-0000000000a4', 'c1618000-0000-0000-0000-0000000000f1', 'r1618-sales@example.test', 'R1618 Sales', 'sales', true),
  ('c1618000-0000-0000-0000-0000000000b1', 'c1618000-0000-0000-0000-0000000000f2', 'r1618-other@example.test', 'R1618 Other', 'owner', true);

insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, secret, created_at, updated_at)
  values ('c1618000-0000-0000-0000-0000000000d1', 'c1618000-0000-0000-0000-0000000000a2', 'test', 'totp', 'verified', 'JBSWY3DPEHPK3PXP', now(), now());

insert into public.prepaid_advances (id, tenant_id, vendor_name, category, total_amount, paid_date)
  values ('c1618000-0000-0000-0000-0000000000c1', 'c1618000-0000-0000-0000-0000000000f1', 'R1618 Vendor', 'Software', 10000, '2026-10-01');
insert into public.compliance_log (id, tenant_id, obligation_key, period_key)
  values ('c1618000-0000-0000-0000-0000000000c2', 'c1618000-0000-0000-0000-0000000000f1', 'gstr1', '2026-09');
insert into public.tenant_secrets (tenant_id, gemini_model)
  values ('c1618000-0000-0000-0000-0000000000f1', 'r1618-model');

create function pg_temp.r1618_as(p_uid uuid, p_aal text) returns void language sql as $$
  select set_config('request.jwt.claims',
    json_build_object('sub', p_uid, 'role', 'authenticated', 'aal', p_aal)::text, true);
$$;
grant execute on function pg_temp.r1618_as(uuid, text) to authenticated;

set local role authenticated;

do $$
declare
  v_who record;
  v_n   int;
  v_st  text;
begin
  for v_who in
    select * from (values
      ('c1618000-0000-0000-0000-0000000000a2'::uuid, 'MFA owner on aal1'),
      ('c1618000-0000-0000-0000-0000000000a3'::uuid, 'deactivated owner')) as w(uid, label)
  loop
    perform pg_temp.r1618_as(v_who.uid, 'aal1');

    select count(*) into v_n from public.prepaid_advances where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n <> 0 then raise exception 'FAIL 3: % reads prepaid_advances (% rows)', v_who.label, v_n; end if;
    select count(*) into v_n from public.compliance_log where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n <> 0 then raise exception 'FAIL 3: % reads compliance_log (% rows)', v_who.label, v_n; end if;
    select count(*) into v_n from public.tenant_secrets where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n <> 0 then raise exception 'FAIL 3: % reads tenant_secrets (% rows)', v_who.label, v_n; end if;

    update public.prepaid_advances set notes = 'r1618 sneak' where id = 'c1618000-0000-0000-0000-0000000000c1';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL 3: % updated prepaid_advances', v_who.label; end if;
    delete from public.prepaid_advances where id = 'c1618000-0000-0000-0000-0000000000c1';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL 3: % deleted prepaid_advances', v_who.label; end if;
    update public.compliance_log set notes = 'r1618 sneak' where id = 'c1618000-0000-0000-0000-0000000000c2';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL 3: % updated compliance_log', v_who.label; end if;
    update public.tenant_secrets set gemini_model = 'r1618 sneak' where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    get diagnostics v_n = row_count;
    if v_n <> 0 then raise exception 'FAIL 3: % updated tenant_secrets', v_who.label; end if;

    begin
      insert into public.prepaid_advances (tenant_id, vendor_name, total_amount)
        values ('c1618000-0000-0000-0000-0000000000f1', 'R1618 sneak', 500);
      raise exception 'FAIL 3: % inserted a prepaid advance', v_who.label;
    exception when others then
      get stacked diagnostics v_st = returned_sqlstate;
      if v_st <> '42501' then raise; end if;
    end;
    begin
      insert into public.compliance_log (tenant_id, obligation_key, period_key)
        values ('c1618000-0000-0000-0000-0000000000f1', 'gstr3b', '2026-09');
      raise exception 'FAIL 3: % inserted a compliance_log row', v_who.label;
    exception when others then
      get stacked diagnostics v_st = returned_sqlstate;
      if v_st <> '42501' then raise; end if;
    end;
  end loop;

  -- another company's owner: nothing
  perform pg_temp.r1618_as('c1618000-0000-0000-0000-0000000000b1', 'aal1');
  select count(*) into v_n from public.prepaid_advances where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 3: another company reads prepaid_advances'; end if;

  -- sales user of the same company: prepaid yes, owner-only secrets no
  perform pg_temp.r1618_as('c1618000-0000-0000-0000-0000000000a4', 'aal1');
  select count(*) into v_n from public.prepaid_advances where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
  if v_n <> 1 then raise exception 'FAIL 3: sales user lost prepaid_advances (% rows)', v_n; end if;
  select count(*) into v_n from public.tenant_secrets where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
  if v_n <> 0 then raise exception 'FAIL 3: sales user reads owner-only tenant_secrets'; end if;

  -- plain owner (no MFA) and MFA owner on aal2: everything still works
  for v_who in
    select * from (values
      ('c1618000-0000-0000-0000-0000000000a1'::uuid, 'plain owner'),
      ('c1618000-0000-0000-0000-0000000000a2'::uuid, 'MFA owner on aal2')) as w(uid, label)
  loop
    perform pg_temp.r1618_as(v_who.uid, 'aal2');
    select count(*) into v_n from public.prepaid_advances where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n < 1 then raise exception 'FAIL 3: % cannot read prepaid_advances', v_who.label; end if;
    select count(*) into v_n from public.compliance_log where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n < 1 then raise exception 'FAIL 3: % cannot read compliance_log', v_who.label; end if;
    select count(*) into v_n from public.tenant_secrets where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    if v_n <> 1 then raise exception 'FAIL 3: % cannot read tenant_secrets', v_who.label; end if;

    update public.prepaid_advances set notes = 'r1618 ok ' || v_who.label where id = 'c1618000-0000-0000-0000-0000000000c1';
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'FAIL 3: % cannot update prepaid_advances', v_who.label; end if;
    insert into public.prepaid_advances (tenant_id, vendor_name, total_amount)
      values ('c1618000-0000-0000-0000-0000000000f1', 'R1618 ' || v_who.label, 500);
    update public.compliance_log set notes = 'r1618 ok' where id = 'c1618000-0000-0000-0000-0000000000c2';
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'FAIL 3: % cannot update compliance_log', v_who.label; end if;
    update public.tenant_secrets set gemini_model = 'r1618-model' where tenant_id = 'c1618000-0000-0000-0000-0000000000f1';
    get diagnostics v_n = row_count;
    if v_n <> 1 then raise exception 'FAIL 3: % cannot update tenant_secrets', v_who.label; end if;

    -- a plain owner still cannot write into another company
    begin
      insert into public.prepaid_advances (tenant_id, vendor_name, total_amount)
        values ('c1618000-0000-0000-0000-0000000000f2', 'R1618 cross', 500);
      raise exception 'FAIL 3: % inserted into another company', v_who.label;
    exception when others then
      get stacked diagnostics v_st = returned_sqlstate;
      if v_st <> '42501' then raise; end if;
    end;
  end loop;

  perform set_config('request.jwt.claims', '', true);
end $$;

reset role;
do $$
declare v_n int;
begin
  select count(*) into v_n from public.prepaid_advances
   where tenant_id = 'c1618000-0000-0000-0000-0000000000f1' and vendor_name like 'R1618 %';
  if v_n <> 3 then raise exception 'FAIL 3: expected the fixture + 2 owner inserts, found % prepaid advances', v_n; end if;
  select count(*) into v_n from public.prepaid_advances where notes like 'r1618 sneak%';
  if v_n <> 0 then raise exception 'FAIL 3: a refused session changed a prepaid advance'; end if;
  raise notice 'R-1618 attack test: inactive + aal1 see 0 rows and write nothing; owners still work';
end $$;

rollback;
