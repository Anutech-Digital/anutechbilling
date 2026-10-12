-- Read-only. Asserts what each person can actually see through RLS, from their own seat.
-- Writes nothing and ends in rollback, so it is safe against production at any time.
-- Run: cd production && env -u SUPABASE_ACCESS_TOKEN npx supabase db query --linked \
--        -f supabase/maintenance/verify-reporting-lines.sql
-- A green run prints one row: MEASURED-OK. Any drift raises with the person and both counts.
--
-- ⚠ CORRECTED 20 Aug 2026 -- the first version of this file passed without measuring
-- anything. It drove its loop off `select ... from public.users` AFTER `set local role
-- authenticated`, and at that moment there is no JWT, so auth.uid() is null, RLS hides
-- every row, the loop ran ZERO times and the file printed MEASURED-OK having checked
-- nobody. It was found by a different tool disagreeing (scripts/org-chart-sync.mjs), not
-- by this file failing -- a vacuous test cannot fail.
--
-- Two changes make that unrepeatable:
--   1. the roster is read BEFORE dropping to `authenticated`, and carried in a GUC;
--   2. the loop counts its own iterations and raises unless it measured every person.
-- The second one matters more than the first: it turns "measured nobody" from a pass
-- into a failure, whatever future edit reintroduces the mistake.
--
-- The expected numbers below are the 20 Aug 2026 measurement of ANUTECH's 10 users and
-- 19 leads. Update them deliberately, with a note, when the book changes -- never to make
-- a red run go green. A new teammate also turns this red (the roster-size check), which
-- is intentional: a person nobody measured is exactly the person to look at.
begin;

do $$
declare roster jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', id, 'email', email) order by email)
    into roster from public.users
    where tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42';
  if roster is null then raise exception 'no users in the tenant -- wrong tenant id?'; end if;
  perform set_config('org.roster', roster::text, true);
end $$;

set local role authenticated;

do $$
declare
  expected constant jsonb := jsonb_build_object(
    'pardeep@anutech.in',            19,   -- owner: whole pipeline
    'deepak@anutech.in',             19,   -- second owner: the tree does not touch owners
    'info@omegaco.test', 19,   -- third owner (ANUTECH's own console id)
    'ananya@anutech.in',             15,   -- Darshan's book, via the 20 Aug line
    'hitesh@anutech.in',              1,   -- 4 direct reports, but they own no leads
    'sales@anutech.in',              15,   -- own book
    'pratik@anutech.in',             19,   -- support: role is not restricted (a decision, not a bug)
    'ranjeet@anutech.in',            19,
    'pawan@anutech.in',              19,
    'abhishek@anutech.in',           19
  );
  roster   jsonb := current_setting('org.roster')::jsonb;
  item     jsonb;
  n        integer;
  want     integer;
  iterated integer := 0;
begin
  for item in select value from jsonb_array_elements(roster) loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', item->>'id', 'role', 'authenticated')::text, true);
    if auth.uid()::text <> (item->>'id') then
      raise exception 'SETUP FAIL: impersonation did not take for %', item->>'email';
    end if;

    if not (expected ? (item->>'email')) then
      raise exception 'UNMEASURED PERSON: % is in the tenant but not in this file. Add them (and their measured count) instead of deleting this check.', item->>'email';
    end if;

    select count(*) into n from public.leads;
    want := (expected ->> (item->>'email'))::int;
    if n <> want then
      raise exception 'MISMATCH: % sees % leads, expected %', item->>'email', n, want;
    end if;
    iterated := iterated + 1;
  end loop;

  -- The check that makes the rest of this file mean anything.
  if iterated <> (select count(*) from jsonb_object_keys(expected)) then
    raise exception 'VACUOUS RUN: measured % people, expected % -- an empty or partial loop must not pass',
      iterated, (select count(*) from jsonb_object_keys(expected));
  end if;
end $$;

reset role;

select 'MEASURED-OK' as committed_tree_visibility;

rollback;
