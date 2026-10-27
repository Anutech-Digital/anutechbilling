-- R-2010 (27 Oct 2026, G-DPDP): consent_events — the server record of website cookie consent.
-- Migration 20261027070332_r2010_consent_events.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. The server (service_role) records a banner choice and a checkout link (anon id + lead + quote).
--   B. Insert-only: the server can neither change nor delete a record.
--   C. The tenant's OWNER reads only their own company's records (another company's row exists).
--   D. A sales login of the same company reads nothing.
--   E. A signed-in user cannot write a record; anon can neither read nor write.
--   F. Checks: a raw IP in ip_hash, a row with no anon id and no lead, an unknown purpose — refused.

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
  ('dddddddd-0000-0000-0000-000000201001','R2010 Co','r2010@example.in','07','R2010'),
  ('dddddddd-0000-0000-0000-000000201002','R2010 Other','r2010b@example.in','07','R2010B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000201001','owner2010@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000201002','sales2010@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000201001','dddddddd-0000-0000-0000-000000201001','owner2010@example.in','Owner 2010','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000201002','dddddddd-0000-0000-0000-000000201001','sales2010@example.in','Sales 2010','sales', true, now() - interval '1 day');

-- ── A. The server records ──────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
insert into public.consent_events (tenant_id, anon_id, purpose, choice, notice_version, source, page, ip_hash, user_agent) values
  ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201001','meta_ads','granted','2026-10-27','banner','/buy/workspace', repeat('a', 64), 'UA'),
  ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201001','meta_ads','denied','2026-10-27','banner','/buy/workspace', repeat('a', 64), 'UA'),
  ('dddddddd-0000-0000-0000-000000201002','11111111-2222-4333-8444-555555201002','meta_ads','granted','2026-10-27','banner','/', null, null);
insert into public.consent_events (tenant_id, anon_id, lead_id, quote_id, purpose, choice, notice_version, source) values
  ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201001','L-R2010','Q-R2010-1','meta_ads','denied','checkout','checkout');

do $$
begin
  if (select count(*) from public.consent_events where tenant_id in ('dddddddd-0000-0000-0000-000000201001','dddddddd-0000-0000-0000-000000201002')) <> 4 then
    raise exception 'FAIL A: the server could not record all four consent rows';
  end if;
  if (select count(*) from public.consent_events where tenant_id = 'dddddddd-0000-0000-0000-000000201002') <> 1 then
    raise exception 'FAIL A-pre: the other company''s row (needed for the isolation check) is missing';
  end if;
end $$;

-- ── B. Insert-only, even for the server ───────────────────────────────────
do $$
begin
  begin
    update public.consent_events set choice = 'granted' where lead_id = 'L-R2010';
    raise exception 'FAIL B1: the server changed a consent record';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.consent_events where lead_id = 'L-R2010';
    raise exception 'FAIL B2: the server deleted a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── C. The owner reads their own company's records only ───────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000201001","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.consent_events) <> 3 then
    raise exception 'FAIL C1: the owner sees % rows, expected their own 3', (select count(*) from public.consent_events);
  end if;
  if exists (select 1 from public.consent_events where tenant_id = 'dddddddd-0000-0000-0000-000000201002') then
    raise exception 'FAIL C2: the owner sees another company''s consent record';
  end if;
  if (select quote_id from public.consent_events where lead_id = 'L-R2010') is distinct from 'Q-R2010-1' then
    raise exception 'FAIL C3: the checkout link (lead + quote) is not readable by the owner';
  end if;
  -- E. a signed-in user cannot write
  begin
    insert into public.consent_events (tenant_id, anon_id, purpose, choice, notice_version)
    values ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201009','meta_ads','granted','x');
    raise exception 'FAIL E1: a signed-in user wrote a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── D. Sales of the same company reads nothing ────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000201002","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.consent_events) <> 0 then
    raise exception 'FAIL D: a sales login reads consent records';
  end if;
end $$;
reset role;

-- ── E. anon: nothing ───────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"anon"}', true);
set local role anon;
do $$
begin
  begin
    perform 1 from public.consent_events;
    raise exception 'FAIL E2: anon can read consent_events';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.consent_events (tenant_id, anon_id, purpose, choice, notice_version)
    values ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201009','meta_ads','granted','x');
    raise exception 'FAIL E3: anon wrote a consent record';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- ── F. Checks ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
begin
  begin
    insert into public.consent_events (tenant_id, anon_id, purpose, choice, notice_version, ip_hash)
    values ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201001','meta_ads','granted','x','203.0.113.9');
    raise exception 'FAIL F1: a raw IP address was stored in ip_hash';
  exception when check_violation then null;
  end;
  begin
    insert into public.consent_events (tenant_id, purpose, choice, notice_version)
    values ('dddddddd-0000-0000-0000-000000201001','meta_ads','granted','x');
    raise exception 'FAIL F2: a record with no anon id and no lead was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.consent_events (tenant_id, anon_id, purpose, choice, notice_version)
    values ('dddddddd-0000-0000-0000-000000201001','11111111-2222-4333-8444-555555201001','newsletter','granted','x');
    raise exception 'FAIL F3: an unknown purpose was accepted';
  exception when check_violation then null;
  end;
end $$;
reset role;

rollback;
