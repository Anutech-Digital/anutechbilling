-- Regression test R-1487: the support desk never shows one company's tickets to another.
-- Self-asserting (RAISEs on failure); runs in a transaction that ROLLS BACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/support_tickets_tenant_isolation.test.sql
--
-- /support said "across all workspaces". That is true only for a platform admin, whose API
-- path uses the admin client. Every other user reads support_tickets through RLS
-- (support_tickets_*_own_tenant: tenant_id = current_tenant_id()). This proves, as a real
-- `authenticated` session:
--   1. Company B's SUPPORT user sees B's ticket and NOT company A's (list and by id).
--   2. B cannot update or delete A's ticket (0 rows touched, A's ticket unchanged).
--   3. B cannot insert a ticket into A's workspace.
--   4. A signed-in user with no workspace (no public.users row) sees no ticket at all.
--   5. Company A's support user sees A's ticket only (the wall works both ways).

begin;

insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-1487-0000-0000-00000000c0a1', 'R1487 COMPANY A', 'r1487-a@example.in', '07'),
  ('cccccccc-1487-0000-0000-00000000c0b2', 'R1487 COMPANY B', 'r1487-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('cccccccc-1487-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'support@r1487-a.example'),
  ('cccccccc-1487-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'support@r1487-b.example'),
  ('cccccccc-1487-0000-0000-0000000000f0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nobody@r1487.example');
insert into public.users (id, tenant_id, email, role) values
  ('cccccccc-1487-0000-0000-0000000000a1', 'cccccccc-1487-0000-0000-00000000c0a1', 'support@r1487-a.example', 'support'),
  ('cccccccc-1487-0000-0000-0000000000b2', 'cccccccc-1487-0000-0000-00000000c0b2', 'support@r1487-b.example', 'support');
-- the no-workspace user deliberately has NO public.users row

insert into public.support_tickets
  (id, tenant_id, customer_name, raised_by_email, category, priority, subject, body, status, channel)
values
  ('TKT-R1487-A', 'cccccccc-1487-0000-0000-00000000c0a1', 'A Customer', 'asha@r1487-a.in',
   'tech', 'normal', 'A secret ticket', 'Only company A may read this.', 'open', 'email'),
  ('TKT-R1487-B', 'cccccccc-1487-0000-0000-00000000c0b2', 'B Customer', 'bala@r1487-b.in',
   'tech', 'normal', 'B ticket', 'Company B''s own ticket.', 'open', 'email');

set local role authenticated;

-- ── 1–3 as company B's support user ─────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-1487-0000-0000-0000000000b2', 'role', 'authenticated')::text, true);
do $$
declare n int; ok boolean := false;
begin
  select count(*) into n from public.support_tickets where id like 'TKT-R1487-%';
  if n <> 1 then raise exception 'FAIL 1: B support user sees % R1487 tickets, expected 1 (own only)', n; end if;
  if not exists (select 1 from public.support_tickets where id = 'TKT-R1487-B') then
    raise exception 'FAIL 1: B support user cannot see its OWN ticket';
  end if;
  if exists (select 1 from public.support_tickets where id = 'TKT-R1487-A') then
    raise exception 'FAIL 1: B support user can READ company A''s ticket';
  end if;
  select count(*) into n from public.support_tickets
   where tenant_id = 'cccccccc-1487-0000-0000-00000000c0a1';
  if n <> 0 then raise exception 'FAIL 1: B support user sees % rows of company A', n; end if;
  raise notice 'PASS 1: B sees its own ticket, not A''s';

  update public.support_tickets set status = 'closed' where id = 'TKT-R1487-A';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2: B support user UPDATED company A''s ticket'; end if;
  delete from public.support_tickets where id = 'TKT-R1487-A';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL 2: B support user DELETED company A''s ticket'; end if;
  raise notice 'PASS 2: B cannot update or delete A''s ticket';

  begin
    insert into public.support_tickets (id, tenant_id, customer_name, category, priority, subject, body, status, channel)
    values ('TKT-R1487-X', 'cccccccc-1487-0000-0000-00000000c0a1', 'x', 'tech', 'normal', 'planted', 'planted', 'open', 'email');
  exception when insufficient_privilege then
    ok := true;
  end;
  if not ok then raise exception 'FAIL 3: B support user INSERTED a ticket into company A'; end if;
  raise notice 'PASS 3: B cannot insert into A''s workspace';
end $$;

-- ── 4 as a signed-in user with no workspace ─────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-1487-0000-0000-0000000000f0', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.support_tickets where id like 'TKT-R1487-%';
  if n <> 0 then raise exception 'FAIL 4: a user with no workspace sees % tickets', n; end if;
  raise notice 'PASS 4: no workspace, no tickets';
end $$;

-- ── 5 as company A's support user ───────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-1487-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
do $$
declare n int; v_status text;
begin
  select count(*) into n from public.support_tickets where id like 'TKT-R1487-%';
  if n <> 1 then raise exception 'FAIL 5: A support user sees % R1487 tickets, expected 1', n; end if;
  select status::text into v_status from public.support_tickets where id = 'TKT-R1487-A';
  if v_status is distinct from 'open' then
    raise exception 'FAIL 5: A''s ticket is % (expected open — B must not have changed it)', v_status;
  end if;
  if exists (select 1 from public.support_tickets where id = 'TKT-R1487-B') then
    raise exception 'FAIL 5: A support user can READ company B''s ticket';
  end if;
  raise notice 'PASS 5: A sees its own ticket only, still open';
end $$;

rollback;
