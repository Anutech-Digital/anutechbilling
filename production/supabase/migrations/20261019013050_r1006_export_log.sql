-- deploy-peek: to_regclass('public.export_log') is not null and to_regprocedure('public.log_export(text,integer,text)') is not null and not exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'invoices' and policyname = 'invoices_select_own_customer')
-- deploy-key: r1006exportlog
-- 20261019013050_r1006_export_log.sql
--
-- R-1006 (P2 security, data-leak audit item f) + R-728 (invoices half).
-- Tests: supabase/tests/r1006_export_log.test.sql, supabase/tests/r728_invoices_customer_policy.test.sql
--
-- ══ R-1006 — WHO EXPORTED WHAT ═══════════════════════════════════════════════════════════
--   Nothing recorded who downloaded a customer list, the salary register or the day book. A
--   departing employee could take the whole book of business as CSV and leave no trace.
--   export_log keeps one row per export button press: company, user, what (report/table key),
--   how many rows, format, when.
--
--   * READ: owner only, of their own company — current_tenant_id() (is_active + MFA, R-722 /
--     R-731) AND current_user_has_role('owner'), the R-1618 shape.
--   * WRITE: nobody writes the table directly (no insert/update/delete grant, no write
--     policy). The app calls log_export(), SECURITY DEFINER, which takes the company from
--     current_tenant_id() — never from an argument — so nobody can write a row for another
--     company, or forge one for another user (user_id is auth.uid()).
--   * The browser treats a failed log as a warning: the export itself always goes through
--     (src/lib/export-log).
--
-- ══ R-728 — invoices_select_own_customer ═════════════════════════════════════════════════
--   baseline.sql:12195 let a customer-portal login (customer_users → current_customer_id())
--   SELECT its invoices — whole rows, and since R-487 invoices.line_items[].cost holds OUR
--   purchase cost, so a portal user would see our margin. The portal does not exist today
--   (src has no customer_users / current_customer_id() reader; R-844 rebuilds it and will read
--   through a definer that leaves cost out — R-845 portal_my_invoices). Drop the policy.
--   The other *_own_customer policies are not in this card.
--
-- Rollback: drop function public.log_export(text, integer, text); drop table public.export_log;
--   (do NOT re-create invoices_select_own_customer — it re-opens the cost leak).

begin;

-- ── R-1006: table ───────────────────────────────────────────────────────────────────────
create table if not exists public.export_log (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  user_id    uuid        references public.users(id) on delete set null,
  what       text        not null check (char_length(what) between 1 and 200),
  row_count  integer     not null check (row_count >= 0),
  format     text        not null check (format in ('csv', 'xlsx', 'pdf', 'json', 'xml', 'txt')),
  at         timestamptz not null default now()
);

comment on table public.export_log is
  'R-1006: one row per export/download button press. Owner-only read; written only by log_export().';

create index if not exists export_log_tenant_at_idx on public.export_log (tenant_id, at desc);

alter table public.export_log enable row level security;

revoke all on table public.export_log from public;
revoke all on table public.export_log from anon;
revoke all on table public.export_log from authenticated;
grant select on table public.export_log to authenticated;
grant all on table public.export_log to service_role;

drop policy if exists export_log_owner_select on public.export_log;
create policy export_log_owner_select on public.export_log as permissive for select to authenticated
  using ((tenant_id = ( select public.current_tenant_id() )) and public.current_user_has_role('owner'));

-- Cloud SQL has no BYPASSRLS: the server (service_role) client needs its own policy (R-450).
drop policy if exists zzz_service_role_all on public.export_log;
create policy zzz_service_role_all on public.export_log
  as permissive for all to service_role using (true) with check (true);

-- ── R-1006: the only writer ─────────────────────────────────────────────────────────────
create or replace function public.log_export(p_what text, p_row_count integer, p_format text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_tenant uuid := public.current_tenant_id();
  v_what   text := left(btrim(coalesce(p_what, '')), 200);
  v_format text := lower(btrim(coalesce(p_format, '')));
begin
  -- Company from the session only (CLAUDE.md 17c): NULL for anon, inactive and aal1-MFA callers.
  if v_tenant is null then
    raise exception 'log_export: no active company session' using errcode = '42501';
  end if;
  if v_what = '' then
    raise exception 'log_export: what is required' using errcode = '22023';
  end if;
  insert into public.export_log (tenant_id, user_id, what, row_count, format)
  values (v_tenant, auth.uid(), v_what, greatest(coalesce(p_row_count, 0), 0), v_format);
end;
$function$;

comment on function public.log_export(text, integer, text) is
  'R-1006: record one export for the caller''s company (tenant from current_tenant_id()).';

revoke all on function public.log_export(text, integer, text) from public;
grant execute on function public.log_export(text, integer, text) to authenticated, service_role;

-- ── R-728: customer-portal read of whole invoice rows (cost included) ───────────────────
drop policy if exists invoices_select_own_customer on public.invoices;

commit;
