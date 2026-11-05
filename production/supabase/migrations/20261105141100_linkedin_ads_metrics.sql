-- deploy-peek: to_regclass('public.linkedin_ad_metrics') is not null
-- deploy-key: linkedinadsmetrics
-- LinkedIn Campaign Manager metrics entered from its report while Advertising API access is pending.
create table if not exists public.linkedin_ad_metrics (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  day date not null,
  campaign_name text not null,
  spend numeric(14,2) not null default 0 check (spend >= 0),
  impressions integer not null default 0 check (impressions >= 0),
  clicks integer not null default 0 check (clicks >= 0),
  leads integer not null default 0 check (leads >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, day, campaign_name)
);

alter table public.linkedin_ad_metrics enable row level security;
create policy "tenant isolation read" on public.linkedin_ad_metrics for select to authenticated using (tenant_id = public.current_tenant_id());
create policy "service role all" on public.linkedin_ad_metrics as permissive for all to service_role using (true) with check (true);
create index if not exists linkedin_ad_metrics_tenant_day_idx on public.linkedin_ad_metrics (tenant_id, day desc);
