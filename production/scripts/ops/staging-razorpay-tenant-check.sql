-- 26 Oct 2026 — READ-ONLY. Why /buy/workspace on staging shows no "Buy now" although Settings shows
-- Razorpay "TEST · Accepting payments": the buy page reads tenant_secrets of tenant
-- fbb976f1-9090-4f10-9726-0901bd144e42 (BUY_PAGE_TENANT_ID is unset on staging). This shows which
-- tenant actually holds the keys. Prints ids, names, the first 9 chars of the key id ("rzp_test_")
-- and whether a secret is stored and sealed — never a secret value.
--
--   gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
--   \i scripts/ops/staging-razorpay-tenant-check.sql
begin;
set transaction read only;

select '1. Anutech by GSTIN' as section, id, name, gstin,
       (id = 'fbb976f1-9090-4f10-9726-0901bd144e42') as is_buy_page_tenant
from tenants where gstin = '07ABDCA0298H1ZP';

select '2. Tenants holding Razorpay keys' as section, s.tenant_id, t.name,
       left(s.razorpay_key_id, 9)                     as key_prefix,
       (s.razorpay_key_secret is not null)            as has_secret,
       (s.razorpay_key_secret like 'rosv1:%')         as secret_sealed,
       (s.tenant_id = 'fbb976f1-9090-4f10-9726-0901bd144e42') as is_buy_page_tenant,
       s.updated_at
from tenant_secrets s join tenants t on t.id = s.tenant_id
where s.razorpay_key_id is not null
order by s.updated_at desc;

select '3. Buy-page tenant exists?' as section, count(*) as rows
from tenants where id = 'fbb976f1-9090-4f10-9726-0901bd144e42';

rollback;
