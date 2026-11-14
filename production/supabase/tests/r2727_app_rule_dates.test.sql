\set ON_ERROR_STOP on
-- R-2727 review (MED): public.app_rule_dates holds the moment the invoice period rule went live on
-- THIS database (migration 20261113181025_r2727_invoice_period_rule_from). Self-asserting, ONE
-- transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2727_app_rule_dates.test.sql
--
-- Expect "PASS r2727_app_rule_dates".
--   ROW      the rule row exists, from_at is a real moment (not in the future, not before this card)
--   READ     a signed-in user can read it (RLS select policy)
--   NOWRITE  a signed-in user cannot change it (select-only grant, no write policy)
--   ANON     a logged-out visitor cannot read it
--   SERVICE  service_role has its own policy (Cloud SQL: no BYPASSRLS) and reads the row
--   ONCE     re-running the insert keeps the first from_at (on conflict do nothing)

begin;
select set_config('request.jwt.claims', '', true);

do $$
declare
  v_fails text[] := '{}';
  v_from  timestamptz;
  v_n     int;
begin
  select from_at into v_from from public.app_rule_dates where key = 'r2727_invoice_period_rule';
  if v_from is null then v_fails := v_fails || 'ROW: no r2727_invoice_period_rule row'; end if;
  if v_from > now() + interval '1 minute' then v_fails := v_fails || 'ROW: from_at in the future'; end if;
  if v_from < timestamptz '2026-11-13 15:00:00+00' then v_fails := v_fails || 'ROW: from_at before the card existed'; end if;

  -- READ as a signed-in user (any tenant): the row is not tenant data.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000r272","role":"authenticated"}', true);
  select count(*) into v_n from public.app_rule_dates where key = 'r2727_invoice_period_rule';
  if v_n <> 1 then v_fails := v_fails || format('READ: signed-in user sees %s rows', v_n); end if;

  -- NOWRITE: a signed-in user has SELECT only (R-2322 grants) — update / delete / insert are refused
  -- (or, should a grant ever come back, still change 0 rows: no write policy for authenticated).
  begin
    update public.app_rule_dates set from_at = now() + interval '10 years' where key = 'r2727_invoice_period_rule';
    get diagnostics v_n = row_count;
    if v_n <> 0 then v_fails := v_fails || 'NOWRITE: signed-in user could update'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.app_rule_dates where key = 'r2727_invoice_period_rule';
    get diagnostics v_n = row_count;
    if v_n <> 0 then v_fails := v_fails || 'NOWRITE: signed-in user could delete'; end if;
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.app_rule_dates (key) values ('r2727_test_insert');
    v_fails := v_fails || 'NOWRITE: signed-in user could insert';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  -- ANON: a logged-out visitor cannot read it (revoked).
  perform set_config('role', 'anon', true);
  begin
    perform 1 from public.app_rule_dates;
    v_fails := v_fails || 'ANON: anon could read';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);

  -- SERVICE ROLE (re-review MED): the invoice PDF route reads with the admin client. On Cloud SQL
  -- service_role has NO BYPASSRLS, so it needs its own policy — check the policy exists (local
  -- Supabase's service_role bypasses RLS, so a plain read alone would prove nothing) AND read as it.
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'app_rule_dates'
                   and policyname = 'zzz_service_role_all' and 'service_role' = any(roles) and cmd = 'ALL') then
    v_fails := v_fails || 'SERVICE: no zzz_service_role_all policy for service_role';
  end if;
  perform set_config('role', 'service_role', true);
  select count(*) into v_n from public.app_rule_dates where key = 'r2727_invoice_period_rule';
  if v_n <> 1 then v_fails := v_fails || format('SERVICE: service_role sees %s rows', v_n); end if;
  perform set_config('role', 'postgres', true);

  -- ONCE
  insert into public.app_rule_dates (key, from_at) values ('r2727_invoice_period_rule', now() + interval '1 day') on conflict (key) do nothing;
  if (select from_at from public.app_rule_dates where key = 'r2727_invoice_period_rule') <> v_from then
    v_fails := v_fails || 'ONCE: a second insert moved from_at';
  end if;

  if array_length(v_fails, 1) > 0 then
    raise exception 'FAIL r2727_app_rule_dates: %', array_to_string(v_fails, ' | ');
  end if;
  raise notice 'PASS r2727_app_rule_dates';
end $$;

rollback;
