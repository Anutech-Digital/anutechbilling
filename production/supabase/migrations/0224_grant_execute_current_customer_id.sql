-- 0224_grant_execute_current_customer_id.sql
-- SECURITY FIX: Grant EXECUTE on current_customer_id() and current_tenant_id()
-- to authenticated, anon, and public so RLS policies on customers/quotes/invoices/subscriptions
-- do not throw "permission denied for function current_customer_id".

grant execute on function public.current_customer_id() to authenticated, anon, public;
grant execute on function public.current_tenant_id() to authenticated, anon, public;
