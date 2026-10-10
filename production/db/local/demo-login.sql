-- LOCAL ONLY demo login for the no-VM app (npm run db:local, then the "ResellerOS (no VM)"
-- launch config on http://localhost:3001). Never run against a real database.
--
--   Email:    owner@demo.test
--   Password: demo-password-123
--
--   docker exec -i ros-pg psql -U postgres -d ros < production/db/local/demo-login.sql
begin;
set local session_replication_role = replica;
insert into public.tenants (id, name, email, doc_code)
  values ('d0000000-0000-4000-8000-000000000001', 'Demo Cloud Reseller', 'owner@demo.test', 'DEMO')
  on conflict (id) do nothing;
insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data)
  values ('d0000000-0000-4000-8000-0000000000aa', 'owner@demo.test', crypt('demo-password-123', gen_salt('bf', 10)),
          now(), 'authenticated', 'authenticated', '{"full_name":"Demo Owner"}')
  on conflict (id) do nothing;
insert into public.users (id, tenant_id, email, full_name, initials, role, color)
  values ('d0000000-0000-4000-8000-0000000000aa', 'd0000000-0000-4000-8000-000000000001',
          'owner@demo.test', 'Demo Owner', 'DO', 'owner', 'indigo')
  on conflict (id) do nothing;
commit;
