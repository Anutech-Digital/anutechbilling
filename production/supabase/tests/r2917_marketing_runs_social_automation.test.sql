-- R-2917 (18 Nov 2026): marketing switches the Social growth jobs (Monday AI plan, scheduled posts,
-- lead-form leads); sales cannot; no one but the owner switches any other automation.
-- Migration 20261118055047_r2917_marketing_runs_social_automation.
-- Self-asserting, ONE transaction, rolled back. LOCAL DB only.
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
  ('dddddddd-0000-0000-0000-000000291701','R2917 Co','r2917@example.in','07','R2917');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000291701','mkt2917@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000291702','sales2917@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000291701','dddddddd-0000-0000-0000-000000291701','mkt2917@example.in','Mkt 2917','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000291702','dddddddd-0000-0000-0000-000000291701','sales2917@example.in','Sales 2917','sales', true, now() - interval '1 day');

-- ── Marketing switches the Social growth jobs ───────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000291701","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  perform public.set_social_automation('social-drafts', true);
  perform public.ensure_social_automation_on('social-publish');
  begin
    perform public.set_social_automation('renewal-emails', true);
    raise exception 'FAIL M3: marketing switched a non-social job';
  exception when invalid_parameter_value then null;
  end;
  raise notice 'PASS M: marketing switches social-drafts / social-publish, nothing else';
end $$;
reset role;
do $$
begin
  if not (select enabled from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000291701' and job = 'social-drafts') then
    raise exception 'FAIL M1: social-drafts not on after marketing saved it';
  end if;
  if (select changed_by from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000291701' and job = 'social-drafts')
     is distinct from 'aaaaaaaa-0000-0000-0000-000000291701'::uuid then
    raise exception 'FAIL M2: changed_by is not the marketing person';
  end if;
  if not (select enabled from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000291701' and job = 'social-publish') then
    raise exception 'FAIL M4: approve-with-time by marketing did not turn social-publish on';
  end if;
end $$;

-- ── Marketing can turn the Monday plan off again ─────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000291701","role":"authenticated"}', true);
set local role authenticated;
select public.set_social_automation('social-drafts', false);
reset role;
do $$
begin
  if (select enabled from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000291701' and job = 'social-drafts') then
    raise exception 'FAIL M5: marketing could not turn social-drafts off';
  end if;
end $$;

-- ── Sales cannot ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000291702","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.set_social_automation('social-drafts', true);
    raise exception 'FAIL S1: sales switched social-drafts';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ensure_social_automation_on('social-publish');
    raise exception 'FAIL S2: sales turned social-publish on';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS S: sales cannot switch Social growth jobs';
end $$;
reset role;

rollback;
