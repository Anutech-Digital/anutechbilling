-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.r1004_backfill_account_managers()') and prosrc like '%R-1004 backfill%')
-- deploy-key: r1004ambackfill
-- 20261019002055_r1004_account_manager_backfill.sql
--
-- R-1004 follow-up — Pardeep's decision HAAN (16 Oct 2026): "ek baar purane customers ka
-- account manager unke lead/quote banane wale se bhar dein (backfill)".
--
-- Why: since 20261012023458_r1004_customer_reads.sql a sales / sales_senior user reads a
-- customer in full only when they (or someone below them) are its account manager. The app
-- never set account_manager_id before that, so every OLD customer is unclaimed and Sales sees
-- all of them by name only until someone presses "Claim customer".
--
-- The rule, for each customer with NO account manager:
--   candidates = its leads (the person who CREATED the lead first, then the lead's owner) and
--                its quotes (the quote's owner — quotes record no separate maker);
--   a candidate counts only when it is an ACTIVE sales or sales_senior user of the SAME
--   company (owner / manager / accountant / billing read every customer anyway; an inactive
--   or foreign user would hand the customer to nobody who can use it);
--   the OLDEST lead / quote with a counting candidate wins (ties: lead before quote, then id).
-- A customer that already has an account manager is never touched. No candidate → stays
-- unclaimed (Sales sees it by name and can claim it, as today).
--
-- Who sees what afterwards — UNCHANGED rules, only the data moves:
--   owner / accountant / billing: every customer, as before.
--   manager: unclaimed customers + those managed by their own team (the existing restrictive
--            customers_hierarchy_select, R-1401). A sales person with NO manager_id is outside
--            every manager's tree, so a manager stops seeing that person's backfilled
--            customers — same as after a "Claim customer" today. Set users.manager_id.
--   sales / sales_senior: their (team's) customers in full; the rest by name only.
--   support / delivery / partner_agent: unchanged (ticket / project links, R-1004).
--
-- The function stays so the same step can be re-run from service_role; it only ever fills
-- NULLs, so a second run changes nothing. authenticated cannot execute it.
-- Runs as the migration owner: role_column_write_guard and the RLS policies do not apply.

begin;

create or replace function public.r1004_backfill_account_managers()
returns integer
language plpgsql
volatile
set search_path to ''
as $$
declare
  v_n int;
begin
  /* R-1004 backfill: fill customers.account_manager_id (NULL only) from the sales person who
     made the customer's oldest lead / quote. Returns the number of customers filled. */
  with cand as (
    select l.customer_id, l.tenant_id, v.uid, l.created_at as at, 0 as src, v.pref, l.id as rid
      from public.leads l
      cross join lateral (values (l.created_by, 0), (l.owner_id, 1)) v(uid, pref)
     where l.customer_id is not null and v.uid is not null
    union all
    select q.customer_id, q.tenant_id, q.owner_id, q.created_at, 1, 0, q.id
      from public.quotes q
     where q.customer_id is not null and q.owner_id is not null
  ),
  pick as (
    select distinct on (c.id) c.id as customer_id, cand.uid
      from public.customers c
      join cand on cand.customer_id = c.id and cand.tenant_id = c.tenant_id
      join public.users u on u.id = cand.uid
                         and u.tenant_id = c.tenant_id
                         and u.is_active
                         and u.role::text in ('sales', 'sales_senior')
     where c.account_manager_id is null
     order by c.id, cand.at nulls last, cand.src, cand.rid, cand.pref
  )
  update public.customers c
     set account_manager_id = p.uid
    from pick p
   where c.id = p.customer_id
     and c.account_manager_id is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

comment on function public.r1004_backfill_account_managers() is
  'R-1004 backfill (Pardeep, 16 Oct 2026): fills NULL customers.account_manager_id from the active sales/sales_senior user who made the customer''s oldest lead (creator, then owner) or quote (owner), same company only. Only fills NULLs; service_role / migration owner only.';

revoke all on function public.r1004_backfill_account_managers() from public, anon, authenticated;
grant execute on function public.r1004_backfill_account_managers() to service_role;

select public.r1004_backfill_account_managers();

commit;
