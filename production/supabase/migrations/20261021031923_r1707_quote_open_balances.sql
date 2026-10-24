-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.quote_open_balances()') and prosrc like '%R-1707%')
-- deploy-key: r1707quoteopenbalances
-- 20261021031923_r1707_quote_open_balances.sql
--
-- R-1707 (P1 money, 21 Oct 2026) — the quotes list shows money due that is not due.
--
-- ─── WHAT WAS WRONG ─────────────────────────────────────────────────────────
--   Billing audit (localhost): #0020 (T-L5) showed "₹38,232 due" and sat in "Awaiting payment",
--   though its invoice was refunded and credit-noted (invoice net ₹0, status paid).
--   lib/quotes/list-tab.ts and status-badge.ts computed amount − quotes.payment_amount, which
--   knows nothing of credit notes, refunds or what the invoice itself says is still payable.
--   quote_open_balance(quote) (R-1686, 20261019162652) already answers it — one quote at a time.
--
-- ─── WHAT THIS DOES ─────────────────────────────────────────────────────────
--   quote_open_balances() — the caller's company's quotes with quote_open_balance(id) each, in ONE
--   call, so the list page makes one round trip instead of one per row. It calls
--   quote_open_balance itself, so the rule stays in one place (invoiced → what the live
--   invoices still say is payable; not invoiced → amount − payments received).
--   SECURITY DEFINER, fail-closed (§17c): a login with no company is refused; the rows are always
--   the caller's own company. No anon.

begin;

create or replace function public.quote_open_balances()
returns table (quote_id text, open_balance integer)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_caller  uuid;
  v_trusted boolean;
begin
  /* R-1707. R-454 / §17c: fail closed for a login with no company. A trusted server path with no
     company context has no "own quotes", so it gets none. */
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  if v_caller is null then
    return;
  end if;

  return query
    select q.id, public.quote_open_balance(q.id)
      from public.quotes q
     where q.tenant_id = v_caller
     order by q.id;
end;
$$;

revoke all on function public.quote_open_balances() from public, anon;
grant execute on function public.quote_open_balances() to authenticated, service_role;

commit;
