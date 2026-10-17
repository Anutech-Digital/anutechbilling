-- Regression test: R-1466 feedback_votes (migration 20261016150000) — "+1 / I have this too".
-- Self-asserting; runs in a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/feedback_votes.test.sql
--
-- What it proves:
--   1. A user can +1 a report of their own company; the count is visible to a colleague.
--   2. One user, one vote: a second +1 on the same report is refused (unique).
--   3. Nobody can vote AS someone else (user_id must be the caller).
--   4. Nobody can vote on another company's report, or file a vote under another company.
--   5. A colleague cannot take back somebody else's vote.
--   6. Another company sees none of these votes.
--   7. Pressing +1 again (delete own vote) takes the vote back.

begin;

insert into public.tenants (id, name, email, state_code) values
  ('bbbbbbbb-0000-0000-0000-00000001466a', 'VOTE CO',  'vote@example.in',  '07'),
  ('bbbbbbbb-0000-0000-0000-00000001466b', 'OTHER CO', 'other@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('bbbbbbbb-0000-0000-0000-0000000a1466', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a1@vote.example'),
  ('bbbbbbbb-0000-0000-0000-0000000a2466', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'a2@vote.example'),
  ('bbbbbbbb-0000-0000-0000-0000000b1466', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'b1@other.example');
insert into public.users (id, tenant_id, email, role) values
  ('bbbbbbbb-0000-0000-0000-0000000a1466', 'bbbbbbbb-0000-0000-0000-00000001466a', 'a1@vote.example',  'sales'),
  ('bbbbbbbb-0000-0000-0000-0000000a2466', 'bbbbbbbb-0000-0000-0000-00000001466a', 'a2@vote.example',  'owner'),
  ('bbbbbbbb-0000-0000-0000-0000000b1466', 'bbbbbbbb-0000-0000-0000-00000001466b', 'b1@other.example', 'owner');
insert into public.feedback (id, tenant_id, title, body) values
  ('bbbbbbbb-0000-0000-0000-0000000fa466', 'bbbbbbbb-0000-0000-0000-00000001466a', 'Invoice PDF download fails', 'x'),
  ('bbbbbbbb-0000-0000-0000-0000000fb466', 'bbbbbbbb-0000-0000-0000-00000001466b', 'Other company report', 'y');

set local role authenticated;

-- ── as A1 ───────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000a1466', 'role', 'authenticated')::text, true);
do $$ begin
  -- 1
  insert into public.feedback_votes (tenant_id, feedback_id, user_id) values
    ('bbbbbbbb-0000-0000-0000-00000001466a', 'bbbbbbbb-0000-0000-0000-0000000fa466', 'bbbbbbbb-0000-0000-0000-0000000a1466');

  -- 2
  begin
    insert into public.feedback_votes (tenant_id, feedback_id, user_id) values
      ('bbbbbbbb-0000-0000-0000-00000001466a', 'bbbbbbbb-0000-0000-0000-0000000fa466', 'bbbbbbbb-0000-0000-0000-0000000a1466');
    raise exception 'FAIL 2: same user voted twice on one report';
  exception when unique_violation then null;
  end;

  -- 3
  begin
    insert into public.feedback_votes (tenant_id, feedback_id, user_id) values
      ('bbbbbbbb-0000-0000-0000-00000001466a', 'bbbbbbbb-0000-0000-0000-0000000fa466', 'bbbbbbbb-0000-0000-0000-0000000a2466');
    raise exception 'FAIL 3: A1 voted as A2';
  exception when insufficient_privilege then null;
  end;

  -- 4a: another company's report, filed under own tenant
  begin
    insert into public.feedback_votes (tenant_id, feedback_id, user_id) values
      ('bbbbbbbb-0000-0000-0000-00000001466a', 'bbbbbbbb-0000-0000-0000-0000000fb466', 'bbbbbbbb-0000-0000-0000-0000000a1466');
    raise exception 'FAIL 4a: A1 voted on another company''s report';
  exception when insufficient_privilege then null;
  end;
  -- 4b: another company's report, filed under that company
  begin
    insert into public.feedback_votes (tenant_id, feedback_id, user_id) values
      ('bbbbbbbb-0000-0000-0000-00000001466b', 'bbbbbbbb-0000-0000-0000-0000000fb466', 'bbbbbbbb-0000-0000-0000-0000000a1466');
    raise exception 'FAIL 4b: A1 filed a vote under another company';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── as A2 (same company) ─────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000a2466', 'role', 'authenticated')::text, true);
do $$ declare n int; begin
  select count(*) into n from public.feedback_votes where feedback_id = 'bbbbbbbb-0000-0000-0000-0000000fa466';
  if n <> 1 then raise exception 'FAIL 1: colleague sees % vote(s), expected 1', n; end if;

  -- 5
  delete from public.feedback_votes where user_id = 'bbbbbbbb-0000-0000-0000-0000000a1466';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 5: A2 deleted A1''s vote'; end if;
end $$;

-- ── as B1 (other company) ────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000b1466', 'role', 'authenticated')::text, true);
do $$ declare n int; begin
  -- 6
  select count(*) into n from public.feedback_votes;
  if n <> 0 then raise exception 'FAIL 6: other company sees % vote(s)', n; end if;
end $$;

-- ── as A1 again: take the vote back ──────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'bbbbbbbb-0000-0000-0000-0000000a1466', 'role', 'authenticated')::text, true);
do $$ declare n int; begin
  -- 7
  delete from public.feedback_votes
   where tenant_id = 'bbbbbbbb-0000-0000-0000-00000001466a'
     and feedback_id = 'bbbbbbbb-0000-0000-0000-0000000fa466'
     and user_id = 'bbbbbbbb-0000-0000-0000-0000000a1466';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL 7: own vote not taken back (% rows)', n; end if;
  select count(*) into n from public.feedback_votes;
  if n <> 0 then raise exception 'FAIL 7b: % vote(s) left', n; end if;
end $$;

select 'feedback_votes.test.sql: all checks passed' as result;

rollback;
