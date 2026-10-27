-- R-1922 (G-ONBOARD OB-1, 25 Oct 2026): a NEW company starts with Customer messages ON, so its
-- first "Save & send" reaches the customer. Scheduled jobs (crons) stay OFF. Existing companies
-- are not changed.
-- Migration: 20261025160239_r1922_new_company_customer_messages_on.sql
--
-- Self-asserting: RAISEs on failure. Runs inside a transaction that ROLLS BACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/new_company_customer_messages_on.test.sql
--
-- What it proves:
--   1. A new company has a customer_messages row (enabled, not dry run) and the gate the send
--      route asks (automation_state) answers 'on' for it — the same switch /automation shows.
--   2. Every scheduled job is still OFF for that new company (no other automation_jobs row).
--   3. Existing companies are unchanged: one with no row stays OFF; one the owner turned OFF
--      stays OFF — making a new company touches no other company's switch.
--   4. The demo workspace ("Try the demo") is turned back OFF when it is registered, so a
--      public demo visitor can never email anyone.
--   5. The switch is still the owner's: turning it off writes the same row, and the gate says off.

begin;

-- ── 3 (setup). "Existing" companies: made with the new trigger off = before the migration ──
alter table public.tenants disable trigger trg_tenants_customer_messages_on;
insert into public.tenants (id, name, email, state_code) values
  ('a1922000-0000-4000-8000-0000000000e1', 'R1922 Old no row',  'r1922-e1@example.in', '07'),
  ('a1922000-0000-4000-8000-0000000000e2', 'R1922 Old off row', 'r1922-e2@example.in', '07');
alter table public.tenants enable trigger trg_tenants_customer_messages_on;
insert into public.automation_jobs (tenant_id, job, enabled, dry_run)
values ('a1922000-0000-4000-8000-0000000000e2', 'customer_messages', false, false);

-- ── 1. New company ──────────────────────────────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('a1922000-0000-4000-8000-0000000000a1', 'R1922 New Co', 'r1922-new@example.in', '07');

do $$
declare
  r public.automation_jobs;
  n int;
begin
  select * into r from public.automation_jobs
   where tenant_id = 'a1922000-0000-4000-8000-0000000000a1' and job = 'customer_messages';
  if not found then
    raise exception 'FAIL 1a: a new company has no customer_messages row — its first Save & send is refused';
  end if;
  if not r.enabled or r.dry_run then
    raise exception 'FAIL 1b: customer_messages should be ON (not dry run) for a new company: %', row_to_json(r);
  end if;
  if public.automation_state('customer_messages', 'a1922000-0000-4000-8000-0000000000a1') <> 'on' then
    raise exception 'FAIL 1c: the send gate (automation_state) does not say on for a new company';
  end if;

  -- ── 2. Crons stay OFF ──
  select count(*) into n from public.automation_jobs
   where tenant_id = 'a1922000-0000-4000-8000-0000000000a1' and job <> 'customer_messages';
  if n <> 0 then raise exception 'FAIL 2a: a new company got % other automation rows — crons must stay off', n; end if;
  if public.automation_state('renewals', 'a1922000-0000-4000-8000-0000000000a1') <> 'off'
     or public.automation_state('invoice-dunning', 'a1922000-0000-4000-8000-0000000000a1') <> 'off' then
    raise exception 'FAIL 2b: a scheduled job is not off for a new company';
  end if;

  -- ── 3. Existing companies unchanged ──
  if exists (select 1 from public.automation_jobs where tenant_id = 'a1922000-0000-4000-8000-0000000000e1') then
    raise exception 'FAIL 3a: an existing company with no switch row got one';
  end if;
  if public.automation_state('customer_messages', 'a1922000-0000-4000-8000-0000000000e1') <> 'off' then
    raise exception 'FAIL 3b: an existing company with no row is no longer off';
  end if;
  select * into r from public.automation_jobs
   where tenant_id = 'a1922000-0000-4000-8000-0000000000e2' and job = 'customer_messages';
  if r.enabled then raise exception 'FAIL 3c: an existing company the owner turned off was turned on'; end if;
end $$;

-- ── 4. Demo workspace → OFF once registered ─────────────────────────────────
insert into public.tenants (id, name, email, state_code) values
  ('a1922000-0000-4000-8000-0000000000d1', 'R1922 Demo', 'r1922-demo@example.in', '07');
insert into public.demo_tenants (tenant_id, visitor_user_id, seeder_user_id) values
  ('a1922000-0000-4000-8000-0000000000d1', 'a1922000-0000-4000-8000-0000000000f1', 'a1922000-0000-4000-8000-0000000000f2');

do $$
begin
  if public.automation_state('customer_messages', 'a1922000-0000-4000-8000-0000000000d1') <> 'off' then
    raise exception 'FAIL 4: the demo workspace can email customers — it must stay off';
  end if;
end $$;

-- ── 5. Still the owner's switch: off is one update of the same row ──────────
update public.automation_jobs set enabled = false
 where tenant_id = 'a1922000-0000-4000-8000-0000000000a1' and job = 'customer_messages';

do $$
begin
  if public.automation_state('customer_messages', 'a1922000-0000-4000-8000-0000000000a1') <> 'off' then
    raise exception 'FAIL 5: turning customer messages off did not take';
  end if;
end $$;

rollback;
