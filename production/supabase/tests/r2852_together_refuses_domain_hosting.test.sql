\set ON_ERROR_STOP on
-- R-2852 (15 Nov 2026, p1 money; rev-r2849 H1 follow-up) — create_renewal_quote_together refuses a domain or hosting
-- subscription in plain words. Migration 20261115152217_r2852_together_refuses_domain_hosting.
-- Self-asserting, ONE transaction, rolled back. Local DB only. RED without the migration (A/B/C/D make a quote).
--
--   A  Workspace + domain → refused "<plan> is a domain renewal — renew it with Review renewal quote on its row", no quote
--   B  Workspace + hosting → refused the same way; C both → both named
--   D  same-set relink: a together quote made for two Workspace subs, then one becomes vendor domain → refused, the
--      old quote is not handed back
--   E  owner browser login calling the RPC directly → refused the same way
--   F  two Workspace subs → still one quote (control)
--   Z  signature unchanged (no overload) and grants unchanged

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
  ('c2852000-0000-0000-0000-0000000000f1', 'R2852 Together Co', 'r2852@example.test', '07', 'R852');

/* Open the R-2847 gate inside this rolled-back transaction (R-2848 opens it for real; a DB without R-2848 still runs). */
create or replace function public.r2847_together_payment_ready() returns boolean language sql stable as $$ select true $$;

create function pg_temp.cust(p_n int) returns uuid language plpgsql as $f$
declare v_c uuid := ('c2852000-0000-0000-0000-0000000001' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.customers (id, tenant_id, name, state_code, country)
  values (v_c, 'c2852000-0000-0000-0000-0000000000f1', 'R2852 C' || p_n, '07', 'India');
  return v_c;
end $f$;

create function pg_temp.sub(p_n int, p_c uuid, p_plan text, p_vendor text, p_renewal date) returns uuid
language plpgsql as $f$
declare v_s uuid := ('c2852000-0000-0000-0000-0000000002' || lpad(p_n::text, 2, '0'))::uuid;
begin
  insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                    term_months, start_date, renewal_date, renewal_state, reminder_count, status, domain)
  values (v_s, 'c2852000-0000-0000-0000-0000000000f1', p_c, (select name from public.customers where id = p_c), p_plan,
          p_vendor::vendor, 1, 1000, 'yearly'::billing_cycle, 12, p_renewal - 365, p_renewal, 'pending', 0,
          'active', 'r2852-' || p_n || '.example.test');
  return v_s;
end $f$;

create function pg_temp.q(p_plan text, p_subtotal int) returns jsonb language sql immutable as $f$
  select jsonb_build_object(
    'customer_name', 'R2852', 'plan', p_plan, 'seats', 1,
    'amount', p_subtotal + round(p_subtotal * 18 / 100.0)::int, 'subtotal', p_subtotal,
    'total_cost', 0, 'tax_rate', 18, 'created_date', '2026-11-15', 'expires_date', '2026-12-15', 'extension_months', 12,
    'line_items', jsonb_build_array(jsonb_build_object('id', 'renewal-1', 'name', p_plan, 'qty', 1,
                                    'rate', p_subtotal, 'cost', 0, 'commitment', 'annual_yearly')))
$f$;

create function pg_temp.parts(a uuid, b uuid) returns jsonb language sql immutable as $f$
  select jsonb_build_array(jsonb_build_object('subscription_id', a, 'quote', pg_temp.q('Part A', 12000)),
                           jsonb_build_object('subscription_id', b, 'quote', pg_temp.q('Part B', 6000)))
$f$;

create function pg_temp.try(p_parts jsonb) returns text language plpgsql as $f$
declare r jsonb;
begin
  r := public.create_renewal_quote_together('c2852000-0000-0000-0000-0000000000f1', p_parts);
  return 'OK ' || (r->>'quote_id');
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $f$;

-- ── A / B / C — domain, hosting, both ───────────────────────────────────────────────────────────────────────
do $$
declare c uuid; w uuid; d uuid; h uuid; v_msg text;
begin
  c := pg_temp.cust(1);
  w := pg_temp.sub(1, c, 'Business Starter', 'google', '2026-12-31');
  d := pg_temp.sub(2, c, 'acme.example domain', 'domain', '2026-12-31');
  h := pg_temp.sub(3, c, 'Hosting Pro', 'hosting', '2026-12-31');

  v_msg := pg_temp.try(pg_temp.parts(w, d));
  if v_msg <> '22023 acme.example domain is a domain renewal — renew it with Review renewal quote on its row, not on one quote with other subscriptions.' then
    raise exception 'FAIL A: %', v_msg; end if;
  raise notice 'PASS A: %', v_msg;

  v_msg := pg_temp.try(pg_temp.parts(h, w));
  if v_msg <> '22023 Hosting Pro is a hosting renewal — renew it with Review renewal quote on its row, not on one quote with other subscriptions.' then
    raise exception 'FAIL B: %', v_msg; end if;
  raise notice 'PASS B: %', v_msg;

  v_msg := pg_temp.try(pg_temp.parts(d, h));
  if v_msg not like '22023 %renew it with Review renewal quote on its row%'
     or v_msg not like '%Hosting Pro is a hosting renewal%' or v_msg not like '%acme.example domain is a domain renewal%' then
    raise exception 'FAIL C: %', v_msg; end if;
  raise notice 'PASS C: both named';

  if exists (select 1 from public.quotes where customer_id = c)
     or exists (select 1 from public.renewal_quote_subscriptions where subscription_id in (w, d, h))
     or exists (select 1 from public.subscriptions where id in (w, d, h) and renewal_quote_id is not null) then
    raise exception 'FAIL A-C: a quote, link row or link was written'; end if;
end $$;

-- ── F — control: two Workspace subs still make one quote; D — then one becomes a domain → no relink ───────
do $$
declare c uuid; a uuid; b uuid; v_msg text; v_q text;
begin
  c := pg_temp.cust(2);
  a := pg_temp.sub(4, c, 'Business Standard', 'google', '2026-12-20');
  b := pg_temp.sub(5, c, 'Business Plus', 'google', '2026-12-21');
  v_msg := pg_temp.try(pg_temp.parts(a, b));
  if v_msg not like 'OK %' then raise exception 'FAIL F: two Workspace subs refused: %', v_msg; end if;
  v_q := substr(v_msg, 4);
  raise notice 'PASS F: two Workspace subscriptions → %', v_q;

  -- the link is lost and b turns out to be a domain: the same set must not get the old quote back
  update public.subscriptions set renewal_quote_id = null where id in (a, b);
  update public.subscriptions set vendor = 'domain'::vendor where id = b;
  v_msg := pg_temp.try(pg_temp.parts(a, b));
  if v_msg not like '22023 Business Plus is a domain renewal — renew it with Review renewal quote on its row%' then
    raise exception 'FAIL D: %', v_msg; end if;
  if exists (select 1 from public.subscriptions where id in (a, b) and renewal_quote_id is not null) then
    raise exception 'FAIL D: the old together quote was relinked'; end if;
  raise notice 'PASS D: relink refused for a domain member';
end $$;

-- ── E — owner login calling the RPC directly ────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values ('c2852000-0000-0000-0000-0000000000a1', 'owner2852@example.test');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('c2852000-0000-0000-0000-0000000000a1', 'c2852000-0000-0000-0000-0000000000f1', 'owner2852@example.test', 'Owner 2852', 'owner', now() - interval '1 day');
grant execute on function pg_temp.try(jsonb) to authenticated;
grant execute on function pg_temp.parts(uuid, uuid) to authenticated;
grant execute on function pg_temp.q(text, int) to authenticated;
select set_config('request.jwt.claims', '{"sub":"c2852000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$ declare v_msg text; begin
  v_msg := pg_temp.try(pg_temp.parts('c2852000-0000-0000-0000-000000000201', 'c2852000-0000-0000-0000-000000000202'));
  if v_msg not like '22023 acme.example domain is a domain renewal — renew it with Review renewal quote on its row%' then
    raise exception 'FAIL E: %', v_msg; end if;
  raise notice 'PASS E: owner login refused the same way';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── Z — one function of that name, same grants ──────────────────────────────────────────────────────────────
do $$ begin
  if (select count(*) from pg_proc where proname = 'create_renewal_quote_together' and pronamespace = 'public'::regnamespace) <> 1 then
    raise exception 'FAIL Z: create_renewal_quote_together is overloaded'; end if;
  if to_regprocedure('public.create_renewal_quote_together(uuid,jsonb)') is null then raise exception 'FAIL Z: signature changed'; end if;
  if has_function_privilege('anon', 'public.create_renewal_quote_together(uuid,jsonb)', 'execute') then
    raise exception 'FAIL Z: anon can execute'; end if;
  if not has_function_privilege('authenticated', 'public.create_renewal_quote_together(uuid,jsonb)', 'execute')
     or not has_function_privilege('service_role', 'public.create_renewal_quote_together(uuid,jsonb)', 'execute') then
    raise exception 'FAIL Z: authenticated / service_role lost execute'; end if;
  if not (select prosecdef from pg_proc where oid = to_regprocedure('public.create_renewal_quote_together(uuid,jsonb)')) then
    raise exception 'FAIL Z: no longer security definer'; end if;
  raise notice 'PASS Z: one signature, grants unchanged';
end $$;

select 'PASS r2852_together_refuses_domain_hosting' as result;
rollback;
