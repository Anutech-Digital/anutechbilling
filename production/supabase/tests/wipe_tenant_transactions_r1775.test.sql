-- R-1775 (23 Oct 2026): the staging wipe of ONE company's data
-- (supabase/cloudsql/staging/wipe-tenant-transactions.sh) proved on the LOCAL DB, inside begin ... rollback.
-- Tenant 1111 stands in for Anutech Digital. Asserts: every non-keep tenant table is 0 for it, the keep-list
-- (logins, settings, secrets, bug reports) is unchanged, the tenants rows and E2E Test Co + every other company are
-- unchanged, no dangling foreign-key rows, every trigger back in its exact mode.
-- The CORE block below is a byte-for-byte copy of the one in wipe-tenant-transactions.sql
-- (tests/ops/wipe-tenant-transactions.test.ts fails if they differ).
-- Run: npm run test:sql:local wipe_tenant_transactions_r1775

begin;

-- >>> R-1775 CORE (begin) - copied byte-for-byte into supabase/tests/wipe_tenant_transactions_r1775.test.sql;
--     tests/ops/wipe-tenant-transactions.test.ts fails if the two copies differ.

-- THE KEEP-LIST - the only place it is defined. Every public table that has a tenant_id column and is
-- NOT named here loses ALL rows of the chosen company. Tables are found from pg_class/pg_attribute,
-- not from a hand list, so a table added later is wiped unless it is added here.
-- Scope (Pardeep, 23 Oct 2026, changed the same morning): ONE company, ALL its data - keep only what a
-- login, the company settings and the integration keys need.
--  * Roles/permissions have no table of their own: they are columns on users, kept with it.
--  * Chart of accounts: there is NO per-tenant chart-of-accounts table - the ledger is worked out from
--    the documents and the account heads are code, not rows. bank_accounts / personal_accounts are the
--    business's own data (made by people, not seeded), so they go. The app runs without them.
--  * users.employee_id is ON DELETE SET NULL: the employee record goes, the login stays.
create or replace function pg_temp.r1775_keep() returns text[] language sql immutable as $f$
  select array[
    -- logins and what hangs off a login (Google sign-in tokens, push devices, API keys, invites, vault PIN)
    'users', 'user_google_tokens', 'push_subscriptions', 'api_keys', 'team_invites', 'join_requests',
    'personal_vault_pin',
    -- company settings (the tenants row itself is never touched: name, GSTIN, address, settings columns)
    'attendance_settings', 'whatsapp_reminder_settings', 'ai_autonomy', 'demo_tenants', 'tenant_domains',
    -- numbering / sequence config: next numbers are NOT reset (runbook says how, if ever wanted)
    'document_series', 'customer_number_seq',
    -- secrets and integration keys / connections (Ads + Google Business tokens, IndiaMART sync state)
    'tenant_secrets', 'ad_accounts', 'gbp_locations', 'indiamart_sync_state',
    -- bug reports (Pardeep, 23 Oct: keep the 30 reports) and what hangs only off them. Their foreign
    -- keys point only at tenants and users, both kept; r1775_keep_refs() stops the run if that changes.
    'feedback', 'feedback_screenshots', 'feedback_votes'
  ]::text[]
$f$;

-- public tables (not partitions) that carry tenant_id
create or replace function pg_temp.r1775_tenant_tables() returns text[] language sql stable as $f$
  select coalesce(array_agg(c.relname::text order by c.relname), '{}'::text[])
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relispartition
    and c.relname <> 'tenants'
    and exists (select 1 from pg_attribute a
                where a.attrelid = c.oid and a.attname = 'tenant_id' and a.attnum > 0 and not a.attisdropped)
$f$;

-- what gets wiped: every tenant_id table not on the keep-list
create or replace function pg_temp.r1775_targets() returns text[] language sql stable as $f$
  select coalesce(array_agg(t order by t), '{}'::text[])
  from unnest(pg_temp.r1775_tenant_tables()) t where t <> all (pg_temp.r1775_keep())
$f$;

-- keep-list tables that exist here
create or replace function pg_temp.r1775_keep_present() returns text[] language sql stable as $f$
  select coalesce(array_agg(t order by t), '{}'::text[])
  from unnest(pg_temp.r1775_tenant_tables()) t where t = any (pg_temp.r1775_keep())
$f$;

create or replace function pg_temp.r1775_counts(p_tables text[], p_tenants uuid[]) returns jsonb
language plpgsql as $f$
declare v_t text; v_n bigint; v_out jsonb := '{}'::jsonb;
begin
  foreach v_t in array coalesce(p_tables, '{}'::text[]) loop
    execute format('select count(*) from public.%I where tenant_id = any($1)', v_t) into v_n using p_tenants;
    v_out := v_out || jsonb_build_object(v_t, v_n);
  end loop;
  return v_out;
end $f$;

-- keep-list rows that an ON DELETE CASCADE foreign key removes together with a wiped parent
-- (e.g. a password-vault entry that belongs to a deleted customer). Counted up front so the
-- after-check knows the exact number each keep table must end at.
create or replace function pg_temp.r1775_keep_cascade(p_tenants uuid[]) returns jsonb
language plpgsql as $f$
declare v_k text; v_cond text; v_n bigint; v_out jsonb := '{}'::jsonb; v_targets text[] := pg_temp.r1775_targets();
begin
  foreach v_k in array pg_temp.r1775_keep_present() loop
    select string_agg(format('exists (select 1 from %s p where p.tenant_id = any($1) and %s)',
             con.confrelid::regclass,
             (select string_agg(format('p.%I = k.%I', pa.attname, ka.attname), ' and ')
                from unnest(con.conkey, con.confkey) as u(kk, fk)
                join pg_attribute ka on ka.attrelid = con.conrelid and ka.attnum = u.kk
                join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = u.fk)), ' or ')
      into v_cond
      from pg_constraint con
      join pg_class pc on pc.oid = con.confrelid
     where con.contype = 'f' and con.confdeltype = 'c'
       and con.conrelid = format('public.%I', v_k)::regclass
       and pc.relnamespace = 'public'::regnamespace and pc.relname::text = any (v_targets);
    if v_cond is not null then
      execute format('select count(*) from public.%I k where k.tenant_id = any($1) and (%s)', v_k, v_cond)
        into v_n using p_tenants;
      if v_n > 0 then v_out := v_out || jsonb_build_object(v_k, v_n); end if;
    end if;
  end loop;
  return v_out;
end $f$;

-- keep-list rows that point at a row about to be wiped through a foreign key whose ON DELETE action
-- is one of p_actions ('a' no action / 'r' restrict = the delete would fail; 'n' set null / 'd' set
-- default = the database itself would change the kept row). Key: table.columns:action.
-- This script never nulls or rewrites a kept row itself: 'a'/'r' rows stop the run (reported, nothing
-- changed); 'n'/'d' rows are shown in the dry run so Pardeep sees them before saying yes.
create or replace function pg_temp.r1775_keep_refs(p_tenants uuid[], p_actions text[]) returns jsonb
language plpgsql as $f$
declare con record; v_cond text; v_cols text; v_n bigint; v_out jsonb := '{}'::jsonb;
  v_targets text[] := pg_temp.r1775_targets();
begin
  for con in select c.conrelid, c.confrelid, c.conkey, c.confkey, c.confdeltype::text as act, kc.relname::text as k
               from pg_constraint c
               join pg_class kc on kc.oid = c.conrelid
               join pg_class pc on pc.oid = c.confrelid
              where c.contype = 'f' and c.confdeltype::text = any (p_actions)
                and kc.relnamespace = 'public'::regnamespace and kc.relname::text = any (pg_temp.r1775_keep_present())
                and pc.relnamespace = 'public'::regnamespace and pc.relname::text = any (v_targets)
              order by kc.relname, c.conname loop
    select string_agg(format('p.%I = k.%I', pa.attname, ka.attname), ' and '),
           string_agg(ka.attname::text, ',')
      into v_cond, v_cols
      from unnest(con.conkey, con.confkey) as u(kk, fk)
      join pg_attribute ka on ka.attrelid = con.conrelid and ka.attnum = u.kk
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = u.fk;
    execute format('select count(*) from public.%I k where k.tenant_id = any($1) and exists (select 1 from %s p where p.tenant_id = any($1) and %s)',
                   con.k, con.confrelid::regclass, v_cond)
      into v_n using p_tenants;
    if v_n > 0 then v_out := v_out || jsonb_build_object(con.k || '.' || v_cols || ':' || con.act, v_n); end if;
  end loop;
  return v_out;
end $f$;

-- one line per company: name | id | GSTIN (made safe for the RAISE channel)
create or replace function pg_temp.r1775_describe(p_tenants uuid[]) returns text language sql stable as $f$
  select string_agg(regexp_replace(t.name, '[^A-Za-z0-9 .,&()-]', ' ', 'g') || ' | ' || t.id || ' | '
                    || coalesce(nullif(t.gstin, ''), 'no GSTIN'), ' ; ' order by t.name)
  from public.tenants t where t.id = any (p_tenants)
$f$;

-- {a:1,b:0} -> 'a=1 b=0' (p_nonzero: leave out zeros)
create or replace function pg_temp.r1775_fmt(p_counts jsonb, p_nonzero boolean) returns text language sql immutable as $f$
  select coalesce(string_agg(key || '=' || value, ' ' order by key), '')
  from jsonb_each_text(coalesce(p_counts, '{}'::jsonb)) where not p_nonzero or value <> '0'
$f$;

create or replace function pg_temp.r1775_total(p_counts jsonb) returns bigint language sql immutable as $f$
  select coalesce(sum(value::bigint), 0)::bigint from jsonb_each_text(coalesce(p_counts, '{}'::jsonb))
$f$;

-- Exactly one company whose name contains p_match (any case) or whose GSTIN equals it.
-- Zero or several -> stop. E2E Test Co can never be the answer.
create or replace function pg_temp.r1775_find(p_match text) returns uuid language plpgsql stable as $f$
declare v_m text := lower(trim(coalesce(p_match, ''))); v_ids uuid[];
begin
  if length(v_m) < 3 then raise exception 'WIPESTOP company match % is too short - nothing changed', v_m; end if;
  select array_agg(t.id order by t.name) into v_ids from public.tenants t
   where lower(t.name) like '%' || v_m || '%' or lower(coalesce(t.gstin, '')) = v_m;
  if v_ids is null then
    raise exception 'WIPESTOP no company matches % - nothing changed. Set ANUTECH_MATCH to its GSTIN.', v_m;
  end if;
  if cardinality(v_ids) > 1 then
    raise exception 'WIPESTOP % companies match % : % - nothing changed. Set ANUTECH_MATCH to the GSTIN of the right one.',
      cardinality(v_ids), v_m, pg_temp.r1775_describe(v_ids);
  end if;
  if v_ids[1] = 'f588b89d-6ba2-4abe-b8b3-e4821a65e7b4'::uuid
     or exists (select 1 from public.tenants t where t.id = v_ids[1] and t.name ilike '%e2e%') then
    raise exception 'WIPESTOP % found E2E Test Co - it is never wiped. Nothing changed.', v_m;
  end if;
  return v_ids[1];
end $f$;

-- THE WIPE. Runs inside the caller's transaction (one statement = one transaction on import);
-- any error rolls everything back, including the trigger/RLS switches below.
create or replace function pg_temp.r1775_wipe(p_tenants uuid[]) returns jsonb language plpgsql as $f$
declare
  v_targets text[] := pg_temp.r1775_targets();
  v_keep text[] := pg_temp.r1775_keep_present();
  v_del_before jsonb; v_keep_before jsonb; v_cascade jsonb; v_keep_expected jsonb := '{}'::jsonb;
  v_del_after jsonb; v_keep_after jsonb;
  v_rels oid[]; v_bad text; v_forced oid[];
  v_trig_rel oid[] := '{}'; v_trig_name text[] := '{}'; v_trig_mode text[] := '{}';
  v_trig_before text; v_trig_after text; v_blocked jsonb; v_nulled jsonb;
  r record; i int; v_t text; v_n bigint; v_progress boolean; v_left int; v_err text; v_pass int := 0;
begin
  if p_tenants is null or cardinality(p_tenants) = 0 then
    raise exception 'WIPESTOP no companies given - nothing changed';
  end if;
  if 'f588b89d-6ba2-4abe-b8b3-e4821a65e7b4'::uuid = any (p_tenants)
     or exists (select 1 from public.tenants t where t.id = any (p_tenants) and t.name ilike '%e2e%') then
    raise exception 'WIPESTOP E2E Test Co is never wiped - nothing changed';
  end if;
  if (select count(*) from public.tenants t where t.id = any (p_tenants))
     <> (select count(distinct x) from unnest(p_tenants) x) then
    raise exception 'WIPESTOP a company id is not in tenants - nothing changed';
  end if;

  -- A kept row (e.g. a bug report) pointing at a row to be wiped through RESTRICT / NO ACTION would
  -- make the delete fail. Report exactly which, and stop - the script never rewrites a kept row.
  v_blocked := pg_temp.r1775_keep_refs(p_tenants, array['a', 'r']);
  if v_blocked <> '{}'::jsonb then
    raise exception 'WIPESTOP kept rows point at rows that would be wiped (table.columns:action=rows): % - nothing changed. Send Claude this screen.',
      pg_temp.r1775_fmt(v_blocked, true);
  end if;
  v_nulled := pg_temp.r1775_keep_refs(p_tenants, array['n', 'd']);

  v_del_before  := pg_temp.r1775_counts(v_targets, p_tenants);
  v_keep_before := pg_temp.r1775_counts(v_keep, p_tenants);
  v_cascade     := pg_temp.r1775_keep_cascade(p_tenants);
  select coalesce(jsonb_object_agg(b.key, b.value::bigint - coalesce((v_cascade ->> b.key)::bigint, 0)), '{}'::jsonb)
    into v_keep_expected from jsonb_each_text(v_keep_before) b;

  -- Relations whose triggers could fire: the wiped tables and every table holding a foreign key to them.
  select array_agg(distinct x) into v_rels from (
    select format('public.%I', t)::regclass::oid as x from unnest(v_targets) t
    union
    select con.conrelid from pg_constraint con
     where con.contype = 'f' and con.confrelid in (select format('public.%I', t)::regclass::oid from unnest(v_targets) t)
  ) s;

  -- ALTER TABLE below needs ownership. Not owner -> stop before anything else.
  select string_agg(c.oid::regclass::text, ' ' order by 1) into v_bad
    from pg_class c where c.oid = any (v_rels) and not pg_has_role(current_user, c.relowner, 'USAGE');
  if v_bad is not null then
    raise exception 'WIPESTOP user % does not own: % - nothing changed', current_user, v_bad;
  end if;

  select string_agg(t.tgrelid::text || ':' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid, t.tgname)
    into v_trig_before from pg_trigger t where t.tgrelid = any (v_rels) and not t.tgisinternal;

  -- WHY triggers are switched off, and why not session_replication_role = replica:
  --  * money/immutability triggers refuse a DELETE of an issued invoice, a payment, a closed period ...
  --    which is exactly what a wipe must do; audit triggers would write new rows for every deleted one.
  --  * replica mode would ALSO switch off the foreign-key actions (ON DELETE CASCADE / SET NULL), leaving
  --    child rows pointing at deleted parents, and on Cloud SQL a non-superuser may not set it.
  -- So: only USER triggers that are enabled now are disabled one by one, foreign keys stay fully live,
  -- and each trigger is put back to its exact mode (O / A / R) before this transaction ends. ALTER TABLE
  -- is transactional: if anything fails, the rollback restores them too.
  for r in select t.tgrelid, t.tgname, t.tgenabled::text as mode
             from pg_trigger t where t.tgrelid = any (v_rels) and not t.tgisinternal and t.tgenabled <> 'D'
            order by t.tgrelid, t.tgname loop
    execute format('alter table %s disable trigger %I', r.tgrelid::regclass, r.tgname);
    v_trig_rel := v_trig_rel || r.tgrelid; v_trig_name := v_trig_name || r.tgname::text; v_trig_mode := v_trig_mode || r.mode;
  end loop;

  -- FORCE ROW LEVEL SECURITY would make the owner see 0 rows and the delete silently do nothing.
  select array_agg(c.oid) into v_forced from pg_class c where c.oid = any (v_rels) and c.relforcerowsecurity;
  for i in 1 .. coalesce(cardinality(v_forced), 0) loop
    execute format('alter table %s no force row level security', v_forced[i]::regclass);
  end loop;

  -- Delete in whatever order the foreign keys allow: try every table, skip the ones that cannot go yet,
  -- repeat. No progress in a full pass -> stop (a keep-list row points at a wiped row).
  -- not_null_violation is caught too: a composite FK (tenant_id, x) ON DELETE SET NULL would null the
  -- child's tenant_id when its parent goes first - the child simply has to be deleted first.
  loop
    v_pass := v_pass + 1; v_progress := false; v_left := 0; v_err := null;
    foreach v_t in array v_targets loop
      begin
        execute format('delete from public.%I where tenant_id = any($1)', v_t) using p_tenants;
        get diagnostics v_n = row_count;
        if v_n > 0 then v_progress := true; end if;
      exception when foreign_key_violation or restrict_violation or not_null_violation then
        v_left := v_left + 1; v_err := v_t || ': ' || regexp_replace(sqlerrm, '["\\]', ' ', 'g');
      end;
    end loop;
    exit when v_left = 0;
    if not v_progress or v_pass > 50 then
      raise exception 'WIPESTOP stuck after % passes, % tables still referenced. Last: % - nothing changed', v_pass, v_left, v_err;
    end if;
  end loop;

  set constraints all immediate;  -- no pending trigger events may block the ALTERs below

  for i in 1 .. coalesce(cardinality(v_trig_rel), 0) loop
    execute format('alter table %s %s trigger %I', v_trig_rel[i]::regclass,
      case v_trig_mode[i] when 'A' then 'enable always' when 'R' then 'enable replica' else 'enable' end, v_trig_name[i]);
  end loop;
  for i in 1 .. coalesce(cardinality(v_forced), 0) loop
    execute format('alter table %s force row level security', v_forced[i]::regclass);
  end loop;

  select string_agg(t.tgrelid::text || ':' || t.tgname || ':' || t.tgenabled::text, ',' order by t.tgrelid, t.tgname)
    into v_trig_after from pg_trigger t where t.tgrelid = any (v_rels) and not t.tgisinternal;
  if v_trig_after is distinct from v_trig_before then
    raise exception 'WIPESTOP triggers did not come back exactly as they were - nothing changed';
  end if;

  v_del_after  := pg_temp.r1775_counts(v_targets, p_tenants);
  v_keep_after := pg_temp.r1775_counts(v_keep, p_tenants);
  if pg_temp.r1775_total(v_del_after) <> 0 then
    raise exception 'WIPESTOP rows still left: % - nothing changed', pg_temp.r1775_fmt(v_del_after, true);
  end if;
  if v_keep_after <> v_keep_expected then
    raise exception 'WIPESTOP keep-list changed. expected % got % - nothing changed',
      pg_temp.r1775_fmt(v_keep_expected, false), pg_temp.r1775_fmt(v_keep_after, false);
  end if;

  return jsonb_build_object('deleted', v_del_before, 'keep', v_keep_after, 'cascade', v_cascade,
                            'nulled', v_nulled, 'passes', v_pass);
end $f$;
-- <<< R-1775 CORE (end)

-- ── The test ────────────────────────────────────────────────────────────────────────────
-- Tenant 1111 is the local stand-in for Anutech Digital. Everything below is rolled back.
do $t$
declare
  t1 constant uuid := '11111111-1111-1111-1111-111111111111';
  e2e constant uuid := 'f588b89d-6ba2-4abe-b8b3-e4821a65e7b4';
  v_all text[] := pg_temp.r1775_tenant_tables();
  v_targets text[] := pg_temp.r1775_targets();
  v_keep text[] := pg_temp.r1775_keep_present();
  v_others uuid[];
  v_others_before jsonb; v_others_after jsonb;
  v_keep_before jsonb; v_keep_after jsonb; v_cascade jsonb;
  v_t1_before jsonb; v_res jsonb; v_tenants_before text; v_tenants_after text;
  v_users_before text; v_users_after text; v_secrets_before bigint;
  v_trig_before text; v_trig_after text; v_rls_before text; v_rls_after text;
  v_t text; v_n bigint; v_ok boolean; con record; v_sql text;
  v_fb uuid; v_fb_user uuid; v_fb_before text; v_fb_after text;
begin
  -- a bug report of 1111 with a screenshot and a vote (local 1111 has none; rolled back with the rest).
  -- Pardeep, 23 Oct: the bug reports stay through the wipe, screenshot rows and votes with them.
  select id into v_fb_user from public.users where tenant_id = t1 order by id limit 1;
  -- R-1802: CI's seed (supabase/seed.sql) gives 1111 data but no login - only scripts/dev-local.mjs adds
  -- one on a laptop. Make one here (rolled back) so the bug report has a reporter in both places.
  if v_fb_user is null then
    v_fb_user := '11111111-1111-1111-1111-00000000f1ee';
    insert into auth.users (id, instance_id, aud, role, email)
      values (v_fb_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r1775-reporter@example.in');
    insert into public.users (id, tenant_id, email, role) values (v_fb_user, t1, 'r1775-reporter@example.in', 'owner');
  end if;
  -- R-1802: the same for E2E Test Co - it comes from e2e/fixtures/seed-e2e-tenant.mjs, which CI's SQL job
  -- never runs. Without it the guards below have no second company to protect (rolled back too).
  if not exists (select 1 from public.tenants where id = e2e) then
    insert into public.tenants (id, name, email, state_code) values (e2e, 'E2E Test Co', 'e2e@example.in', '07');
    insert into public.customers (tenant_id, name) values (e2e, 'R-1802 E2E customer');
  end if;
  insert into public.feedback (tenant_id, title, body, reported_by, reporter_name)
    values (t1, 'R-1775 test report', 'kept through the wipe', v_fb_user, 'R-1775 test') returning id into v_fb;
  insert into public.feedback_screenshots (feedback_id, tenant_id, file_path, file_name)
    values (v_fb, t1, t1 || '/feedback/' || v_fb || '/shot.png', 'shot.png');
  insert into public.feedback_votes (tenant_id, feedback_id, user_id) values (t1, v_fb, v_fb_user);
  select string_agg(x, '|' order by x) into v_fb_before from (
    select to_jsonb(f)::text as x from public.feedback f where f.tenant_id = t1
    union all select to_jsonb(s)::text from public.feedback_screenshots s where s.tenant_id = t1
    union all select to_jsonb(v)::text from public.feedback_votes v where v.tenant_id = t1) q;

  -- the keep-list is what Pardeep chose on 23 Oct (scope change): logins, settings, secrets/keys only
  foreach v_t in array array['users', 'tenant_secrets', 'document_series', 'user_google_tokens',
                             'feedback', 'feedback_screenshots', 'feedback_votes'] loop
    if not v_t = any (v_keep) then raise exception 'FAIL: % must be on the keep-list', v_t; end if;
  end loop;
  foreach v_t in array array['customers', 'invoices', 'quotes', 'payments', 'subscriptions', 'items',
                             'vendors', 'expenses', 'vendor_bills', 'leads', 'tasks',
                             'bank_accounts', 'employees', 'zoho_books_import_runs'] loop
    if not v_t = any (v_targets) then raise exception 'FAIL: % must be wiped (not on the keep-list)', v_t; end if;
  end loop;
  if cardinality(v_targets) + cardinality(v_keep) <> cardinality(v_all) then
    raise exception 'FAIL: targets + keep (% + %) is not every tenant table (%)', cardinality(v_targets), cardinality(v_keep), cardinality(v_all);
  end if;

  select array_agg(id) into v_others from public.tenants where id <> t1;
  if not e2e = any (v_others) then raise exception 'FAIL: local DB has no E2E Test Co tenant to protect'; end if;

  v_t1_before := pg_temp.r1775_counts(v_targets, array[t1]);
  if pg_temp.r1775_total(v_t1_before) = 0 or (v_t1_before ->> 'customers')::int = 0 then
    raise exception 'FAIL: tenant 1111 has nothing to wipe - the test would prove nothing';
  end if;
  v_others_before := pg_temp.r1775_counts(v_all, v_others);
  v_keep_before := pg_temp.r1775_counts(v_keep, array[t1]);
  v_cascade := pg_temp.r1775_keep_cascade(array[t1]);
  select string_agg(t::text, '|' order by id) into v_tenants_before from public.tenants t;
  select string_agg((to_jsonb(u) - 'employee_id' - 'updated_at')::text, '|' order by id) into v_users_before
    from public.users u where tenant_id = t1;
  select count(*) into v_secrets_before from public.tenant_secrets where tenant_id = t1;
  select string_agg(tgrelid::text || ':' || tgname || ':' || tgenabled::text, ',' order by tgrelid, tgname) into v_trig_before
    from pg_trigger where not tgisinternal;
  select string_agg(oid::text || ':' || relforcerowsecurity::text, ',' order by oid) into v_rls_before
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p');

  -- E2E Test Co is refused, by id
  v_ok := false;
  begin perform pg_temp.r1775_wipe(array[e2e]);
  exception when others then
    if sqlerrm like 'WIPESTOP E2E%' then v_ok := true; else raise; end if;
  end;
  if not v_ok then raise exception 'FAIL: wipe of E2E Test Co was not refused'; end if;
  -- ... and the finder never returns it
  v_ok := false;
  begin perform pg_temp.r1775_find('E2E Test');
  exception when others then
    if sqlerrm like 'WIPESTOP%E2E%' then v_ok := true; else raise; end if;
  end;
  if not v_ok then raise exception 'FAIL: finder returned E2E Test Co'; end if;
  -- zero / unknown match stops
  v_ok := false;
  begin perform pg_temp.r1775_find('no-such-company-xyz');
  exception when others then
    if sqlerrm like 'WIPESTOP no company matches%' then v_ok := true; else raise; end if;
  end;
  if not v_ok then raise exception 'FAIL: a match with no company did not stop'; end if;

  -- THE WIPE (the same function the staging script runs)
  v_res := pg_temp.r1775_wipe(array[t1]);

  -- 1. every non-keep tenant table: 0 rows for 1111
  foreach v_t in array v_targets loop
    execute format('select count(*) from public.%I where tenant_id = $1', v_t) into v_n using t1;
    if v_n <> 0 then raise exception 'FAIL: % still has % rows of tenant 1111', v_t, v_n; end if;
  end loop;
  -- 2. keep-list unchanged (minus rows an ON DELETE CASCADE takes with a wiped parent, counted up front)
  v_keep_after := pg_temp.r1775_counts(v_keep, array[t1]);
  foreach v_t in array v_keep loop
    if (v_keep_after ->> v_t)::bigint <> (v_keep_before ->> v_t)::bigint - coalesce((v_cascade ->> v_t)::bigint, 0) then
      raise exception 'FAIL: keep table % went % -> % (cascade %)', v_t, v_keep_before ->> v_t, v_keep_after ->> v_t, v_cascade ->> v_t;
    end if;
  end loop;
  if (v_keep_after ->> 'users')::int = 0 or (v_keep_after ->> 'users') <> (v_keep_before ->> 'users') then
    raise exception 'FAIL: logins of 1111 changed';
  end if;
  if (select count(*) from public.tenant_secrets where tenant_id = t1) <> v_secrets_before then
    raise exception 'FAIL: tenant_secrets changed';
  end if;
  -- the login rows themselves are the same, except employee_id (ON DELETE SET NULL, employee record wiped)
  select string_agg((to_jsonb(u) - 'employee_id' - 'updated_at')::text, '|' order by id) into v_users_after
    from public.users u where tenant_id = t1;
  if v_users_after is distinct from v_users_before then raise exception 'FAIL: login rows of 1111 changed'; end if;
  -- the bug reports, their screenshot rows and votes: every row byte-for-byte the same
  select string_agg(x, '|' order by x) into v_fb_after from (
    select to_jsonb(f)::text as x from public.feedback f where f.tenant_id = t1
    union all select to_jsonb(s)::text from public.feedback_screenshots s where s.tenant_id = t1
    union all select to_jsonb(v)::text from public.feedback_votes v where v.tenant_id = t1) q;
  if v_fb_after is distinct from v_fb_before then raise exception 'FAIL: bug reports of 1111 changed'; end if;
  if (v_res -> 'deleted') ?| array['feedback', 'feedback_screenshots', 'feedback_votes'] then
    raise exception 'FAIL: a feedback table is in the DELETE list';
  end if;
  -- 3. the tenants table (1111's company row with its settings, and every other company) is untouched
  select string_agg(t::text, '|' order by id) into v_tenants_after from public.tenants t;
  if v_tenants_after is distinct from v_tenants_before then raise exception 'FAIL: tenants rows changed'; end if;
  -- 4. E2E Test Co and every other company: every tenant table count the same
  v_others_after := pg_temp.r1775_counts(v_all, v_others);
  if v_others_after <> v_others_before then
    raise exception 'FAIL: another company changed: before % after %',
      pg_temp.r1775_fmt(v_others_before, true), pg_temp.r1775_fmt(v_others_after, true);
  end if;
  -- 5. no dangling foreign-key rows anywhere in public
  for con in select c.oid, c.conrelid, c.confrelid, c.conkey, c.confkey from pg_constraint c
              where c.contype = 'f' and c.connamespace = 'public'::regnamespace loop
    select format('select count(*) from %s k where %s and not exists (select 1 from %s p where %s)',
             con.conrelid::regclass,
             string_agg(format('k.%I is not null', ka.attname), ' and '),
             con.confrelid::regclass,
             string_agg(format('p.%I = k.%I', pa.attname, ka.attname), ' and '))
      into v_sql
      from unnest(con.conkey, con.confkey) as u(kk, fk)
      join pg_attribute ka on ka.attrelid = con.conrelid and ka.attnum = u.kk
      join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = u.fk;
    execute v_sql into v_n;
    if v_n <> 0 then raise exception 'FAIL: % dangling rows for FK %', v_n, con.oid; end if;
  end loop;
  -- 6. every trigger back in its exact mode, FORCE RLS flags unchanged
  select string_agg(tgrelid::text || ':' || tgname || ':' || tgenabled::text, ',' order by tgrelid, tgname) into v_trig_after
    from pg_trigger where not tgisinternal;
  if v_trig_after is distinct from v_trig_before then raise exception 'FAIL: trigger modes changed'; end if;
  select string_agg(oid::text || ':' || relforcerowsecurity::text, ',' order by oid) into v_rls_after
    from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p');
  if v_rls_after is distinct from v_rls_before then raise exception 'FAIL: FORCE RLS flags changed'; end if;

  raise notice 'PASS R-1775: wiped % rows of tenant 1111 from % tables in % passes; keep %; cascade %; other companies unchanged; no dangling FK rows',
    pg_temp.r1775_total(v_res -> 'deleted'), cardinality(v_targets), v_res ->> 'passes',
    pg_temp.r1775_fmt(v_keep_after, true), coalesce(nullif(pg_temp.r1775_fmt(v_cascade, true), ''), 'none');
end $t$;

rollback;
