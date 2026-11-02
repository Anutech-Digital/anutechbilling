-- R-2013 (2 Nov 2026, goal G-DPDP): data-rights requests (privacy_requests).
-- Migration 20261101215539_r2013_privacy_requests.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. A wrong code is refused and counted; an expired code and a 6th try are refused.
--   B. The right code opens the request: due_by = IST today + 30 days, the person's leads
--      (same email in any case, or same last-10-digit mobile) and customers are linked, the
--      code's hash is wiped, and activity_log says so WITHOUT the person's name or email.
--   C. "Withdraw consent": a consent_events 'withdrawn' row per lead (newest marketing row,
--      so R-2011's filter skips them) and the email lands in email_suppressions.
--   D. The owner reads verified requests of their own company only — never an unverified one,
--      never the code's hash; a sales login reads nothing and may not act.
--   E. The owner marks exported / corrected / closed; each is logged; a closed one stays closed.
--   F. A signed-in user cannot run the code check, and cannot write the table directly.

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
  ('dddddddd-0000-0000-0000-000000201301','R2013 Site','r2013@example.in','07','R2013A'),
  ('dddddddd-0000-0000-0000-000000201302','R2013 Other','r2013b@example.in','07','R2013B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000201301','owner2013@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000201302','sales2013@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000201301','dddddddd-0000-0000-0000-000000201301','owner2013@example.in','Owner 2013','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000201302','dddddddd-0000-0000-0000-000000201301','sales2013@example.in','Sales 2013','sales', true, now() - interval '1 day');

insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone) values
  ('L-R2013A','dddddddd-0000-0000-0000-000000201301','Asha Traders','Asha Verma','Asha.Verma@Example.in', null),
  ('L-R2013B','dddddddd-0000-0000-0000-000000201301','Asha Mobile','Asha','other@example.in','+91 98100 20130'),
  ('L-R2013C','dddddddd-0000-0000-0000-000000201301','Someone Else','Ravi','ravi@example.in','9999900000'),
  ('L-R2013D','dddddddd-0000-0000-0000-000000201302','Other Company','Asha Verma','asha.verma@example.in', null);
insert into public.customers (id, tenant_id, name, contact_email) values
  ('cccccccc-0000-0000-0000-000000201301','dddddddd-0000-0000-0000-000000201301','Asha Traders','asha.verma@example.in'),
  ('cccccccc-0000-0000-0000-000000201302','dddddddd-0000-0000-0000-000000201301','Ravi Co','ravi@example.in');

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;

insert into public.consent_events (tenant_id, lead_id, purpose, choice, notice_version, source, form, created_at) values
  ('dddddddd-0000-0000-0000-000000201301','L-R2013A','marketing','granted','2026-11-01','form','enquiry', now() - interval '1 day');

insert into public.privacy_requests (id, tenant_id, full_name, email, phone, kind, otp_hash, otp_expires_at) values
  ('eeeeeeee-0000-0000-0000-000000201301','dddddddd-0000-0000-0000-000000201301','Asha Verma','asha.verma@example.in','98100 20130','access',
     encode(sha256('r2013-good'::bytea), 'hex'), now() + interval '10 minutes'),
  ('eeeeeeee-0000-0000-0000-000000201302','dddddddd-0000-0000-0000-000000201301','Asha Verma','asha.verma@example.in', null,'withdraw_consent',
     encode(sha256('r2013-good2'::bytea), 'hex'), now() + interval '10 minutes'),
  ('eeeeeeee-0000-0000-0000-000000201303','dddddddd-0000-0000-0000-000000201301','Old Code','old@example.in', null,'erasure',
     encode(sha256('r2013-old'::bytea), 'hex'), now() - interval '1 minute'),
  ('eeeeeeee-0000-0000-0000-000000201304','dddddddd-0000-0000-0000-000000201301','Guesser','guess@example.in', null,'erasure',
     encode(sha256('r2013-g'::bytea), 'hex'), now() + interval '10 minutes');

-- ── A. Wrong, expired, too many ────────────────────────────────────────────
do $$
declare j jsonb; i int;
begin
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201301', encode(sha256('nope'::bytea), 'hex'));
  if j->>'reason' is distinct from 'wrong_code' or (j->>'ok')::boolean then
    raise exception 'FAIL A1: a wrong code was not refused: %', j;
  end if;
  if (select otp_attempts from public.privacy_requests where id = 'eeeeeeee-0000-0000-0000-000000201301') <> 1 then
    raise exception 'FAIL A2: the wrong try was not counted';
  end if;
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201302','eeeeeeee-0000-0000-0000-000000201301', encode(sha256('r2013-good'::bytea), 'hex'));
  if j->>'reason' is distinct from 'not_found' then
    raise exception 'FAIL A3: another company opened this request: %', j;
  end if;
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201303', encode(sha256('r2013-old'::bytea), 'hex'));
  if j->>'reason' is distinct from 'expired' then
    raise exception 'FAIL A4: an expired code was accepted: %', j;
  end if;
  for i in 1..5 loop
    perform public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201304', encode(sha256('x'::bytea), 'hex'));
  end loop;
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201304', encode(sha256('r2013-g'::bytea), 'hex'));
  if j->>'reason' is distinct from 'too_many' then
    raise exception 'FAIL A5: the right code after 5 wrong tries was accepted: %', j;
  end if;
end $$;

-- ── B. The right code opens it ─────────────────────────────────────────────
do $$
declare j jsonb; r record;
begin
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201301', encode(sha256('r2013-good'::bytea), 'hex'));
  if not (j->>'ok')::boolean then
    raise exception 'FAIL B1: the right code was refused: %', j;
  end if;
  select * into r from public.privacy_requests where id = 'eeeeeeee-0000-0000-0000-000000201301';
  if r.status <> 'open' or r.verified_at is null then
    raise exception 'FAIL B2: status is %, expected open', r.status;
  end if;
  if r.due_by <> (now() at time zone 'Asia/Kolkata')::date + 30 then
    raise exception 'FAIL B3: due_by is %, expected IST today + 30', r.due_by;
  end if;
  if r.lead_ids <> array['L-R2013A','L-R2013B'] then
    raise exception 'FAIL B4: linked leads are %, expected the email match and the mobile match of this company only', r.lead_ids;
  end if;
  if r.customer_ids <> array['cccccccc-0000-0000-0000-000000201301'::uuid] then
    raise exception 'FAIL B5: linked customers are %', r.customer_ids;
  end if;
  if r.otp_hash is not null then
    raise exception 'FAIL B6: the code hash was kept after use';
  end if;
  if not exists (select 1 from public.activity_log where entity = 'privacy_request' and entity_id = r.id::text and action = 'privacy_request.verified') then
    raise exception 'FAIL B7: the confirmation is not in activity_log';
  end if;
  if exists (select 1 from public.activity_log where entity = 'privacy_request' and (label ilike '%asha%' or label ilike '%@%')) then
    raise exception 'FAIL B8: activity_log carries the person''s name or email';
  end if;
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201301', encode(sha256('r2013-good'::bytea), 'hex'));
  if not coalesce((j->>'already')::boolean, false) then
    raise exception 'FAIL B9: a second press did not answer "already confirmed": %', j;
  end if;
end $$;

-- ── C. Withdraw consent ────────────────────────────────────────────────────
do $$
declare j jsonb;
begin
  j := public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201302', encode(sha256('r2013-good2'::bytea), 'hex'));
  if not (j->>'ok')::boolean then
    raise exception 'FAIL C1: the withdraw request was refused: %', j;
  end if;
  if (select choice from public.consent_events
       where tenant_id = 'dddddddd-0000-0000-0000-000000201301' and lead_id = 'L-R2013A' and purpose = 'marketing'
       order by created_at desc, (choice = 'withdrawn') desc limit 1) is distinct from 'withdrawn' then
    raise exception 'FAIL C2: the newest marketing row of the lead is not "withdrawn"';
  end if;
  if (select source from public.consent_events where lead_id = 'L-R2013A' and choice = 'withdrawn') is distinct from 'privacy_request' then
    raise exception 'FAIL C3: the withdrawal does not say it came from the privacy request';
  end if;
  if exists (select 1 from public.consent_events where lead_id = 'L-R2013D') then
    raise exception 'FAIL C4: another company''s lead was touched';
  end if;
  if not exists (select 1 from public.email_suppressions where tenant_id = 'dddddddd-0000-0000-0000-000000201301' and email = 'asha.verma@example.in' and reason = 'consent_withdrawn') then
    raise exception 'FAIL C5: the email is not suppressed';
  end if;
  if exists (select 1 from public.email_suppressions where tenant_id = 'dddddddd-0000-0000-0000-000000201302') then
    raise exception 'FAIL C6: another company''s suppression list changed';
  end if;
end $$;
reset role;

-- ── D. Who reads ───────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000201301","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.privacy_requests) <> 2 then
    raise exception 'FAIL D1: the owner sees % requests, expected the 2 confirmed ones', (select count(*) from public.privacy_requests);
  end if;
  begin
    perform otp_hash from public.privacy_requests limit 1;
    raise exception 'FAIL D2: the owner can read the code hash';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.privacy_requests (tenant_id, full_name, email, kind)
    values ('dddddddd-0000-0000-0000-000000201301','X Y','x@example.in','access');
    raise exception 'FAIL F1: a signed-in user wrote a request directly';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.privacy_request_verify('dddddddd-0000-0000-0000-000000201301','eeeeeeee-0000-0000-0000-000000201304', 'x');
    raise exception 'FAIL F2: a signed-in user ran the code check';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── E. Owner actions ───────────────────────────────────────────────────────
do $$
begin
  perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201301', 'exported');
  perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201301', 'corrected', 'Phone number fixed');
  if (select status from public.privacy_requests where id = 'eeeeeeee-0000-0000-0000-000000201301') <> 'corrected'
     or (select exported_at from public.privacy_requests where id = 'eeeeeeee-0000-0000-0000-000000201301') is null then
    raise exception 'FAIL E1: exported / corrected not recorded';
  end if;
  perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201301', 'closed');
  if (select closed_by from public.privacy_requests where id = 'eeeeeeee-0000-0000-0000-000000201301') is distinct from 'aaaaaaaa-0000-0000-0000-000000201301'::uuid then
    raise exception 'FAIL E2: closed_by is not the owner';
  end if;
  if (select count(*) from public.activity_log where entity = 'privacy_request' and entity_id = 'eeeeeeee-0000-0000-0000-000000201301'
        and action in ('privacy_request.exported', 'privacy_request.corrected', 'privacy_request.closed')) <> 3 then
    raise exception 'FAIL E3: the owner actions are not all in activity_log';
  end if;
  begin
    perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201301', 'corrected');
    raise exception 'FAIL E4: a closed request was reopened';
  exception when invalid_parameter_value then null;
  end;
  begin
    perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201304', 'closed');
    raise exception 'FAIL E5: an unconfirmed request could be acted on';
  exception when no_data_found then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000201302","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if (select count(*) from public.privacy_requests) <> 0 then
    raise exception 'FAIL D3: a sales login reads privacy requests';
  end if;
  begin
    perform public.privacy_request_action('eeeeeeee-0000-0000-0000-000000201302', 'closed');
    raise exception 'FAIL D4: a sales login closed a privacy request';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

rollback;
