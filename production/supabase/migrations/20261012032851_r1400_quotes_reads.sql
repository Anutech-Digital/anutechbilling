-- deploy-peek: exists(select 1 from pg_policy where polname = 'quotes_r1400_select' and polrelid = to_regclass('public.quotes') and not polpermissive and pg_get_expr(polqual, polrelid) like '%my_customer_ids%') and exists(select 1 from pg_trigger where tgname = 'trg_r1400_quote_owner' and tgrelid = to_regclass('public.quotes')) and exists(select 1 from pg_proc where oid = to_regprocedure('public.r1400_quote_owner()') and prosrc like '%R-1400%')
-- deploy-key: r1400quotes
-- 20261012032851_r1400_quotes_reads.sql
-- R-1400 (P1 launch blocker, gap found by the R-1004 worker, 12 Oct 2026).
--
-- ══ THE LEAK ═════════════════════════════════════════════════════════════════════════
--   R-1004 limited customers / contacts / invoices / payments per role, but quotes stayed:
--     quotes_select            PERMISSIVE  tenant_id = current_tenant_id()
--     quotes_hierarchy_select  RESTRICTIVE owner_id IS NULL OR hierarchy_sees_all() OR team
--   hierarchy_sees_all() is TRUE for support / delivery / partner_agent, and the builder never
--   sets owner_id (all live quotes are unowned), so every low role read EVERY quote — customer
--   name, domain, place of supply, amounts, payment refs, notes — of customers R-1004 hides.
--   (quotes carries no phone / email / GSTIN column; those live on customers / contacts, which
--   R-1004 already guards, also when embedded. So hiding the ROWS closes it — no slim view needed.)
--
-- ══ WHO READS WHICH QUOTES AFTER THIS ════════════════════════════════════════════════
--   owner / manager / accountant / billing   unchanged (manager still bound by the hierarchy rule)
--   customer portal (no users row)           unchanged (quotes_select_own_customer)
--   service_role                             unchanged (policies are TO authenticated)
--   sales, sales_senior                      quotes they or their reports own; quotes of customers
--                                            they read in full (my_customer_ids, R-1004); prospect
--                                            quotes (no customer) on a lead they can see
--   support, delivery                        quotes they own; quotes of LINKED customers
--                                            (my_customer_ids); quotes on a task they own
--   partner_agent                            quotes they own only
--   A quote a low role saves with no owner becomes theirs (trg_r1400_quote_owner) — without it
--   `insert … returning` from the quote builder would fail RLS for the person who wrote it.
--
-- Writes: the existing quotes_update / quotes_delete / hierarchy_write policies are unchanged;
-- a low role's UPDATE on a quote it cannot SELECT now affects 0 rows.
-- Idempotent: create or replace / drop … if exists.

begin;

-- ── 1. A quote a low role creates without an owner is theirs ─────────────────────────
create or replace function public.r1400_quote_owner()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  /* R-1400: the quote builder inserts with owner_id NULL. For a limited role that row would
     be invisible to its own author after quotes_r1400_select, so the author owns it. */
  if new.owner_id is null
     and auth.uid() is not null
     and public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery', 'partner_agent') then
    new.owner_id := auth.uid();
  end if;
  return new;
end
$$;

drop trigger if exists trg_r1400_quote_owner on public.quotes;
create trigger trg_r1400_quote_owner
  before insert on public.quotes
  for each row execute function public.r1400_quote_owner();

-- ── 2. Which quote rows a limited role may read ──────────────────────────────────────
drop policy if exists quotes_r1400_select on public.quotes;
create policy quotes_r1400_select on public.quotes
  as restrictive for select to authenticated
  using (
    not (select public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery', 'partner_agent'))
    or owner_id = (select auth.uid())
    or ((select public.current_user_has_role('sales', 'sales_senior'))
        and (owner_id = any ((select public.visible_owner_ids())::uuid[])
             or (customer_id is null and lead_id is not null
                 and exists (select 1 from public.leads l
                              where l.id = quotes.lead_id and l.tenant_id = quotes.tenant_id))))
    or ((select public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery'))
        and customer_id = any ((select public.my_customer_ids())::uuid[]))
    or ((select public.current_user_has_role('support', 'delivery'))
        and exists (select 1 from public.tasks k
                     where k.quote_id = quotes.id and k.owner_id = (select auth.uid())))
  );
comment on policy quotes_r1400_select on public.quotes is
  'R-1400: sales/sales_senior read own+team quotes, quotes of customers they read in full, prospect quotes on visible leads; support/delivery own + linked customers + own tasks; partner_agent own only. Other roles unchanged.';

commit;
