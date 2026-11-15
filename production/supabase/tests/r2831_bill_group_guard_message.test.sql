-- R-2831 (15 Nov 2026) — trg_subscriptions_bill_group_guarded's words. Migration 20261115031722_r2831_bill_group_guard_message.
-- Self-asserting, ONE transaction, rolled back. Local DB only. RED without the migration (the old message told the
-- owner to "take it out of Bill together on Renewals", which no screen can do).
--   M. A browser login (owner) moving a grouped subscription to another customer → refused (42501), the message
--      says it is grouped for billing and to ask support; it never names a "take it out of Bill together" action.
--   K. Rules unchanged: an ungrouped subscription still changes customer; setting bill_group_id by hand still refused.

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
  ('b2831000-0000-0000-0000-0000000000f1', 'R2831 Guard Co', 'r2831@example.test', '07', 'R831');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('b2831000-0000-0000-0000-000000000101', 'b2831000-0000-0000-0000-0000000000f1', 'R2831 C1', '07', 'India'),
  ('b2831000-0000-0000-0000-000000000102', 'b2831000-0000-0000-0000-0000000000f1', 'R2831 C2', '07', 'India');
-- set up as server code (no request login): one grouped, one ungrouped subscription of C1
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, billing_cycle,
                                  term_months, start_date, renewal_date, renewal_state, reminder_count, status, bill_group_id) values
  ('b2831000-0000-0000-0000-000000000201', 'b2831000-0000-0000-0000-0000000000f1', 'b2831000-0000-0000-0000-000000000101', 'R2831 C1',
   'Plan G', 'google'::vendor, 1, 1000, 'monthly'::billing_cycle, 12, '2025-10-01', '2026-10-01', 'grace_period', 0, 'active',
   'b2831000-0000-0000-0000-0000000009a1'),
  ('b2831000-0000-0000-0000-000000000202', 'b2831000-0000-0000-0000-0000000000f1', 'b2831000-0000-0000-0000-000000000101', 'R2831 C1',
   'Plan U', 'google'::vendor, 1, 1000, 'monthly'::billing_cycle, 12, '2025-10-01', '2026-10-01', 'grace_period', 0, 'active', null);

insert into auth.users (id, email) values ('b2831000-0000-0000-0000-0000000000a1', 'owner2831@example.test');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('b2831000-0000-0000-0000-0000000000a1', 'b2831000-0000-0000-0000-0000000000f1', 'owner2831@example.test', 'Owner 2831', 'owner', now() - interval '1 day');
select set_config('request.jwt.claims', '{"sub":"b2831000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
do $$
declare n int;
begin
  -- M. the grouped subscription cannot move customer — and the words name a real way (support)
  begin
    update public.subscriptions set customer_id = 'b2831000-0000-0000-0000-000000000102'
     where id = 'b2831000-0000-0000-0000-000000000201';
    get diagnostics n = row_count;
    raise exception 'FAIL M: owner login moved a grouped subscription to another customer (% rows, no error)', n;
  exception when insufficient_privilege then
    if sqlerrm ilike '%take it out%' or sqlerrm ilike '%on Renewals first%' then
      raise exception 'FAIL M: the message still names an action no screen has: %', sqlerrm;
    end if;
    if sqlerrm not like '%grouped for billing%' or sqlerrm not like '%another customer%' or sqlerrm not ilike '%ask support%' then
      raise exception 'FAIL M: the message does not say it is grouped for billing / ask support: %', sqlerrm;
    end if;
    raise notice 'PASS M: refused in plain words: %', sqlerrm;
  end;
  -- K. rules unchanged
  begin
    update public.subscriptions set bill_group_id = null where id = 'b2831000-0000-0000-0000-000000000201';
    raise exception 'FAIL K: owner login cleared bill_group_id by hand';
  exception when insufficient_privilege then
    if sqlerrm not like '%Bill together%' then raise exception 'FAIL K: refused for another reason: %', sqlerrm; end if;
    raise notice 'PASS K: bill_group_id still set only by server code';
  end;
  update public.subscriptions set customer_id = 'b2831000-0000-0000-0000-000000000102'
   where id = 'b2831000-0000-0000-0000-000000000202';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL K: an ungrouped subscription can no longer change customer (% rows)', n; end if;
  raise notice 'PASS K: an ungrouped subscription still changes customer';
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

rollback;
