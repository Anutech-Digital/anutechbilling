-- deploy-peek: (exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'coupons' and column_name = 'campaign_id') and exists(select 1 from pg_proc where proname = 'lead_source_key' and pronamespace = 'public'::regnamespace and prosrc like '%website-order%'))
-- deploy-key: r1981couponcampaign
-- 20261026154613_r1981_lead_source_website_coupon_campaign.sql
--
-- R-1981 (26 Oct 2026, goal G-ADS).
--
--   1. Lead sources written by the website itself get one name each, at READ time:
--        buy-workspace-direct, buy-cart-direct            -> website-order       "Website order"
--        buy-workspace-direct-sim, buy-cart-direct-sim    -> website-order-test  "Website order (test)"
--        buy-workspace-trial, buy-hosting-trial,
--        website-trial                                    -> website-trial       "Website trial"
--        buy-workspace (buy-page enquiry)                 -> buy-workspace-v2    "Buy Workspace page"
--      public.lead_source_key / lead_source_label are 20261007190000's (R-392) with these entries
--      added — TS twin lib/leads/lead-sources.ts (LEAD_SOURCES + aliases); the twin test
--      src/lib/leads/lead-source-search-sql.test.ts reads the NEWEST definition. Same signatures,
--      still immutable; list_leads / lead_counts / lead_search_hit call them unchanged.
--      NO data repair: leads.source keeps the raw code (Online Orders and the trial clock read it).
--
--   2. coupons.campaign_id — optional link to the marketing campaign the code was made for
--      (same shape as expenses.campaign_id, 20260926240000). ON DELETE SET NULL: deleting a
--      campaign never deletes a coupon customers may hold. A trigger refuses another company's
--      campaign (the FK alone would accept a foreign id typed into an API call).
--
-- Additive; no row is changed. Idempotent.

create or replace function public.lead_source_key(p_source text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case
    when lower(btrim(coalesce(p_source, ''))) in ('google-ads', 'google ads') then 'google-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('meta-ads', 'facebook / instagram ads') then 'meta-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('linkedin-ads', 'linkedin ads') then 'linkedin-ads'
    when lower(btrim(coalesce(p_source, ''))) in ('indiamart', 'indiamart') then 'indiamart'
    when lower(btrim(coalesce(p_source, ''))) in ('justdial', 'justdial') then 'justdial'
    when lower(btrim(coalesce(p_source, ''))) in ('google-organic', 'google search / seo') then 'google-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('meta-organic', 'facebook / instagram page (organic)') then 'meta-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('linkedin-organic', 'linkedin (organic)') then 'linkedin-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('youtube-organic', 'youtube') then 'youtube-organic'
    when lower(btrim(coalesce(p_source, ''))) in ('enquiry-form', 'website enquiry form') then 'enquiry-form'
    when lower(btrim(coalesce(p_source, ''))) in ('buy-workspace-v2', 'buy workspace page', 'buy-workspace') then 'buy-workspace-v2'
    when lower(btrim(coalesce(p_source, ''))) in ('website-order', 'website order', 'buy-workspace-direct', 'buy-cart-direct') then 'website-order'
    when lower(btrim(coalesce(p_source, ''))) in ('website-order-test', 'website order (test)', 'buy-workspace-direct-sim', 'buy-cart-direct-sim') then 'website-order-test'
    when lower(btrim(coalesce(p_source, ''))) in ('website-trial', 'website trial', 'buy-workspace-trial', 'buy-hosting-trial') then 'website-trial'
    when lower(btrim(coalesce(p_source, ''))) in ('whatsapp', 'whatsapp') then 'whatsapp'
    when lower(btrim(coalesce(p_source, ''))) in ('referral', 'referral') then 'referral'
    when lower(btrim(coalesce(p_source, ''))) in ('tele-calling', 'tele calling') then 'tele-calling'
    when lower(btrim(coalesce(p_source, ''))) in ('email-outreach', 'email outreach') then 'email-outreach'
    when lower(btrim(coalesce(p_source, ''))) in ('email-inbound', 'email (inbound)') then 'email-inbound'
    when lower(btrim(coalesce(p_source, ''))) in ('trade-show', 'trade show / event') then 'trade-show'
    when lower(btrim(coalesce(p_source, ''))) in ('walk-in', 'walk-in / office visit') then 'walk-in'
    when lower(btrim(coalesce(p_source, ''))) in ('ai-finder', 'ai lead finder') then 'ai-finder'
    when lower(btrim(coalesce(p_source, ''))) in ('manual', 'added manually') then 'manual'
    when lower(btrim(coalesce(p_source, ''))) in ('csv', 'csv import') then 'csv'
    else btrim(coalesce(p_source, ''))
  end
$fn$;

comment on function public.lead_source_key(text) is
  'R-392+R-1981: canonical lead source key (key, label or alias, any case -> key). TS twin: lib/leads/lead-sources.ts#canonicalSource.';

revoke all on function public.lead_source_key(text) from public;
revoke all on function public.lead_source_key(text) from anon;
grant execute on function public.lead_source_key(text) to authenticated;

create or replace function public.lead_source_label(p_key text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select case p_key
    when 'google-ads' then 'Google Ads'
    when 'meta-ads' then 'Facebook / Instagram Ads'
    when 'linkedin-ads' then 'LinkedIn Ads'
    when 'indiamart' then 'IndiaMART'
    when 'justdial' then 'JustDial'
    when 'google-organic' then 'Google search / SEO'
    when 'meta-organic' then 'Facebook / Instagram page (organic)'
    when 'linkedin-organic' then 'LinkedIn (organic)'
    when 'youtube-organic' then 'YouTube'
    when 'enquiry-form' then 'Website enquiry form'
    when 'buy-workspace-v2' then 'Buy Workspace page'
    when 'website-order' then 'Website order'
    when 'website-order-test' then 'Website order (test)'
    when 'website-trial' then 'Website trial'
    when 'whatsapp' then 'WhatsApp'
    when 'referral' then 'Referral'
    when 'tele-calling' then 'Tele calling'
    when 'email-outreach' then 'Email outreach'
    when 'email-inbound' then 'Email (inbound)'
    when 'trade-show' then 'Trade show / event'
    when 'walk-in' then 'Walk-in / office visit'
    when 'ai-finder' then 'AI Lead Finder'
    when 'manual' then 'Added manually'
    when 'csv' then 'CSV import'
    else null
  end
$fn$;

comment on function public.lead_source_label(text) is
  'R-392+R-1981: label for a canonical lead source key, null when unknown. TS twin: lib/leads/lead-sources.ts#LEAD_SOURCES.';

revoke all on function public.lead_source_label(text) from public;
revoke all on function public.lead_source_label(text) from anon;
grant execute on function public.lead_source_label(text) to authenticated;

-- ── coupons.campaign_id ─────────────────────────────────────────────────────
alter table public.coupons
  add column if not exists campaign_id uuid references public.marketing_campaigns(id) on delete set null;

comment on column public.coupons.campaign_id is
  'R-1981: optional marketing campaign this code was made for (marketing_campaigns.code = utm_campaign). NULL = no campaign.';

create index if not exists coupons_campaign_idx on public.coupons (tenant_id, campaign_id) where campaign_id is not null;

create or replace function public.tg_coupon_campaign_same_tenant()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.campaign_id is not null and not exists (
    select 1 from public.marketing_campaigns c where c.id = new.campaign_id and c.tenant_id = new.tenant_id
  ) then
    raise exception 'Campaign not found for this company.';
  end if;
  return new;
end $$;

revoke all on function public.tg_coupon_campaign_same_tenant() from public;
revoke all on function public.tg_coupon_campaign_same_tenant() from anon;

drop trigger if exists trg_coupon_campaign_same_tenant on public.coupons;
create trigger trg_coupon_campaign_same_tenant
  before insert or update of campaign_id, tenant_id on public.coupons
  for each row execute function public.tg_coupon_campaign_same_tenant();
