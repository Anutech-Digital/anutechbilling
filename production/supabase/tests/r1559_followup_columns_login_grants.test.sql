-- Regression test for 20261018220847_r1559_definer_grants.sql (R-1559)
--
-- WHAT IT PROVES (self-asserting; whole file rolls back)
--   1. A sales user can still edit the note on their own payment follow-up.
--   2. … but cannot rewrite who wrote it (created_by) or when (created_at)        ← was allowed
--      — not even an owner can. tenant_id / customer_id cannot be moved either.
--   3. An insert cannot choose its own id or created_at (back-dated history).
--   4. The normal insert (the app's column set, created_by from auth.uid()) still works.
--   5. public.login_profile_id_for_email (any email → user id, every company) is NOT
--      executable by anon, authenticated or service_role — only the login role app_auth.
--      The function comes from prisma/migrations/20261009200000_login_profile_lookup; where
--      that has not run (local Supabase) this file creates it the same way, as postgres,
--      so it also proves postgres' default privileges no longer hand new functions to
--      anon/authenticated.
--
-- Run it in one rollback with the migration (CLAUDE.md §17c):
--   begin; <migration without begin/commit> <this file without begin/rollback> rollback;

begin;

create temp table r1559_login_fn_created on commit drop as
  select to_regprocedure('public.login_profile_id_for_email(text)') is null as created;

do $$ begin
  if to_regprocedure('public.login_profile_id_for_email(text)') is null then
    -- same body + grants as prisma/migrations/20261009200000_login_profile_lookup
    execute $f$
      create function public.login_profile_id_for_email(p_email text) returns uuid
        language sql stable security definer set search_path = ''
      as $b$
        select u.id from public.users u
         where lower(u.email) = lower(btrim(p_email)) and u.is_active
         order by u.created_at, u.id limit 1;
      $b$ $f$;
    execute 'revoke all on function public.login_profile_id_for_email(text) from public';
  end if;
end $$;

insert into auth.users (id, email) values
  ('f1559000-0000-0000-0000-0000000000a1', 'r1559-owner@example.test'),
  ('f1559000-0000-0000-0000-0000000000a5', 'r1559-sales@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('f1559000-0000-0000-0000-00000000aaaa', 'R1559 A', 'r1559-a@example.test', '07', 'R59A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('f1559000-0000-0000-0000-0000000000a1', 'f1559000-0000-0000-0000-00000000aaaa', 'r1559-owner@example.test', 'R1559 Owner', 'owner', true),
  ('f1559000-0000-0000-0000-0000000000a5', 'f1559000-0000-0000-0000-00000000aaaa', 'r1559-sales@example.test', 'R1559 Sales', 'sales', true);

insert into public.customers (id, tenant_id, name, account_manager_id) values
  ('f1559000-0000-0000-0000-0000000000ca', 'f1559000-0000-0000-0000-00000000aaaa', 'R1559 Customer', 'f1559000-0000-0000-0000-0000000000a5'),
  ('f1559000-0000-0000-0000-0000000000cb', 'f1559000-0000-0000-0000-00000000aaaa', 'R1559 Customer 2', 'f1559000-0000-0000-0000-0000000000a5');

-- 5. login lookup: only app_auth (where it exists) may run it
do $$
declare
  r text;
  v_roles text[] := array['anon', 'authenticated', 'service_role'];
begin
  -- Created just above (local Supabase): this proves the DEFAULT privileges — anon and
  -- authenticated get nothing by default any more. service_role keeps its default here;
  -- the explicit revoke from it is proven where the function already existed (staging/live).
  if (select created from r1559_login_fn_created) then
    v_roles := array['anon', 'authenticated'];
  end if;
  foreach r in array v_roles loop
    if has_function_privilege(r, 'public.login_profile_id_for_email(text)', 'EXECUTE') then
      raise exception 'FAIL 5: % can EXECUTE login_profile_id_for_email (any email → user id across companies)', r;
    end if;
  end loop;
end $$;

set local role authenticated;

do $$
declare
  v_a     uuid := 'f1559000-0000-0000-0000-00000000aaaa';
  v_owner uuid := 'f1559000-0000-0000-0000-0000000000a1';
  v_sales uuid := 'f1559000-0000-0000-0000-0000000000a5';
  v_cust  uuid := 'f1559000-0000-0000-0000-0000000000ca';
  v_cust2 uuid := 'f1559000-0000-0000-0000-0000000000cb';
  v_row   uuid;
  v_by    uuid;
  v_at    timestamptz;
  v_state text;
  v_n     int;
begin
  -- 4. the app's insert (followup-rules.ts buildFollowupInsert) still works
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  insert into public.payment_followups
    (tenant_id, customer_id, kind, note, promised_amount, promised_on, next_follow_up_on,
     assigned_to, invoice_id, quote_id, subscription_id)
  values (v_a, v_cust, 'call', 'sales logs a call', null, null, current_date + 2, v_sales, null, null, null)
  returning id, created_by, created_at into v_row, v_by, v_at;
  if v_by is distinct from v_sales then
    raise exception 'FAIL 4: created_by not stamped from the login (got %)', v_by;
  end if;

  -- 1. sales edits the note on its own row
  update public.payment_followups set note = 'sales edits the note', next_follow_up_on = current_date + 5
   where id = v_row;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'FAIL 1: sales could not edit its own follow-up (rows %)', v_n;
  end if;

  -- 2. created_by / created_at / tenant_id / customer_id are not editable — sales or owner
  foreach v_state in array array['sales', 'owner'] loop
    perform set_config('request.jwt.claims', json_build_object(
      'sub', case when v_state = 'sales' then v_sales else v_owner end, 'role', 'authenticated')::text, true);
    begin
      update public.payment_followups set created_by = v_owner where id = v_row;
      raise exception 'FAIL 2a: % rewrote created_by on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set created_at = now() - interval '30 days' where id = v_row;
      raise exception 'FAIL 2b: % back-dated created_at on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set customer_id = v_cust2 where id = v_row;
      raise exception 'FAIL 2c: % moved a follow-up to another customer', v_state;
    exception when insufficient_privilege then null;
    end;
    begin
      update public.payment_followups set tenant_id = v_a where id = v_row;
      raise exception 'FAIL 2d: % could write tenant_id on a follow-up', v_state;
    exception when insufficient_privilege then null;
    end;
  end loop;

  -- 3. insert cannot pick id or created_at
  perform set_config('request.jwt.claims', json_build_object('sub', v_sales, 'role', 'authenticated')::text, true);
  begin
    insert into public.payment_followups (tenant_id, customer_id, kind, note, created_at)
    values (v_a, v_cust, 'note', 'back-dated', now() - interval '90 days');
    raise exception 'FAIL 3a: insert chose its own created_at';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.payment_followups (id, tenant_id, customer_id, kind, note)
    values (gen_random_uuid(), v_a, v_cust, 'note', 'own id');
    raise exception 'FAIL 3b: insert chose its own id';
  exception when insufficient_privilege then null;
  end;

  raise notice 'R-1559: payment_followups columns + login lookup grants: all checks passed';
end $$;

reset role;

rollback;
