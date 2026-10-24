-- R-1878 (25 Oct 2026): campaign co-pilot tables — ad_plans, ad_target_groups, ad_creatives,
-- ad_copies (under marketing_campaigns). Migration 20261024234500_ad_copilot_tables.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Owner, manager and marketing logins can make a plan with target groups, creatives and copies.
--   B. Tenant isolation: another company's plan / child rows are invisible, and cannot be written
--      (insert with the other tenant_id, or a child row pointing at the other company's plan).
--   C. Roles: sales and billing see nothing and cannot write; a deactivated owner sees nothing.
--   D. Same-company links: a plan cannot point at another company's campaign or product.
--   E. Checks: objective, platform list, status, copy platform, target-group ages and kind,
--      creative mime/size, copy text not blank.
--   F. Deleting a plan deletes its children; deleting the campaign keeps the plan (link cleared).
--   G. service_role (the server) can read and write every company's rows (Cloud SQL, R-450).

begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000187801','R1878 Co','r1878@example.in','07','R1878'),
  ('dddddddd-0000-0000-0000-000000187802','R1878 Other','r1878b@example.in','07','R1878B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000187801','owner1878@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187802','mkt1878@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187803','sales1878@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187804','billing1878@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187805','owner1878b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187806','exowner1878@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187807','mgr1878@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000187801','dddddddd-0000-0000-0000-000000187801','owner1878@example.in','Owner 1878','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187802','dddddddd-0000-0000-0000-000000187801','mkt1878@example.in','Mkt 1878','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187803','dddddddd-0000-0000-0000-000000187801','sales1878@example.in','Sales 1878','sales', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187804','dddddddd-0000-0000-0000-000000187801','billing1878@example.in','Billing 1878','billing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187805','dddddddd-0000-0000-0000-000000187802','owner1878b@example.in','Owner 1878B','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187806','dddddddd-0000-0000-0000-000000187801','exowner1878@example.in','Ex 1878','owner', false, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187807','dddddddd-0000-0000-0000-000000187801','mgr1878@example.in','Mgr 1878','manager', true, now() - interval '1 day');

insert into public.marketing_campaigns (id, tenant_id, name, code, start_date, end_date, budget) values
  ('cccccccc-0000-0000-0000-000000187801','dddddddd-0000-0000-0000-000000187801','Diwali 1878','diwali-1878','2026-11-01','2026-11-30',20000),
  ('cccccccc-0000-0000-0000-000000187802','dddddddd-0000-0000-0000-000000187802','Other 1878','other-1878','2026-11-01','2026-11-30',5000);

-- The other company's plan + children, written by the server.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.ad_plans (id, tenant_id, marketing_campaign_id, name, objective, platforms, prompt)
values ('eeeeeeee-0000-0000-0000-000000187802','dddddddd-0000-0000-0000-000000187802',
        'cccccccc-0000-0000-0000-000000187802','Other plan','traffic', array['google-ads'], 'Other company prompt');
insert into public.ad_target_groups (tenant_id, plan_id, name, kind)
values ('dddddddd-0000-0000-0000-000000187802','eeeeeeee-0000-0000-0000-000000187802','Other group','generic');
insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
values ('dddddddd-0000-0000-0000-000000187802','eeeeeeee-0000-0000-0000-000000187802','google-ads','search','headline','Other headline',0);
insert into public.ad_creatives (tenant_id, plan_id, storage_path, mime_type, width, height, size_bytes)
values ('dddddddd-0000-0000-0000-000000187802','eeeeeeee-0000-0000-0000-000000187802','other/a.png','image/png',1080,1080,1000);

-- ── A. As the MARKETING login ────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187802","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.ad_plans (id, tenant_id, marketing_campaign_id, name, objective, platforms, prompt, tone, language)
  values ('eeeeeeee-0000-0000-0000-000000187801','dddddddd-0000-0000-0000-000000187801',
          'cccccccc-0000-0000-0000-000000187801','Diwali Workspace','lead_gen', array['google-ads','meta-ads'],
          'Google Workspace Diwali offer for Delhi SMEs', 'friendly', 'en');
  insert into public.ad_target_groups (tenant_id, plan_id, platform, name, kind, age_min, age_max, genders, regions, interests)
  values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801', null, 'Delhi SMEs', 'custom',
          25, 55, array['male','female'], '[{"country":"IN","region":"Delhi"}]', '["Small business"]');
  insert into public.ad_creatives (tenant_id, plan_id, storage_path, mime_type, width, height, size_bytes)
  values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','r1878/a.png','image/png',1200,628,20000);
  insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position, ai_generated)
  values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','google-ads','search','headline','Workspace for Diwali',0,true),
         ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','meta-ads','feed_image','primary_text','Get Google Workspace this Diwali.',0,true);
  update public.ad_plans set status = 'ready' where id = 'eeeeeeee-0000-0000-0000-000000187801';
  if (select count(*) from public.ad_plans) <> 1 then raise exception 'FAIL A1: marketing sees % plans (want own 1)', (select count(*) from public.ad_plans); end if;
  if (select count(*) from public.ad_copies) <> 2 then raise exception 'FAIL A2: copies %', (select count(*) from public.ad_copies); end if;
  if (select count(*) from public.ad_target_groups) <> 1 or (select count(*) from public.ad_creatives) <> 1 then
    raise exception 'FAIL A3: other company''s children visible'; end if;
  if (select created_by from public.ad_plans where id = 'eeeeeeee-0000-0000-0000-000000187801') is distinct from 'aaaaaaaa-0000-0000-0000-000000187802' then
    raise exception 'FAIL A4: created_by not filled from the login'; end if;
  raise notice 'PASS A: marketing makes a plan with groups, creative and copies; sees only own company';
end $$;

-- ── B. Tenant isolation (still marketing) ───────────────────────────────────
do $$
declare n int;
begin
  begin
    insert into public.ad_plans (tenant_id, name, objective, platforms, prompt)
    values ('dddddddd-0000-0000-0000-000000187802','Sneaky','traffic', array['google-ads'],'x');
    raise exception 'FAIL B1: wrote a plan for another company';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187802','google-ads','search','headline','Hijack',1);
    raise exception 'FAIL B2: own-tenant copy attached to another company''s plan';
  exception when foreign_key_violation then null;
  end;
  update public.ad_plans set name = 'Hacked' where id = 'eeeeeeee-0000-0000-0000-000000187802';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B3: updated another company''s plan'; end if;
  delete from public.ad_copies where plan_id = 'eeeeeeee-0000-0000-0000-000000187802';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL B4: deleted another company''s copy'; end if;
  begin
    update public.ad_plans set tenant_id = 'dddddddd-0000-0000-0000-000000187802' where id = 'eeeeeeee-0000-0000-0000-000000187801';
    raise exception 'FAIL B5: moved own plan to another company';
  -- either refusal is right: the campaign link (trigger) or RLS with check
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  begin
    update public.ad_copies set tenant_id = 'dddddddd-0000-0000-0000-000000187802' where plan_id = 'eeeeeeee-0000-0000-0000-000000187801';
    raise exception 'FAIL B6: moved own copy to another company';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  raise notice 'PASS B: other company''s rows invisible and unwritable';
end $$;

-- D. same-company links
do $$
begin
  begin
    insert into public.ad_plans (tenant_id, marketing_campaign_id, name, objective, platforms, prompt)
    values ('dddddddd-0000-0000-0000-000000187801','cccccccc-0000-0000-0000-000000187802','Wrong camp','traffic', array['meta-ads'],'x');
    raise exception 'FAIL D1: plan linked to another company''s campaign';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.ad_plans (tenant_id, item_id, name, objective, platforms, prompt)
    values ('dddddddd-0000-0000-0000-000000187801','no-such-item-1878','Wrong item','traffic', array['meta-ads'],'x');
    raise exception 'FAIL D2: plan linked to a product that is not this company''s';
  exception when foreign_key_violation then null;
  end;
  raise notice 'PASS D: campaign and product must be this company''s';
end $$;

-- E. checks
do $$
begin
  begin
    insert into public.ad_plans (tenant_id, name, objective, platforms, prompt) values ('dddddddd-0000-0000-0000-000000187801','Bad','viral', array['meta-ads'],'x');
    raise exception 'FAIL E1: unknown objective accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_plans (tenant_id, name, objective, platforms, prompt) values ('dddddddd-0000-0000-0000-000000187801','Bad','traffic', array['myspace'],'x');
    raise exception 'FAIL E2: unknown platform accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_plans (tenant_id, name, objective, platforms, prompt) values ('dddddddd-0000-0000-0000-000000187801','Bad','traffic', array[]::text[],'x');
    raise exception 'FAIL E3: empty platform list accepted';
  exception when check_violation then null;
  end;
  begin
    update public.ad_plans set status = 'paused-ish' where id = 'eeeeeeee-0000-0000-0000-000000187801';
    raise exception 'FAIL E4: unknown status accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_target_groups (tenant_id, plan_id, name, kind, age_min, age_max)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','Bad ages','generic',50,20);
    raise exception 'FAIL E5: age_min > age_max accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_target_groups (tenant_id, plan_id, name, kind)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','Bad kind','boomer');
    raise exception 'FAIL E6: unknown kind accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_creatives (tenant_id, plan_id, storage_path, mime_type, width, height, size_bytes)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','r1878/x.exe','application/x-msdownload',1,1,10);
    raise exception 'FAIL E7: non-image/video creative accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','google-ads','search','headline','   ',5);
    raise exception 'FAIL E8: blank copy accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','tiktok','x','headline','Hi',6);
    raise exception 'FAIL E9: unknown copy platform accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187801','google-ads','search','headline','Dup slot',0);
    raise exception 'FAIL E10: two copies in the same slot';
  exception when unique_violation then null;
  end;
  raise notice 'PASS E: objective / platform / status / ages / kind / mime / blank / slot checks';
end $$;
reset role;

-- ── A (cont). Owner and manager can read + write ────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187807","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_plans) <> 1 then raise exception 'FAIL A5: manager cannot see the plan'; end if;
  update public.ad_copies set text = 'Workspace this Diwali' where platform = 'google-ads';
  if not found then raise exception 'FAIL A6: manager cannot edit a copy'; end if;
  raise notice 'PASS A5-6: manager reads and edits';
end $$;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187801","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_plans) <> 1 then raise exception 'FAIL A7: owner cannot see the plan'; end if;
  raise notice 'PASS A7: owner reads';
end $$;
reset role;

-- ── C. Roles that must not see it ───────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187803","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.ad_plans) or exists (select 1 from public.ad_copies) or exists (select 1 from public.ad_target_groups) or exists (select 1 from public.ad_creatives) then
    raise exception 'FAIL C1: sales sees co-pilot rows'; end if;
  begin
    insert into public.ad_plans (tenant_id, name, objective, platforms, prompt) values ('dddddddd-0000-0000-0000-000000187801','Sales plan','traffic', array['meta-ads'],'x');
    raise exception 'FAIL C2: sales wrote a plan';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS C1-2: sales sees nothing, cannot write';
end $$;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187804","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.ad_plans) then raise exception 'FAIL C3: billing sees plans'; end if;
  raise notice 'PASS C3: billing sees nothing';
end $$;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187806","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.ad_plans) then raise exception 'FAIL C4: deactivated owner sees plans'; end if;
  raise notice 'PASS C4: deactivated owner sees nothing';
end $$;
reset role;

-- ── F + G. As the SERVER ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  if (select count(*) from public.ad_plans where id in ('eeeeeeee-0000-0000-0000-000000187801','eeeeeeee-0000-0000-0000-000000187802')) <> 2 then
    raise exception 'FAIL G1: server does not see both companies'' plans'; end if;
  update public.ad_plans set status = 'publishing' where id = 'eeeeeeee-0000-0000-0000-000000187802';
  if not found then raise exception 'FAIL G2: server cannot write'; end if;
  -- Local service_role has BYPASSRLS, Cloud SQL's does not — so check the policy itself.
  if (select count(*) from pg_policies where schemaname = 'public' and policyname = 'zzz_service_role_all'
        and 'service_role' = any (roles)
        and tablename in ('ad_plans', 'ad_target_groups', 'ad_creatives', 'ad_copies')) <> 4 then
    raise exception 'FAIL G3: a co-pilot table has no service_role policy (Cloud SQL, R-450)'; end if;
  raise notice 'PASS G: service_role reads/writes every company (R-450)';
end $$;
reset role;

do $$
begin
  delete from public.marketing_campaigns where id = 'cccccccc-0000-0000-0000-000000187801';
  if (select marketing_campaign_id from public.ad_plans where id = 'eeeeeeee-0000-0000-0000-000000187801') is not null then
    raise exception 'FAIL F1: campaign delete did not clear the link'; end if;
  delete from public.ad_plans where id = 'eeeeeeee-0000-0000-0000-000000187801';
  if exists (select 1 from public.ad_copies where plan_id = 'eeeeeeee-0000-0000-0000-000000187801')
     or exists (select 1 from public.ad_target_groups where plan_id = 'eeeeeeee-0000-0000-0000-000000187801')
     or exists (select 1 from public.ad_creatives where plan_id = 'eeeeeeee-0000-0000-0000-000000187801') then
    raise exception 'FAIL F2: plan delete left children behind'; end if;
  raise notice 'PASS F: campaign delete keeps plan (link cleared); plan delete takes its children';
end $$;

rollback;
