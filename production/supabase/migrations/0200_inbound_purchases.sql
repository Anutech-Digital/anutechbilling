-- 0200 — Inbound purchase capture (Amazon & co.) staging table.
--
-- Amazon (and similar) send an order/invoice email for every purchase. A Gmail
-- filter forwards those to /api/webhooks/inbound-purchase, which parses them
-- (Gemini) and drops a PENDING row here. Nothing touches expenses / P&L / GST
-- until the owner reviews it and clicks "Add to expenses" — money stays correct
-- and human-in-loop. Idempotent on (tenant, message_id).

create table if not exists public.inbound_purchases (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  source       text not null default 'amazon',          -- 'amazon' | 'other'
  message_id   text,                                     -- provider message id (dedupe)
  order_id     text,                                     -- Amazon order id (dedupe / display)
  from_email   text,
  subject      text,
  order_date   date,
  currency     text not null default 'INR',
  total        numeric(14,2),                            -- gross ₹ (incl. GST)
  gst          numeric(14,2),                            -- ₹ input credit
  items        jsonb not null default '[]'::jsonb,       -- [{name, qty, amount}]
  raw_text     text,
  status       text not null default 'pending'
                 check (status in ('pending','imported','ignored')),
  expense_id   text references public.expenses(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, message_id)
);

create index if not exists inbound_purchases_tenant_status_idx
  on public.inbound_purchases (tenant_id, status, created_at desc);

alter table public.inbound_purchases enable row level security;

-- Owner reads + updates (review / ignore) their own tenant's rows. Inserts come
-- from the service-role webhook (bypasses RLS).
drop policy if exists inbound_purchases_select on public.inbound_purchases;
create policy inbound_purchases_select on public.inbound_purchases
  for select using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop policy if exists inbound_purchases_update on public.inbound_purchases;
create policy inbound_purchases_update on public.inbound_purchases
  for update using (tenant_id = (select tenant_id from public.users where id = auth.uid()));

drop trigger if exists trg_inbound_purchases_updated_at on public.inbound_purchases;
create trigger trg_inbound_purchases_updated_at
  before update on public.inbound_purchases
  for each row execute function public.handle_updated_at();
