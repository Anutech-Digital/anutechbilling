-- LOCAL ONLY extra demo logins (R-1791, 23 Oct 2026) — to try a flow as each role: the
-- Marketing budget (marketing asks, owner approves, billing pays). Never run against a real
-- database. Same tenant and password as demo-login.sql (run that first).
--
--   marketing@demo.test   role marketing   password demo-password-123
--   billing@demo.test     role billing     password demo-password-123
--
-- Local Supabase stack (`npm run dev:local`, http://localhost:3001):
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < production/db/local/demo-team-logins.sql
-- No-VM Postgres (`npm run db:local`, container ros-pg, database ros):
--   docker exec -i ros-pg psql -U postgres -d ros -v ON_ERROR_STOP=1 < production/db/local/demo-team-logins.sql
--
-- R-1837 (24 Oct 2026): rows GoTrue can sign in with — see demo-login.sql. Safe to run again.
begin;
set local session_replication_role = replica;
insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  select '00000000-0000-0000-0000-000000000000'::uuid, v.id, 'authenticated', 'authenticated', v.email,
         crypt('demo-password-123', gen_salt('bf', 10)), now(),
         '{"provider":"email","providers":["email"]}'::jsonb, jsonb_build_object('full_name', v.full_name), now(), now(),
         '', '', '', '', '', '', '', ''
    from (values
      ('d0000000-0000-4000-8000-0000000000b1'::uuid, 'marketing@demo.test', 'Demo Marketing'),
      ('d0000000-0000-4000-8000-0000000000b2'::uuid, 'billing@demo.test',   'Demo Billing')
    ) as v(id, email, full_name)
  on conflict (id) do update set
    instance_id                = coalesce(auth.users.instance_id, excluded.instance_id),
    aud                        = coalesce(auth.users.aud, excluded.aud),
    role                       = coalesce(auth.users.role, excluded.role),
    email_confirmed_at         = coalesce(auth.users.email_confirmed_at, excluded.email_confirmed_at),
    raw_app_meta_data          = coalesce(auth.users.raw_app_meta_data, excluded.raw_app_meta_data),
    created_at                 = coalesce(auth.users.created_at, excluded.created_at),
    updated_at                 = coalesce(auth.users.updated_at, excluded.updated_at),
    confirmation_token         = coalesce(auth.users.confirmation_token, ''),
    recovery_token             = coalesce(auth.users.recovery_token, ''),
    email_change_token_new     = coalesce(auth.users.email_change_token_new, ''),
    email_change               = coalesce(auth.users.email_change, ''),
    email_change_token_current = coalesce(auth.users.email_change_token_current, ''),
    phone_change               = coalesce(auth.users.phone_change, ''),
    phone_change_token         = coalesce(auth.users.phone_change_token, ''),
    reauthentication_token     = coalesce(auth.users.reauthentication_token, '');
do $$ begin
  if to_regclass('auth.identities') is not null then
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      select u.id::text, u.id,
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now()
        from auth.users u
       where u.id in ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-0000000000b2')
      on conflict (provider_id, provider) do nothing;
  end if;
end $$;
insert into public.users (id, tenant_id, email, full_name, initials, role, color)
  values
    ('d0000000-0000-4000-8000-0000000000b1', 'd0000000-0000-4000-8000-000000000001',
     'marketing@demo.test', 'Demo Marketing', 'DM', 'marketing', 'amber'),
    ('d0000000-0000-4000-8000-0000000000b2', 'd0000000-0000-4000-8000-000000000001',
     'billing@demo.test', 'Demo Billing', 'DB', 'billing', 'emerald')
  on conflict (id) do nothing;
commit;
