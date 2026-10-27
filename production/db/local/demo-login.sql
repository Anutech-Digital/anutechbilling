-- LOCAL ONLY demo login. Never run against a real database.
--
--   Email:    owner@demo.test
--   Password: demo-password-123
--
-- Local Supabase stack (`npm run dev:local`, http://localhost:3001):
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < production/db/local/demo-login.sql
-- No-VM Postgres (`npm run db:local`, container ros-pg, database ros):
--   docker exec -i ros-pg psql -U postgres -d ros -v ON_ERROR_STOP=1 < production/db/local/demo-login.sql
--
-- R-1837 (24 Oct 2026): GoTrue signs in only a row it would have made itself — instance_id set,
-- the token columns '' (NULL makes GoTrue fail to scan the row: "Database error querying
-- schema"), created_at/updated_at set, and an auth.identities row for the email provider.
-- Safe to run again: an existing row is repaired, never duplicated; the password is kept.
begin;
set local session_replication_role = replica;
insert into public.tenants (id, name, email, doc_code)
  values ('d0000000-0000-4000-8000-000000000001', 'Demo Cloud Reseller', 'owner@demo.test', 'DEMO')
  on conflict (id) do nothing;
insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token)
  values ('00000000-0000-0000-0000-000000000000', 'd0000000-0000-4000-8000-0000000000aa',
          'authenticated', 'authenticated', 'owner@demo.test', crypt('demo-password-123', gen_salt('bf', 10)), now(),
          '{"provider":"email","providers":["email"]}', '{"full_name":"Demo Owner"}', now(), now(),
          '', '', '', '', '', '', '', '')
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
-- auth.identities: GoTrue's table on the Supabase stack; the ros-pg shim has none (skipped there).
do $$ begin
  if to_regclass('auth.identities') is not null then
    insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      select u.id::text, u.id,
             jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true, 'phone_verified', false),
             'email', now(), now(), now()
        from auth.users u
       where u.id = 'd0000000-0000-4000-8000-0000000000aa'
      on conflict (provider_id, provider) do nothing;
  end if;
end $$;
insert into public.users (id, tenant_id, email, full_name, initials, role, color)
  values ('d0000000-0000-4000-8000-0000000000aa', 'd0000000-0000-4000-8000-000000000001',
          'owner@demo.test', 'Demo Owner', 'DO', 'owner', 'indigo')
  on conflict (id) do nothing;
commit;
