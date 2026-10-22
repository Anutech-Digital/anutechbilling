-- R-1749 — a tenant's Zoho Books connection (tenant_secrets.zoho_books_*) is readable and
-- writable only by that tenant's owner. Tenant B can never see or change tenant A's token or
-- chosen organization.
--
-- The app itself reads these columns only server-side with the service role, always filtered by
-- the caller's own tenant (src/lib/integrations/zoho-books/store.ts). This file proves the
-- database refuses the cross-tenant read even for a browser token that asks directly.
--
--   1. Owner of A reads A's connection (org id) — the row is there.
--   2. Owner of B reading A's row gets nothing.
--   3. Owner of B updating A's row changes nothing (A's org id is unchanged afterwards).
--   4. Owner of B inserting a row FOR tenant A is refused (RLS with-check).
--   5. A manager of A does not read the connection either (owner-only table).
--
-- Fails without migration 20261022065809_r1749_zoho_books_connection.sql (the columns do not exist).
-- Synthetic tenants and users; the whole file is one transaction ending in ROLLBACK.

begin;

insert into auth.users (id, email) values
  ('c1749000-0000-0000-0000-0000000000a1', 'zoho-owner-a@example.test'),
  ('c1749000-0000-0000-0000-0000000000a2', 'zoho-manager-a@example.test'),
  ('c1749000-0000-0000-0000-0000000000b1', 'zoho-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('c1749000-0000-0000-0000-00000000aaaa', 'ZOHO TEST TENANT A', 'zoho-a@example.test', '07', 'ZTA1'),
  ('c1749000-0000-0000-0000-00000000bbbb', 'ZOHO TEST TENANT B', 'zoho-b@example.test', '07', 'ZTB1'),
  ('c1749000-0000-0000-0000-00000000cccc', 'ZOHO TEST TENANT C', 'zoho-c@example.test', '07', 'ZTC1');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('c1749000-0000-0000-0000-0000000000a1', 'c1749000-0000-0000-0000-00000000aaaa', 'zoho-owner-a@example.test',   'Owner A',   'owner',   true),
  ('c1749000-0000-0000-0000-0000000000a2', 'c1749000-0000-0000-0000-00000000aaaa', 'zoho-manager-a@example.test', 'Manager A', 'manager', true),
  ('c1749000-0000-0000-0000-0000000000b1', 'c1749000-0000-0000-0000-00000000bbbb', 'zoho-owner-b@example.test',   'Owner B',   'owner',   true);

-- Tenant A's connection, as the server (service role) stores it.
insert into public.tenant_secrets (tenant_id, zoho_books_refresh_token, zoho_books_org_id, zoho_books_org_name, zoho_books_connected_at)
values ('c1749000-0000-0000-0000-00000000aaaa', 'rosv1:test-only-envelope', 'ORG-A-1', 'Tenant A Books', now())
on conflict (tenant_id) do update
  set zoho_books_refresh_token = excluded.zoho_books_refresh_token,
      zoho_books_org_id        = excluded.zoho_books_org_id,
      zoho_books_org_name      = excluded.zoho_books_org_name;

set local role authenticated;

do $$
declare
  v_a  uuid := 'c1749000-0000-0000-0000-00000000aaaa';
  v_b  uuid := 'c1749000-0000-0000-0000-00000000bbbb';
  v_n  int;
  v_org text;
  v_blocked boolean;
  v_msg text;
begin
  ------------------------------------------------------------------ 1. owner A reads own row
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1749000-0000-0000-0000-0000000000a1', 'role', 'authenticated')::text, true);
  select zoho_books_org_id into v_org from public.tenant_secrets where tenant_id = v_a;
  if v_org is distinct from 'ORG-A-1' then
    raise exception 'FAIL 1: the owner of tenant A cannot read their own Zoho Books connection (got %)', v_org;
  end if;
  raise notice 'PASS 1: owner A reads A''s Zoho Books connection';

  ------------------------------------------------------------------ 2. owner B reads A's row
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1749000-0000-0000-0000-0000000000b1', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.tenant_secrets
   where tenant_id = v_a and (zoho_books_refresh_token is not null or zoho_books_org_id is not null);
  if v_n <> 0 then
    raise exception 'FAIL 2: the owner of tenant B read tenant A''s Zoho Books connection';
  end if;
  raise notice 'PASS 2: owner B sees nothing of A''s connection';

  ------------------------------------------------------------------ 3. owner B updates A's row
  update public.tenant_secrets set zoho_books_org_id = 'ORG-HIJACK', zoho_books_refresh_token = 'stolen'
   where tenant_id = v_a;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'FAIL 3: the owner of tenant B changed tenant A''s Zoho Books connection (% rows)', v_n;
  end if;
  raise notice 'PASS 3: owner B cannot change A''s connection';

  ------------------------------------------------------------------ 4. owner B inserts for A
  v_blocked := false;
  begin
    -- tenant C exists and has no tenant_secrets row, so only RLS can refuse this.
    insert into public.tenant_secrets (tenant_id, zoho_books_refresh_token)
      values ('c1749000-0000-0000-0000-00000000cccc'::uuid, 'x');
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;
  if not v_blocked then
    raise exception 'FAIL 4: a row for another tenant was inserted by the owner of tenant B';
  end if;
  if v_msg not like '%row-level security%' then
    raise exception 'FAIL 4: refused for the wrong reason: %', v_msg;
  end if;
  raise notice 'PASS 4: owner B cannot write a connection for another tenant';

  ------------------------------------------------------------------ 5. manager A
  perform set_config('request.jwt.claims',
    json_build_object('sub', 'c1749000-0000-0000-0000-0000000000a2', 'role', 'authenticated')::text, true);
  select count(*) into v_n from public.tenant_secrets where tenant_id = v_a;
  if v_n <> 0 then
    raise exception 'FAIL 5: a manager read the owner-only tenant_secrets row';
  end if;
  raise notice 'PASS 5: a manager does not read the stored token (server reads it for them)';
end $$;

reset role;

-- A's connection is exactly as stored — B's update did not land.
do $$
begin
  if (select zoho_books_org_id from public.tenant_secrets
       where tenant_id = 'c1749000-0000-0000-0000-00000000aaaa') is distinct from 'ORG-A-1' then
    raise exception 'FAIL 3b: tenant A''s organization changed after tenant B''s update';
  end if;
  raise notice 'PASS 3b: tenant A''s connection unchanged';
end $$;

rollback;
