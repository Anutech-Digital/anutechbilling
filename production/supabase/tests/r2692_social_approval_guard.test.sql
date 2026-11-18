-- R-2692 (12 Nov 2026): a marketing login cannot approve / schedule / publish a social post by
-- writing social_content directly; the owner / manager path still works; the cron (service role)
-- still publishes; the OWNER approving with a post time / choosing lead forms turns the job on,
-- never over an owner's own switch; a manager changes no switch.
-- Migrations 20261112060206_r2692_social_approval_guard + 20261117060541_r2709_social_marketing_approves.
-- Self-asserting, ONE transaction, rolled back. Run on a LOCAL DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. R-2709 (16 Nov 2026, migration 20261117060541): marketing reviews too — approves a draft and
--      inserts a scheduled (approved) post, each stamped with its own login (a forged reviewer is
--      replaced); nobody inserts published / failed; a post sent for review has no stamp.
--   B. Manager: review → approved works and reviewed_by is stamped with the manager (not a
--      forged value); Publish now (approved → publishing → published) works.
--   C. Service role (social-publish cron): approved → publishing → published works.
--   D. ensure_social_automation_on: marketing refused; unknown job refused; a manager changes
--      nothing; the owner turns social-publish on (no row) and meta-leads-pull on (over a cron
--      run-stamp row); another owner's OFF stays off.

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
  ('dddddddd-0000-0000-0000-000000269201','R2692 Co','r2692@example.in','07','R2692'),
  ('dddddddd-0000-0000-0000-000000269202','R2692 Other','r2692b@example.in','07','R2692B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000269201','mkt2692@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000269202','mgr2692@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000269203','own2692b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000269204','own2692@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000269201','dddddddd-0000-0000-0000-000000269201','mkt2692@example.in','Mkt 2692','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000269202','dddddddd-0000-0000-0000-000000269201','mgr2692@example.in','Mgr 2692','manager', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000269203','dddddddd-0000-0000-0000-000000269202','own2692b@example.in','Owner 2692B','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000269204','dddddddd-0000-0000-0000-000000269201','own2692@example.in','Owner 2692','owner', true, now() - interval '1 day');

-- Seed as the server: one post in review, one already approved (by the manager), one draft, one draft to delete.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.social_content (id, tenant_id, platform, format, caption, status, scheduled_at, reviewed_by) values
  ('eeeeeeee-0000-0000-0000-000000269201','dddddddd-0000-0000-0000-000000269201','facebook','post','In review',  'review',   now() + interval '1 hour', null),
  ('eeeeeeee-0000-0000-0000-000000269202','dddddddd-0000-0000-0000-000000269201','facebook','post','Approved',   'approved', now() + interval '1 hour', 'aaaaaaaa-0000-0000-0000-000000269202'),
  ('eeeeeeee-0000-0000-0000-000000269203','dddddddd-0000-0000-0000-000000269201','facebook','post','Draft',      'draft',    null, null),
  ('eeeeeeee-0000-0000-0000-000000269205','dddddddd-0000-0000-0000-000000269201','facebook','post','Draft 2',    'draft',    null, null);

-- ── A. As the MARKETING login (R-2709: marketing reviews too) ────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269201","role":"authenticated"}', true);
set local role authenticated;
do $$
declare v_msg text;
begin
  -- Marketing approves a draft; a forged reviewer is replaced by the real login.
  update public.social_content set status = 'approved', scheduled_at = now() + interval '2 hours',
         reviewed_by = 'aaaaaaaa-0000-0000-0000-000000269202'
   where id = 'eeeeeeee-0000-0000-0000-000000269203';
  if (select status from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269203') <> 'approved' then
    raise exception 'FAIL A1: marketing could not approve (R-2709)';
  end if;
  if (select reviewed_by from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269203') is distinct from 'aaaaaaaa-0000-0000-0000-000000269201' then
    raise exception 'FAIL A2: reviewed_by is not the approving marketing login';
  end if;
  -- "Schedule post": a reviewer inserts an approved post, stamped with that login.
  insert into public.social_content (id, tenant_id, platform, format, caption, status, scheduled_at, reviewed_by)
  values ('eeeeeeee-0000-0000-0000-000000269206','dddddddd-0000-0000-0000-000000269201','facebook','post','Scheduled','approved', now() + interval '5 minutes','aaaaaaaa-0000-0000-0000-000000269202');
  if (select reviewed_by from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269206') is distinct from 'aaaaaaaa-0000-0000-0000-000000269201' then
    raise exception 'FAIL A3: an inserted approved post is not stamped with the login';
  end if;
  -- Nobody inserts a published / failed post.
  begin
    insert into public.social_content (tenant_id, platform, format, caption, status)
    values ('dddddddd-0000-0000-0000-000000269201','facebook','post','Sneaky','published');
    raise exception 'FAIL A4: a published post was inserted directly';
  exception when insufficient_privilege then
    get stacked diagnostics v_msg = message_text;
    if v_msg not like 'A new post is saved as a draft%' then raise exception 'FAIL A4b: wrong sentence: %', v_msg; end if;
  end;
  begin
    insert into public.social_content (tenant_id, platform, format, caption, status)
    values ('dddddddd-0000-0000-0000-000000269201','facebook','post','Sneaky','failed');
    raise exception 'FAIL A5: a failed post was inserted directly';
  exception when insufficient_privilege then null;
  end;
  -- A post sent for review carries no reviewer stamp.
  insert into public.social_content (id, tenant_id, platform, format, caption, status, reviewed_by)
  values ('eeeeeeee-0000-0000-0000-000000269204','dddddddd-0000-0000-0000-000000269201','facebook','post','New one','review','aaaaaaaa-0000-0000-0000-000000269202');
  if (select reviewed_by from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269204') is not null then
    raise exception 'FAIL A9: a new post kept a reviewer stamp';
  end if;
  if (select status from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269201') <> 'review' then
    raise exception 'FAIL A10: section A changed the post kept for B';
  end if;
  delete from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269205';
  if exists (select 1 from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269205') then
    raise exception 'FAIL A12: marketing could not delete its own draft';
  end if;
  raise notice 'PASS A: marketing approves and schedules (stamped as reviewer); nobody inserts published / failed; review posts carry no stamp';
end $$;

-- ── B. As the MANAGER login ──────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269202","role":"authenticated"}', true);
do $$
begin
  update public.social_content set status = 'approved', reviewed_by = 'aaaaaaaa-0000-0000-0000-000000269201'
   where id = 'eeeeeeee-0000-0000-0000-000000269201';
  if (select status from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269201') <> 'approved' then
    raise exception 'FAIL B1: manager could not approve';
  end if;
  if (select reviewed_by from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269201') is distinct from 'aaaaaaaa-0000-0000-0000-000000269202' then
    raise exception 'FAIL B2: reviewed_by is not the approving manager';
  end if;
  update public.social_content set status = 'publishing' where id = 'eeeeeeee-0000-0000-0000-000000269201' and status = 'approved';
  update public.social_content set status = 'published', external_id = 'fb_1', published_by = 'aaaaaaaa-0000-0000-0000-000000269202', published_at = now()
   where id = 'eeeeeeee-0000-0000-0000-000000269201' and status = 'publishing';
  if (select status from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269201') <> 'published' then
    raise exception 'FAIL B3: manager Publish now did not reach published';
  end if;
  raise notice 'PASS B: manager approves (stamped as reviewer) and publishes';
end $$;

-- ── C. As the social-publish cron (service role) ─────────────────────────────
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  update public.social_content set status = 'publishing' where id = 'eeeeeeee-0000-0000-0000-000000269202' and status = 'approved';
  update public.social_content set status = 'published', external_id = 'fb_2', published_at = now()
   where id = 'eeeeeeee-0000-0000-0000-000000269202' and status = 'publishing';
  if (select status from public.social_content where id = 'eeeeeeee-0000-0000-0000-000000269202') <> 'published' then
    raise exception 'FAIL C1: the cron could not publish an approved post';
  end if;
  raise notice 'PASS C: the cron publishes an approved post';
end $$;

-- ── D. ensure_social_automation_on ───────────────────────────────────────────
reset role;
-- A cron run stamp made this row (enabled = false, nobody's choice); the other company's owner
-- switches social-publish OFF for their company by hand.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.automation_jobs (tenant_id, job, enabled) values
  ('dddddddd-0000-0000-0000-000000269201','meta-leads-pull', false);
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269203","role":"authenticated"}', true);
set local role authenticated;
select public.set_automation_job('social-publish', false, false);
do $$
begin
  if public.ensure_social_automation_on('social-publish') then
    raise exception 'FAIL D1: an owner''s OFF was turned back on';
  end if;
  if (select enabled from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000269202' and job = 'social-publish') then
    raise exception 'FAIL D1b: owner''s OFF row changed';
  end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269201","role":"authenticated"}', true);
do $$
begin
  /* R-2917 (18 Nov 2026): marketing now turns the Social growth jobs on too. */
  if not public.ensure_social_automation_on('social-publish') then
    raise exception 'FAIL D2: marketing could not turn social-publish on (R-2917)';
  end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269202","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.ensure_social_automation_on('invoice-dunning');
    raise exception 'FAIL D3: another job through this function';
  exception when invalid_parameter_value then null;
  end;
  /* R-2917: a manager may switch it too; marketing (D2) already turned it on for this company. */
  if not public.ensure_social_automation_on('social-publish') then
    raise exception 'FAIL D4: social-publish is not on for the manager after marketing turned it on';
  end if;
end $$;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000269204","role":"authenticated"}', true);
do $$
begin
  if not public.ensure_social_automation_on('social-publish') then
    raise exception 'FAIL D5: owner, no row → not turned on';
  end if;
  if not public.ensure_social_automation_on('meta-leads-pull') then
    raise exception 'FAIL D6: owner, run-stamp row (nobody''s choice) → not turned on';
  end if;
  if not public.ensure_social_automation_on('social-publish') then
    raise exception 'FAIL D7: a second call turned it off';
  end if;
  raise notice 'PASS D: owner, manager and marketing turn the jobs on (R-2917); an owner''s OFF stays; other jobs refused';
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  if (select count(*) from public.automation_jobs
       where tenant_id = 'dddddddd-0000-0000-0000-000000269201' and job in ('social-publish','meta-leads-pull')
         and enabled and changed_by is not null) <> 2
     or (select changed_by from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000269201' and job = 'social-publish')
        is distinct from 'aaaaaaaa-0000-0000-0000-000000269201'::uuid
     or (select changed_by from public.automation_jobs where tenant_id = 'dddddddd-0000-0000-0000-000000269201' and job = 'meta-leads-pull')
        is distinct from 'aaaaaaaa-0000-0000-0000-000000269204'::uuid then
    raise exception 'FAIL D8: the switched-on rows do not name who did it (marketing: social-publish, owner: meta-leads-pull — R-2917)';
  end if;
  if (select automation_state('social-publish', 'dddddddd-0000-0000-0000-000000269201')) <> 'on' then
    raise exception 'FAIL D9: automation_state does not read on';
  end if;
end $$;

rollback;
