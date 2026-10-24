-- deploy-peek: exists(select 1 from pg_trigger where tgname = 'trg_fixed_asset_expense_lock' and tgrelid = to_regclass('public.fixed_assets') and (tgtype & 4) = 4)
-- deploy-key: r1809assetlinklock
-- 20261023232214_r1809_asset_link_locked_expense.sql
--
-- R-1809 (R-1650's open decision) — linking an expense from a LOCKED month to a fixed asset
-- changed that closed month's P&L.
--
-- ══ WHAT WAS WRONG ═══════════════════════════════════════════════════════════════════════
--   report_pnl (20261018180232_r1578, CTE exps) leaves out an expense a fixed asset points at
--   (fixed_assets.expense_id) — its cost reaches the P&L as depreciation instead. R-1650
--   (20261023223717) stopped the link being REMOVED when the expense is in a locked month. The
--   other direction was still open: add an asset (put to use in an open month) and link an
--   expense dated inside the lock — the expense left the locked month's P&L, which was already
--   closed / filed.
--
-- ══ THE DECISION (coordinator, under Pardeep's "jo logical ho"; recorded on R-1650/R-1809) ═══
--   Block it, the same rule as R-1650's delete: a closed month must not change. The asset can
--   still be added — without the link — or the owner unlocks the month first.
--
-- ══ WHAT THIS DOES ═══════════════════════════════════════════════════════════════════════
--   tg_fixed_asset_expense_lock (R-1650) now also checks the NEW link: on INSERT with an
--   expense_id, and on UPDATE that sets expense_id to a different expense, the expense's date is
--   compared with tenants.books_locked_until and the row is refused when it is on/before the lock.
--   The R-1650 check (removing a link to a locked expense) is unchanged. The trigger now fires
--   BEFORE INSERT OR DELETE OR UPDATE OF expense_id. Same trust rule as tg_books_locked: only API
--   callers (anon / authenticated) are checked. SECURITY DEFINER, tenant-matched. No data is changed.

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
  v_tenant uuid;
begin
  -- R-1650 / R-1809
  if coalesce(auth.role(), '') not in ('anon', 'authenticated') then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'UPDATE' and new.expense_id is not distinct from old.expense_id then
    return new;
  end if;

  v_tenant := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;
  select t.books_locked_until into v_lock from public.tenants t where t.id = v_tenant;
  if v_lock is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  -- R-1650: the link to an expense in a locked month is removed (delete, or expense_id changed away).
  if tg_op in ('DELETE', 'UPDATE') and old.expense_id is not null then
    select e.expense_date into v_date
      from public.expenses e
     where e.id = old.expense_id and e.tenant_id = old.tenant_id;
    if v_date is not null and v_date <= v_lock then
      raise exception 'Books % tak lock hain — "%" ka kharcha % ka hai. Asset hatane se wo kharcha us band mahine ke P&L me wapas aa jaata, isliye mana hai. Asset bik gaya / kabaad ho gaya to "Sold / scrap" karein; galti se bana tha to owner Accounting → Month-end close par lock hata kar hataayein.',
        to_char(v_lock, 'DD Mon YYYY'), old.name, to_char(v_date, 'DD Mon YYYY')
        using errcode = 'check_violation';
    end if;
  end if;

  -- R-1809: a NEW link to an expense in a locked month (insert, or expense_id changed to it).
  if tg_op in ('INSERT', 'UPDATE') and new.expense_id is not null then
    v_date := null;
    select e.expense_date into v_date
      from public.expenses e
     where e.id = new.expense_id and e.tenant_id = new.tenant_id;
    if v_date is not null and v_date <= v_lock then
      raise exception 'That expense is in a locked month (%). Unlock the month first, or add the asset without linking the expense.',
        to_char(v_date, 'FMMonth YYYY')
        using errcode = 'check_violation',
              hint = 'Books are locked up to ' || to_char(v_lock, 'DD Mon YYYY') || ' — Accounting → Month-end close.';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; else return new; end if;
end $function$;

revoke all on function public.tg_fixed_asset_expense_lock() from public, anon, authenticated;

drop trigger if exists trg_fixed_asset_expense_lock on public.fixed_assets;
create trigger trg_fixed_asset_expense_lock
  before insert or delete or update of expense_id on public.fixed_assets
  for each row execute function public.tg_fixed_asset_expense_lock();

commit;
