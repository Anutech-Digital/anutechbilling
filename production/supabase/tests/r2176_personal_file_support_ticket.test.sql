\set ON_ERROR_STOP on
-- R-2176 (GP-10c, goal G-PERSONAL): a personal login's Help → Report a problem becomes ONE ticket
-- on the support desk of the company it is a customer of (personal_identity_link, GP-16a) —
-- through personal_file_support_ticket(), run AS THE SIGNED-IN USER (role authenticated), the way
-- the data gateway and PostgREST run it. Migration 20261030221233_r2176_personal_file_support_ticket.sql.
-- Rolled back — safe anywhere.
--
-- Why a SECURITY DEFINER function (checker FAIL on 4957282b0): the route read public.users and
-- inserted support_tickets with the service-role client; under DATA_GATEWAY=1 that is app_service
-- (no RLS bypass), so the role read came back empty (403 NOT_PERSONAL for a real personal user)
-- and the insert was refused by RLS.
--
--   0  the function exists; authenticated may execute it; anon and public may not
--   1  a linked personal user → a ticket in the SELLER tenant for THEIR customer, channel app,
--      tier free (no support plan) with a 24 h SLA, raised_by_user = them, the link's email,
--      category/priority as given; the seller's owners get a notification
--   2  a personal user with NO link → R2176_NOT_LINKED, nothing written
--   3  a gated link (needs_decision, no customer) → R2176_NOT_LINKED
--   4  a business login (the seller's owner) → R2176_NOT_PERSONAL
--   5  another user's link is never used: user two files for customer two only
--   6  workspace_kind 'personal' alone (role not 'personal') is enough
--   7  rate limit: the 11th ticket in an hour → R2176_TOO_MANY; another user is not affected
--   8  empty body / unknown category → R2176_BAD_INPUT; no session → R2176_NOT_SIGNED_IN

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('21760000-0000-4000-8000-0000000000a1', 'ZZ R2176 SELLER', 'r2176-seller@example.invalid', '07', 'R76S', 'reseller'),
  ('21760000-0000-4000-8000-0000000000b1', 'ZZ R2176 Personal One', 'r2176-p1@example.invalid', '07', 'R76P1', 'reseller'),
  ('21760000-0000-4000-8000-0000000000b2', 'ZZ R2176 Personal Two', 'r2176-p2@example.invalid', '07', 'R76P2', 'reseller'),
  ('21760000-0000-4000-8000-0000000000b3', 'ZZ R2176 Personal Three', 'r2176-p3@example.invalid', '07', 'R76P3', 'reseller'),
  ('21760000-0000-4000-8000-0000000000b4', 'ZZ R2176 Personal Four', 'r2176-p4@example.invalid', '07', 'R76P4', 'reseller'),
  ('21760000-0000-4000-8000-0000000000b5', 'ZZ R2176 Personal Five', 'r2176-p5@example.invalid', '07', 'R76P5', 'reseller');
update public.tenants set workspace_kind = 'personal'
 where id in ('21760000-0000-4000-8000-0000000000b1', '21760000-0000-4000-8000-0000000000b2',
              '21760000-0000-4000-8000-0000000000b3', '21760000-0000-4000-8000-0000000000b4',
              '21760000-0000-4000-8000-0000000000b5');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) values
  ('21760000-0000-4000-8000-0000000000e0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r2176-owner@example.invalid', now(), '{}'),
  ('21760000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'one.r2176@example.invalid', now(), '{}'),
  ('21760000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'two.r2176@example.invalid', now(), '{}'),
  ('21760000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nolink.r2176@example.invalid', now(), '{}'),
  ('21760000-0000-4000-8000-0000000000e4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gated.r2176@example.invalid', now(), '{}'),
  ('21760000-0000-4000-8000-0000000000e5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'kind.r2176@example.invalid', now(), '{}');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('21760000-0000-4000-8000-0000000000e0', '21760000-0000-4000-8000-0000000000a1', 'r2176-owner@example.invalid', 'Seller Owner', 'owner', true),
  ('21760000-0000-4000-8000-0000000000e1', '21760000-0000-4000-8000-0000000000b1', 'one.r2176@example.invalid', 'Person One', 'personal', true),
  ('21760000-0000-4000-8000-0000000000e2', '21760000-0000-4000-8000-0000000000b2', 'two.r2176@example.invalid', '', 'personal', true),
  ('21760000-0000-4000-8000-0000000000e3', '21760000-0000-4000-8000-0000000000b3', 'nolink.r2176@example.invalid', 'No Link', 'personal', true),
  ('21760000-0000-4000-8000-0000000000e4', '21760000-0000-4000-8000-0000000000b4', 'gated.r2176@example.invalid', 'Gated', 'personal', true),
  ('21760000-0000-4000-8000-0000000000e5', '21760000-0000-4000-8000-0000000000b5', 'kind.r2176@example.invalid', 'Kind Only', 'owner', true);

insert into public.customers (id, tenant_id, name, contact_email, customer_type) values
  ('21760000-0000-4000-8000-0000000000c1', '21760000-0000-4000-8000-0000000000a1', 'Person One', 'one.r2176@example.invalid', 'individual'),
  ('21760000-0000-4000-8000-0000000000c2', '21760000-0000-4000-8000-0000000000a1', 'Person Two', 'two.r2176@example.invalid', 'individual'),
  ('21760000-0000-4000-8000-0000000000c5', '21760000-0000-4000-8000-0000000000a1', 'Kind Only', 'kind.r2176@example.invalid', 'individual');

insert into public.personal_identity_link (auth_user_id, personal_tenant_id, seller_tenant_id, anutech_customer_id, email, link_status) values
  ('21760000-0000-4000-8000-0000000000e1', '21760000-0000-4000-8000-0000000000b1', '21760000-0000-4000-8000-0000000000a1', '21760000-0000-4000-8000-0000000000c1', 'one.r2176@example.invalid', 'linked'),
  ('21760000-0000-4000-8000-0000000000e2', '21760000-0000-4000-8000-0000000000b2', '21760000-0000-4000-8000-0000000000a1', '21760000-0000-4000-8000-0000000000c2', 'two.r2176@example.invalid', 'linked'),
  ('21760000-0000-4000-8000-0000000000e4', '21760000-0000-4000-8000-0000000000b4', '21760000-0000-4000-8000-0000000000a1', null, 'gated.r2176@example.invalid', 'needs_decision'),
  ('21760000-0000-4000-8000-0000000000e5', '21760000-0000-4000-8000-0000000000b5', '21760000-0000-4000-8000-0000000000a1', '21760000-0000-4000-8000-0000000000c5', 'kind.r2176@example.invalid', 'linked');

-- ── 0: exists; grants ─────────────────────────────────────────────────────────
do $$
declare f text := 'public.personal_file_support_ticket(text,text,text,text)';
begin
  if to_regprocedure(f) is null then raise exception 'FAIL 0: % does not exist', f; end if;
  if not has_function_privilege('authenticated', f, 'execute') then raise exception 'FAIL 0b: authenticated cannot execute'; end if;
  if has_function_privilege('anon', f, 'execute') then raise exception 'FAIL 0c: anon can execute'; end if;
  if has_function_privilege('service_role', f, 'execute') then raise exception 'FAIL 0f: service_role can execute (authenticated only)'; end if;
  if not (select prosecdef from pg_proc where oid = to_regprocedure(f)) then raise exception 'FAIL 0d: not SECURITY DEFINER'; end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure(f) and 'search_path=public' = any(proconfig)) then
    raise exception 'FAIL 0e: search_path is not pinned';
  end if;
end $$;

-- a helper: run one call as the current session, return the error message ('' = no error)
create or replace function pg_temp.r2176_try(p_body text, p_category text default 'tech')
returns text language plpgsql as $$
begin
  perform public.personal_file_support_ticket('Subject', p_body, p_category, 'normal');
  return '';
exception when others then
  return sqlerrm;
end $$;
grant execute on function pg_temp.r2176_try(text, text) to authenticated;

set local role authenticated;


-- ── 1: linked personal user ───────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e1','role','authenticated')::text, true);
do $$
declare v_id text;
begin
  v_id := public.personal_file_support_ticket('Bank balance shows 0', E'I added a statement.\n\nPage: /vault/personal/banking', 'tech', 'high');
  if v_id !~ '^TKT-[0-9A-Z]+-[0-9A-F]{2}$' then raise exception 'FAIL 1a: ticket number %', v_id; end if;
  perform set_config('r2176.t1', v_id, true);
end $$;

-- ── 2: no link ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e3','role','authenticated')::text, true);
do $$ declare m text := pg_temp.r2176_try('x'); begin
  if m not like 'R2176_NOT_LINKED%' then raise exception 'FAIL 2: no-link user got "%"', m; end if;
end $$;

-- ── 3: gated link ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e4','role','authenticated')::text, true);
do $$ declare m text := pg_temp.r2176_try('x'); begin
  if m not like 'R2176_NOT_LINKED%' then raise exception 'FAIL 3: gated user got "%"', m; end if;
end $$;

-- ── 4: business login ─────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e0','role','authenticated')::text, true);
do $$ declare m text := pg_temp.r2176_try('x'); begin
  if m not like 'R2176_NOT_PERSONAL%' then raise exception 'FAIL 4: business owner got "%"', m; end if;
end $$;

-- ── 5: user two files for their OWN customer ─────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e2','role','authenticated')::text, true);
do $$ begin
  perform set_config('r2176.t2', public.personal_file_support_ticket('Two', 'Body two', 'feature', 'low'), true);
end $$;

-- ── 6: workspace_kind personal, role owner ────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e5','role','authenticated')::text, true);
do $$ declare m text := pg_temp.r2176_try('kind only'); begin
  if m <> '' then raise exception 'FAIL 6: workspace_kind personal user refused: "%"', m; end if;
end $$;

-- ── 8: bad input ──────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e1','role','authenticated')::text, true);
do $$ declare m text; begin
  m := pg_temp.r2176_try('   ');
  if m not like 'R2176_BAD_INPUT%' then raise exception 'FAIL 8a: empty body got "%"', m; end if;
  m := pg_temp.r2176_try('x', 'hack');
  if m not like 'R2176_BAD_INPUT%' then raise exception 'FAIL 8b: unknown category got "%"', m; end if;
end $$;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
do $$ declare m text := pg_temp.r2176_try('x'); begin
  if m not like 'R2176_NOT_SIGNED_IN%' then raise exception 'FAIL 8c: no session got "%"', m; end if;
end $$;

-- ── 7: rate limit (user one already has 1; 9 more pass, the 11th is refused) ─
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e1','role','authenticated')::text, true);
do $$ declare i int; m text; begin
  for i in 1..9 loop
    m := pg_temp.r2176_try('again ' || i);
    if m <> '' then raise exception 'FAIL 7a: ticket % of 10 refused: "%"', i + 1, m; end if;
  end loop;
  m := pg_temp.r2176_try('one too many');
  if m not like 'R2176_TOO_MANY%' then raise exception 'FAIL 7b: 11th ticket got "%"', m; end if;
end $$;
select set_config('request.jwt.claims', json_build_object('sub','21760000-0000-4000-8000-0000000000e2','role','authenticated')::text, true);
do $$ declare m text := pg_temp.r2176_try('still fine'); begin
  if m <> '' then raise exception 'FAIL 7c: user two was rate-limited by user one: "%"', m; end if;
end $$;

reset role;
-- ── 9: the data gateway path (R-1901): login app_runtime, the user in app.user_id, no JWT ─
-- Only where the gateway logins exist (dev-local creates them; plain Supabase in CI has none) and
-- the runner is a real superuser (locally: psql -U supabase_admin).
do $g$
declare m text; v_id text;
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime')
     or not (select rolsuper from pg_roles where rolname = current_user) then
    raise notice 'r2176: no app_runtime login (or not a superuser to become it) - gateway case 9 skipped';
    return;
  end if;
  execute 'set session authorization app_runtime';
  perform set_config('request.jwt.claims', '', true);
  perform set_config('app.user_id', '21760000-0000-4000-8000-0000000000e2', true);
  v_id := public.personal_file_support_ticket('Via gateway', 'gateway body', 'tech', 'normal');
  perform set_config('r2176.t9', v_id, true);
  perform set_config('app.user_id', '21760000-0000-4000-8000-0000000000e0', true);
  begin
    perform public.personal_file_support_ticket('x', 'x', 'tech', 'normal');
    m := '';
  exception when others then m := sqlerrm;
  end;
  execute 'reset session authorization';
  if m not like 'R2176_NOT_PERSONAL%' then raise exception 'FAIL 9b: gateway business login got "%"', m; end if;
end $g$;
do $$ declare t record; begin
  if coalesce(current_setting('r2176.t9', true), '') = '' then return; end if;
  select * into t from public.support_tickets where id = current_setting('r2176.t9');
  if t.raised_by_user is distinct from '21760000-0000-4000-8000-0000000000e2' or t.customer_id is distinct from '21760000-0000-4000-8000-0000000000c2' then
    raise exception 'FAIL 9a: gateway ticket user % customer %', t.raised_by_user, t.customer_id;
  end if;
end $$;

-- ── checks on what was written (as the superuser) ─────────────────────────────
reset role;
do $$
declare t record; v_n int;
begin
  select * into t from public.support_tickets where id = current_setting('r2176.t1');
  if t.id is null then raise exception 'FAIL 1b: ticket % not written', current_setting('r2176.t1'); end if;
  if t.tenant_id <> '21760000-0000-4000-8000-0000000000a1' then raise exception 'FAIL 1c: tenant %', t.tenant_id; end if;
  if t.customer_id is distinct from '21760000-0000-4000-8000-0000000000c1' then raise exception 'FAIL 1d: customer %', t.customer_id; end if;
  if t.channel is distinct from 'app' then raise exception 'FAIL 1e: channel %', t.channel; end if;
  if t.tier is distinct from 'free' then raise exception 'FAIL 1f: tier %', t.tier; end if;
  if t.sla_due_at < now() + interval '23 hours' or t.sla_due_at > now() + interval '25 hours' then raise exception 'FAIL 1g: sla_due_at %', t.sla_due_at; end if;
  if t.raised_by_user is distinct from '21760000-0000-4000-8000-0000000000e1' then raise exception 'FAIL 1h: raised_by_user %', t.raised_by_user; end if;
  if t.raised_by_email <> 'one.r2176@example.invalid' or t.customer_name <> 'Person One' then raise exception 'FAIL 1i: % / %', t.raised_by_email, t.customer_name; end if;
  if t.subject <> 'Bank balance shows 0' or t.body not like 'I added a statement.%' or t.category <> 'tech' or t.priority <> 'high' or t.status <> 'open' then
    raise exception 'FAIL 1j: % / % / % / % / %', t.subject, t.body, t.category, t.priority, t.status;
  end if;
  if not exists (select 1 from public.notifications where entity_id = t.id and user_id = '21760000-0000-4000-8000-0000000000e0') then
    raise exception 'FAIL 1k: the seller owner got no notification';
  end if;

  select * into t from public.support_tickets where id = current_setting('r2176.t2');
  if t.customer_id is distinct from '21760000-0000-4000-8000-0000000000c2' or t.raised_by_user is distinct from '21760000-0000-4000-8000-0000000000e2' then
    raise exception 'FAIL 5a: user two ticket customer % user %', t.customer_id, t.raised_by_user;
  end if;
  if t.customer_name <> 'two.r2176@example.invalid' then raise exception 'FAIL 5b: empty full name should fall back to the link email, got %', t.customer_name; end if;
  if t.category <> 'feature' or t.priority <> 'low' then raise exception 'FAIL 5c: % / %', t.category, t.priority; end if;

  select count(*) into v_n from public.support_tickets where raised_by_user in ('21760000-0000-4000-8000-0000000000e3', '21760000-0000-4000-8000-0000000000e4', '21760000-0000-4000-8000-0000000000e0');
  if v_n <> 0 then raise exception 'FAIL 2-4: refused callers wrote % ticket(s)', v_n; end if;
  select count(*) into v_n from public.support_tickets where raised_by_user = '21760000-0000-4000-8000-0000000000e1';
  if v_n <> 10 then raise exception 'FAIL 7d: user one has % tickets (expected 10)', v_n; end if;
end $$;

do $$ begin raise notice 'r2176_personal_file_support_ticket: all checks passed'; end $$;
rollback;
