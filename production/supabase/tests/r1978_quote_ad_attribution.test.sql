-- R-1978 (26 Oct 2026, G-ADS): ad attribution on the ORDER.
-- Migration 20261026121125_r1978_quote_ad_attribution.sql adds utm_content / utm_term to leads
-- and the attribution set to quotes; a subscription reads it through subscriptions.quote_id.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Proves (fails without the migration — the columns do not exist):
--   A. a lead keeps utm_content + utm_term (Meta ad + keyword);
--   B. an online-order quote keeps utm_source/medium/campaign/content/term, fbclid, gclid,
--      landing_page_url, referrer_url;
--   C. the subscription that payment made for that quote reads the same attribution by
--      subscriptions.quote_id → quotes (no copy, one place);
--   D. a quote raised in the app carries none of it (NULL = nothing captured).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code)
  values ('dddddddd-0000-0000-0000-000000197801', 'R1978 TEST', 'r1978@example.in', '07');
insert into public.customers (id, tenant_id, name)
  values ('cccccccc-0000-0000-0000-000000197801', 'dddddddd-0000-0000-0000-000000197801', 'Ravi Traders');

insert into public.leads (id, tenant_id, company, contact_name, stage, source,
                          utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid)
  values ('L-R1978-1', 'dddddddd-0000-0000-0000-000000197801', 'Ravi Traders', 'Ravi', 'quote', 'buy-workspace-direct',
          'facebook', 'paid_social', 'ws-oct', 'ad1', 'google workspace price', 'fbclid-X');

insert into public.quotes (id, tenant_id, customer_id, customer_name, lead_id, amount, status, payment_status, line_items,
                           utm_source, utm_medium, utm_campaign, utm_content, utm_term, fbclid, gclid,
                           landing_page_url, referrer_url)
  values ('Q-R1978-ONLINE', 'dddddddd-0000-0000-0000-000000197801', 'cccccccc-0000-0000-0000-000000197801', 'Ravi Traders',
          'L-R1978-1', 3823, 'sent', 'awaiting',
          '[{"name":"Google Workspace Business Starter","qty":1,"rate":3240,"commitment":"annual_yearly"}]'::jsonb,
          'facebook', 'paid_social', 'ws-oct', 'ad1', 'google workspace price', 'fbclid-X', null,
          'https://example.in/buy/workspace?utm_source=facebook&utm_campaign=ws-oct', 'https://l.facebook.com/');

insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, status, payment_status, line_items)
  values ('Q-R1978-APP', 'dddddddd-0000-0000-0000-000000197801', 'cccccccc-0000-0000-0000-000000197801', 'Ravi Traders',
          3823, 'sent', 'awaiting', '[]'::jsonb);

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, renewal_date, quote_id)
  values ('eeeeeeee-0000-0000-0000-000000197801', 'dddddddd-0000-0000-0000-000000197801', 'cccccccc-0000-0000-0000-000000197801',
          'Ravi Traders', 'Google Workspace Business Starter', 'google', 1, 270, 'active',
          (current_date + interval '1 year')::date, 'Q-R1978-ONLINE');

do $$
declare
  l record; q record; s record; a record;
begin
  select utm_content, utm_term into l from public.leads where id = 'L-R1978-1';
  if l.utm_content is distinct from 'ad1' or l.utm_term is distinct from 'google workspace price' then
    raise exception 'A FAIL: lead utm_content/utm_term not kept (%, %)', l.utm_content, l.utm_term;
  end if;

  select * into q from public.quotes where id = 'Q-R1978-ONLINE';
  if q.utm_source is distinct from 'facebook' or q.utm_medium is distinct from 'paid_social'
     or q.utm_campaign is distinct from 'ws-oct' or q.utm_content is distinct from 'ad1'
     or q.utm_term is distinct from 'google workspace price' or q.fbclid is distinct from 'fbclid-X'
     or q.landing_page_url is null or q.referrer_url is distinct from 'https://l.facebook.com/' then
    raise exception 'B FAIL: quote attribution not kept';
  end if;

  select qq.utm_source, qq.utm_campaign, qq.utm_content, qq.fbclid into s
    from public.subscriptions sub join public.quotes qq on qq.id = sub.quote_id and qq.tenant_id = sub.tenant_id
   where sub.id = 'eeeeeeee-0000-0000-0000-000000197801';
  if s.utm_source is distinct from 'facebook' or s.utm_campaign is distinct from 'ws-oct'
     or s.utm_content is distinct from 'ad1' or s.fbclid is distinct from 'fbclid-X' then
    raise exception 'C FAIL: subscription cannot read its order''s attribution through quote_id';
  end if;

  select utm_source, utm_content, fbclid, landing_page_url into a from public.quotes where id = 'Q-R1978-APP';
  if a.utm_source is not null or a.utm_content is not null or a.fbclid is not null or a.landing_page_url is not null then
    raise exception 'D FAIL: an app quote got attribution it never had';
  end if;
end $$;

select 'R-1978 lead + quote ad attribution, subscription reads it via quote_id: ALL PASS' as result;

rollback;
