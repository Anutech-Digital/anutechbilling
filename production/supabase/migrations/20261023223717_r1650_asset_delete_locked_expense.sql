-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_fixed_asset_expense_lock' and tgrelid = to_regclass('public.fixed_assets'))
-- deploy-key: r1650assetexpenselock
-- 20261023223717_r1650_asset_delete_locked_expense.sql
--
-- R-1650 (weekly UX audit 19 Oct) — deleting a fixed asset brought its expense back into a
-- CLOSED month's P&L.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════════════
--   report_pnl (20261018180232_r1578, CTE exps) leaves out an expense a fixed asset points at
--   (fixed_assets.expense_id) — its cost reaches the P&L as depreciation. Remove the asset and
--   the expense is a cost again in its own month, and the depreciation is gone. The books lock
--   on fixed_assets (trg_books_lock → tg_books_locked('put_to_use', 'disposed_on', …)) only
--   looks at put_to_use, so an asset put to use AFTER the lock but bought with an expense dated
--   INSIDE the lock could be deleted — and the locked month's P&L (already filed) changed.
--
-- ══ THE RULE (recorded on card R-1650) ═══════════════════════════════════════════════════
--   Deleting an asset = undoing a capitalisation entered by mistake: the expense is a revenue
--   cost of its own month again, and the depreciation charged on the asset is reversed with it
--   (never both, never neither). That is a correction, so it is allowed only while the periods
--   it rewrites are open: the asset's put-to-use date (existing trigger) AND the linked
--   expense's date (this trigger). An asset that left the business is "Sold / scrap"
--   (disposed_on) — that keeps the depreciation already charged.
--
-- ══ WHAT THIS DOES ═══════════════════════════════════════════════════════════════════════
--   One BEFORE DELETE OR UPDATE OF expense_id trigger on fixed_assets: when the row's link to an
--   expense dated on/before tenants.books_locked_until is removed (delete, or expense_id changed
--   away from it), refuse with the same message shape as tg_books_locked. Same trust rule as
--   tg_books_locked: only API callers (anon / authenticated) are checked. SECURITY DEFINER so the
--   expense's date is read even where the caller's RLS hides that expense; tenant-matched.
--   No data is changed.

begin;

create or replace function public.tg_fixed_asset_expense_lock()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_lock date;
  v_date date;
begin
  -- R-1650
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if old.expense_id is null
     or (tg_op = 'UPDATE' and new.expense_id is not distinct from old.expense_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select t.books_locked_until into v_lock from public.tenants t where t.id = old.tenant_id;
  if v_lock is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  select e.expense_date into v_date
    from public.expenses e
   where e.id = old.expense_id and e.tenant_id = old.tenant_id;

  if v_date is not null and v_date <= v_lock then
    raise exception 'Books % tak lock hain — "%" ka kharcha % ka hai. Asset hatane se wo kharcha us band mahine ke P&L me wapas aa jaata, isliye mana hai. Asset bik gaya / kabaad ho gaya to "Sold / scrap" karein; galti se bana tha to owner Accounting → Month-end close par lock hata kar hataayein.',
      to_char(v_lock, 'DD Mon YYYY'), old.name, to_char(v_date, 'DD Mon YYYY')
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $function$;

revoke all on function public.tg_fixed_asset_expense_lock() from public, anon, authenticated;

drop trigger if exists trg_fixed_asset_expense_lock on public.fixed_assets;
create trigger trg_fixed_asset_expense_lock
  before delete or update of expense_id on public.fixed_assets
  for each row execute function public.tg_fixed_asset_expense_lock();

commit;
