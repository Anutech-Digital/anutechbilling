-- Regression test: Marketing Hub tables (migration 20260926190000).
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/marketing_hub.test.sql
--
-- What it proves:
--   1. A company saves its tool state; saving the same tool again updates, never duplicates.
--   2. Another company sees none of it, and cannot write into it.
--   3. Tracking links are per company.
--   4. A signed-in user CANNOT add an address to the opt-out list (only the signed public
--      link, via the service role, can) — but can read and remove their own company's.
--   5. Opt-out emails must be stored lower-case and trimmed.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('aaaaaaaa-0000-0000-0000-0000000000d8', 'HUB TEST A', 'hub-a@example.in', '07'),
  ('bbbbbbbb-0000-0000-0000-0000000000d8', 'HUB TEST B', 'hub-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('aaaaaaaa-0000-0000-0000-00000000d0a8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hub-a-user@example.in'),
  ('bbbbbbbb-0000-0000-0000-00000000d0b8', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'hub-b-user@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('aaaaaaaa-0000-0000-0000-00000000d0a8', 'aaaaaaaa-0000-0000-0000-0000000000d8', 'hub-a-user@example.in', 'owner'),
  ('bbbbbbbb-0000-0000-0000-00000000d0b8', 'bbbbbbbb-0000-0000-0000-0000000000d8', 'hub-b-user@example.in', 'owner');

-- The service role (public unsubscribe route) records one opt-out for each company.
insert into public.email_suppressions (tenant_id, email) values
  ('aaaaaaaa-0000-0000-0000-0000000000d8', 'gone@democo.test'),
  ('bbbbbbbb-0000-0000-0000-0000000000d8', 'other@b.in');

-- 5. Stored normalised
do $$ begin
  begin
    insert into public.email_suppressions (tenant_id, email) values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'Mixed@Case.in');
    raise exception 'FAIL 5: mixed-case email accepted';
  exception when check_violation then null;
  end;
end $$;

set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000d0a8', 'role', 'authenticated')::text, true);

-- 1. Save, then save again → one row, updated
do $$
declare n int; b int;
begin
  insert into public.marketing_tools (tenant_id, tool_key, name, status, monthly_budget)
  values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'meta-ads', 'Meta Ads', 'setting_up', 3000);
  insert into public.marketing_tools (tenant_id, tool_key, name, status, monthly_budget)
  values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'meta-ads', 'Meta Ads', 'active', 5000)
  on conflict (tenant_id, tool_key) do update set status = excluded.status, monthly_budget = excluded.monthly_budget;
  select count(*), max(monthly_budget) into n, b from public.marketing_tools where tool_key = 'meta-ads';
  if n <> 1 or b <> 5000 then raise exception 'FAIL 1: % rows, budget %', n, b; end if;

  insert into public.tracking_links (tenant_id, label, channel, utm_medium, utm_campaign, destination_path, full_url)
  values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'FB Diwali', 'meta-ads', 'cpc', 'diwali-2026', '/enquiry',
          'https://x.in/enquiry?utm_source=meta-ads&utm_medium=cpc&utm_campaign=diwali-2026');
end $$;

-- 4. Cannot add an opt-out from the browser; can read own
do $$
declare n int;
begin
  begin
    insert into public.email_suppressions (tenant_id, email) values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'victim@democo.test');
    raise exception 'FAIL 4a: a signed-in user added an opt-out';
  exception when insufficient_privilege then null;
  end;
  select count(*) into n from public.email_suppressions;
  if n <> 1 then raise exception 'FAIL 4b: A sees % opt-outs (expected its own 1)', n; end if;
end $$;

-- 2 + 3. Company B sees none of A's rows and cannot write into A
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-00000000d0b8', 'role', 'authenticated')::text, true);
do $$
declare t int; l int; s int;
begin
  select count(*) into t from public.marketing_tools;
  select count(*) into l from public.tracking_links;
  select count(*) into s from public.email_suppressions where email = 'gone@democo.test';
  if t <> 0 or l <> 0 or s <> 0 then raise exception 'FAIL 2: B sees tools %, links %, A opt-outs %', t, l, s; end if;
  begin
    insert into public.marketing_tools (tenant_id, tool_key, name) values ('aaaaaaaa-0000-0000-0000-0000000000d8', 'google-ads', 'x');
    raise exception 'FAIL 2b: B wrote into A';
  exception when insufficient_privilege then null;
  end;
  -- B deleting A's opt-out does nothing
  delete from public.email_suppressions where email = 'gone@democo.test';
end $$;

-- 4c. A can remove its own opt-out (someone who asked back in); B's delete above did nothing
select set_config('request.jwt.claims', json_build_object('sub', 'aaaaaaaa-0000-0000-0000-00000000d0a8', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.email_suppressions where email = 'gone@democo.test';
  if n <> 1 then raise exception 'FAIL 4c: B removed A''s opt-out'; end if;
  delete from public.email_suppressions where email = 'gone@democo.test';
  select count(*) into n from public.email_suppressions where email = 'gone@democo.test';
  if n <> 0 then raise exception 'FAIL 4d: A could not remove its own opt-out'; end if;
end $$;

select 'marketing_hub: all assertions passed' as result;
rollback;
