-- 0191 — Map every app "person" to its Google Contacts resourceName, per user.
--
-- The Contacts page shows people from THREE sources: standalone contacts, leads,
-- and customers. Pardeep wants ALL of them on his phone (two-way). Rather than
-- add google_* columns to leads AND customers (money tables), we keep a single
-- per-user link table: (user, source_type, source_id) ↔ Google resourceName.
-- This prevents duplicate creation on re-sync and lets us update in place, and
-- keeps the leads/customers schemas untouched.
--
-- Per-USER (not per-tenant): each team member syncs the tenant's people into
-- THEIR OWN Google account, so the same lead maps to a different resourceName
-- for each user. Service-role only (RLS deny-all), same as user_google_tokens.

create table if not exists public.google_contact_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  user_id       uuid not null references public.users(id) on delete cascade,
  source_type   text not null check (source_type in ('contact', 'lead', 'customer')),
  source_id     text not null,
  resource_name text not null,
  etag          text,
  synced_at     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, source_type, source_id),
  unique (user_id, resource_name)
);

create index if not exists google_contact_links_tenant_idx on public.google_contact_links (tenant_id);

alter table public.google_contact_links enable row level security;
-- No policies → service-role (admin client) only.

drop trigger if exists trg_google_contact_links_updated_at on public.google_contact_links;
create trigger trg_google_contact_links_updated_at
  before update on public.google_contact_links
  for each row execute function public.handle_updated_at();

-- Carry over links already recorded on contacts.external_id (from the v1 engine)
-- so the switch to this table doesn't re-create those Google contacts.
insert into public.google_contact_links (tenant_id, user_id, source_type, source_id, resource_name, etag)
select c.tenant_id, t.user_id, 'contact', c.id, c.external_id, c.google_etag
  from public.contacts c
  join public.user_google_tokens t on t.tenant_id = c.tenant_id
 where c.external_id is not null
on conflict do nothing;

comment on table public.google_contact_links is 'Per-user link: app person (contact/lead/customer) ↔ Google Contacts resourceName. Service-role only.';
