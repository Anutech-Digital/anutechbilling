-- deploy-peek: to_regprocedure('public.customer_payer_lines(uuid)') is not null
-- deploy-key: r2711customerpayerlines
-- 20261112152104_r2711_customer_payer_lines.sql
--
-- R-2711 (12 Nov 2026): the customer page's "Known payers" card (R-2025) read its "Seen on which
-- lines" list with `.eq("payer->>customer_id", id)` on bank_transactions. The data gateway
-- (src/server/postgrest) accepts plain column names only, so on staging every customer page got
-- 400 PGRST100 and the card never loaded. The gateway parser is NOT widened for JSON paths
-- (security decision on the card); the read moves into this function instead.
--
-- SECURITY INVOKER on purpose: the caller's own RLS on bank_transactions decides what it sees
-- (tenant isolation read + the personal-session wall), exactly as the old direct read did — no new
-- privileged surface. The explicit tenant filter repeats that RLS read rule (same rows) and lets
-- the existing (tenant_id, txn_date) index serve the read.
-- Read-only; no money is written or computed. Test: supabase/tests/r2711_customer_payer_lines.test.sql

create or replace function public.customer_payer_lines(p_customer_id uuid)
returns table (id uuid, bank_account_id uuid, txn_date date, credit integer, payer_key text)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- R-2711: lines answered for this customer on the Reconcile sheet and reconciled.
  select t.id, t.bank_account_id, t.txn_date, t.credit, t.payer ->> 'key'
  from public.bank_transactions t
  where t.tenant_id = public.current_tenant_id()
    and t.payer ->> 'customer_id' = p_customer_id::text
    and t.matched_to_type is not null
  order by t.txn_date desc, t.id
$$;

comment on function public.customer_payer_lines(uuid) is
  'R-2711: the reconciled bank lines whose payer answer (bank_transactions.payer, R-2025) names this customer — the customer page''s Known payers card. SECURITY INVOKER: RLS on bank_transactions applies.';

revoke all on function public.customer_payer_lines(uuid) from public, anon;
grant execute on function public.customer_payer_lines(uuid) to authenticated, service_role;
-- No new index: bank_txn_date_idx (tenant_id, txn_date desc) already narrows to the tenant, and a
-- plain CREATE INDEX would block bank_transactions writes during the DB step for no real gain.
