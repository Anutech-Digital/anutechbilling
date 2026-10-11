-- deploy-key: r716vault
-- deploy-peek: (exists(select 1 from pg_policy where polname = 'vault_passwords_select_om' and polrelid = to_regclass('public.vault_passwords')) and not exists(select 1 from pg_policy where polname = 'vault_passwords_select' and polrelid = to_regclass('public.vault_passwords')))
-- 20261011031600_r716_vault_owner_manager.sql
--
-- R-716 (vault security, 11 Oct 2026).
--
-- ══ WHAT WAS OPEN, measured on the local DB ══════════════════════════════════
--
--   vault_passwords   vault_passwords_select / _insert / _update / _delete — tenant only, no
--                     role. The /vault menu is owner/manager only (nav.ts OM), but any member
--                     (a sales rep, a support login) could list the customers' admin-console
--                     credentials, add or rename one, or delete it straight through
--                     PostgREST — and POST /api/vault/[id]/reveal decrypted the row for them.
--   anon              baseline GRANT ALL on the table (no anon policy, so 0 rows — but no
--                     reason to hold the grant at all).
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════
--
--   Every vault_passwords policy now also requires current_user_has_role('owner','manager')
--   (an active user of that role — a deactivated manager is out). Same roles as
--   can_reveal_vault in src/lib/auth/roles.ts and the /vault nav entry. The API routes check
--   the same thing first (R-716) so the user gets a clear 403, not an empty list.
--
--   vault_access_log is NOT changed: the reveal / create audit insert keeps working exactly
--   as before (and only owner / manager can now reach a row to log against).
--
--   Behaviour change: staff other than owner / manager (sales, sales_senior, billing,
--   delivery, accountant, support, partner_agent) no longer see or use the vault at all.

begin;

revoke all on table public.vault_passwords from anon;

drop policy if exists vault_passwords_select on public.vault_passwords;
drop policy if exists vault_passwords_insert on public.vault_passwords;
drop policy if exists vault_passwords_update on public.vault_passwords;
drop policy if exists vault_passwords_delete on public.vault_passwords;
drop policy if exists vault_passwords_select_om on public.vault_passwords;
drop policy if exists vault_passwords_insert_om on public.vault_passwords;
drop policy if exists vault_passwords_update_om on public.vault_passwords;
drop policy if exists vault_passwords_delete_om on public.vault_passwords;

create policy vault_passwords_select_om on public.vault_passwords for select to authenticated
  using      (tenant_id = (select public.current_tenant_id())
              and public.current_user_has_role('owner', 'manager'));
create policy vault_passwords_insert_om on public.vault_passwords for insert to authenticated
  with check (tenant_id = (select public.current_tenant_id())
              and public.current_user_has_role('owner', 'manager'));
create policy vault_passwords_update_om on public.vault_passwords for update to authenticated
  using      (tenant_id = (select public.current_tenant_id())
              and public.current_user_has_role('owner', 'manager'))
  with check (tenant_id = (select public.current_tenant_id())
              and public.current_user_has_role('owner', 'manager'));
create policy vault_passwords_delete_om on public.vault_passwords for delete to authenticated
  using      (tenant_id = (select public.current_tenant_id())
              and public.current_user_has_role('owner', 'manager'));

commit;
