-- deploy-key: r713views
-- deploy-peek: (select count(*) from pg_class c where c.oid in (to_regclass('public.v_tenant_with_parent'), to_regclass('public.purchase_order_summary')) and ('security_invoker=on' = any(c.reloptions) or 'security_invoker=true' = any(c.reloptions)) and not has_table_privilege('anon', c.oid, 'SELECT') and not has_table_privilege('authenticated', c.oid, 'INSERT') and not has_table_privilege('authenticated', c.oid, 'UPDATE') and not has_table_privilege('authenticated', c.oid, 'DELETE')) = 2
-- 20261011060000_r713_views_tenant_scope.sql
--
-- R-713 (11 Oct 2026, security P0). Two public views leaked every tenant's data to anyone
-- holding the public anon key.
--
-- ══ WHAT WAS OPEN ═══════════════════════════════════════════════════════════════
--   v_tenant_with_parent    (baseline.sql:8748)   id, name, tier, parent name/tier/GSTIN
--   purchase_order_summary  (baseline.sql:10292)  customer, plan, seats, unit cost, totals
--   Both owned by postgres WITHOUT security_invoker, so a query through them ran with the
--   owner's rights and the RLS of tenants / purchase_orders / po_bill_allocations never applied.
--   No tenant filter in either. anon + authenticated held GRANT ALL (baseline.sql:14289, :14427).
--   20260927280000 only dropped anon from the DEFAULT privileges for new objects — these old
--   grants stayed.
--
-- ══ WHAT THIS DOES ══════════════════════════════════════════════════════════════
--   • security_invoker = on: the caller's own RLS applies through the view —
--       tenants             tenants_self_read (id = current_tenant_id()) + customer-portal policy
--       purchase_orders     purchase_orders_select (tenant_id = current_tenant_id())
--       po_bill_allocations po_alloc_select (tenant_id = current_tenant_id())
--     so a signed-in user sees only their own tenant's rows. service_role keeps its own
--     policies on those tables (purchase_orders_service_role, po_alloc_service_role, BYPASSRLS
--     locally), so server reads are unchanged.
--   • anon and PUBLIC lose every privilege on both views.
--   • authenticated keeps SELECT only (no insert/update/delete/truncate/trigger/references).
--
-- ══ APP READS (checked) ═════════════════════════════════════════════════════════
--   purchase_order_summary  src/lib/queries/purchase-orders.ts usePurchaseOrderSummaries
--                           (Procurement variance card) and accounting/profitability/page.tsx —
--                           both the signed-in browser client, both want own-tenant rows only.
--   v_tenant_with_parent    not read by the app (Settings → Reseller tier uses the SECURITY
--                           DEFINER RPC get_my_tenant_with_parent()). Through the view a tenant
--                           now sees its own row; parent_* columns are null unless the tenants
--                           RLS lets it read the parent row (it does not today) — the RPC is the
--                           way to get them.
--   supabase/cloudsql/09-grant-what-policies-allow.sql only grants on relkind 'r' (tables), so
--   it never re-grants on these views.
--
-- Idempotent.

begin;

alter view public.v_tenant_with_parent   set (security_invoker = on);
alter view public.purchase_order_summary set (security_invoker = on);

revoke all on public.v_tenant_with_parent   from anon, public;
revoke all on public.purchase_order_summary from anon, public;

revoke all on public.v_tenant_with_parent   from authenticated;
revoke all on public.purchase_order_summary from authenticated;
grant select on public.v_tenant_with_parent   to authenticated;
grant select on public.purchase_order_summary to authenticated;

grant select on public.v_tenant_with_parent   to service_role;
grant select on public.purchase_order_summary to service_role;

commit;
