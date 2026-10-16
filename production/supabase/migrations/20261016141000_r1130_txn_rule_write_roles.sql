-- deploy-peek: (exists(select 1 from pg_policy where polname = 'txn_category_rules_delete_money_roles' and polrelid = to_regclass('public.txn_category_rules')) and not exists(select 1 from pg_policy where polname = 'txn_category_rules_tenant_delete' and polrelid = to_regclass('public.txn_category_rules')))
-- deploy-key: r1130txnrules
-- 20261016141000_r1130_txn_rule_write_roles.sql
--
-- R-1130 (weekly UX audit, 12 Oct 2026): Banking → Category Rules.
--
-- WHAT WAS OPEN: txn_category_rules (20260822090000_txn_categorisation.sql, restored on
-- staging by cloudsql/05-restore-app-rls-policies.sql:763-770) had insert / update / delete
-- policies that asked only "which company?". R-719 gave bank_aa_connections the money roles
-- but skipped this table, so billing — read-only on Banking since R-254 — could add, re-file
-- or delete the rules that categorise every imported bank line, from the page or one REST call.
--
-- WHO WRITES IT: the browser client only — Banking → Category Rules (page now behind
-- canWriteMoney) and the import-statement dialog's "remember this text" (the Import button
-- sits behind canWrite on the account page). No SECURITY DEFINER function or server client
-- writes it.
--
-- WHAT CHANGES: insert / update / delete need the tenant AND owner / manager / accountant
-- (MONEY_WRITE_ROLES in src/lib/nav.ts — the same roles as bank_accounts / bank_transactions /
-- bank_aa_connections). Reads unchanged: billing still sees the rules.
-- A billing user's direct insert now fails with 42501 (new row violates row-level security);
-- update / delete simply touch no rows.
--
-- Re-runnable: drop policy if exists before every create. No new function, so no grants.
-- Staging: the deploy script rewrites auth.role() -> public.current_request_role() (R-161);
-- nothing here calls auth.role().

begin;

drop policy if exists txn_category_rules_tenant_write  on public.txn_category_rules;
drop policy if exists txn_category_rules_tenant_update on public.txn_category_rules;
drop policy if exists txn_category_rules_tenant_delete on public.txn_category_rules;
drop policy if exists txn_category_rules_insert_money_roles on public.txn_category_rules;
drop policy if exists txn_category_rules_update_money_roles on public.txn_category_rules;
drop policy if exists txn_category_rules_delete_money_roles on public.txn_category_rules;

create policy txn_category_rules_insert_money_roles on public.txn_category_rules for insert to authenticated
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy txn_category_rules_update_money_roles on public.txn_category_rules for update to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'))
  with check (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));
create policy txn_category_rules_delete_money_roles on public.txn_category_rules for delete to authenticated
  using      (tenant_id = public.current_tenant_id()
              and public.current_user_has_role('owner', 'manager', 'accountant'));

commit;
