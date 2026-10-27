-- R-1897 (25 Oct 2026): Co-pilot Step 3 — ad copy per platform AND audience, with versions.
-- Migration 20261025092735_r1897_ad_copy_sets (on top of R-1878's 20261025001000_ad_copilot_tables).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. Marketing saves a set (version) + its version history + lines for two audiences; the same
--      headline position exists once per audience; an old row with no audience is the main audience.
--   B. Checks: duplicate slot in one audience refused; unknown audience / pin 4 refused.
--   C. Tenant isolation: another company's set and versions invisible and unwritable; a set under
--      another company's plan, and a version under another company's set, are refused (composite FK).
--   D. Roles: sales sees nothing and cannot write.
--   E. Deleting the plan deletes its sets and versions.

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
  ('dddddddd-0000-0000-0000-000000189701','R1897 Co','r1897@example.in','07','R1897'),
  ('dddddddd-0000-0000-0000-000000189702','R1897 Other','r1897b@example.in','07','R1897B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000189701','mkt1897@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000189702','sales1897@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000189703','owner1897b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000189701','dddddddd-0000-0000-0000-000000189701','mkt1897@example.in','Mkt 1897','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000189702','dddddddd-0000-0000-0000-000000189701','sales1897@example.in','Sales 1897','sales', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000189703','dddddddd-0000-0000-0000-000000189702','owner1897b@example.in','Owner 1897B','owner', true, now() - interval '1 day');

-- Both plans + the other company's set, version and line, written by the server.
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into public.ad_plans (id, tenant_id, name, objective, platforms, prompt) values
  ('eeeeeeee-0000-0000-0000-000000189701','dddddddd-0000-0000-0000-000000189701','Diwali Workspace','lead_gen', array['google-ads','meta-ads'],'Diwali offer'),
  ('eeeeeeee-0000-0000-0000-000000189702','dddddddd-0000-0000-0000-000000189702','Other plan','traffic', array['google-ads'],'Other');
insert into public.ad_copy_sets (id, tenant_id, plan_id, platform, audience, format, version)
values ('ffffffff-0000-0000-0000-000000189702','dddddddd-0000-0000-0000-000000189702','eeeeeeee-0000-0000-0000-000000189702','google-ads','generic','search',4);
insert into public.ad_copy_set_versions (tenant_id, set_id, version, lines)
values ('dddddddd-0000-0000-0000-000000189702','ffffffff-0000-0000-0000-000000189702',4,'[{"field":"headline","text":"Other headline"}]');
insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
values ('dddddddd-0000-0000-0000-000000189702','eeeeeeee-0000-0000-0000-000000189702','google-ads','search','headline','Other headline',0);
-- E-prep: a line saved before this migration's columns were used (no audience given).
insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position)
values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','feed_image','primary_text','Old primary text',0);

-- ── A. As the MARKETING login ────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189701","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select audience from public.ad_copies where text = 'Old primary text') <> 'generic'
     or (select locked from public.ad_copies where text = 'Old primary text') is distinct from false
     or (select pinned from public.ad_copies where text = 'Old primary text') is not null then
    raise exception 'FAIL A0: an existing line is not the main audience / unlocked / unpinned';
  end if;

  insert into public.ad_copy_sets (id, tenant_id, plan_id, platform, audience, format)
  values ('ffffffff-0000-0000-0000-000000189701','dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','generic','feed_image'),
         ('ffffffff-0000-0000-0000-000000189703','dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','lookalike','feed_image');
  insert into public.ad_copy_set_versions (tenant_id, set_id, version, lines)
  values ('dddddddd-0000-0000-0000-000000189701','ffffffff-0000-0000-0000-000000189701',1,'[]'),
         ('dddddddd-0000-0000-0000-000000189701','ffffffff-0000-0000-0000-000000189701',2,'[{"field":"headline","text":"Workspace for Diwali"}]');
  update public.ad_copy_sets set version = 2 where id = 'ffffffff-0000-0000-0000-000000189701';

  insert into public.ad_copies (tenant_id, plan_id, platform, audience, format, field, text, position, locked, pinned, ai_generated)
  values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','generic','feed_image','headline','Workspace for Diwali',0,true,null,true),
         ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','lookalike','feed_image','headline','Teams like yours use Workspace',0,false,null,true),
         ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','google-ads','generic','search','headline','Google Workspace Delhi',0,false,1,true);

  if (select count(*) from public.ad_copy_sets) <> 2 then raise exception 'FAIL A1: marketing sees % sets (want own 2)', (select count(*) from public.ad_copy_sets); end if;
  if (select count(*) from public.ad_copy_set_versions) <> 2 then raise exception 'FAIL A2: versions %', (select count(*) from public.ad_copy_set_versions); end if;
  if (select version from public.ad_copy_sets where id = 'ffffffff-0000-0000-0000-000000189701') <> 2 then raise exception 'FAIL A3: version not saved'; end if;
  if (select count(*) from public.ad_copies where field = 'headline' and position = 0 and platform = 'meta-ads') <> 2 then
    raise exception 'FAIL A4: headline position 0 should exist once per audience'; end if;
  if (select updated_by from public.ad_copy_sets where id = 'ffffffff-0000-0000-0000-000000189701') is distinct from 'aaaaaaaa-0000-0000-0000-000000189701' then
    raise exception 'FAIL A5: updated_by not filled from the login'; end if;
  raise notice 'PASS A: marketing saves sets, versions and lines for two audiences';
end $$;

-- ── B. Checks ────────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, audience, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','generic','feed_image','headline','Twice',0);
    raise exception 'FAIL B1: two lines in one slot of one audience';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, audience, format, field, text, position)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','everyone','feed_image','headline','Bad audience',3);
    raise exception 'FAIL B2: unknown audience accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_copies (tenant_id, plan_id, platform, format, field, text, position, pinned)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','google-ads','search','headline','Pin four',5,4);
    raise exception 'FAIL B3: pin 4 accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.ad_copy_sets (tenant_id, plan_id, platform, audience, format)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','meta-ads','generic','feed_image');
    raise exception 'FAIL B4: second set for the same plan, platform and audience';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ad_copy_set_versions (tenant_id, set_id, version, lines)
    values ('dddddddd-0000-0000-0000-000000189701','ffffffff-0000-0000-0000-000000189701',2,'[]');
    raise exception 'FAIL B5: the same version saved twice';
  exception when unique_violation then null;
  end;
  begin
    insert into public.ad_copy_set_versions (tenant_id, set_id, version, lines)
    values ('dddddddd-0000-0000-0000-000000189701','ffffffff-0000-0000-0000-000000189701',3,'{"not":"a list"}');
    raise exception 'FAIL B6: version lines that are not a list';
  exception when check_violation then null;
  end;
  raise notice 'PASS B: slot, audience, pin, one set per audience, version checks';
end $$;

-- ── C. Tenant isolation (still marketing) ───────────────────────────────────
do $$
declare n int;
begin
  if exists (select 1 from public.ad_copy_sets where tenant_id = 'dddddddd-0000-0000-0000-000000189702')
     or exists (select 1 from public.ad_copy_set_versions where tenant_id = 'dddddddd-0000-0000-0000-000000189702') then
    raise exception 'FAIL C1: another company''s set / versions visible';
  end if;
  begin
    insert into public.ad_copy_sets (tenant_id, plan_id, platform, audience, format)
    values ('dddddddd-0000-0000-0000-000000189702','eeeeeeee-0000-0000-0000-000000189702','google-ads','lookalike','search');
    raise exception 'FAIL C2: wrote a set for another company';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.ad_copy_sets (tenant_id, plan_id, platform, audience, format)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189702','google-ads','lookalike','search');
    raise exception 'FAIL C3: own-tenant set attached to another company''s plan';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.ad_copy_set_versions (tenant_id, set_id, version, lines)
    values ('dddddddd-0000-0000-0000-000000189701','ffffffff-0000-0000-0000-000000189702',9,'[]');
    raise exception 'FAIL C4: own-tenant version attached to another company''s set';
  exception when foreign_key_violation then null;
  end;
  update public.ad_copy_sets set version = 99 where id = 'ffffffff-0000-0000-0000-000000189702';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL C5: updated another company''s set'; end if;
  delete from public.ad_copy_set_versions where set_id = 'ffffffff-0000-0000-0000-000000189702';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL C6: deleted another company''s versions'; end if;
  delete from public.ad_copies where plan_id = 'eeeeeeee-0000-0000-0000-000000189702';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL C7: deleted another company''s lines'; end if;
  begin
    update public.ad_copy_sets set tenant_id = 'dddddddd-0000-0000-0000-000000189702' where id = 'ffffffff-0000-0000-0000-000000189701';
    raise exception 'FAIL C8: moved own set to another company';
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  raise notice 'PASS C: other company''s sets, versions and lines invisible and unwritable';
end $$;

-- ── D. Roles: sales ──────────────────────────────────────────────────────────
reset role;
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000189702","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.ad_copy_sets) <> 0 or (select count(*) from public.ad_copy_set_versions) <> 0 then
    raise exception 'FAIL D1: sales sees ad-copy sets';
  end if;
  begin
    insert into public.ad_copy_sets (tenant_id, plan_id, platform, audience, format)
    values ('dddddddd-0000-0000-0000-000000189701','eeeeeeee-0000-0000-0000-000000189701','google-ads','generic','search');
    raise exception 'FAIL D2: sales wrote a set';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS D: sales sees nothing and cannot write';
end $$;

-- ── E. Deleting the plan deletes its sets and versions (as the server) ──────
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
do $$
begin
  delete from public.ad_plans where id = 'eeeeeeee-0000-0000-0000-000000189701';
  if exists (select 1 from public.ad_copy_sets where plan_id = 'eeeeeeee-0000-0000-0000-000000189701')
     or exists (select 1 from public.ad_copy_set_versions where set_id = 'ffffffff-0000-0000-0000-000000189701')
     or exists (select 1 from public.ad_copies where plan_id = 'eeeeeeee-0000-0000-0000-000000189701') then
    raise exception 'FAIL E1: sets / versions / lines left after the plan was deleted';
  end if;
  if not exists (select 1 from public.ad_copy_sets where id = 'ffffffff-0000-0000-0000-000000189702') then
    raise exception 'FAIL E2: the other company''s set went too';
  end if;
  raise notice 'PASS E: plan delete cascades to its own sets, versions and lines only';
end $$;

rollback;
