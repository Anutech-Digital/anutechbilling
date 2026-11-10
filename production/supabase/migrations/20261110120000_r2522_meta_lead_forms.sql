-- deploy-peek: to_regclass('public.meta_lead_forms') is not null
-- deploy-key: r2522metaleadforms
-- R-2522: which Facebook / Instagram lead forms a company brings into Sales → Leads. A form can sit
-- on any Page the connected Meta Ads login manages (e.g. a brand Page that is not the posting Page).
-- No token is stored here: page tokens are fetched at pull time through the Meta Ads login.
begin;

create table if not exists public.meta_lead_forms (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  form_id text not null check (form_id ~ '^[0-9]{1,30}$'),
  page_id text not null check (page_id ~ '^[0-9]{1,30}$'),
  page_name text not null default '' check (char_length(page_name) <= 300),
  form_name text not null default '' check (char_length(form_name) <= 300),
  enabled boolean not null default true,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  last_pulled_at timestamptz,
  last_result text check (last_result is null or char_length(last_result) <= 500),
  primary key (tenant_id, form_id)
);

alter table public.meta_lead_forms enable row level security;
create policy meta_lead_forms_read on public.meta_lead_forms for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager','marketing')));
create policy meta_lead_forms_manage on public.meta_lead_forms for all to authenticated
  using (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager')))
  with check (tenant_id = (select public.current_tenant_id()) and (select public.current_user_has_role('owner','manager')));
create policy zzz_service_role_all on public.meta_lead_forms for all to service_role using (true) with check (true);
revoke all on public.meta_lead_forms from public, anon;
grant select, insert, update, delete on public.meta_lead_forms to authenticated, service_role;
commit;
