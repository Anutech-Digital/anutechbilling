-- R-2897 (17 Nov 2026): the marketing login writes the Marketing Hub tables — coupons, referral
-- partners, WhatsApp reminder templates, social content settings; a sales login still cannot.
-- Migration 20261117060543_r2897_marketing_role_marketing_tables.
-- Self-asserting, ONE transaction, rolled back. LOCAL DB only.
begin;

create function pg_temp.r1643_fill_supplier() returns trigger language plpgsql as $r1643$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, ' || coalesce(new.state, 'India'));
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := lpad(coalesce(nullif(btrim(new.state_code), ''), '07'), 2, '0') || 'AAACT1643F1Z5';
  end if;
  return new;
end $r1643$;
create trigger zz_r1643_test_supplier before insert on public.tenants
  for each row execute function pg_temp.r1643_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000289701','R2897 Co','r2897@example.in','07','R2897');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000289701','mkt2897@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000289702','sales2897@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000289701','dddddddd-0000-0000-0000-000000289701','mkt2897@example.in','Mkt 2897','marketing', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000289702','dddddddd-0000-0000-0000-000000289701','sales2897@example.in','Sales 2897','sales', true, now() - interval '1 day');

-- ── Marketing writes every table ─────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000289701","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  insert into public.coupons (tenant_id, code, discount_value) values ('dddddddd-0000-0000-0000-000000289701', 'MKT2897', 10);
  update public.coupons set discount_value = 12 where code = 'MKT2897' and tenant_id = 'dddddddd-0000-0000-0000-000000289701';
  if (select discount_value from public.coupons where code = 'MKT2897' and tenant_id = 'dddddddd-0000-0000-0000-000000289701') <> 12 then
    raise exception 'FAIL M1: marketing could not change a coupon';
  end if;
  insert into public.referral_partners (tenant_id, name) values ('dddddddd-0000-0000-0000-000000289701', 'Partner 2897');
  insert into public.whatsapp_reminder_templates (tenant_id, kind, template_name) values ('dddddddd-0000-0000-0000-000000289701', 'renewal_upcoming', 'tpl_2897');
  insert into public.social_content_settings (tenant_id, ai_paused) values ('dddddddd-0000-0000-0000-000000289701', true);
  update public.social_content_settings set brief = 'Marketing brief' where tenant_id = 'dddddddd-0000-0000-0000-000000289701';
  if (select brief from public.social_content_settings where tenant_id = 'dddddddd-0000-0000-0000-000000289701') <> 'Marketing brief' then
    raise exception 'FAIL M2: marketing could not change social settings';
  end if;
  delete from public.coupons where code = 'MKT2897' and tenant_id = 'dddddddd-0000-0000-0000-000000289701';
  if exists (select 1 from public.coupons where code = 'MKT2897' and tenant_id = 'dddddddd-0000-0000-0000-000000289701') then
    raise exception 'FAIL M3: marketing could not delete a coupon';
  end if;
  raise notice 'PASS M: marketing writes coupons, referral partners, WhatsApp reminder templates, social settings';
end $$;

-- ── Sales still cannot ───────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000289702","role":"authenticated"}', true);
do $$
begin
  begin
    insert into public.coupons (tenant_id, code, discount_value) values ('dddddddd-0000-0000-0000-000000289701', 'SALES2897', 10);
    raise exception 'FAIL S1: sales inserted a coupon';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.whatsapp_reminder_templates (tenant_id, kind, template_name) values ('dddddddd-0000-0000-0000-000000289701', 'renewal_upcoming', 'tpl_s2897');
    raise exception 'FAIL S2: sales inserted a reminder template';
  exception when insufficient_privilege then null;
  end;
  update public.social_content_settings set brief = 'Sales brief' where tenant_id = 'dddddddd-0000-0000-0000-000000289701';
  raise notice 'PASS S: sales cannot write marketing tables';
end $$;
reset role;
do $$
begin
  if (select brief from public.social_content_settings where tenant_id = 'dddddddd-0000-0000-0000-000000289701') <> 'Marketing brief' then
    raise exception 'FAIL S3: sales changed social settings';
  end if;
end $$;

rollback;
