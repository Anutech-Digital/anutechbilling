-- R-1979 (26 Oct 2026, G-ADS): Meta Pixel settings on tenant_secrets.
-- Migration 20261026174905_r1979_meta_pixel_secrets.sql. Self-asserting, ONE transaction,
-- rolled back. Run on a dev/test DB only.
-- Proves (fails without the migration — the columns do not exist):
--   A. a tenant's pixel id, sealed CAPI token and test code are stored per tenant;
--   B. another tenant's row is untouched (one row per tenant, tenant_id key).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('dddddddd-0000-0000-0000-000000197901', 'R1979 A', 'r1979a@example.in', '07'),
  ('dddddddd-0000-0000-0000-000000197902', 'R1979 B', 'r1979b@example.in', '07');

insert into public.tenant_secrets (tenant_id, meta_pixel_id, meta_capi_token, meta_test_event_code)
  values ('dddddddd-0000-0000-0000-000000197901', '1234567890123456', 'rosv1:sealed-token', 'TEST123')
  on conflict (tenant_id) do update set meta_pixel_id = excluded.meta_pixel_id,
    meta_capi_token = excluded.meta_capi_token, meta_test_event_code = excluded.meta_test_event_code;
insert into public.tenant_secrets (tenant_id) values ('dddddddd-0000-0000-0000-000000197902')
  on conflict (tenant_id) do nothing;

do $$
declare a record; b record;
begin
  select meta_pixel_id, meta_capi_token, meta_test_event_code into a
    from public.tenant_secrets where tenant_id = 'dddddddd-0000-0000-0000-000000197901';
  if a.meta_pixel_id is distinct from '1234567890123456' or a.meta_capi_token is distinct from 'rosv1:sealed-token'
     or a.meta_test_event_code is distinct from 'TEST123' then
    raise exception 'A FAIL: Meta settings not kept';
  end if;
  select meta_pixel_id, meta_capi_token into b
    from public.tenant_secrets where tenant_id = 'dddddddd-0000-0000-0000-000000197902';
  if b.meta_pixel_id is not null or b.meta_capi_token is not null then
    raise exception 'B FAIL: another tenant got a pixel';
  end if;
end $$;

select 'R-1979 Meta pixel settings per tenant: ALL PASS' as result;

rollback;
