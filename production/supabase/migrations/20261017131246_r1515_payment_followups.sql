-- deploy-peek: to_regclass('public.payment_followups') is not null and exists(select 1 from pg_policy where polname = 'payment_followups_select' and polrelid = to_regclass('public.payment_followups'))
-- deploy-key: r1515followups
--
-- R-1515 (17 Oct 2026, Pardeep — part 1 of 4 of R-1514 "Payment Follow-up system"):
-- one place to keep every payment follow-up with a customer — the call / WhatsApp / email /
-- meeting, what was said, a promise to pay (amount + date) and when to follow up next.
-- R-1516 builds /collections on top of this (today's list); R-1517 the add/edit screens.
--
-- DECISIONS (Pardeep, 17 Oct, on R-1514)
--   • A follow-up belongs to the CUSTOMER'S OWNER — customers.account_manager_id already is
--     that column (users.id, used by the sales hierarchy RLS). No new owner column is added.
--     `assigned_to` here is filled from it by the app and can be changed per follow-up.
--   • Reminders are sent by a human; AI only drafts. Nothing here sends anything.
--
-- MONEY: promised_amount is whole rupees (CLAUDE.md §13), integer, never negative.
--
-- TENANT SAFETY (CLAUDE.md §4, §17c — fail closed)
--   • Every policy needs tenant_id = current_tenant_id(); a NULL tenant (portal login, inactive
--     user, MFA not passed) matches nothing, so it reads and writes nothing.
--   • A follow-up is only visible/writable when the signed-in user can see its CUSTOMER (the
--     exists() runs under customers' own RLS) — so a sales person sees follow-ups of their own
--     customers only, exactly like the customer list. Customer-portal logins are excluded by role.
--   • customers.id / invoices.id have no unique (tenant_id, id), so a composite FK is not
--     possible without changing those tables. Same-tenant links are enforced by a trigger
--     (house pattern: tg_lead_customer_same_tenant, tg_academy_task_same_tenant) for the
--     customer, invoice, quote, subscription and assigned user.
--   • invoices.id and quotes.id are TEXT in this schema (human numbers), so those columns are text.
--
-- Cloud SQL: no extensions schema, no auth.users. Staging's apply() rewrites auth.uid() →
-- public.current_user_id(), so it is written plainly. service_role gets its own policy
-- (no BYPASSRLS on Cloud SQL — R-450).

begin;

create table if not exists public.payment_followups (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references public.tenants(id) on delete cascade,
  customer_id        uuid        not null references public.customers(id) on delete cascade,
  invoice_id         text        references public.invoices(id) on delete set null,
  quote_id           text        references public.quotes(id) on delete set null,
  subscription_id    uuid        references public.subscriptions(id) on delete set null,
  kind               text        not null
                     check (kind in ('call', 'whatsapp', 'email', 'meeting', 'note', 'promise')),
  note               text        check (note is null or length(note) <= 4000),
  -- Whole rupees (§13). A promise without an amount is allowed ("will pay the balance").
  promised_amount    integer     check (promised_amount is null or promised_amount >= 0),
  promised_on        date,
  next_follow_up_on  date,
  outcome            text        check (outcome is null or length(outcome) <= 500),
  assigned_to        uuid        references public.users(id) on delete set null,
  created_by         uuid        default auth.uid() references public.users(id) on delete set null,
  created_at         timestamptz not null default now(),
  -- A promise-to-pay must say WHEN.
  constraint payment_followups_promise_has_date check (kind <> 'promise' or promised_on is not null)
);

comment on table public.payment_followups is
  'R-1515: payment follow-up log per customer (call/whatsapp/email/meeting/note/promise-to-pay). Owner = customers.account_manager_id; assigned_to per row.';

create index if not exists payment_followups_next_idx
  on public.payment_followups (tenant_id, next_follow_up_on);
create index if not exists payment_followups_customer_idx
  on public.payment_followups (tenant_id, customer_id, created_at desc);
create index if not exists payment_followups_assigned_idx
  on public.payment_followups (tenant_id, assigned_to);

-- ── Same-tenant links (definer: must see the other rows whatever the caller's RLS) ──
create or replace function public.tg_payment_followups_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.customers c where c.id = new.customer_id and c.tenant_id = new.tenant_id) then
    raise exception 'That customer is not in this company.' using errcode = '23514';
  end if;
  if new.invoice_id is not null
     and not exists (select 1 from public.invoices i where i.id = new.invoice_id and i.tenant_id = new.tenant_id) then
    raise exception 'That invoice is not in this company.' using errcode = '23514';
  end if;
  if new.quote_id is not null
     and not exists (select 1 from public.quotes q where q.id = new.quote_id and q.tenant_id = new.tenant_id) then
    raise exception 'That quote is not in this company.' using errcode = '23514';
  end if;
  if new.subscription_id is not null
     and not exists (select 1 from public.subscriptions s where s.id = new.subscription_id and s.tenant_id = new.tenant_id) then
    raise exception 'That subscription is not in this company.' using errcode = '23514';
  end if;
  if new.assigned_to is not null
     and not exists (select 1 from public.users u where u.id = new.assigned_to and u.tenant_id = new.tenant_id) then
    raise exception 'That person is not in this company — pick someone from your team.' using errcode = '23514';
  end if;
  return new;
end $$;

revoke all on function public.tg_payment_followups_same_tenant() from public, anon;

drop trigger if exists trg_payment_followups_same_tenant on public.payment_followups;
create trigger trg_payment_followups_same_tenant
  before insert or update of tenant_id, customer_id, invoice_id, quote_id, subscription_id, assigned_to
  on public.payment_followups
  for each row execute function public.tg_payment_followups_same_tenant();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.payment_followups enable row level security;

drop policy if exists payment_followups_select on public.payment_followups;
drop policy if exists payment_followups_insert on public.payment_followups;
drop policy if exists payment_followups_update on public.payment_followups;
drop policy if exists payment_followups_delete on public.payment_followups;
drop policy if exists zzz_service_role_all     on public.payment_followups;

-- Read: same company, a staff role, and the customer is one this user can see.
create policy payment_followups_select on public.payment_followups
  for select to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.current_user_has_role('owner', 'manager', 'accountant', 'billing',
                                             'sales', 'sales_senior', 'support', 'delivery'))
    and exists (select 1 from public.customers c where c.id = payment_followups.customer_id)
  );

-- Add: same, and the row is written as yourself (created_by cannot be forged).
create policy payment_followups_insert on public.payment_followups
  for insert to authenticated
  with check (
    tenant_id = (select public.current_tenant_id())
    and (select public.current_user_has_role('owner', 'manager', 'accountant', 'billing',
                                             'sales', 'sales_senior', 'support', 'delivery'))
    and created_by = (select auth.uid())
    and exists (select 1 from public.customers c where c.id = payment_followups.customer_id)
  );

-- Change: owner / manager / accountant / billing on any follow-up they can see (they reassign);
-- everyone else only on a follow-up they wrote or that is assigned to them.
create policy payment_followups_update on public.payment_followups
  for update to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and exists (select 1 from public.customers c where c.id = payment_followups.customer_id)
    and (
      (select public.current_user_has_role('owner', 'manager', 'accountant', 'billing'))
      or ((select public.current_user_has_role('sales', 'sales_senior', 'support', 'delivery'))
          and (created_by = (select auth.uid()) or assigned_to = (select auth.uid())))
    )
  )
  with check (
    tenant_id = (select public.current_tenant_id())
    and exists (select 1 from public.customers c where c.id = payment_followups.customer_id)
  );

-- Remove: owner / manager / accountant only — it is the history of what was promised.
create policy payment_followups_delete on public.payment_followups
  for delete to authenticated
  using (
    tenant_id = (select public.current_tenant_id())
    and (select public.current_user_has_role('owner', 'manager', 'accountant'))
  );

-- Cloud SQL has no BYPASSRLS: the service role needs its own policy (R-450).
create policy zzz_service_role_all on public.payment_followups
  as permissive for all to service_role using (true) with check (true);

grant select, insert, update, delete on public.payment_followups to authenticated;
grant select, insert, update, delete on public.payment_followups to service_role;

commit;
