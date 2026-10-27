-- deploy-peek: to_regclass('public.marketing_payment_requests') is not null
-- deploy-key: r1792marketingbudget
-- prisma/migrations/20261023120000_r1792_marketing_budget
-- R-1792 (Abhishek, 23 Oct 2026): Marketing budget & payments.
--   1. Marketing asks the owner for a budget (channel, product, month, amount).
--   2. Only the OWNER approves (maybe for less) or rejects it.
--   3. Against an approved budget, marketing asks billing to pay; up to what is left, billing
--      pays without asking the owner again. Over what is left is refused — ask for more budget.
--   4. Billing marks it paid (date, mode, UTR); the app writes the expense in the same step.
--   What is left on a budget is never lost: it carries into the next months until used.
-- Seen only by the person who asked, the owner and billing. The rules that move money are
-- enforced HERE (triggers), not only in the app — a check only in TypeScript stops at curl.
begin;

create table if not exists public.marketing_budgets (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  requested_by     uuid not null references public.users(id),
  channel          text not null check (channel in ('google-ads', 'meta-ads', 'linkedin-ads', 'trade-show', 'other')),
  product_item_id  text,
  product_name     text check (product_name is null or length(product_name) <= 200),
  month            date not null check (extract(day from month) = 1),
  amount_requested integer not null check (amount_requested > 0 and amount_requested <= 100000000),
  amount_approved  integer check (amount_approved is null or (amount_approved > 0 and amount_approved <= 100000000)),
  note             text check (note is null or length(note) <= 1000),
  status           text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by       uuid references public.users(id),
  decided_at       timestamptz,
  decision_note    text check (decision_note is null or length(decision_note) <= 1000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (status <> 'approved' or amount_approved is not null)
);
create index if not exists marketing_budgets_tenant_idx on public.marketing_budgets (tenant_id, status, month desc);

create table if not exists public.marketing_payment_requests (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  budget_id      uuid not null references public.marketing_budgets(id) on delete restrict,
  requested_by   uuid not null references public.users(id),
  amount         integer not null check (amount > 0 and amount <= 100000000),
  pay_to         text not null check (length(pay_to) between 1 and 200),
  purpose        text check (purpose is null or length(purpose) <= 1000),
  bill_link      text check (bill_link is null or length(bill_link) <= 500),
  due_on         date,
  status         text not null default 'pending' check (status in ('pending', 'paid', 'rejected', 'cancelled')),
  paid_by        uuid references public.users(id),
  paid_at        timestamptz,
  paid_on        date,
  payment_mode   text check (payment_mode is null or length(payment_mode) <= 40),
  reference      text check (reference is null or length(reference) <= 100),
  expense_id     text references public.expenses(id) on delete set null,
  decision_note  text check (decision_note is null or length(decision_note) <= 1000),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (status <> 'paid' or (paid_on is not null and paid_by is not null))
);
create index if not exists marketing_payment_requests_budget_idx on public.marketing_payment_requests (budget_id, status);
create index if not exists marketing_payment_requests_tenant_idx on public.marketing_payment_requests (tenant_id, status, created_at desc);

/* Trusted callers: psql / scripts (no request role) and the service role. Everyone else is a
   signed-in person and goes through the role checks (fail closed — CLAUDE.md §17c). */
create or replace function public.r1792_trusted() returns boolean
language sql stable set search_path = public as $$
  select coalesce(public.current_request_role(), '') = 'service_role'
      or (public.current_request_role() is null
          and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime', 'app_jobs'));
$$;

/* Budgets: who may move a budget to which status. */
create or replace function public.r1792_budget_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.current_user_id();
  trusted boolean := public.r1792_trusted();
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.decided_by is not null or new.amount_approved is not null then
      raise exception 'A new budget request starts as pending — the owner approves it.' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.tenant_id <> old.tenant_id or new.requested_by <> old.requested_by then
    raise exception 'A budget cannot move to another company or person.' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'This budget was already %; ask for a new budget instead.', old.status using errcode = '42501';
  end if;
  if new.status in ('approved', 'rejected') then
    if not (trusted or public.current_user_has_role('owner')) then
      raise exception 'Only the owner can approve or reject a budget.' using errcode = '42501';
    end if;
    new.decided_by := coalesce(me, new.decided_by);
    new.decided_at := now();
  elsif new.status = 'cancelled' then
    if not (trusted or old.requested_by = me or public.current_user_has_role('owner')) then
      raise exception 'Only the person who asked (or the owner) can withdraw this request.' using errcode = '42501';
    end if;
  elsif new.status = 'pending' then
    -- the person who asked may still change it before the owner decides
    if not (trusted or old.requested_by = me) then
      raise exception 'Only the person who asked can change a pending request.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists r1792_budget_guard on public.marketing_budgets;
create trigger r1792_budget_guard before insert or update on public.marketing_budgets
  for each row execute function public.r1792_budget_guard();

/* What is left on a budget: approved minus every payment not rejected / cancelled. */
create or replace function public.marketing_budget_left(p_budget uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(b.amount_approved, 0) - coalesce((
    select sum(p.amount)::integer from public.marketing_payment_requests p
     where p.budget_id = b.id and p.status in ('pending', 'paid')), 0)
    from public.marketing_budgets b
   where b.id = p_budget
     and (public.r1792_trusted() or b.tenant_id = public.current_tenant_id());
$$;

/* Payments: within the budget, and only billing / owner mark them paid. */
create or replace function public.r1792_payment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me uuid := public.current_user_id();
  trusted boolean := public.r1792_trusted();
  b record;
  used integer;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' or new.paid_by is not null or new.expense_id is not null then
      raise exception 'A payment request starts as pending — billing marks it paid.' using errcode = '42501';
    end if;
    -- lock the budget so two requests at the same moment cannot both fit the same rupees
    select * into b from public.marketing_budgets where id = new.budget_id for update;
    if not found or b.tenant_id <> new.tenant_id then
      raise exception 'That budget is not in your company.' using errcode = '42501';
    end if;
    if b.status <> 'approved' then
      raise exception 'This budget is %, not approved — payments can be asked only against an approved budget.', b.status using errcode = '42501';
    end if;
    select coalesce(sum(amount), 0) into used from public.marketing_payment_requests
     where budget_id = b.id and status in ('pending', 'paid');
    if used + new.amount > b.amount_approved then
      raise exception 'Only Rs % is left on this budget — ask the owner for more budget.', b.amount_approved - used
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.tenant_id <> old.tenant_id or new.budget_id <> old.budget_id
     or new.amount <> old.amount or new.requested_by <> old.requested_by then
    raise exception 'The amount and budget of a payment request cannot be changed — cancel it and ask again.' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'This payment request is already %.', old.status using errcode = '42501';
  end if;
  if new.status in ('paid', 'rejected') then
    if not (trusted or public.current_user_has_role('owner', 'billing', 'accountant')) then
      raise exception 'Only billing (or the owner) can mark a payment paid or send it back.' using errcode = '42501';
    end if;
    if new.status = 'paid' then
      new.paid_by := coalesce(me, new.paid_by);
      new.paid_at := now();
    end if;
  elsif new.status = 'cancelled' then
    if not (trusted or old.requested_by = me or public.current_user_has_role('owner')) then
      raise exception 'Only the person who asked (or the owner) can cancel this request.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists r1792_payment_guard on public.marketing_payment_requests;
create trigger r1792_payment_guard before insert or update on public.marketing_payment_requests
  for each row execute function public.r1792_payment_guard();

/* Who sees and writes: the person who asked, the owner, billing (+ accountant, a money role). */
alter table public.marketing_budgets enable row level security;
alter table public.marketing_payment_requests enable row level security;

do $$
declare t text;
begin
  foreach t in array array['marketing_budgets', 'marketing_payment_requests'] loop
    execute format('drop policy if exists r1792_read on public.%I', t);
    execute format(
      'create policy r1792_read on public.%I for select to authenticated
         using (tenant_id = public.current_tenant_id()
                and (requested_by = public.current_user_id()
                     or public.current_user_has_role(''owner'', ''billing'', ''accountant'')))', t);
    execute format('drop policy if exists r1792_insert on public.%I', t);
    execute format(
      'create policy r1792_insert on public.%I for insert to authenticated
         with check (tenant_id = public.current_tenant_id()
                     and requested_by = public.current_user_id()
                     and public.current_user_has_role(''marketing'', ''owner''))', t);
    execute format('drop policy if exists r1792_update on public.%I', t);
    execute format(
      'create policy r1792_update on public.%I for update to authenticated
         using (tenant_id = public.current_tenant_id()
                and (requested_by = public.current_user_id()
                     or public.current_user_has_role(''owner'', ''billing'', ''accountant'')))
         with check (tenant_id = public.current_tenant_id())', t);
    execute format('drop policy if exists zzz_service_role_all on public.%I', t);
    execute format(
      'create policy zzz_service_role_all on public.%I as permissive for all to service_role
         using (true) with check (true)', t);
    execute format('grant select, insert, update on public.%I to authenticated, service_role', t);
  end loop;
end $$;

grant execute on function public.marketing_budget_left(uuid) to authenticated, service_role;

commit;
