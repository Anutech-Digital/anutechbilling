-- deploy-peek: exists(select 1 from pg_proc where oid = to_regprocedure('public.my_customer_ids()') and prosrc like '%R-1004%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.customers_name_only()') and prosrc like '%R-1004%') and exists(select 1 from pg_proc where oid = to_regprocedure('public.claim_customer(uuid)') and prosrc like '%R-1004%') and exists(select 1 from pg_policy where polname = 'customers_select' and polrelid = to_regclass('public.customers') and pg_get_expr(polqual, polrelid) like '%my_customer_ids%') and exists(select 1 from pg_policy where polname = 'contacts_select' and polrelid = to_regclass('public.contacts') and pg_get_expr(polqual, polrelid) like '%my_customer_ids%') and exists(select 1 from pg_policy where polname = 'invoices_select' and polrelid = to_regclass('public.invoices') and pg_get_expr(polqual, polrelid) like '%my_customer_ids%') and exists(select 1 from pg_policy where polname = 'payments_select' and polrelid = to_regclass('public.payments') and pg_get_expr(polqual, polrelid) like '%my_customer_ids%') and exists(select 1 from pg_trigger where tgname = 'trg_r1004_customer_creator_manages' and tgrelid = to_regclass('public.customers'))
-- deploy-key: r1004customers
-- 20261012023458_r1004_customer_reads.sql
--
-- R-1004 (P1 launch blocker, data-leak audit 11 Oct 2026, decided by Pardeep via the Super
-- Manager). The reserved slot 20261011143000 was taken by R-724, and CI needs a new migration
-- to sort after the newest file on the branch, so this sits after 20261012023000 (R-897).
--
-- ══ THE LEAK ═════════════════════════════════════════════════════════════════════════
--   customers_select / contacts_select / invoices_select / payments_select were all
--   `tenant_id = current_tenant_id()` (cloudsql/05:195, 271, 385, 455). The only narrowing was
--   the RESTRICTIVE customers_hierarchy_select (20260818150000 + 20260928100000), and it lets
--   EVERY row with no account manager through — and the app never sets account_manager_id, so
--   that is every customer. support, delivery, sales and partner_agent could therefore read
--   every customer's phone, email and GSTIN (and every invoice/payment with the GSTIN snapshot).
--
-- ══ WHO READS WHAT AFTER THIS (every value of enum user_role) ════════════════════════
--   role           customers (full row)            contacts                       invoices / payments
--   owner          all in tenant                   all                            all
--   manager        all in tenant ∩ hierarchy rule  all                            all
--                  (unclaimed + own team's — the restrictive customers_hierarchy_select, unchanged)
--   accountant     all in tenant                   all                            all
--   billing        all (invoices need them)        all                            all
--   sales          customers they or their         their customers' contacts +    their customers' only
--   sales_senior   reports manage (account_manager contacts with no customer
--                  in get_subordinate_user_ids)    (lead / imported book)
--   support        LINKED customers only           linked customers' contacts     linked customers' only
--   delivery       LINKED customers only           linked customers' contacts     linked customers' only
--   partner_agent  none                            none                           none
--   customer portal (no users row): unchanged — its own *_own_customer / *_self_customer policies.
--   service_role: unchanged — its own policies (customers via BYPASS / *_service_role).
--
--   LINKED (support, delivery) = a customer on
--     • a support ticket assigned to them, raised by them, resolved by them, or OPEN and
--       unassigned (the queue they pick from);
--     • a support call request assigned to them;
--     • a task they own;
--     • a project (project_sales) with a project_task or project_labour row for their employee;
--     • or a customer they added themselves (see the trigger below).
--
--   NAMES ONLY: customers_name_only() — SECURITY DEFINER, returns id, name, display_name,
--   customer_number, state code (entered or from the GSTIN prefix — place of supply needs it),
--   country, has_gstin, account_manager_id, is_active. No phone, email, GSTIN, address.
--     sales / sales_senior → unclaimed customers (no account manager) they cannot read in full.
--     support / delivery   → every tenant customer they cannot read in full (pickers still work).
--     every other role     → nothing (they read the table).
--   claim_customer(id): sales, sales_senior, manager, owner take an UNCLAIMED customer
--   (account_manager_id := caller). From then on the full row is theirs (and their managers').
--   A customer added by sales / sales_senior / delivery is claimed by them on insert
--   (trg_r1004_customer_creator_manages) — without it `insert … returning` would fail RLS for
--   the very person who just created the row.
--
--   Unchanged on purpose: every INSERT / UPDATE / DELETE policy (R-719), the restrictive
--   customers_hierarchy_* policies, R-718's money RPCs, R-454 tenant rule (helpers use
--   current_tenant_id(), which since R-722 requires users.is_active).
--   Writes by a low role on a row it cannot SELECT now affect 0 rows (UPDATE … WHERE reads
--   the row) — claim first.
--
-- Staging's apply() rewrites auth.uid() → public.current_user_id(), so it is written plainly.
-- Idempotent: create or replace / drop … if exists.

begin;

-- ── 1. Which customers may a limited role read in full ───────────────────────────────
create or replace function public.my_customer_ids()
returns uuid[]
language sql
stable
security definer
set search_path to ''
as $$
  /* R-1004: the customers a sales / support / delivery user may read in FULL. Empty for
     every other role (they are decided by role in the policies) and for a caller with no
     active company (current_tenant_id() is NULL — R-454 / R-722). */
  with me as (
    select u.id, u.role::text as role, u.employee_id, u.tenant_id
      from public.users u
     where u.id = auth.uid()
       and u.is_active
       and u.tenant_id = public.current_tenant_id()
  )
  select coalesce(array_agg(distinct x.cid), '{}'::uuid[])
    from (
      select c.id as cid
        from public.customers c, me
       where me.role in ('sales', 'sales_senior')
         and c.tenant_id = me.tenant_id
         and c.account_manager_id in (select public.get_subordinate_user_ids(me.id))
      union all
      select c.id
        from public.customers c, me
       where me.role in ('support', 'delivery')
         and c.tenant_id = me.tenant_id
         and c.account_manager_id = me.id
      union all
      select t.customer_id
        from public.support_tickets t, me
       where me.role in ('support', 'delivery')
         and t.tenant_id = me.tenant_id
         and (t.assigned_agent = me.id
              or t.raised_by_user = me.id
              or t.resolved_by = me.id
              or (t.assigned_agent is null and coalesce(t.status, 'open') not in ('resolved', 'closed')))
      union all
      select r.customer_id
        from public.support_call_requests r, me
       where me.role in ('support', 'delivery')
         and r.tenant_id = me.tenant_id
         and r.assigned_to = me.id
      union all
      select k.customer_id
        from public.tasks k, me
       where me.role in ('support', 'delivery')
         and k.tenant_id = me.tenant_id
         and k.owner_id = me.id
      union all
      select p.customer_id
        from public.project_sales p, me
       where me.role in ('support', 'delivery')
         and p.tenant_id = me.tenant_id
         and me.employee_id is not null
         and (exists (select 1 from public.project_tasks pt
                       where pt.project_id = p.id and pt.assignee_employee_id = me.employee_id)
              or exists (select 1 from public.project_labour pl
                          where pl.project_id = p.id and pl.employee_id = me.employee_id))
    ) x
   where x.cid is not null
$$;

revoke all on function public.my_customer_ids() from public, anon;
grant execute on function public.my_customer_ids() to authenticated, service_role;

-- ── 2. SELECT policies ───────────────────────────────────────────────────────────────
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and ((select public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
         /* the row's own account manager, checked on the row itself: my_customer_ids() reads
            the table at statement start, so it cannot see a row `insert … returning` just made */
         or ((select public.current_user_has_role('sales', 'sales_senior'))
             and account_manager_id = any ((select public.visible_owner_ids())::uuid[]))
         or ((select public.current_user_has_role('support', 'delivery'))
             and account_manager_id = (select auth.uid()))
         or id = any ((select public.my_customer_ids())::uuid[]))
  );
comment on policy customers_select on public.customers is
  'R-1004: owner/manager/accountant/billing read all (manager also bound by customers_hierarchy_select); sales/sales_senior read customers their team manages; support/delivery read linked customers (tickets, calls, tasks, projects, own); partner_agent nothing. Names of the rest: customers_name_only().';

drop policy if exists contacts_select on public.contacts;
create policy contacts_select on public.contacts
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and ((select public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
         or (customer_id is null and (select public.current_user_has_role('sales', 'sales_senior')))
         or customer_id = any ((select public.my_customer_ids())::uuid[]))
  );
comment on policy contacts_select on public.contacts is
  'R-1004: owner/manager/accountant/billing all; sales/sales_senior contacts with no customer + their customers''; support/delivery linked customers'' contacts only; partner_agent nothing.';

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and ((select public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
         or customer_id = any ((select public.my_customer_ids())::uuid[]))
  );
comment on policy invoices_select on public.invoices is
  'R-1004: owner/manager/accountant/billing all; sales/sales_senior/support/delivery only invoices of customers they may read in full (my_customer_ids); partner_agent nothing.';

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments
  as permissive for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and ((select public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
         or customer_id = any ((select public.my_customer_ids())::uuid[]))
  );
comment on policy payments_select on public.payments is
  'R-1004: owner/manager/accountant/billing all; sales/sales_senior/support/delivery only payments of customers they may read in full (my_customer_ids); partner_agent nothing.';

-- ── 3. Names only, for pickers ──────────────────────────────────────────────────────
create or replace function public.customers_name_only()
returns table (
  id uuid,
  name text,
  display_name text,
  customer_number text,
  state_code text,
  country text,
  has_gstin boolean,
  account_manager_id uuid,
  is_active boolean
)
language sql
stable
security definer
set search_path to ''
as $$
  /* R-1004: the customers a limited role may NOT read in full, by name only — so a picker
     still lists them. Never phone, email, GSTIN or address. Empty for full-read roles. */
  select c.id, c.name, c.display_name, c.customer_number,
         coalesce(nullif(btrim(c.state_code), ''),
                  case when c.gstin ~ '^[0-9]{2}' then left(c.gstin, 2) end),
         c.country,
         nullif(btrim(coalesce(c.gstin, '')), '') is not null,
         c.account_manager_id,
         c.is_active
    from public.customers c
   where c.tenant_id = public.current_tenant_id()
     and public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery')
     and not (c.id = any (public.my_customer_ids()))
     and (c.account_manager_id is null
          or not public.current_user_has_role('sales', 'sales_senior'))
   order by c.name, c.id
$$;

revoke all on function public.customers_name_only() from public, anon;
grant execute on function public.customers_name_only() to authenticated, service_role;

-- ── 4. Claim an unclaimed customer ───────────────────────────────────────────────────
create or replace function public.claim_customer(p_customer_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path to ''
as $$
declare
  v_caller uuid;
  v_n      int;
begin
  /* R-1004: a sales person (or manager / owner) takes an UNCLAIMED customer. Fails closed
     (R-454): no active company → refused; another company's id or a claimed row → refused. */
  v_caller := public.current_tenant_id();
  if v_caller is null then
    raise exception 'No company on this login' using errcode = '28000';
  end if;
  if not public.current_user_has_role('owner', 'manager', 'sales', 'sales_senior') then
    raise exception 'Only sales, a manager or the owner can claim a customer' using errcode = '42501';
  end if;
  update public.customers
     set account_manager_id = auth.uid()
   where id = p_customer_id
     and tenant_id = v_caller
     and account_manager_id is null;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'Customer not found or already has an account manager' using errcode = 'P0002';
  end if;
end;
$$;

revoke all on function public.claim_customer(uuid) from public, anon;
grant execute on function public.claim_customer(uuid) to authenticated, service_role;

-- ── 5. Whoever (sales / delivery) adds a customer manages it ─────────────────────────
create or replace function public.r1004_customer_creator_manages()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
begin
  /* R-1004: without this the person who just created a customer could not read it back
     (insert … returning, the app's create path) under the narrowed customers_select. */
  if new.account_manager_id is null
     and auth.uid() is not null
     and new.tenant_id = public.current_tenant_id()
     and public.current_user_has_role('sales', 'sales_senior', 'delivery') then
    new.account_manager_id := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.r1004_customer_creator_manages() from public, anon;

drop trigger if exists trg_r1004_customer_creator_manages on public.customers;
create trigger trg_r1004_customer_creator_manages
  before insert on public.customers
  for each row execute function public.r1004_customer_creator_manages();

commit;
