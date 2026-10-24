-- deploy-peek: (exists(select 1 from pg_proc where oid = to_regprocedure('public.log_activity(text,text,text,text)') and prosrc like '%R-1010%') and exists(select 1 from pg_indexes where schemaname = 'public' and tablename = 'activity_log' and indexname = 'activity_log_login_once'))
-- deploy-key: r1010loginlog
-- 20261023173100_r1010_server_login_log.sql
--
-- R-1010 (data-leak audit, 11 Oct 2026; still open 19 Oct): sign-ins were recorded only by the
-- browser — the topbar called log_activity('login') once per tab session, with no IP and no
-- device. Whatever the browser writes it can also skip or forge.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════
--   1. log_activity(p_action, …): a 'login' action (any case / spaces) is IGNORED — the browser
--      can no longer write a sign-in row. Every other action is unchanged (lib/ai/audit.ts
--      uses it). Body otherwise identical to 20261018225100_r1615_definer_tenant_gate (R-1615:
--      no current_tenant_id() → nothing written). Fire-and-forget contract kept: an old
--      browser tab that still calls it gets no error.
--   2. The app server writes the sign-in instead (src/server/auth/login-log.ts, service_role):
--      action 'login', entity 'session', label "Chrome on Windows · IP 203.0.113.7 · password",
--      changes {ip, device, method, signed_in_at}. No email, no user-agent string, no token.
--   3. activity_log_login_once: unique (user_id, changes->>'signed_in_at') for login rows that
--      carry signed_in_at — one row per sign-in even if the browser asks the server twice.
--      Older login rows have no signed_in_at and are outside the index.
--
-- Readers unchanged: activity_log_sel_owner_manager (R-1002) — owner and manager see the rows on
-- /activity. No insert/update/delete policy for request roles exists or is added.
-- Staging: the deploy script rewrites auth.uid() → public.current_user_id() (R-161).
-- Re-runnable: create or replace / create unique index if not exists. Catalog-only peek.
-- Test: supabase/tests/r1010_server_login_log.test.sql (rolled back).

begin;

create or replace function public.log_activity(
  p_action text, p_entity text default 'session'::text,
  p_entity_id text default null::text, p_label text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-1615: a deactivated user / half-signed-in MFA session logs nothing. */
  v_tenant uuid := public.current_tenant_id();
begin
  /* R-1010: sign-ins are recorded by the app server only (src/server/auth/login-log.ts). */
  if lower(btrim(coalesce(p_action, ''))) = 'login' then return; end if;
  if v_tenant is null then return; end if;
  insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label)
  values (v_tenant, auth.uid(), p_action, coalesce(p_entity, 'session'), p_entity_id, left(p_label, 120));
end $function$;

do $$
declare
  v_dupes int;
begin
  select count(*) into v_dupes
    from (select 1 from public.activity_log
           where action = 'login' and changes ? 'signed_in_at'
           group by user_id, changes ->> 'signed_in_at'
          having count(*) > 1) x;
  if v_dupes > 0 then
    raise exception 'R-1010: % sign-in(s) are recorded more than once in activity_log. Look at them (action = login, same user_id and changes->>signed_in_at), keep one row each, then run this migration again.', v_dupes;
  end if;
end $$;

create unique index if not exists activity_log_login_once
  on public.activity_log (user_id, (changes ->> 'signed_in_at'))
  where action = 'login' and changes ? 'signed_in_at';

commit;
