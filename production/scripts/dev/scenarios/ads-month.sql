-- R-1957 scenario "ads-month" (R-1980) — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- Serves R-1980 "Sales by campaign": two ad campaigns with platform spend, five website orders paid this
-- month (one refunded, one monthly flex billed by subscription billing with NO quote on its invoice,
-- one paid in two halves, one not from any campaign) and one lead that did not buy.
-- Hand-worked numbers (src/lib/marketing/campaign-sales.test.ts has the same data):
--   SCN Workspace Oct  (scn-ws-oct, Meta)      spend 6,000 · 250 clicks · 3 leads · 2 paid · 11,000 · ROAS 1.83 · CAC 3,000
--   SCN Google Search  (scn-gads-search)       spend 4,000 ·  80 clicks · 2 leads · 1 paid · 20,000 · ROAS 5.00 · CAC 4,000
--   Not from an ad campaign                    1 lead · 1 paid · 2,000
-- Everything is dated inside the CURRENT month, so Marketing → ROAS & CAC → "This month" shows it.
--
-- Business triggers (activity log, contact auto-link, provisioning, trial convert, quote/invoice guards)
-- are for a user's actions; this is test data, so they are off on these tables while it loads
-- (transactional — a failure rolls it back) and on again at the end. Foreign keys and checks stay on.

alter table public.leads disable trigger user;
alter table public.quotes disable trigger user;
alter table public.invoices disable trigger user;
alter table public.payments disable trigger user;
alter table public.subscriptions disable trigger user;
alter table public.subscription_billings disable trigger user;

-- ── campaigns + ad accounts + what the platforms reported ──────────────────
insert into public.marketing_campaigns (id, tenant_id, name, code, start_date, end_date, budget, notes) values
  ('c1957000-0000-4000-8000-000000000401', :'tenant', 'SCN Workspace Oct', 'scn-ws-oct',
   date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date, 8000,
   'SCN scenario ads-month (R-1980)'),
  ('c1957000-0000-4000-8000-000000000402', :'tenant', 'SCN Google Search', 'scn-gads-search',
   date_trunc('month', current_date)::date, (date_trunc('month', current_date) + interval '1 month - 1 day')::date, 5000,
   'SCN scenario ads-month (R-1980)');

insert into public.ad_accounts (id, tenant_id, platform, account_id, name, enabled) values
  ('c1957000-0000-4000-8000-000000000411', :'tenant', 'meta-ads',   'SCN-ADS-META',   'SCN Meta account (local test)', false),
  ('c1957000-0000-4000-8000-000000000412', :'tenant', 'google-ads', 'SCN-ADS-GOOGLE', 'SCN Google account (local test)', false);

insert into public.ad_spend_daily (tenant_id, ad_account_id, day, campaign_id, campaign_name, spend, impressions, clicks) values
  (:'tenant', 'c1957000-0000-4000-8000-000000000411', date_trunc('month', current_date)::date + 1, 'SCN-META-1', 'scn-ws-oct', 3000, 6000, 150),
  (:'tenant', 'c1957000-0000-4000-8000-000000000411', date_trunc('month', current_date)::date + 2, 'SCN-META-1', 'scn-ws-oct', 2000, 4000, 100),
  -- Google names the campaign, not the code — matched by the campaign's name
  (:'tenant', 'c1957000-0000-4000-8000-000000000412', date_trunc('month', current_date)::date + 2, 'SCN-G-2', 'SCN Google Search', 4000, 2000, 80);

-- Costs booked against Workspace Oct: a designer (counts) and the Meta invoice (the platform's spend again — not added)
insert into public.expenses (id, tenant_id, category, vendor_name, expense_date, amount, gst_paid, bill_type, bill_no,
                             campaign_id, channel, paid, description) values
  ('EXP-SCN-ADS-1', :'tenant', 'Advertising & Marketing', 'SCN Ad Designer', date_trunc('month', current_date)::date + 1,
   1000, 0, 'none', 'SCN-ADS-1', 'c1957000-0000-4000-8000-000000000401', null, false,
   'SCN ads-month: creatives for Workspace Oct (R-1980 — adds to campaign spend)'),
  ('EXP-SCN-ADS-2', :'tenant', 'Advertising & Marketing', 'SCN Meta Platforms', date_trunc('month', current_date)::date + 3,
   4000, 0, 'none', 'SCN-ADS-2', 'c1957000-0000-4000-8000-000000000401', 'meta-ads', false,
   'SCN ads-month: Meta invoice for Workspace Oct (R-1980 — same money as the platform spend, not added)');

-- ── leads (website orders) ─────────────────────────────────────────────────
insert into public.leads (id, tenant_id, company, contact_name, contact_email, plan, seats, value, stage, source,
                          utm_source, utm_medium, utm_campaign, created_at, notes) values
  ('SCN-ADS-L1', :'tenant', 'SCN Ads Alpha Pvt Ltd',  'Asha',  'asha@scn-ads-alpha.example',  'Business Starter', 10, 10000, 'won',  'buy-workspace-direct', 'facebook', 'paid_social', 'scn-ws-oct',      date_trunc('month', current_date) + interval '1 day 5 hours', 'SCN ads-month (R-1980)'),
  ('SCN-ADS-L2', :'tenant', 'SCN Ads Beta Traders',   'Bala',  'bala@scn-ads-beta.example',   'Business Starter',  5,  5000, 'won',  'buy-workspace-direct', 'facebook', 'paid_social', 'scn-ws-oct',      date_trunc('month', current_date) + interval '2 days 5 hours', 'SCN ads-month (R-1980) — refunded'),
  ('SCN-ADS-L3', :'tenant', 'SCN Ads Gamma Studio',   'Gita',  'gita@scn-ads-gamma.example',  'Business Starter',  1,  1000, 'won',  'buy-workspace-direct', 'facebook', 'paid_social', 'scn-ws-oct',      date_trunc('month', current_date) + interval '3 days 5 hours', 'SCN ads-month (R-1980) — monthly flex'),
  ('SCN-ADS-L4', :'tenant', 'SCN Ads Delta Exports',  'Dev',   'dev@scn-ads-delta.example',   'Business Standard', 10, 20000, 'won', 'buy-workspace-direct', 'google',   'cpc',         'scn-gads-search', date_trunc('month', current_date) + interval '4 days 5 hours', 'SCN ads-month (R-1980) — paid in two halves'),
  ('SCN-ADS-L5', :'tenant', 'SCN Ads Epsilon Clinic', 'Esha',  'esha@scn-ads-epsilon.example', 'Business Starter',  2,  2000, 'won', 'buy-workspace-direct', null,       null,          null,              date_trunc('month', current_date) + interval '5 days 5 hours', 'SCN ads-month (R-1980) — no campaign'),
  ('SCN-ADS-L6', :'tenant', 'SCN Ads Zeta Labs',      'Zoya',  'zoya@scn-ads-zeta.example',   'Business Standard',  5, 10000, 'new', 'buy-workspace',        'google',   'cpc',         'scn-gads-search', date_trunc('month', current_date) + interval '6 days 5 hours', 'SCN ads-month (R-1980) — enquiry, not bought');

-- ── quotes (amounts incl 18% GST) ──────────────────────────────────────────
insert into public.quotes (id, tenant_id, customer_name, lead_id, plan, seats, amount, subtotal, tax_rate, status, billing_cycle, created_date, notes) values
  ('SCN-ADS-Q1', :'tenant', 'SCN Ads Alpha Pvt Ltd',  'SCN-ADS-L1', 'Business Starter', 10, 11800, 10000, 18, 'accepted', 'yearly',  date_trunc('month', current_date)::date + 1, 'SCN ads-month (R-1980)'),
  ('SCN-ADS-Q2', :'tenant', 'SCN Ads Beta Traders',   'SCN-ADS-L2', 'Business Starter',  5,  5900,  5000, 18, 'accepted', 'yearly',  date_trunc('month', current_date)::date + 2, 'SCN ads-month (R-1980)'),
  ('SCN-ADS-Q3', :'tenant', 'SCN Ads Gamma Studio',   'SCN-ADS-L3', 'Business Starter',  1,  1180,  1000, 18, 'accepted', 'monthly', date_trunc('month', current_date)::date + 3, 'SCN ads-month (R-1980) — monthly flex'),
  ('SCN-ADS-Q4', :'tenant', 'SCN Ads Delta Exports',  'SCN-ADS-L4', 'Business Standard', 10, 23600, 20000, 18, 'accepted', 'yearly', date_trunc('month', current_date)::date + 4, 'SCN ads-month (R-1980)'),
  ('SCN-ADS-Q5', :'tenant', 'SCN Ads Epsilon Clinic', 'SCN-ADS-L5', 'Business Starter',  2,  2360,  2000, 18, 'accepted', 'yearly',  date_trunc('month', current_date)::date + 5, 'SCN ads-month (R-1980)');

-- Q1's GST invoice; the flex month's invoice from subscription billing has NO quote_id
insert into public.invoices (id, tenant_id, customer_name, quote_id, amount, taxable_value, tax_amount, tax_rate, status, invoice_date, paid_amount) values
  ('SCN-ADS-INV1', :'tenant', 'SCN Ads Alpha Pvt Ltd', 'SCN-ADS-Q1', 11800, 10000, 1800, 18, 'paid', date_trunc('month', current_date)::date + 7, 11800),
  ('SCN-ADS-INV3', :'tenant', 'SCN Ads Gamma Studio',  null,          1180,  1000,  180, 18, 'paid', date_trunc('month', current_date)::date + 9, 1180);
update public.quotes set invoice_id = 'SCN-ADS-INV1' where id = 'SCN-ADS-Q1' and tenant_id = :'tenant';

insert into public.subscriptions (id, tenant_id, customer_name, domain, plan, vendor, seats, mrr, start_date, renewal_date,
                                  status, billing_cycle, term_months, quote_id) values
  ('c1957000-0000-4000-8000-000000000431', :'tenant', 'SCN Ads Gamma Studio', 'scn-ads-gamma.example', 'Business Starter', 'google',
   1, 1000, date_trunc('month', current_date)::date + 3, (date_trunc('month', current_date) + interval '1 month 3 days')::date,
   'active', 'monthly', 1, 'SCN-ADS-Q3');
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end,
                                          taxable_amount, tax_rate, invoice_id) values
  ('c1957000-0000-4000-8000-000000000432', :'tenant', 'c1957000-0000-4000-8000-000000000431',
   date_trunc('month', current_date)::date + 3, 0, date_trunc('month', current_date)::date + 9,
   date_trunc('month', current_date)::date + 3, (date_trunc('month', current_date) + interval '1 month 2 days')::date,
   1000, 18, 'SCN-ADS-INV3');

-- ── payments ───────────────────────────────────────────────────────────────
insert into public.payments (id, tenant_id, quote_id, invoice_id, amount, method, reference, status, received_at, refunded_at, refund_reason, notes) values
  ('c1957000-0000-4000-8000-000000000441', :'tenant', 'SCN-ADS-Q1', 'SCN-ADS-INV1', 11800, 'razorpay', 'SCN-ADS-PAY1', 'received',
   date_trunc('month', current_date) + interval '7 days 6 hours', null, null, 'SCN ads-month (R-1980)'),
  ('c1957000-0000-4000-8000-000000000442', :'tenant', 'SCN-ADS-Q2', null, 5900, 'razorpay', 'SCN-ADS-PAY2', 'refunded',
   date_trunc('month', current_date) + interval '8 days 6 hours', date_trunc('month', current_date) + interval '11 days 6 hours',
   'SCN: customer cancelled', 'SCN ads-month (R-1980) — refunded'),
  ('c1957000-0000-4000-8000-000000000443', :'tenant', null, 'SCN-ADS-INV3', 1180, 'razorpay', 'SCN-ADS-PAY3', 'received',
   date_trunc('month', current_date) + interval '9 days 6 hours', null, null, 'SCN ads-month (R-1980) — monthly flex'),
  ('c1957000-0000-4000-8000-000000000444', :'tenant', 'SCN-ADS-Q4', null, 11800, 'bank_transfer', 'SCN-ADS-PAY4A', 'received',
   date_trunc('month', current_date) + interval '10 days 6 hours', null, null, 'SCN ads-month (R-1980) — first half'),
  ('c1957000-0000-4000-8000-000000000445', :'tenant', 'SCN-ADS-Q4', null, 11800, 'bank_transfer', 'SCN-ADS-PAY4B', 'received',
   date_trunc('month', current_date) + interval '12 days 6 hours', null, null, 'SCN ads-month (R-1980) — second half'),
  ('c1957000-0000-4000-8000-000000000446', :'tenant', 'SCN-ADS-Q5', null, 2360, 'upi', 'SCN-ADS-PAY5', 'received',
   date_trunc('month', current_date) + interval '13 days 6 hours', null, null, 'SCN ads-month (R-1980)');

alter table public.leads enable trigger user;
alter table public.quotes enable trigger user;
alter table public.invoices enable trigger user;
alter table public.payments enable trigger user;
alter table public.subscriptions enable trigger user;
alter table public.subscription_billings enable trigger user;
