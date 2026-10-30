-- R-2113 / GP-03 (30 Oct 2026, goal G-PERSONAL): consent_events fit for ACCOUNT consent.
-- Migration 20261030021500_gp03_consent_account.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. The server records a signup consent for a USER with no tenant yet (purpose account_terms,
--      personal_finance_processing, marketing; source signup / upgrade).
--   B. A row with none of anon_id / lead_id / user_id is refused; unknown purpose/source refused.
--   C. Still insert-only: the server cannot change the choice, purpose, user or version, cannot
--      move a row from one tenant to another, and cannot delete a row.
--   D. The verify step may fill a NULL tenant_id once (attachConsentTenant) — nothing else.
--   E. Deleting the tenant keeps the proof: the row stays with tenant_id null.
--   F. A signed-in user / anon still cannot write.

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
  ('dddddddd-0000-0000-0000-000000211301','GP03 Personal','gp03@example.in','07','GP03A'),
  ('dddddddd-0000-0000-0000-000000211302','GP03 Other','gp03b@example.in','07','GP03B');

-- ── A. Signup consent for a user, tenant not known yet ─────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.consent_events (tenant_id, user_id, purpose, choice, notice_version, source, page, ip_hash, user_agent) values
  (null,'aaaaaaaa-0000-0000-0000-000000211301','account_terms','granted','2026-10-30','signup','/signup', repeat('b', 64), 'UA'),
  (null,'aaaaaaaa-0000-0000-0000-000000211301','personal_finance_processing','granted','2026-10-30','signup','/signup', repeat('b', 64), 'UA'),
  (null,'aaaaaaaa-0000-0000-0000-000000211301','marketing','denied','2026-10-30','signup','/signup', repeat('b', 64), 'UA'),
  ('dddddddd-0000-0000-0000-000000211302','aaaaaaaa-0000-0000-0000-000000211302','account_terms','granted','2026-10-30','upgrade','/upgrade', null, null);

do $$
begin
  if (select count(*) from public.consent_events where user_id = 'aaaaaaaa-0000-0000-0000-000000211301' and tenant_id is null) <> 3 then
    raise exception 'FAIL A1: signup consent rows with user_id and no tenant were not recorded';
  end if;
  if not exists (select 1 from public.consent_events where user_id = 'aaaaaaaa-0000-0000-0000-000000211302' and source = 'upgrade') then
    raise exception 'FAIL A2: an upgrade consent row was not recorded';
  end if;
end $$;

-- ── B. Checks ──────────────────────────────────────────────────────────────
do $$
begin
  begin
    insert into public.consent_events (tenant_id, purpose, choice, notice_version, source)
    values (null,'account_terms','granted','x','signup');
    raise exception 'FAIL B1: a record with no anon id, no lead and no user was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.consent_events (user_id, purpose, choice, notice_version, source)
    values ('aaaaaaaa-0000-0000-0000-000000211301','newsletter','granted','x','signup');
    raise exception 'FAIL B2: an unknown purpose was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.consent_events (user_id, purpose, choice, notice_version, source)
    values ('aaaaaaaa-0000-0000-0000-000000211301','account_terms','granted','x','popup');
    raise exception 'FAIL B3: an unknown source was accepted';
  exception when check_violation then null;
  end;
end $$;

-- ── C. Insert-only for everything but the one-time tenant attach ───────────
do $$
begin
  begin
    update public.consent_events set choice = 'granted' where purpose = 'marketing' and user_id = 'aaaaaaaa-0000-0000-0000-000000211301';
    raise exception 'FAIL C1: the server changed the choice of a consent record';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.consent_events set tenant_id = 'dddddddd-0000-0000-0000-000000211301'
     where user_id = 'aaaaaaaa-0000-0000-0000-000000211302';
    raise exception 'FAIL C2: the server moved a consent record to another tenant';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.consent_events where user_id = 'aaaaaaaa-0000-0000-0000-000000211301';
    raise exception 'FAIL C3: the server deleted a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── D. The verify step fills tenant_id once ────────────────────────────────
update public.consent_events set tenant_id = 'dddddddd-0000-0000-0000-000000211301'
 where user_id = 'aaaaaaaa-0000-0000-0000-000000211301' and tenant_id is null;
do $$
begin
  if (select count(*) from public.consent_events
       where user_id = 'aaaaaaaa-0000-0000-0000-000000211301' and tenant_id = 'dddddddd-0000-0000-0000-000000211301') <> 3 then
    raise exception 'FAIL D1: attaching the tenant at verify did not fill tenant_id';
  end if;
  begin
    update public.consent_events set tenant_id = null where user_id = 'aaaaaaaa-0000-0000-0000-000000211301';
    raise exception 'FAIL D2: the server un-attached a consent record from a live tenant';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── E. Tenant erasure keeps the proof ──────────────────────────────────────
select set_config('request.jwt.claims', '', true);
do $$
begin
  delete from public.tenants where id = 'dddddddd-0000-0000-0000-000000211301';
  if (select count(*) from public.consent_events where user_id = 'aaaaaaaa-0000-0000-0000-000000211301') <> 3 then
    raise exception 'FAIL E1: deleting the tenant deleted the consent proof';
  end if;
  if exists (select 1 from public.consent_events where user_id = 'aaaaaaaa-0000-0000-0000-000000211301' and tenant_id is not null) then
    raise exception 'FAIL E2: after tenant erasure the consent rows still point at the deleted tenant';
  end if;
  if (select string_agg(purpose || '=' || choice, ',' order by purpose) from public.consent_events
       where user_id = 'aaaaaaaa-0000-0000-0000-000000211301')
     is distinct from 'account_terms=granted,marketing=denied,personal_finance_processing=granted' then
    raise exception 'FAIL E3: tenant erasure changed what the consent rows say';
  end if;
end $$;

-- ── F. Signed-in user / anon cannot write ──────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000211302","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  begin
    insert into public.consent_events (user_id, purpose, choice, notice_version, source)
    values ('aaaaaaaa-0000-0000-0000-000000211302','account_terms','granted','x','signup');
    raise exception 'FAIL F1: a signed-in user wrote a consent record';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.consent_events set tenant_id = null where user_id = 'aaaaaaaa-0000-0000-0000-000000211302';
    raise exception 'FAIL F2: a signed-in user changed a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin
    insert into public.consent_events (user_id, purpose, choice, notice_version, source)
    values ('aaaaaaaa-0000-0000-0000-000000211302','account_terms','granted','x','signup');
    raise exception 'FAIL F3: anon wrote a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
