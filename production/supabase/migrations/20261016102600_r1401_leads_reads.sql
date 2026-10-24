-- deploy-peek: exists(select 1 from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'leads' and p.polname = 'leads_r1401_select' and not p.polpermissive and pg_get_expr(p.polqual, p.polrelid) like '%my_customer_ids%') and exists(select 1 from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'leads' and p.polname = 'leads_r1401_write' and not p.polpermissive) and exists(select 1 from pg_proc where oid = to_regprocedure('public.hierarchy_sees_all()') and prosrc like '%R-1401%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.can_see_record(uuid)') and prosrc like '%R-1401%') and exists(select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = 'leads' and t.tgname = 'trg_r1401_lead_creator')
-- deploy-key: r1401leads
-- 20261016102600_r1401_leads_reads.sql
-- R-1401 (P1 launch blocker, gap found by the R-1400 worker, 12 Oct 2026).
--
-- ══ THE LEAK ═════════════════════════════════════════════════════════════════════════
--   leads_select             PERMISSIVE  tenant_id = current_tenant_id()
--   leads_hierarchy_select   RESTRICTIVE owner_id IS NULL OR hierarchy_sees_all() OR owner in team
--   hierarchy_sees_all() (20260928100000, 20261009200000) was TRUE for every staff role except
--   sales / sales_senior / manager — so support, delivery and partner_agent read EVERY lead in
--   the company: contact name, phone, email, GSTIN, notes, value. R-1004 (customers) and R-1400
--   (quotes) narrowed their tables; leads had nothing.
--
-- ══ EVERY PLACE hierarchy_sees_all() IS USED, AND WHAT THIS DOES TO EACH ═════════════
--   (pg_policy / pg_proc / pg_views scan of the local DB on 16 Oct 2026 — nothing else uses it,
--   no view, no other function; app code never calls it directly.)
--
--   hierarchy_sees_all()  NOW: portal customer, service_role (R-458), or staff role
--                         owner / accountant / billing. FALSE for manager (unchanged — a manager
--                         is bound by the reporting tree), sales, sales_senior, and — the fix —
--                         support, delivery, partner_agent.
--                         accountant / billing stay TRUE on purpose: R-1004 gives them every
--                         customer (invoices need them) and R-718 / R-895 every money row; a
--                         FALSE here would hide every claimed customer / owned quote from the
--                         people who bill them.
--
--   leads_hierarchy_select / _write / _delete      (RESTRICTIVE, 20260928100000)
--   quotes_hierarchy_select / _write / _delete     (RESTRICTIVE, 20260928100000)
--   customers_hierarchy_select / _write / _delete  (RESTRICTIVE, 20260928100000)
--     The reporting tree is a rule about SALES people. For support / delivery / partner_agent
--     the tree says nothing useful (they have no reports and their "own" rows are the
--     exception, not the rule) — their rows are decided by the role policies:
--       customers  customers_select (R-1004: linked customers only / partner none)
--       quotes     quotes_r1400_select (R-1400: own + linked customers' + own tasks' / partner own)
--       leads      leads_r1401_select (THIS file, below)
--     So these nine policies now let those three roles through EXPLICITLY (named in the policy,
--     not hidden inside hierarchy_sees_all()) and the role policy narrows. Had they stayed as
--     they were with the narrower function, support would have lost R-1004's linked customer
--     the moment a sales rep claimed it, and R-1400's linked quotes the same way.
--     owner / accountant / billing: unchanged (TRUE before, TRUE now).
--     manager / sales / sales_senior: unchanged (own + reports' rows, unowned rows).
--     service_role: unchanged (R-458 branch kept).
--
--   can_see_record(uuid)  (20260818150000; same test inline) — rewritten to the same rule, so
--     the two never disagree again. Nothing in the DB calls it; the app only lists it in the
--     generated types.
--
-- ══ WHO READS WHICH LEADS AFTER THIS ═════════════════════════════════════════════════
--   owner / accountant / billing             all leads in the company (unchanged)
--   manager                                  unowned + own team's (hierarchy rule, unchanged)
--   sales / sales_senior                     unowned + own + reports' (hierarchy rule, unchanged)
--   support / delivery                       leads they own or created; leads of a LINKED
--                                            customer (my_customer_ids — their tickets, call
--                                            requests, tasks, projects); leads on a task they own
--   partner_agent                            leads they own or created, nothing else
--   customer portal (no users row)           nothing (leads has no portal policy — unchanged)
--   service_role                             unchanged (policies are TO authenticated)
--   another company                          nothing (leads_select tenant rule, unchanged)
--
--   UPDATE follows SELECT for the three roles (leads_r1401_write): a support user can no longer
--   update a lead by id that it cannot read (leads_update is tenant-wide). DELETE was already
--   owner / manager only (20261002180000). INSERT unchanged; the app sets owner_id and
--   created_by to the signed-in user (withCreatorAsOwner); the trigger below covers the API
--   path that leaves created_by empty, so `insert … returning` still works for the author.
--
-- Ctrl+K search, /leads, /deals, the lead drawer, lead_counts() and nav_badges() all read
-- through list_leads() / the table as SECURITY INVOKER — they return fewer rows, never an error.
-- Staging's apply() rewrites auth.uid() → public.current_user_id(), so it is written plainly.
-- Idempotent: create or replace / drop … if exists.
-- Test: supabase/tests/r1401_leads_reads.test.sql (FAIL before, PASS after; rolled back).

begin;

-- ── 1. hierarchy_sees_all(): owner / accountant / billing, portal customer, service ──────
create or replace function public.hierarchy_sees_all() returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  /* R-1401: no longer TRUE for support / delivery / partner_agent — they read EVERY lead
     through it. TRUE only for the roles that genuinely see the whole company. */
  select public.current_customer_id() is not null
      or exists (select 1 from public.users u
                  where u.id = auth.uid()
                    and u.is_active
                    and u.role in ('owner', 'accountant', 'billing'))
      or coalesce(auth.role() = 'service_role', false)
$$;

comment on function public.hierarchy_sees_all() is
  'True when the caller sees the whole company regardless of the reporting tree: a portal customer, an active owner / accountant / billing user, or the service connection (R-458). FALSE for manager, sales, sales_senior, support, delivery, partner_agent (R-1401). Zero-argument so RLS evaluates it once per query: (select public.hierarchy_sees_all()).';

create or replace function public.can_see_record(p_owner uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
as $$
  /* R-1401: the same rule as the *_hierarchy_* policies, in one place. */
  select p_owner is null
      or public.hierarchy_sees_all()
      or public.current_user_has_role('support', 'delivery', 'partner_agent')
      or p_owner in (select public.get_subordinate_user_ids(auth.uid()))
$$;

-- ── 2. The nine hierarchy policies: the tree rule binds tree roles only ─────────────────
drop policy if exists leads_hierarchy_select on public.leads;
create policy leads_hierarchy_select on public.leads
  as restrictive for select
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists leads_hierarchy_write on public.leads;
create policy leads_hierarchy_write on public.leads
  as restrictive for update
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists leads_hierarchy_delete on public.leads;
create policy leads_hierarchy_delete on public.leads
  as restrictive for delete
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));

drop policy if exists quotes_hierarchy_select on public.quotes;
create policy quotes_hierarchy_select on public.quotes
  as restrictive for select
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists quotes_hierarchy_write on public.quotes;
create policy quotes_hierarchy_write on public.quotes
  as restrictive for update
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists quotes_hierarchy_delete on public.quotes;
create policy quotes_hierarchy_delete on public.quotes
  as restrictive for delete
  using (owner_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or owner_id = any ((select public.visible_owner_ids())::uuid[]));

drop policy if exists customers_hierarchy_select on public.customers;
create policy customers_hierarchy_select on public.customers
  as restrictive for select
  using (account_manager_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists customers_hierarchy_write on public.customers;
create policy customers_hierarchy_write on public.customers
  as restrictive for update
  using (account_manager_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));
drop policy if exists customers_hierarchy_delete on public.customers;
create policy customers_hierarchy_delete on public.customers
  as restrictive for delete
  using (account_manager_id is null
         or (select public.hierarchy_sees_all())
         or (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
         or account_manager_id = any ((select public.visible_owner_ids())::uuid[]));

-- ── 3. Which lead rows a limited role may read / update ─────────────────────────────────
drop policy if exists leads_r1401_select on public.leads;
create policy leads_r1401_select on public.leads
  as restrictive for select to authenticated
  using (
    not (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
    or owner_id = (select auth.uid())
    or created_by = (select auth.uid())
    or ((select public.current_user_has_role('support', 'delivery'))
        and (customer_id = any ((select public.my_customer_ids())::uuid[])
             or exists (select 1 from public.tasks k
                         where k.lead_id = leads.id
                           and k.tenant_id = leads.tenant_id
                           and k.owner_id = (select auth.uid()))))
  );
comment on policy leads_r1401_select on public.leads is
  'R-1401: support/delivery read leads they own or created, leads of linked customers (my_customer_ids) and leads on their own tasks; partner_agent own/created only. owner/manager/accountant/billing/sales unchanged (hierarchy rule).';

drop policy if exists leads_r1401_write on public.leads;
create policy leads_r1401_write on public.leads
  as restrictive for update to authenticated
  using (
    not (select public.current_user_has_role('support', 'delivery', 'partner_agent'))
    or owner_id = (select auth.uid())
    or created_by = (select auth.uid())
    or ((select public.current_user_has_role('support', 'delivery'))
        and (customer_id = any ((select public.my_customer_ids())::uuid[])
             or exists (select 1 from public.tasks k
                         where k.lead_id = leads.id
                           and k.tenant_id = leads.tenant_id
                           and k.owner_id = (select auth.uid()))))
  );
comment on policy leads_r1401_write on public.leads is
  'R-1401: support/delivery/partner_agent may only UPDATE the leads they can SELECT (no blind writes by id).';

-- ── 4. A lead a limited role adds is at least theirs by created_by ──────────────────────
create or replace function public.r1401_lead_creator()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  /* R-1401: the app sends owner_id + created_by = the signed-in user. An API path that leaves
     created_by empty would hand the row to round-robin (leads_assign_new_owner) and the author
     could not read it back — `insert … returning` would fail RLS. */
  if new.created_by is null
     and auth.uid() is not null
     and public.current_user_has_role('support', 'delivery', 'partner_agent') then
    new.created_by := auth.uid();
  end if;
  return new;
end
$$;

drop trigger if exists trg_r1401_lead_creator on public.leads;
create trigger trg_r1401_lead_creator
  before insert on public.leads
  for each row execute function public.r1401_lead_creator();

commit;
