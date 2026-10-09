\set ON_ERROR_STOP on
-- Regression test: website offers (site_promos) are created and changed by the tenant's own
-- owner/manager only. Migration 20261009233000_site_promo_owner_only.sql (R-700).
-- Rolled back — safe anywhere.
--
--   BLOCKED  an owner of ANOTHER tenant calling create_site_promo with our tenant id
--            (before R-700: any signed-up account could put 100% off on our buy page)
--   BLOCKED  a `sales` login of our tenant calling create_site_promo
--   BLOCKED  a `sales` login inserting / switching on a promo straight through PostgREST
--   BLOCKED  a percent offer above 100, even for the owner
--   BLOCKED  a call with no signed-in user, and anon touching the table
--   ALLOWED  our owner creating an offer — created_by is the owner, not a caller-chosen id
--   ALLOWED  our owner switching an offer on/off (the /online-promos toggle)
--   ALLOWED  the service connection (no user) creating an offer

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('47000000-0000-4000-8000-000000000001', 'R700 SELLER', 'r700-a@example.in', '07', 'R70A'),
  ('47000000-0000-4000-8000-000000000002', 'R700 OTHER',  'r700-b@example.in', '07', 'R70B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('47000000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r700-owner@example.in'),
  ('47000000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r700-sales@example.in'),
  ('47000000-0000-4000-8000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r700-other@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('47000000-0000-4000-8000-00000000000a', '47000000-0000-4000-8000-000000000001', 'r700-owner@example.in', 'owner', true),
  ('47000000-0000-4000-8000-00000000000b', '47000000-0000-4000-8000-000000000001', 'r700-sales@example.in', 'sales', true),
  ('47000000-0000-4000-8000-00000000000c', '47000000-0000-4000-8000-000000000002', 'r700-other@example.in', 'owner', true);

/* An existing offer that is switched off — the sales login will try to switch it on. */
insert into public.site_promos (id, tenant_id, headline, discount_type, discount_value, is_active)
  values ('SP-R700OFF', '47000000-0000-4000-8000-000000000001', 'Old offer', 'percent', 10, false);

do $$
declare
  v_err boolean; v_n int; v_id text; v_by uuid;
  c_seller constant uuid := '47000000-0000-4000-8000-000000000001';
begin
  set local role authenticated;

  -- ── BLOCKED: another tenant's owner targets our buy page ─────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','47000000-0000-4000-8000-00000000000c','role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.create_site_promo(c_seller, 'Free', null, null, 'percent', 100, null, 1, null, null, null,
                                     '47000000-0000-4000-8000-00000000000a');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: an owner of another tenant created a promo on our tenant'; end if;

  -- ── BLOCKED: our own sales login calls the RPC ───────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub','47000000-0000-4000-8000-00000000000b','role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.create_site_promo(c_seller, 'Sale', null, null, 'percent', 50, null, 1, null, null, null, null);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: a sales login created a promo through the RPC'; end if;

  -- ── BLOCKED: sales inserts directly ──────────────────────────────────────
  v_err := false;
  begin
    insert into public.site_promos (id, tenant_id, headline, discount_type, discount_value)
      values ('SP-R700SAL', c_seller, 'Direct', 'percent', 90);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 3: a sales login inserted a promo directly'; end if;

  -- ── BLOCKED: sales switches the old offer on (RLS → 0 rows) ──────────────
  update public.site_promos set is_active = true, discount_value = 99 where id = 'SP-R700OFF';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 4: a sales login updated % promo row(s)', v_n; end if;

  -- ── BLOCKED: no signed-in user ───────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.create_site_promo(c_seller, 'Nobody', null, null, 'flat', 100, null, 1, null, null, null, null);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: a call with no user created a promo'; end if;

  -- ── Owner: percent above 100 refused, a normal offer allowed ─────────────
  perform set_config('request.jwt.claims', json_build_object('sub','47000000-0000-4000-8000-00000000000a','role','authenticated')::text, true);
  v_err := false;
  begin
    perform public.create_site_promo(c_seller, 'Too much', null, null, 'percent', 101, null, 1, null, null, null, null);
  exception when invalid_parameter_value then v_err := true; end;
  if not v_err then raise exception 'FAIL 6: a 101 percent offer was accepted'; end if;

  /* p_created_by names the sales user — the row must record the owner who really did it. */
  v_id := public.create_site_promo(c_seller, 'Diwali 10% off', null, null, 'percent', 10, null, 1, null, null, null,
                                   '47000000-0000-4000-8000-00000000000b');
  select created_by into v_by from public.site_promos where id = v_id;
  if v_by is distinct from '47000000-0000-4000-8000-00000000000a'::uuid then
    raise exception 'FAIL 7: owner-created promo has created_by %', v_by;
  end if;

  update public.site_promos set is_active = true where id = 'SP-R700OFF';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 8: the owner could not switch the offer on (% rows)', v_n; end if;

  -- ── BLOCKED: anon ────────────────────────────────────────────────────────
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', json_build_object('role','anon')::text, true);
  v_err := false;
  begin
    perform 1 from public.site_promos limit 1;
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 9: anon can still read site_promos'; end if;
  v_err := false;
  begin
    perform public.create_site_promo(c_seller, 'Anon', null, null, 'percent', 100, null, 1, null, null, null, null);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10: anon can call create_site_promo'; end if;
  reset role;

  -- ── ALLOWED: the service connection ──────────────────────────────────────
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  v_id := public.create_site_promo(c_seller, 'Server offer', null, null, 'flat', 50, null, 1, null, null, null, null);
  if v_id is null then raise exception 'FAIL 11: service connection could not create a promo'; end if;

  select count(*) into v_n from public.site_promos where tenant_id = c_seller;
  if v_n <> 3 then raise exception 'FAIL 12: expected 3 promos for the seller (old + owner + server), found %', v_n; end if;

  raise notice 'site_promo_owner_only: all 12 checks passed';
end $$;

rollback;
