-- Regression test: migration 20261009160000_lead_followup_sync (R-483: R-444 part 5, R-459).
-- Self-asserting; runs in a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/lead_followup_sync.test.sql
--
-- What it proves:
--   1. A new open task on an open lead sets the lead's follow_up_date to the task's IST day.
--   2. A later task does not push an earlier upcoming follow-up date back.
--   3. Moving the lead to Won closes its open tasks and clears follow_up_date.
--   4. A task added AFTER the win stays open and does not set a follow-up on the won lead.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('bbbbbbbb-0000-0000-0000-00000000f001', 'FOLLOWUP CO', 'fu@example.in', '07');
insert into public.leads (id, tenant_id, company, stage, source, priority) values
  ('L-FUTEST1', 'bbbbbbbb-0000-0000-0000-00000000f001', 'Sharma Traders', 'quote', 'manual', 'medium');

do $$
declare v date; n int;
begin
  -- 1. task due tomorrow 10:00 IST → follow_up_date = tomorrow (IST)
  insert into public.tasks (tenant_id, title, due_at, lead_id)
  values ('bbbbbbbb-0000-0000-0000-00000000f001', 'Call Amit about quote',
          ((now() at time zone 'Asia/Kolkata')::date + 1 + time '10:00') at time zone 'Asia/Kolkata', 'L-FUTEST1');
  select follow_up_date into v from public.leads where id = 'L-FUTEST1';
  if v is distinct from (now() at time zone 'Asia/Kolkata')::date + 1 then
    raise exception 'FAIL 1: follow_up_date % (want tomorrow IST)', v;
  end if;

  -- 2. a task in 5 days keeps tomorrow
  insert into public.tasks (tenant_id, title, due_at, lead_id)
  values ('bbbbbbbb-0000-0000-0000-00000000f001', 'Second follow-up', now() + interval '5 days', 'L-FUTEST1');
  select follow_up_date into v from public.leads where id = 'L-FUTEST1';
  if v is distinct from (now() at time zone 'Asia/Kolkata')::date + 1 then
    raise exception 'FAIL 2: later task moved follow_up_date to %', v;
  end if;

  -- 3. Won closes open tasks + clears the date
  update public.leads set stage = 'won' where id = 'L-FUTEST1';
  select count(*) into n from public.tasks where lead_id = 'L-FUTEST1' and status in ('pending', 'snoozed');
  if n <> 0 then raise exception 'FAIL 3: % open tasks left after Won', n; end if;
  select follow_up_date into v from public.leads where id = 'L-FUTEST1';
  if v is not null then raise exception 'FAIL 3: follow_up_date % after Won', v; end if;

  -- 4. post-sale task stays open, won lead gets no follow-up date
  insert into public.tasks (tenant_id, title, due_at, lead_id)
  values ('bbbbbbbb-0000-0000-0000-00000000f001', 'Onboarding call', now() + interval '1 day', 'L-FUTEST1');
  select count(*) into n from public.tasks where lead_id = 'L-FUTEST1' and status = 'pending';
  if n <> 1 then raise exception 'FAIL 4: post-sale task not open (%)', n; end if;
  select follow_up_date into v from public.leads where id = 'L-FUTEST1';
  if v is not null then raise exception 'FAIL 4: won lead got follow_up_date %', v; end if;

  raise notice 'lead_followup_sync: all 4 checks passed';
end $$;

rollback;
