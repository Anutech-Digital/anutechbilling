-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.set_books_lock(date)') and prosrc like '%R-1132%')
-- deploy-key: r1132close
-- 20261017002400_r1132_books_lock_accountant.sql
--
-- R-1132 (Pardeep, 16 Oct 2026: "Books lock accountant bhi kar sake" → haan).
--
-- The accountant works down Accounting → Month-end close, but the last step — lock the books
-- up to the month end — was owner-only: tenants.books_locked_until is written through the
-- tenants_self_update RLS policy, which admits the owner alone. The button was hidden and the
-- accountant had to chase the owner.
--
-- set_books_lock(p_until) is now the one way the app writes the lock:
--   owner       any date up to today (IST), or NULL to open the books — unchanged powers
--   accountant  may LOCK: a date up to today, never earlier than the current lock and never
--               NULL. Opening a filed month again stays with the owner (R-1132 decision was
--               about locking).
--   anyone else (manager, sales, billing, support…) refused — 42501
--   no company  (NULL current_tenant_id(): customer login, deactivated, MFA not passed)
--               refused — 28000, fails closed (CLAUDE.md §17c). There is no tenant argument:
--               the function only ever acts on the caller's own company.
-- tenants_self_update is not touched: the owner's direct update still works for old clients.
-- SECURITY DEFINER so the accountant's update passes RLS; the R-720 column guard lets the
-- function owner through and books_locked_until is not one of its guarded columns.
-- Test: supabase/tests/r1132_books_lock_accountant.test.sql (rolled back).

begin;

create or replace function public.set_books_lock(p_until date)
returns date
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  /* R-1132 */
  v_tenant  uuid := public.current_tenant_id();
  v_current date;
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if v_tenant is null then
    raise exception 'Sign in to your company to change the books lock.'
      using errcode = '28000';
  end if;

  if not public.current_user_has_role('owner', 'accountant') then
    raise exception 'Only the owner or the accountant can lock the books.'
      using errcode = '42501';
  end if;

  if p_until is not null and p_until > v_today then
    raise exception 'The books can be locked only up to today.'
      using errcode = '22023';
  end if;

  select t.books_locked_until into v_current
    from public.tenants t where t.id = v_tenant
    for update;

  if not public.current_user_has_role('owner')
     and (p_until is null or (v_current is not null and p_until < v_current)) then
    raise exception 'Only the owner can open locked books (remove the lock or move it back).'
      using errcode = '42501';
  end if;

  update public.tenants set books_locked_until = p_until where id = v_tenant;
  return p_until;
end;
$function$;

comment on function public.set_books_lock(date) is
  'R-1132: set the books lock for the caller''s own company. Owner: any date up to today or NULL. Accountant: lock or move forward only. Others refused.';

revoke all on function public.set_books_lock(date) from public, anon;
grant execute on function public.set_books_lock(date) to authenticated, service_role;

commit;
