-- R-2039 (AI Lead Workflow A): lead_ai_runs RLS + one running run per lead.
-- Migration 20261101205400_r2039_lead_ai_runs.sql.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   1. A member of tenant A reads tenant A's run; tenant B's owner reads NONE of A's runs
--      (and A reads none of B's).
--   2. A signed-in user cannot insert / update / delete a run (server writes only) — even in
--      their own tenant.
--   3. A second RUNNING run for the same lead is refused (unique index); once the first is
--      finished a new one may start.
--   4. leads.ai_status refuses a value outside the step list; a failed run must say why.
--   5. A sales user who cannot see the lead (another rep's lead, R-1401 hierarchy) cannot read
--      its runs either.
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c2039000-0000-0000-0000-0000000000a1', 'r2039-owner-a@example.test'),
  ('c2039000-0000-0000-0000-0000000000a2', 'r2039-sales-a1@example.test'),
  ('c2039000-0000-0000-0000-0000000000a3', 'r2039-sales-a2@example.test'),
  ('c2039000-0000-0000-0000-0000000000b1', 'r2039-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c2039000-0000-0000-0000-0000000000f0', 'R2039 A', 'r2039a@example.test', '07', 'R2039A'),
  ('c2039000-0000-0000-0000-0000000000f1', 'R2039 B', 'r2039b@example.test', '07', 'R2039B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c2039000-0000-0000-0000-0000000000a1', 'c2039000-0000-0000-0000-0000000000f0', 'r2039-owner-a@example.test',  'Owner A',  'owner', true),
  ('c2039000-0000-0000-0000-0000000000a2', 'c2039000-0000-0000-0000-0000000000f0', 'r2039-sales-a1@example.test', 'Sales A1', 'sales', true),
  ('c2039000-0000-0000-0000-0000000000a3', 'c2039000-0000-0000-0000-0000000000f0', 'r2039-sales-a2@example.test', 'Sales A2', 'sales', true),
  ('c2039000-0000-0000-0000-0000000000b1', 'c2039000-0000-0000-0000-0000000000f1', 'r2039-owner-b@example.test',  'Owner B',  'owner', true);

insert into public.leads (id, tenant_id, company, contact_name, contact_email, contact_phone, owner_id) values
  ('R2039-LA', 'c2039000-0000-0000-0000-0000000000f0', 'R2039 Co A',  'PA', 'pa@example.test', '9700000011', 'c2039000-0000-0000-0000-0000000000a2'),
  ('R2039-LB', 'c2039000-0000-0000-0000-0000000000f1', 'R2039 Co B',  'PB', 'pb@example.test', '9700000022', null);

-- Runs written as the server does (superuser here = the service role path).
insert into public.lead_ai_runs (id, tenant_id, lead_id, step, qualify_result, pitch, finished_at) values
  ('c2039000-0000-0000-0000-0000000000d1', 'c2039000-0000-0000-0000-0000000000f0', 'R2039-LA', 'draft_ready',
   '{"verdict":"qualified","reasons":["Indian SME on its own domain"]}', 'Line one.\nLine two.', now()),
  ('c2039000-0000-0000-0000-0000000000d2', 'c2039000-0000-0000-0000-0000000000f1', 'R2039-LB', 'unqualified',
   '{"verdict":"unqualified","reasons":["Student enquiry"]}', null, now());

do $$
declare
  n int;
  v_err text;
begin
  -- ── 3. one RUNNING run per lead ─────────────────────────────────────────────────────
  insert into public.lead_ai_runs (tenant_id, lead_id) values ('c2039000-0000-0000-0000-0000000000f0', 'R2039-LA');
  begin
    insert into public.lead_ai_runs (tenant_id, lead_id) values ('c2039000-0000-0000-0000-0000000000f0', 'R2039-LA');
    raise exception 'FAIL 3: a second running run for the same lead was allowed';
  exception when unique_violation then null;
  end;
  update public.lead_ai_runs set step = 'unqualified', finished_at = now()
   where lead_id = 'R2039-LA' and finished_at is null;
  insert into public.lead_ai_runs (tenant_id, lead_id) values ('c2039000-0000-0000-0000-0000000000f0', 'R2039-LA');
  delete from public.lead_ai_runs where lead_id = 'R2039-LA' and id <> 'c2039000-0000-0000-0000-0000000000d1';

  -- ── 4. checks ────────────────────────────────────────────────────────────────────────
  begin
    update public.leads set ai_status = 'emailed' where id = 'R2039-LA';
    raise exception 'FAIL 4a: leads.ai_status took a value outside the step list';
  exception when check_violation then
    get stacked diagnostics v_err = constraint_name;
    if v_err <> 'leads_ai_status_check' then raise exception 'FAIL 4a: wrong constraint %', v_err; end if;
  end;
  update public.leads set ai_status = 'draft_ready', ai_status_at = now() where id = 'R2039-LA';
  begin
    insert into public.lead_ai_runs (tenant_id, lead_id, step, finished_at)
      values ('c2039000-0000-0000-0000-0000000000f0', 'R2039-LA', 'failed', now());
    raise exception 'FAIL 4b: a failed run without an error was allowed';
  exception when check_violation then
    get stacked diagnostics v_err = constraint_name;
    if v_err <> 'lead_ai_runs_failed_says_why' then raise exception 'FAIL 4b: wrong constraint %', v_err; end if;
  end;
end $$;

-- ── 1. tenant A's owner ─────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', 'c2039000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d1';
  if n <> 1 then raise exception 'FAIL 1a: tenant A owner cannot read its own run (got %)', n; end if;
  select count(*) into n from public.lead_ai_runs where tenant_id = 'c2039000-0000-0000-0000-0000000000f1';
  if n <> 0 then raise exception 'FAIL 1b: tenant A owner reads % of tenant B''s runs', n; end if;

  -- ── 2. no writes for signed-in users ──
  begin
    insert into public.lead_ai_runs (tenant_id, lead_id) values ('c2039000-0000-0000-0000-0000000000f0', 'R2039-LA');
    raise exception 'FAIL 2a: a signed-in user inserted a run';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.lead_ai_runs set pitch = 'x' where id = 'c2039000-0000-0000-0000-0000000000d1';
    raise exception 'FAIL 2b: a signed-in user updated a run';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d1';
    raise exception 'FAIL 2c: a signed-in user deleted a run';
  exception when insufficient_privilege then null;
  end;
end $$;

-- ── 1c. tenant B's owner sees none of A's ──
select set_config('request.jwt.claims', json_build_object('sub', 'c2039000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.lead_ai_runs where tenant_id = 'c2039000-0000-0000-0000-0000000000f0';
  if n <> 0 then raise exception 'FAIL 1c: tenant B owner reads % of tenant A''s runs', n; end if;
  select count(*) into n from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'FAIL 1c: tenant B owner reads tenant A''s run by id'; end if;
  select count(*) into n from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d2';
  if n <> 1 then raise exception 'FAIL 1d: tenant B owner cannot read its own run (got %)', n; end if;
end $$;

-- ── 5. the lead's own rep reads it; another rep (who cannot see the lead) does not ──
select set_config('request.jwt.claims', json_build_object('sub', 'c2039000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d1';
  if n <> 1 then raise exception 'FAIL 5a: the lead owner cannot read the run (got %)', n; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub', 'c2039000-0000-0000-0000-0000000000a3', 'role', 'authenticated')::text, true);
do $$
declare n int;
begin
  select count(*) into n from public.leads where id = 'R2039-LA';
  if n <> 0 then raise exception 'SETUP 5: sales A2 can see sales A1''s lead — the hierarchy fixture is wrong'; end if;
  select count(*) into n from public.lead_ai_runs where id = 'c2039000-0000-0000-0000-0000000000d1';
  if n <> 0 then raise exception 'FAIL 5b: a rep who cannot open the lead reads its AI run'; end if;
end $$;

reset role;

rollback;
