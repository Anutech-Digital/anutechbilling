-- LOCAL ONLY extra demo logins (R-1791, 23 Oct 2026) — to try a flow as each role: the
-- Marketing budget (marketing asks, owner approves, billing pays). Never run against a real
-- database. Same tenant and password as demo-login.sql (run that first).
--
--   marketing@demo.test   role marketing   password demo-password-123
--   billing@demo.test     role billing     password demo-password-123
--
--   docker exec -i ros-pg psql -U postgres -d ros < production/db/local/demo-team-logins.sql
begin;
set local session_replication_role = replica;
insert into auth.users (id, email, encrypted_password, email_confirmed_at, aud, role, raw_user_meta_data)
  values
    ('d0000000-0000-4000-8000-0000000000b1', 'marketing@demo.test', crypt('demo-password-123', gen_salt('bf', 10)),
     now(), 'authenticated', 'authenticated', '{"full_name":"Demo Marketing"}'),
    ('d0000000-0000-4000-8000-0000000000b2', 'billing@demo.test', crypt('demo-password-123', gen_salt('bf', 10)),
     now(), 'authenticated', 'authenticated', '{"full_name":"Demo Billing"}')
  on conflict (id) do nothing;
insert into public.users (id, tenant_id, email, full_name, initials, role, color)
  values
    ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001',
     'marketing@demo.test', 'Demo Marketing', 'DM', 'marketing', 'amber'),
    ('d0000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001',
     'billing@demo.test', 'Demo Billing', 'DB', 'billing', 'emerald')
  on conflict (id) do nothing;
commit;
