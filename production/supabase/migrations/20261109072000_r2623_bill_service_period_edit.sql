-- deploy-peek: to_regprocedure('public.vendor_bills_service_periods(text[])') is not null
-- deploy-key: r2623billserviceperiodedit
--
-- R-2623 (9 Nov 2026, slice 3 of R-2156): the owner sees and sets a vendor bill's SERVICE PERIOD
-- (the month(s) the licence was used) on the bill. R-2156 added vendor_bills.service_from /
-- service_to and vendor_bill_service_period(); when its guess is wrong (a Google bill 2 months in
-- arrears with no month in the reference) the owner pins it.
--
-- ══ WHAT CHANGES ═════════════════════════════════════════════════════════════════════════
--   1. public.vendor_bills_service_periods(p_ids text[]) → (id, service_from, service_to, basis):
--      the period of each of the caller's bills, worked out by the ONE rule
--      (vendor_bill_service_period) — the bills list and the bill view read it, so the screen
--      never guesses the period itself. SECURITY INVOKER (RLS) + an explicit tenant filter; a
--      login with no company gets no rows.
--   2. Books lock: trg_books_lock on vendor_bills was tg_books_locked('bill_date') — every change
--      to a bill in a locked (filed) month refused. The service period is management-only (GST,
--      GSTR, report_pnl read bill_date and the amounts), so a locked-month bill may now change
--      ONLY service_from / service_to (+ updated_at). Any other column, alone or together with
--      them, is refused exactly as before (the same tg_books_locked "free columns" rule R-1584 uses for later events).
--
-- Rollback:
--   drop function public.vendor_bills_service_periods(text[]);
--   drop trigger trg_books_lock on public.vendor_bills;
--   create trigger trg_books_lock before insert or update or delete on public.vendor_bills
--     for each row execute function public.tg_books_locked('bill_date');

create or replace function public.vendor_bills_service_periods(p_ids text[])
returns table(id text, service_from date, service_to date, basis text)
language sql
stable
set search_path to 'public'
as $function$
  /* R-2623 */
  select vb.id, sp.service_from, sp.service_to, sp.basis
    from public.vendor_bills vb
    cross join lateral public.vendor_bill_service_period(vb.bill_date, vb.category, vb.bill_no, vb.notes,
                                                          vb.service_from, vb.service_to) sp
   where vb.tenant_id = public.current_tenant_id()
     and vb.id = any (coalesce(p_ids, array[]::text[]));
$function$;

revoke all on function public.vendor_bills_service_periods(text[]) from public, anon;
grant execute on function public.vendor_bills_service_periods(text[]) to authenticated, service_role;

comment on function public.vendor_bills_service_periods(text[]) is
  'R-2623: each of the caller''s vendor bills with its service period (from, to) and basis (set / reference / vendor_default / bill_month) — the bills list and bill view read it. Management P&L only.';

drop trigger if exists trg_books_lock on public.vendor_bills;
create trigger trg_books_lock
  before insert or update or delete on public.vendor_bills
  for each row execute function public.tg_books_locked('bill_date', '', 'service_from,service_to');
