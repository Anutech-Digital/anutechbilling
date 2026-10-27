-- R-1981 (26 Oct 2026, G-ADS): one name per website lead source + a coupon can belong to a
-- marketing campaign. Migration: 20261026*_r1981_lead_source_website_coupon_campaign.sql.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
-- Proves (fails without the migration — lead_source_key returns the raw code, and
-- coupons.campaign_id does not exist):
--   A. lead_source_key maps the website checkout codes to website-order / website-order-test /
--      website-trial, and buy-workspace to buy-workspace-v2; labels read "Website order" …
--      The saved leads.source is NOT changed (read-time only).
--   B. a coupon can point at its own company's campaign; NULL stays allowed.
--   C. a coupon cannot point at ANOTHER company's campaign.
--   D. deleting the campaign keeps the coupon (campaign_id becomes NULL).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('dddddddd-0000-0000-0000-000000198101', 'R1981 TEST', 'r1981@example.in', '07'),
  ('dddddddd-0000-0000-0000-000000198102', 'R1981 OTHER', 'r1981b@example.in', '07');

insert into public.leads (id, tenant_id, company, stage, source) values
  ('L-R1981-1', 'dddddddd-0000-0000-0000-000000198101', 'Ravi Traders', 'new', 'buy-workspace-direct'),
  ('L-R1981-2', 'dddddddd-0000-0000-0000-000000198101', 'Mehta & Co',   'new', 'buy-cart-direct'),
  ('L-R1981-3', 'dddddddd-0000-0000-0000-000000198101', 'Test Order',   'new', 'buy-workspace-direct-sim'),
  ('L-R1981-4', 'dddddddd-0000-0000-0000-000000198101', 'Trial Co',     'new', 'buy-workspace-trial');

insert into public.marketing_campaigns (id, tenant_id, name, code, start_date, end_date, budget) values
  ('aaaaaaaa-0000-0000-0000-000000198101', 'dddddddd-0000-0000-0000-000000198101', 'Diwali offer', 'diwali-26', '2026-10-01', '2026-10-31', 20000),
  ('aaaaaaaa-0000-0000-0000-000000198102', 'dddddddd-0000-0000-0000-000000198102', 'Other co',     'other-26',  '2026-10-01', '2026-10-31', 0);

do $$
declare
  v_keys jsonb;
  v_err  boolean := false;
  v_cid  uuid;
begin
  -- A
  select jsonb_object_agg(k, n) into v_keys
    from (select public.lead_source_key(source) k, count(*) n from public.leads
           where tenant_id = 'dddddddd-0000-0000-0000-000000198101' group by 1) x;
  if v_keys is distinct from '{"website-order": 2, "website-order-test": 1, "website-trial": 1}'::jsonb then
    raise exception 'A FAIL: by-source keys %', v_keys;
  end if;
  if public.lead_source_key('website-trial') <> 'website-trial'
     or public.lead_source_key('buy-hosting-trial') <> 'website-trial'
     or public.lead_source_key('buy-cart-direct-sim') <> 'website-order-test'
     or public.lead_source_key('buy-workspace') <> 'buy-workspace-v2'
     or public.lead_source_key(' Website Order ') <> 'website-order'
     or public.lead_source_key('meta-ads') <> 'meta-ads'
     or public.lead_source_key('old-partner-form') <> 'old-partner-form' then
    raise exception 'A FAIL: lead_source_key mapping';
  end if;
  if public.lead_source_label('website-order') is distinct from 'Website order'
     or public.lead_source_label('website-order-test') is distinct from 'Website order (test)'
     or public.lead_source_label('website-trial') is distinct from 'Website trial' then
    raise exception 'A FAIL: labels';
  end if;
  if (select source from public.leads where id = 'L-R1981-1') <> 'buy-workspace-direct' then
    raise exception 'A FAIL: saved source changed';
  end if;

  -- B
  insert into public.coupons (tenant_id, code, discount_value, campaign_id)
    values ('dddddddd-0000-0000-0000-000000198101', 'R1981DIWALI', 10, 'aaaaaaaa-0000-0000-0000-000000198101');
  insert into public.coupons (tenant_id, code, discount_value)
    values ('dddddddd-0000-0000-0000-000000198101', 'R1981PLAIN', 5);
  if (select campaign_id from public.coupons where code = 'R1981PLAIN') is not null then
    raise exception 'B FAIL: campaign must default to NULL';
  end if;

  -- C
  begin
    insert into public.coupons (tenant_id, code, discount_value, campaign_id)
      values ('dddddddd-0000-0000-0000-000000198101', 'R1981CROSS', 10, 'aaaaaaaa-0000-0000-0000-000000198102');
  exception when others then v_err := true;
  end;
  if not v_err then raise exception 'C FAIL: coupon linked to another company''s campaign'; end if;
  v_err := false;
  begin
    update public.coupons set campaign_id = 'aaaaaaaa-0000-0000-0000-000000198102' where code = 'R1981PLAIN';
  exception when others then v_err := true;
  end;
  if not v_err then raise exception 'C FAIL: coupon moved to another company''s campaign'; end if;

  -- D
  delete from public.marketing_campaigns where id = 'aaaaaaaa-0000-0000-0000-000000198101';
  select campaign_id into v_cid from public.coupons where code = 'R1981DIWALI';
  if not found then raise exception 'D FAIL: coupon deleted with its campaign'; end if;
  if v_cid is not null then raise exception 'D FAIL: campaign_id not cleared'; end if;

  raise notice 'R-1981 coupon campaign + website lead sources: ALL PASS';
end $$;

rollback;
