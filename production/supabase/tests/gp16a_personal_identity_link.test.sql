\set ON_ERROR_STOP on
-- R-2118 (GP-16a, goal G-PERSONAL): a verified personal signup gets ONE Anutech individual
-- customer, a customer-panel (DMS) account request and a Free support desk — all at once (D4).
-- Migration 20261030053741_gp16a_personal_identity_link.sql. Rolled back — safe anywhere.
--
--   1  an UNCONFIRMED email raises and writes nothing (no customer, no outbox, no link)
--   2  the authenticated role cannot execute link_personal_identity (service_role only)
--   3  a business workspace (workspace_kind business) is refused
--   4  a confirmed email: 1 customer (individual, consumer, seller company, no linked_tenant_id),
--      1 panel_account_outbox row (source personal-signup), 1 support_sync_outbox row (plan_key
--      free, no subscription), 1 personal_identity_link row
--   5  a rerun changes nothing (same ids, same counts)
--   6  the personal tenant gets no vendor bill (an Anutech invoice to the customer mirrors
--      nothing) and is not in the seller's get_partner_metrics
--   7  the email already belongs to an individual customer → that customer is linked, none created
--   8  the email belongs to a COMPANY customer → gated (owner decision): needs_decision, link row
--      without customer, nothing created or queued
--   9  the panel account finishing copies dms_user_id into the link
--  10  a user reads only their own link row and cannot write it

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- seller (stands in for Anutech's company) + three personal workspaces + one business one
insert into public.tenants (id, name, email, state_code, doc_code, tier) values
  ('21180000-0000-4000-8000-0000000000a1', 'ZZ GP16A SELLER', 'gp16a-seller@example.invalid', '07', 'G16S', 'reseller'),
  ('21180000-0000-4000-8000-0000000000b1', 'ZZ GP16A Personal One', 'gp16a-p1@example.invalid', '07', 'G16P1', 'reseller'),
  ('21180000-0000-4000-8000-0000000000b2', 'ZZ GP16A Personal Two', 'gp16a-p2@example.invalid', '07', 'G16P2', 'reseller'),
  ('21180000-0000-4000-8000-0000000000b3', 'ZZ GP16A Personal Three', 'gp16a-p3@example.invalid', '07', 'G16P3', 'reseller'),
  ('21180000-0000-4000-8000-0000000000b9', 'ZZ GP16A Business', 'gp16a-b@example.invalid', '07', 'G16B', 'reseller');
update public.tenants set workspace_kind = 'personal'
 where id in ('21180000-0000-4000-8000-0000000000b1', '21180000-0000-4000-8000-0000000000b2', '21180000-0000-4000-8000-0000000000b3');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at, raw_user_meta_data) values
  ('21180000-0000-4000-8000-0000000000e0', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'gp16a-seller-owner@example.invalid', now(), '{}'),
  ('21180000-0000-4000-8000-0000000000e1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'Riya.GP16A@example.invalid', null, '{"full_name":"Riya Sen"}'),
  ('21180000-0000-4000-8000-0000000000e2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'old.gp16a@example.invalid', now(), '{}'),
  ('21180000-0000-4000-8000-0000000000e3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'boss@gp16a-co.invalid', now(), '{}'),
  ('21180000-0000-4000-8000-0000000000e9', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'biz.gp16a@example.invalid', now(), '{}');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('21180000-0000-4000-8000-0000000000e0', '21180000-0000-4000-8000-0000000000a1', 'gp16a-seller-owner@example.invalid', 'Seller Owner', 'owner', true),
  ('21180000-0000-4000-8000-0000000000e1', '21180000-0000-4000-8000-0000000000b1', 'riya.gp16a@example.invalid', 'Riya Sen', 'personal', true),
  ('21180000-0000-4000-8000-0000000000e2', '21180000-0000-4000-8000-0000000000b2', 'old.gp16a@example.invalid', 'Old Buyer', 'personal', true),
  ('21180000-0000-4000-8000-0000000000e3', '21180000-0000-4000-8000-0000000000b3', 'boss@gp16a-co.invalid', 'Company Boss', 'personal', true),
  ('21180000-0000-4000-8000-0000000000e9', '21180000-0000-4000-8000-0000000000b9', 'biz.gp16a@example.invalid', 'Biz Owner', 'owner', true);

-- already customers of the seller: one individual, one company
insert into public.customers (id, tenant_id, name, contact_email, customer_type) values
  ('21180000-0000-4000-8000-0000000000c2', '21180000-0000-4000-8000-0000000000a1', 'Old Buyer', 'OLD.gp16a@example.invalid', 'individual'),
  ('21180000-0000-4000-8000-0000000000c3', '21180000-0000-4000-8000-0000000000a1', 'ZZ GP16A Co Pvt Ltd', 'boss@gp16a-co.invalid', 'business');

do $$
declare
  c_seller constant uuid := '21180000-0000-4000-8000-0000000000a1';
  c_p1     constant uuid := '21180000-0000-4000-8000-0000000000b1';
  c_p2     constant uuid := '21180000-0000-4000-8000-0000000000b2';
  c_p3     constant uuid := '21180000-0000-4000-8000-0000000000b3';
  c_biz    constant uuid := '21180000-0000-4000-8000-0000000000b9';
  c_u1     constant uuid := '21180000-0000-4000-8000-0000000000e1';
  c_u2     constant uuid := '21180000-0000-4000-8000-0000000000e2';
  c_u3     constant uuid := '21180000-0000-4000-8000-0000000000e3';
  c_u9     constant uuid := '21180000-0000-4000-8000-0000000000e9';
  v_err boolean; v_msg text; v_n int; v_r jsonb; v_r2 jsonb; c record; l record; o record; s record;
begin
  if to_regprocedure('public.link_personal_identity(uuid,uuid,uuid)') is null then
    raise exception 'FAIL 0: link_personal_identity(uuid,uuid,uuid) does not exist';
  end if;

  -- ── 1: unconfirmed email raises, writes nothing ─────────────────────────
  v_err := false;
  begin
    perform public.link_personal_identity(c_u1, c_p1, c_seller);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 1: an unconfirmed email was linked'; end if;
  if v_msg not ilike '%confirm%' then raise exception 'FAIL 1b: refused for another reason: %', v_msg; end if;
  select count(*) into v_n from public.customers where tenant_id = c_seller and lower(contact_email) = 'riya.gp16a@example.invalid';
  if v_n <> 0 then raise exception 'FAIL 1c: % customer rows for an unconfirmed email', v_n; end if;
  select count(*) into v_n from public.personal_identity_link where auth_user_id = c_u1;
  if v_n <> 0 then raise exception 'FAIL 1d: a link row for an unconfirmed email'; end if;

  -- ── 3: a business workspace is refused ──────────────────────────────────
  v_err := false;
  begin
    perform public.link_personal_identity(c_u9, c_biz, c_seller);
  exception when others then v_err := true; v_msg := sqlerrm; end;
  if not v_err then raise exception 'FAIL 3: a business workspace was linked as personal'; end if;
  if v_msg not ilike '%personal%' then raise exception 'FAIL 3b: refused for another reason: %', v_msg; end if;

  -- a user who is not a member of that personal workspace is refused
  update auth.users set email_confirmed_at = now() where id = c_u1;
  v_err := false;
  begin
    perform public.link_personal_identity(c_u1, c_p2, c_seller);
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 3c: a user was linked to someone else''s personal workspace'; end if;

  -- ── 4: confirmed → customer + panel + support + link ────────────────────
  v_r := public.link_personal_identity(c_u1, c_p1, c_seller);
  if v_r->>'status' <> 'linked' then raise exception 'FAIL 4: status % (expected linked): %', v_r->>'status', v_r; end if;
  select count(*) into v_n from public.customers where tenant_id = c_seller and lower(contact_email) = 'riya.gp16a@example.invalid';
  if v_n <> 1 then raise exception 'FAIL 4a: % customers for the person, expected 1', v_n; end if;
  select * into c from public.customers where id = (v_r->>'customer_id')::uuid;
  if c.tenant_id <> c_seller or c.customer_type <> 'individual' or c.gst_treatment is distinct from 'consumer' then
    raise exception 'FAIL 4b: customer is %/%/% (expected seller/individual/consumer)', c.tenant_id, c.customer_type, c.gst_treatment;
  end if;
  if c.linked_tenant_id is not null then raise exception 'FAIL 4c: customer got linked_tenant_id (vendor-bill mirror trap)'; end if;
  if c.name <> 'Riya Sen' then raise exception 'FAIL 4d: customer name % (expected the person''s name)', c.name; end if;
  select count(*) into v_n from public.panel_account_outbox where customer_id = c.id and source = 'personal-signup' and status = 'pending' and tenant_id = c_seller;
  if v_n <> 1 then raise exception 'FAIL 4e: % personal-signup panel rows, expected 1', v_n; end if;
  select count(*) into v_n from public.support_sync_outbox
   where customer_id = c.id and tenant_id = c_seller and subscription_id is null
     and payload->'data'->>'plan_key' = 'free' and payload->'data'->>'email' = 'Riya.GP16A@example.invalid';
  if v_n <> 1 then raise exception 'FAIL 4f: % free support rows, expected 1', v_n; end if;
  select * into l from public.personal_identity_link where auth_user_id = c_u1;
  if not found or l.personal_tenant_id <> c_p1 or l.anutech_customer_id <> c.id or l.email <> 'riya.gp16a@example.invalid' then
    raise exception 'FAIL 4g: link row wrong: %', row_to_json(l);
  end if;
  select parent_tenant_id into o from public.tenants where id = c_p1;
  if o.parent_tenant_id is not null then raise exception 'FAIL 4h: personal tenant got a parent_tenant_id'; end if;

  -- ── 5: rerun changes nothing ────────────────────────────────────────────
  v_r2 := public.link_personal_identity(c_u1, c_p1, c_seller);
  if v_r2->>'status' <> 'already_linked' or v_r2->>'customer_id' <> v_r->>'customer_id' then
    raise exception 'FAIL 5: rerun gave %', v_r2;
  end if;
  select count(*) into v_n from public.customers where tenant_id = c_seller and lower(contact_email) = 'riya.gp16a@example.invalid';
  if v_n <> 1 then raise exception 'FAIL 5a: rerun made % customers', v_n; end if;
  select count(*) into v_n from public.panel_account_outbox where customer_id = c.id;
  if v_n <> 1 then raise exception 'FAIL 5b: rerun made % panel rows', v_n; end if;
  select count(*) into v_n from public.support_sync_outbox where customer_id = c.id;
  if v_n <> 1 then raise exception 'FAIL 5c: rerun made % support rows', v_n; end if;
  -- the same user may not be re-pointed at another workspace
  v_err := false;
  begin
    perform public.link_personal_identity(c_u1, c_p2, c_seller);
  exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 5d: an existing link was moved to another workspace'; end if;

  -- ── 6: no vendor bill, no partner metrics ───────────────────────────────
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date)
  values ('ZZ-G16A-INV1', c_seller, c.id, c.name, 1180, 'pending', current_date, current_date + 7);
  select count(*) into v_n from public.vendor_bills where tenant_id = c_p1;
  if v_n <> 0 then raise exception 'FAIL 6: the personal tenant got % vendor bill(s)', v_n; end if;

  -- ── 7: email already an individual customer → matched ───────────────────
  v_r := public.link_personal_identity(c_u2, c_p2, c_seller);
  if v_r->>'status' <> 'linked' or v_r->>'customer_id' <> '21180000-0000-4000-8000-0000000000c2' then
    raise exception 'FAIL 7: existing individual customer not matched: %', v_r;
  end if;
  select count(*) into v_n from public.customers where tenant_id = c_seller and lower(contact_email) = 'old.gp16a@example.invalid';
  if v_n <> 1 then raise exception 'FAIL 7b: % customers for the matched email', v_n; end if;
  select count(*) into v_n from public.panel_account_outbox where customer_id = '21180000-0000-4000-8000-0000000000c2' and source = 'personal-signup';
  if v_n <> 1 then raise exception 'FAIL 7c: matched customer not queued for a panel account'; end if;

  -- ── 8: email is a company customer → gated ──────────────────────────────
  v_r := public.link_personal_identity(c_u3, c_p3, c_seller);
  if v_r->>'status' <> 'needs_decision' or v_r->>'customer_id' is not null then
    raise exception 'FAIL 8: company email not gated: %', v_r;
  end if;
  select count(*) into v_n from public.customers where tenant_id = c_seller and lower(contact_email) = 'boss@gp16a-co.invalid';
  if v_n <> 1 then raise exception 'FAIL 8b: % customers for the company email (expected the 1 existing)', v_n; end if;
  select count(*) into v_n from public.panel_account_outbox where customer_id = '21180000-0000-4000-8000-0000000000c3';
  if v_n <> 0 then raise exception 'FAIL 8c: company customer queued for a panel account'; end if;
  select count(*) into v_n from public.support_sync_outbox where customer_id = '21180000-0000-4000-8000-0000000000c3';
  if v_n <> 0 then raise exception 'FAIL 8d: company customer queued for support'; end if;
  select * into l from public.personal_identity_link where auth_user_id = c_u3;
  if not found or l.anutech_customer_id is not null or l.link_status <> 'needs_decision' then
    raise exception 'FAIL 8e: gated link row wrong: %', row_to_json(l);
  end if;

  -- ── 9: panel account done → dms_user_id copied ──────────────────────────
  update public.panel_account_outbox set status = 'done', dms_user_id = 'dms-gp16a-1', done_at = now()
   where customer_id = (v_r2->>'customer_id')::uuid;
  select dms_user_id into l from public.personal_identity_link where auth_user_id = c_u1;
  if l.dms_user_id is distinct from 'dms-gp16a-1' then raise exception 'FAIL 9: dms_user_id not copied (got %)', l.dms_user_id; end if;
end $$;

-- ── 6b: the seller's partner metrics do not list the personal tenant ──────
set local role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','21180000-0000-4000-8000-0000000000e0','role','authenticated')::text, true);
do $$
begin
  if exists (select 1 from public.get_partner_metrics() m
              where m.tenant_id in ('21180000-0000-4000-8000-0000000000b1', '21180000-0000-4000-8000-0000000000b2')) then
    raise exception 'FAIL 6b: a personal tenant shows in the seller''s partner metrics';
  end if;
end $$;

-- ── 2: authenticated cannot execute ───────────────────────────────────────
select set_config('request.jwt.claims', json_build_object('sub','21180000-0000-4000-8000-0000000000e1','role','authenticated')::text, true);
do $$
declare v_err boolean := false; v_n int;
begin
  begin
    perform public.link_personal_identity('21180000-0000-4000-8000-0000000000e1', '21180000-0000-4000-8000-0000000000b1', '21180000-0000-4000-8000-0000000000a1');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 2: the authenticated role executed link_personal_identity'; end if;

  -- ── 10: own row only, no browser writes ───────────────────────────────
  select count(*) into v_n from public.personal_identity_link;
  if v_n <> 1 then raise exception 'FAIL 10: user sees % link rows (expected only their own)', v_n; end if;
  v_err := false;
  begin
    update public.personal_identity_link set anutech_customer_id = null where auth_user_id = '21180000-0000-4000-8000-0000000000e1';
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10b: a user updated their link row'; end if;
  v_err := false;
  begin
    insert into public.personal_identity_link (auth_user_id, personal_tenant_id, email)
    values ('21180000-0000-4000-8000-0000000000e9', '21180000-0000-4000-8000-0000000000b9', 'x@example.invalid');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 10c: a user inserted a link row'; end if;
end $$;
reset role;

do $$ begin raise notice 'gp16a_personal_identity_link: all checks passed'; end $$;

rollback;
