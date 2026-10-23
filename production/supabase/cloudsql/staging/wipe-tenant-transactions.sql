-- R-1775 (23 Oct 2026) STAGING ONLY: wipe ALL data of ONE company (Anutech Digital) and keep only its
-- logins, company settings and secrets/integration keys. Every other company and E2E Test Co: untouched.
-- Run ONLY through wipe-tenant-transactions.sh (it fills the __PLACEHOLDERS__ and takes the backup).
--
-- Output goes out through RAISE (gcloud sql import has no other channel), same as deploy-db PEEK:
--   WIPEDRY   rehearsal: the whole delete ran inside this statement, every count was checked,
--             then the RAISE rolled it back. Nothing changed.
--   WIPEAFTER read-only counts after an apply.
--   WIPESTOP  refused / something did not add up. Nothing changed.
-- Messages stay ASCII, one line, no double quotes or backslashes (the shell greps them out of JSON).

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
    'tenant_secrets', 'ad_accounts', 'gbp_locations', 'indiamart_sync_state'
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
  v_trig_before text; v_trig_after text;
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

  return jsonb_build_object('deleted', v_del_before, 'keep', v_keep_after, 'cascade', v_cascade, 'passes', v_pass);
end $f$;
-- <<< R-1775 CORE (end)

DO $do$
DECLARE
  v_mode text := '__MODE__';
  v_a uuid := pg_temp.r1775_find('__ANUTECH_MATCH__');
  v_ids uuid[];
  v_given uuid[];
  v_res jsonb;
  v_left jsonb;
BEGIN
  PERFORM set_config('lock_timeout', '20s', true);
  v_ids := array[v_a];

  IF v_mode = 'after' THEN
    v_left := pg_temp.r1775_counts(pg_temp.r1775_targets(), v_ids);
    RAISE EXCEPTION 'WIPEAFTER company: % || LEFT{total=% %} || KEEP{%}',
      pg_temp.r1775_describe(v_ids), pg_temp.r1775_total(v_left), pg_temp.r1775_fmt(v_left, true),
      pg_temp.r1775_fmt(pg_temp.r1775_counts(pg_temp.r1775_keep_present(), v_ids), false);
  ELSIF v_mode = 'apply' THEN
    v_given := string_to_array('__TENANTS__', ',')::uuid[];
    IF cardinality(v_given) <> 1 OR v_given[1] <> v_a THEN
      RAISE EXCEPTION 'WIPESTOP TENANTS is not the company found now (%) - nothing changed', pg_temp.r1775_describe(v_ids);
    END IF;
  ELSIF v_mode <> 'dry' THEN
    RAISE EXCEPTION 'WIPESTOP unknown mode % - nothing changed', v_mode;
  END IF;

  v_res := pg_temp.r1775_wipe(v_ids);

  IF v_mode = 'dry' THEN
    RAISE EXCEPTION 'WIPEDRY company: % || DELETE{total=% %} || tables with 0 rows: % || KEEP{%} || keep rows that go with a deleted parent (FK cascade): % || rehearsal ok in % passes: deleted, every count checked, then rolled back - NOTHING changed',
      pg_temp.r1775_describe(v_ids),
      pg_temp.r1775_total(v_res -> 'deleted'), pg_temp.r1775_fmt(v_res -> 'deleted', true),
      (select count(*) from jsonb_each_text(v_res -> 'deleted') where value = '0'),
      pg_temp.r1775_fmt(v_res -> 'keep', false),
      coalesce(nullif(pg_temp.r1775_fmt(v_res -> 'cascade', true), ''), 'none'),
      v_res ->> 'passes';
  END IF;
  -- apply: reaching here means every check passed; the statement ends and the import commits it.
END $do$;
