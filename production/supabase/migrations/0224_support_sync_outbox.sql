-- ============================================================
-- Billing → DSP support-plan sync (outbox pattern)
-- Migration: 0224_support_sync_outbox.sql
-- ============================================================
-- Whenever a subscription with vendor='support' is created, or its plan /
-- status / renewal_date changes, queue an event here. A server-side flush
-- (src/lib/dsp/support-sync.ts, called from /api/cron/support-sync) drains
-- this queue by POSTing to DSP's existing webhook receiver
-- (POST /api/sync/customer). An outbox + trigger is used instead of hooking
-- every one of the many record_payment call sites, so the sync fires no
-- matter which code path created/changed the subscription.
-- ============================================================

begin;

create table public.support_sync_outbox (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references public.tenants(id)   on delete cascade,
  subscription_id uuid          not null references public.subscriptions(id) on delete cascade,
  customer_id     uuid          not null references public.customers(id) on delete cascade,
  payload         jsonb         not null,
  status          text          not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts        int           not null default 0,
  last_error      text,
  created_at      timestamptz   not null default now(),
  sent_at         timestamptz
);

create index idx_support_sync_outbox_pending
  on public.support_sync_outbox (created_at)
  where status = 'pending';

alter table public.support_sync_outbox enable row level security;

-- Service-role only — this table is drained by the server-side cron route,
-- never read/written from the browser.
create policy support_sync_outbox_service_role
  on public.support_sync_outbox for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.queue_support_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer record;
begin
  -- No-op update (something unrelated to plan/status/renewal changed) — skip.
  if tg_op = 'UPDATE'
     and old.plan          is not distinct from new.plan
     and old.status        is not distinct from new.status
     and old.renewal_date  is not distinct from new.renewal_date then
    return new;
  end if;

  select name, contact_name, contact_email, domain, customer_number
    into v_customer
    from public.customers
   where id = new.customer_id;

  -- DSP keys the sync on email (or billing_customer_id) — nothing to send
  -- without one.
  if v_customer.contact_email is null then
    return new;
  end if;

  insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
  values (
    new.tenant_id, new.id, new.customer_id,
    jsonb_build_object(
      'event_type', 'subscription.updated',
      'data', jsonb_build_object(
        'billing_customer_id', coalesce(v_customer.customer_number, new.customer_id::text),
        'name',         coalesce(v_customer.contact_name, v_customer.name),
        'email',        v_customer.contact_email,
        'domain',       coalesce(new.domain, v_customer.domain),
        'plan',         new.plan,
        'plan_status',  new.status,
        'plan_expiry',  new.renewal_date
      )
    )
  );

  return new;
end;
$$;

create trigger trg_queue_support_sync
  after insert or update of plan, status, renewal_date
  on public.subscriptions
  for each row
  when (new.vendor = 'support')
  execute function public.queue_support_sync();

grant execute on function public.queue_support_sync() to authenticated;

commit;
