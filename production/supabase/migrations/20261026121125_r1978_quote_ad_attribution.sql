-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'utm_content') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'leads' and column_name = 'utm_term')
-- deploy-key: r1978quoteadattribution
-- 20261026121125_r1978_quote_ad_attribution.sql
--
-- R-1978 (26 Oct 2026, goal G-ADS): ad attribution reaches the ORDER, not only the lead.
--
-- Until now the inbound attribution (0232 marketing_attribution: utm_source/medium/campaign,
-- referrer_url, landing_page_url, gclid, wbraid, fbclid) was written to `leads` only. A paid
-- online order is a QUOTE (and, after payment, a subscription with quotes.id as its quote_id),
-- so "which ad sold this subscription?" had to go quote → lead → columns, and a quote raised
-- without a lead row had nothing. Meta ads also tag the AD and the KEYWORD (utm_content,
-- utm_term), which nothing stored.
--
--   1. leads  + utm_content, utm_term.
--   2. quotes + the same attribution set as leads (utm_source, utm_medium, utm_campaign,
--      utm_content, utm_term, referrer_url, landing_page_url, gclid, wbraid, fbclid).
--      The simplest right way for a subscription to read it: subscriptions.quote_id → quotes
--      (supabase/tests/r1978_quote_ad_attribution.test.sql). No copy on subscriptions — one fact,
--      one place; the subscription already points at its quote.
--
-- All nullable, no default: a quote typed in the app was never clicked from an ad, and NULL
-- means "nothing captured" — never "unknown". Values are cleaned before they arrive
-- (src/lib/marketing/utm.ts: path + utm params only, referrer without its query — DPDP).
-- Additive only; no data is changed. Idempotent (if not exists).

begin;

alter table public.leads
  add column if not exists utm_content text,
  add column if not exists utm_term    text;

comment on column public.leads.utm_content is 'utm_content from the landing URL — which ad / creative (R-1978). NULL = not tagged.';
comment on column public.leads.utm_term    is 'utm_term from the landing URL — the keyword (R-1978). NULL = not tagged.';

alter table public.quotes
  add column if not exists utm_source       text,
  add column if not exists utm_medium       text,
  add column if not exists utm_campaign     text,
  add column if not exists utm_content      text,
  add column if not exists utm_term         text,
  add column if not exists referrer_url     text,
  add column if not exists landing_page_url text,
  add column if not exists gclid            text,
  add column if not exists wbraid           text,
  add column if not exists fbclid           text;

comment on column public.quotes.utm_source       is 'R-1978: ad attribution of an ONLINE order (website checkout), same cleaning as leads.utm_source. NULL for quotes raised in the app. A subscription reads it through subscriptions.quote_id.';
comment on column public.quotes.utm_medium       is 'R-1978: utm_medium of the online order.';
comment on column public.quotes.utm_campaign     is 'R-1978: utm_campaign of the online order.';
comment on column public.quotes.utm_content      is 'R-1978: utm_content (the ad / creative) of the online order.';
comment on column public.quotes.utm_term         is 'R-1978: utm_term (the keyword) of the online order.';
comment on column public.quotes.referrer_url     is 'R-1978: where the buyer came from — origin + path only (query stripped).';
comment on column public.quotes.landing_page_url is 'R-1978: the landing page — path + utm params only (other query params dropped, DPDP).';
comment on column public.quotes.gclid            is 'R-1978: Google Ads click id of the online order (offline conversion import).';
comment on column public.quotes.wbraid           is 'R-1978: Google cookieless click id of the online order.';
comment on column public.quotes.fbclid           is 'R-1978: Meta click id of the online order (Conversions API fbc).';

-- "Sales by campaign": paid online orders grouped by source — partial, small.
create index if not exists quotes_utm_source_idx
  on public.quotes (tenant_id, utm_source, created_date)
  where utm_source is not null;

commit;
