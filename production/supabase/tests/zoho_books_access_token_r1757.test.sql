-- R-1757 — the cached Zoho Books ACCESS token (tenant_secrets.zoho_books_access_token /
-- _access_expires_at) is as private as the refresh token: tenant B never reads or overwrites
-- tenant A's cached token, and a manager of A does not read it either (owner-only row).
--
-- Fails without migration ..._r1757_zoho_books_access_token_cache.sql (the columns do not exist).
-- Synthetic tenants and users; one transaction ending in ROLLBACK.
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/zoho_books_access_token_r1757.test.sql

begin;

insert into auth.users (id, email) values
  ('c1757000-0000-0000-0000-0000000000a1', 'r1757-owner-a@example.test'),
  ('c1757000-0000-0000-0000-0000000000a2', 'r1757-manager-a@example.test'),
  ('c1757000-0000-0000-0000-0000000000b1', 'r1757-owner-b@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1757000-0000-0000-0000-00000000aaaa', 'T-R1757 A', 'r1757-a@example.test', '07', 'TRA7'),
  ('c1757000-0000-0000-0000-00000000bbbb', 'T-R1757 B', 'r1757-b@example.test', '07', 'TRB7');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1757000-0000-0000-0000-0000000000a1', 'c1757000-0000-0000-0000-00000000aaaa', 'r1757-owner-a@example.test', 'Owner A', 'owner', true),
  ('c1757000-0000-0000-0000-0000000000a2', 'c1757000-0000-0000-0000-00000000aaaa', 'r1757-manager-a@example.test', 'Manager A', 'manager', true),
  ('c1757000-0000-0000-0000-0000000000b1', 'c1757000-0000-0000-0000-00000000bbbb', 'r1757-owner-b@example.test', 'Owner B', 'owner', true);

-- What the server (service role) writes after one mint.
insert into public.tenant_secrets (tenant_id, zoho_books_refresh_token, zoho_books_access_token, zoho_books_access_expires_at)
values ('c1757000-0000-0000-0000-00000000aaaa', 'rosv1:test-only-refresh', 'rosv1:test-only-access', now() + interval '55 minutes')
on conflict (tenant_id) do update set zoho_books_access_token = excluded.zoho_books_access_token,
                                      zoho_books_access_expires_at = excluded.zoho_books_access_expires_at;

set local role authenticated;

do $$
declare v_tok text; v_n int;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'c1757000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select zoho_books_access_token into v_tok from public.tenant_secrets where tenant_id = 'c1757000-0000-0000-0000-00000000aaaa';
  if v_tok is distinct from 'rosv1:test-only-access' then raise exception 'FAIL 1: owner A cannot read own cached token (%)', v_tok; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'c1757000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.tenant_secrets
   where tenant_id = 'c1757000-0000-0000-0000-00000000aaaa' and zoho_books_access_token is not null;
  if v_n <> 0 then raise exception 'FAIL 2: tenant B reads tenant A''s cached Zoho access token'; end if;
  update public.tenant_secrets set zoho_books_access_token = 'stolen', zoho_books_access_expires_at = now() + interval '1 day'
   where tenant_id = 'c1757000-0000-0000-0000-00000000aaaa';

  perform set_config('request.jwt.claims', json_build_object('sub', 'c1757000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.tenant_secrets where tenant_id = 'c1757000-0000-0000-0000-00000000aaaa';
  if v_n <> 0 then raise exception 'FAIL 3: a manager reads the owner-only secrets row'; end if;
  raise notice 'PASS 1-3: cached access token readable by owner A only; B and manager see nothing';
end $$;

reset role;
do $$
begin
  if (select zoho_books_access_token from public.tenant_secrets where tenant_id = 'c1757000-0000-0000-0000-00000000aaaa') <> 'rosv1:test-only-access' then
    raise exception 'FAIL 4: tenant B overwrote tenant A''s cached token';
  end if;
  raise notice 'PASS 4: tenant B''s update changed nothing';
end $$;

rollback;
