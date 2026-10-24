\set ON_ERROR_STOP on
-- R-1635 (P1): "Write off" on /payments must take the subscription's open invoices out of the
-- chase — Payment Follow-up, Overdue, the dunning cron, reminders, the nav badge and the
-- Today inbox — without changing a rupee on them.
-- Migrations: 20261023184545_r1635_write_off_invoices + 20261023184546_r1635_badges_inbox_written_off.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1635_write_off_subscription.test.sql
--
-- Expect "PASS r1635_write_off_subscription".
--
--   GUARDS   no reason, a sales user, another company → refused; nothing stamped
--   WRITE    owner writes S1 off → S1 cancelled + stamped; its own-quote invoice (in a LOCKED
--            month) and its instalment invoice stamped with the reason; status, amount,
--            net_payable, paid_amount unchanged; another invoice of the customer untouched
--   ONCE     a second write-off of S1 → refused
--   SHARED   S2's quote also bills live S3 → that invoice is left open and listed
--   LOCK     the locked-month invoice still refuses any OTHER change (paid_amount)
--   READERS  nav_badges() invoices and today_inbox() overdue items leave written-off ones out

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e1635000-0000-4000-8000-0000000000a1', 'r1635-owner@example.test'),
  ('e1635000-0000-4000-8000-0000000000a3', 'r1635-sales@example.test'),
  ('e1635000-0000-4000-8000-0000000000b1', 'r1635-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1635000-0000-0000-0000-0000000000a0', 'R1635 A', 'r1635a@example.in', '07', 'R35A'),
  ('e1635000-0000-0000-0000-0000000000b0', 'R1635 B', 'r1635b@example.in', '07', 'R35B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1635000-0000-4000-8000-0000000000a1', 'e1635000-0000-0000-0000-0000000000a0', 'r1635-owner@example.in',   'R1635 Owner',   'owner', true),
  ('e1635000-0000-4000-8000-0000000000a3', 'e1635000-0000-0000-0000-0000000000a0', 'r1635-sales@example.in',   'R1635 Sales',   'sales', true),
  ('e1635000-0000-4000-8000-0000000000b1', 'e1635000-0000-0000-0000-0000000000b0', 'r1635-owner-b@example.in', 'R1635 Owner B', 'owner', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1635000-0000-4000-8000-0000000000c1', 'e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, paid_amount, taxable_value, invoice_date, due_date, status, quote_id) values
  -- S1's own quote invoice, part paid, dated in September (locked below)
  ('R35-OWN',   'e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', 'e1635000-0000-4000-8000-0000000000c1', 11800, 11800, 1800, 10000, '2026-09-01', '2026-09-15', 'pending', null),
  -- S1's instalment invoice (quote_id stays null)
  ('R35-INST',  'e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', 'e1635000-0000-4000-8000-0000000000c1',  1180,  1180,    0,  1000, '2026-10-01', '2026-10-05', 'pending', null),
  -- S1's instalment that is already paid — not touched
  ('R35-PAID',  'e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', 'e1635000-0000-4000-8000-0000000000c1',  1180,  1180, 1180,  1000, '2026-10-01', '2026-10-05', 'paid',    null),
  -- S2/S3's shared quote invoice
  ('R35-SHARED','e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', 'e1635000-0000-4000-8000-0000000000c1',  2360,  2360,    0,  2000, '2026-10-01', '2026-10-05', 'pending', null),
  -- an unrelated invoice of the same customer
  ('R35-OTHER', 'e1635000-0000-0000-0000-0000000000a0', 'R1635 Closed Co', 'e1635000-0000-4000-8000-0000000000c1',   590,   590,    0,   500, '2026-10-01', '2026-10-05', 'pending', null);

insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items, invoice_id) values
  ('Q-R35-1', 'e1635000-0000-0000-0000-0000000000a0', null, 'e1635000-0000-4000-8000-0000000000c1', 'R1635 Closed Co', 11800, 10000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R35-OWN'),
  ('Q-R35-2', 'e1635000-0000-0000-0000-0000000000a0', null, 'e1635000-0000-4000-8000-0000000000c1', 'R1635 Closed Co',  2360,  2000, 18, 'accepted', 'invoiced', '[]'::jsonb, 'R35-SHARED');
update public.invoices set quote_id = 'Q-R35-1' where id = 'R35-OWN';
update public.invoices set quote_id = 'Q-R35-2' where id = 'R35-SHARED';

insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, quote_id, outstanding_amount) values
  ('e1635000-0000-4000-8000-0000000000d1', 'e1635000-0000-0000-0000-0000000000a0', 'e1635000-0000-4000-8000-0000000000c1', 'R1635 Closed Co', 'Business Starter', 'google', 5, 1000, 'active', 'Q-R35-1', 11180),
  ('e1635000-0000-4000-8000-0000000000d2', 'e1635000-0000-0000-0000-0000000000a0', 'e1635000-0000-4000-8000-0000000000c1', 'R1635 Closed Co', 'Business Plus',    'google', 1, 1000, 'active', 'Q-R35-2',  1180),
  ('e1635000-0000-4000-8000-0000000000d3', 'e1635000-0000-0000-0000-0000000000a0', 'e1635000-0000-4000-8000-0000000000c1', 'R1635 Closed Co', 'Vault',            'google', 1, 1000, 'active', 'Q-R35-2',  1180);
insert into public.subscription_billings (tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, invoice_id) values
  ('e1635000-0000-0000-0000-0000000000a0', 'e1635000-0000-4000-8000-0000000000d1', '2026-10-01', 1, '2026-10-01', '2026-10-01', '2026-10-31', 1000, 18, 'R35-INST'),
  ('e1635000-0000-0000-0000-0000000000a0', 'e1635000-0000-4000-8000-0000000000d1', '2026-10-01', 2, '2026-11-01', '2026-11-01', '2026-11-30', 1000, 18, 'R35-PAID');

-- September is filed: the books are locked to 30 Sep.
update public.tenants set books_locked_until = '2026-09-30' where id = 'e1635000-0000-0000-0000-0000000000a0';

create temp table r1635_fail (msg text) on commit drop;
grant all on r1635_fail to authenticated;

create function pg_temp.r1635_try(p_sub uuid, p_reason text) returns text language plpgsql as $$
begin
  perform public.write_off_subscription(p_sub, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1635_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1635_try(uuid, text) to authenticated;
grant execute on function pg_temp.r1635_as(text) to authenticated;

do $$
declare
  d1 constant uuid := 'e1635000-0000-4000-8000-0000000000d1';
  d2 constant uuid := 'e1635000-0000-4000-8000-0000000000d2';
  v_e text; v_r jsonb; v_s record; v_i record; v_n int; v_b jsonb;
begin
  set local role authenticated;

  -- ════ GUARDS ══════════════════════════════════════════════════════════════════════
  perform pg_temp.r1635_as('e1635000-0000-4000-8000-0000000000a1');
  v_e := pg_temp.r1635_try(d1, ' ');
  if v_e is null or v_e not like '22023: Write why these dues are being written off%' then
    insert into r1635_fail values ('no reason not refused: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1635_as('e1635000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r1635_try(d1, 'Customer closed the business');
  if v_e is null or v_e not like '42501: Only an owner, manager, accountant or billing user%' then
    insert into r1635_fail values ('sales user wrote off: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r1635_as('e1635000-0000-4000-8000-0000000000b1');
  v_e := pg_temp.r1635_try(d1, 'Customer closed the business');
  if v_e is null or v_e not like '42501: That subscription was not found in your company%' then
    insert into r1635_fail values ('other company wrote off: ' || coalesce(v_e, 'ran'));
  end if;

  perform pg_temp.r1635_as('e1635000-0000-4000-8000-0000000000a1');
  -- before: the badge counts all four unpaid invoices of tenant A
  v_b := public.nav_badges('{}');
  if (v_b->>'invoices')::int <> 4 then
    insert into r1635_fail values ('badge before write-off should be 4: ' || v_b::text);
  end if;

  -- ════ WRITE ═══════════════════════════════════════════════════════════════════════
  begin
    v_r := public.write_off_subscription(d1, 'Customer closed the business');
    if v_r->'invoices_written_off' is distinct from '["R35-INST", "R35-OWN"]'::jsonb
       or (v_r->>'invoice_amount')::int <> 10000 + 1180
       or v_r->'invoices_left_open' is distinct from '[]'::jsonb then
      insert into r1635_fail values ('S1 result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1635_fail values ('S1 write-off raised: ' || sqlerrm);
  end;

  -- ════ ONCE ════════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r1635_try(d1, 'Again');
  if v_e is null or v_e not like '22023: These dues were already written off%' then
    insert into r1635_fail values ('second write-off not refused: ' || coalesce(v_e, 'ran'));
  end if;

  -- ════ SHARED ══════════════════════════════════════════════════════════════════════
  begin
    v_r := public.write_off_subscription(d2, 'Seat not used');
    if v_r->'invoices_written_off' is distinct from '[]'::jsonb
       or v_r->'invoices_left_open' is distinct from '["R35-SHARED"]'::jsonb then
      insert into r1635_fail values ('S2 result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1635_fail values ('S2 write-off raised: ' || sqlerrm);
  end;

  -- ════ READERS ═════════════════════════════════════════════════════════════════════
  v_b := public.nav_badges('{}');
  if (v_b->>'invoices')::int <> 2 then   -- R35-SHARED + R35-OTHER
    insert into r1635_fail values ('badge after write-off should be 2: ' || v_b::text);
  end if;
  select count(*) into v_n from public.today_inbox() t
   where t.kind = 'invoice_overdue' and t.id in ('R35-OWN', 'R35-INST');
  if v_n <> 0 then insert into r1635_fail values ('today_inbox still lists written-off invoices: ' || v_n); end if;
  select count(*) into v_n from public.today_inbox() t
   where t.kind = 'invoice_overdue' and t.id in ('R35-SHARED', 'R35-OTHER');
  if v_n <> 2 then insert into r1635_fail values ('today_inbox lost open overdue invoices: ' || v_n); end if;

  -- ════ LOCK ════════════════════════════════════════════════════════════════════════
  begin
    update public.invoices set paid_amount = 2000 where id = 'R35-OWN';
    insert into r1635_fail values ('a locked-month invoice took a paid_amount change');
  exception when others then
    if sqlerrm not like 'Books % tak lock hain%' then
      insert into r1635_fail values ('locked change refused with wrong message: ' || sqlerrm);
    end if;
  end;

  set local role postgres;
  select status::text as status, written_off_at, write_off_reason into v_s from public.subscriptions where id = d1;
  if v_s.status <> 'cancelled' or v_s.written_off_at is null or v_s.write_off_reason <> 'Customer closed the business' then
    insert into r1635_fail values ('S1 not cancelled + stamped: ' || row_to_json(v_s)::text);
  end if;
  select status::text as status, written_off_at is not null as wo, write_off_reason, amount, net_payable, paid_amount
    into v_i from public.invoices where id = 'R35-OWN';
  if v_i.status <> 'pending' or not v_i.wo or v_i.write_off_reason <> 'Customer closed the business'
     or v_i.amount <> 11800 or v_i.net_payable <> 11800 or v_i.paid_amount <> 1800 then
    insert into r1635_fail values ('R35-OWN wrong after write-off: ' || row_to_json(v_i)::text);
  end if;
  select count(*) into v_n from public.invoices where id = 'R35-INST' and written_off_at is not null and status = 'pending' and paid_amount = 0;
  if v_n <> 1 then insert into r1635_fail values ('R35-INST not stamped'); end if;
  select count(*) into v_n from public.invoices where id in ('R35-PAID', 'R35-SHARED', 'R35-OTHER') and written_off_at is not null;
  if v_n <> 0 then insert into r1635_fail values ('an invoice outside S1 (or paid) was stamped: ' || v_n); end if;
  select count(*) into v_n from public.subscriptions where id = d2 and written_off_at is not null and status = 'cancelled';
  if v_n <> 1 then insert into r1635_fail values ('S2 not cancelled + stamped'); end if;

  select count(*) into v_n from r1635_fail;
  if v_n > 0 then
    raise exception 'FAIL r1635_write_off_subscription: %', (select string_agg(msg, E'\n') from r1635_fail);
  end if;
  raise notice 'PASS r1635_write_off_subscription';
end $$;

rollback;
