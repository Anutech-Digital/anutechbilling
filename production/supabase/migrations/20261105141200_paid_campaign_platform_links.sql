-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'marketing_campaigns' and column_name = 'ads_manager_url')
-- deploy-key: paidcampaignplatformlinks
-- A paid campaign can point back to the exact campaign in its ad platform.
-- `code` remains the UTM campaign value used to join leads and revenue.
alter table public.marketing_campaigns
  add column if not exists ad_platform text,
  add column if not exists ads_manager_url text;

alter table public.marketing_campaigns
  drop constraint if exists marketing_campaigns_ad_platform_check;

alter table public.marketing_campaigns
  add constraint marketing_campaigns_ad_platform_check
  check (ad_platform is null or ad_platform in ('google-ads', 'meta-ads', 'linkedin-ads'));

alter table public.marketing_campaigns
  drop constraint if exists marketing_campaigns_ads_manager_url_check;

alter table public.marketing_campaigns
  add constraint marketing_campaigns_ads_manager_url_check
  check (ads_manager_url is null or ads_manager_url ~ '^https?://');

comment on column public.marketing_campaigns.ad_platform is
  'Ad platform that owns this campaign: Google, Meta, or LinkedIn.';
comment on column public.marketing_campaigns.ads_manager_url is
  'Optional direct HTTPS link to this exact campaign in the external Ads Manager.';
