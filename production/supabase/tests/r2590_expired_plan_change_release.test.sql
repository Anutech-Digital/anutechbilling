-- R-2590 (c): an expired, unpaid Change plan quote lets go of the subscription's renewal link.
--
--   1. plan-change draft, unpaid, validity ended 3 days ago (IST) → status 'expired', renewal_quote_id null.
--      1b. same with status 'sent' → released too.
--      1c. accepted but never paid → released too (acceptance alone changes nothing).
--   2. validity ended 2 days ago → untouched (2-day margin for a payment started on the last day).
--   3. part-paid (payment_status partial) and expired → untouched (money outranks the date).
--   4. control: an expired R-2073 support upgrade (no plan_change) and an expired renewal quote
--      (extension_months 12) → untouched.
--   5. an expired plan-change quote NOT linked (the subscription links another) → untouched.
--   6. second run → 0 (released once).
--   7. tenant filter: another tenant's expired quote untouched when a tenant id is passed;
--      anon / authenticated cannot execute.
--
-- Fails without the migration: public.release_expired_plan_change_quotes does not exist.
-- Fixture owns its data and rolls back.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('dd259000-0000-4000-8000-00000000a001', 'R2590 Tenant', 'r2590@test.invalid', '07'),
  ('dd259000-0000-4000-8000-00000000a002', 'R2590 Tenant 2', 'r2590b@test.invalid', '07');
insert into public.customers (id, tenant_id, name) values
  ('dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000a001', 'R2590 Cust'),
  ('dd259000-0000-4000-8000-00000000c002', 'dd259000-0000-4000-8000-00000000a002', 'R2590 Cust 2');

-- subscriptions b1..b8 (tenant 1), b9 (tenant 2)
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, status, term_months,
                                  start_date, renewal_date, renewal_state, reminder_count, outstanding_amount)
select ('dd259000-0000-4000-8000-00000000b00' || n)::uuid,
       case when n = 9 then 'dd259000-0000-4000-8000-00000000a002'::uuid else 'dd259000-0000-4000-8000-00000000a001'::uuid end,
       case when n = 9 then 'dd259000-0000-4000-8000-00000000c002'::uuid else 'dd259000-0000-4000-8000-00000000c001'::uuid end,
       'R2590 Cust', 'R2590 Starter', 'google', 10, 2700, 'active', 12,
       current_date - 100, current_date + 265, 'pending', 0, 0
  from generate_series(1, 9) n;

-- quotes: (id, tenant, status, payment_status, expires, plan_change?, extension_months)
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status,
                           expires_date, line_items, is_renewal, extension_months, billing_cycle)
select v.id, v.tenant::uuid, v.cust::uuid, 'R2590 Cust', 1180, 1000, 18, v.status::public.quote_status, v.pay::public.payment_status,
       public.ist_today() + v.exp_days,
       case when v.pc then
         jsonb_build_array(jsonb_build_object('id','plan-change-1','name','x','qty',1,'rate',1000,'cost',0,
           'plan_change', jsonb_build_object('subscription_id', v.sub, 'from_seats',10,'from_mrr',2700,'from_plan','R2590 Starter','seats',12,'new_mrr',10368)))
       else jsonb_build_array(jsonb_build_object('id','line-1','name','y','qty',1,'rate',1000,'cost',0)) end,
       true, v.ext, 'yearly'
  from (values
    ('Q-R2590-1',  'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b001', 'draft', 'awaiting', -3, true,  0),
    ('Q-R2590-1C', 'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b008', 'accepted', 'awaiting', -4, true, 0),
    ('Q-R2590-1B', 'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b002', 'sent',  'awaiting', -5, true,  0),
    ('Q-R2590-2',  'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b003', 'draft', 'awaiting', -2, true,  0),
    ('Q-R2590-3',  'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b004', 'sent',  'partial',  -3, true,  0),
    ('Q-R2590-4A', 'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b005', 'draft', 'awaiting', -3, false, 0),
    ('Q-R2590-4B', 'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b006', 'draft', 'awaiting', -3, false, 12),
    ('Q-R2590-5',  'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b007', 'draft', 'awaiting', -3, true,  0),
    ('Q-R2590-5L', 'dd259000-0000-4000-8000-00000000a001', 'dd259000-0000-4000-8000-00000000c001', 'dd259000-0000-4000-8000-00000000b007', 'draft', 'awaiting', 30, false, 12),
    ('Q-R2590-7',  'dd259000-0000-4000-8000-00000000a002', 'dd259000-0000-4000-8000-00000000c002', 'dd259000-0000-4000-8000-00000000b009', 'draft', 'awaiting', -3, true,  0)
  ) as v(id, tenant, cust, sub, status, pay, exp_days, pc, ext);

update public.subscriptions s set renewal_quote_id = l.q
  from (values
    ('dd259000-0000-4000-8000-00000000b001'::uuid, 'Q-R2590-1'),
    ('dd259000-0000-4000-8000-00000000b002'::uuid, 'Q-R2590-1B'),
    ('dd259000-0000-4000-8000-00000000b008'::uuid, 'Q-R2590-1C'),
    ('dd259000-0000-4000-8000-00000000b003'::uuid, 'Q-R2590-2'),
    ('dd259000-0000-4000-8000-00000000b004'::uuid, 'Q-R2590-3'),
    ('dd259000-0000-4000-8000-00000000b005'::uuid, 'Q-R2590-4A'),
    ('dd259000-0000-4000-8000-00000000b006'::uuid, 'Q-R2590-4B'),
    ('dd259000-0000-4000-8000-00000000b007'::uuid, 'Q-R2590-5L'),
    ('dd259000-0000-4000-8000-00000000b009'::uuid, 'Q-R2590-7')
  ) as l(sub, q)
 where s.id = l.sub;

do $$
declare
  v_n integer;
  v_status text;
  v_link text;
begin
  /* 7b. only the service role may run it */
  if has_function_privilege('authenticated', 'public.release_expired_plan_change_quotes(uuid)', 'execute')
     or has_function_privilege('anon', 'public.release_expired_plan_change_quotes(uuid)', 'execute') then
    raise exception 'FAIL 7b: anon / authenticated can execute release_expired_plan_change_quotes';
  end if;
  raise notice 'PASS 7b: only service_role can execute';

  select count(*) into v_n from public.release_expired_plan_change_quotes('dd259000-0000-4000-8000-00000000a001');
  if v_n <> 3 then raise exception 'FAIL 1: expected 3 released for tenant 1, got %', v_n; end if;

  select q.status::text, s.renewal_quote_id into v_status, v_link
    from public.quotes q join public.subscriptions s on s.id = 'dd259000-0000-4000-8000-00000000b001'
   where q.id = 'Q-R2590-1';
  if v_status <> 'expired' or v_link is not null then
    raise exception 'FAIL 1: draft ended 3 days ago → status % link %', v_status, v_link;
  end if;
  raise notice 'PASS 1: expired unpaid plan-change draft → expired, link cleared';

  select q.status::text, s.renewal_quote_id into v_status, v_link
    from public.quotes q join public.subscriptions s on s.id = 'dd259000-0000-4000-8000-00000000b002'
   where q.id = 'Q-R2590-1B';
  if v_status <> 'expired' or v_link is not null then
    raise exception 'FAIL 1b: sent, expired → status % link %', v_status, v_link;
  end if;
  raise notice 'PASS 1b: sent + expired → released';

  if (select status::text from public.quotes where id = 'Q-R2590-1C') <> 'expired'
     or (select renewal_quote_id from public.subscriptions where id = 'dd259000-0000-4000-8000-00000000b008') is not null then
    raise exception 'FAIL 1c: accepted, never paid, expired → not released';
  end if;
  raise notice 'PASS 1c: accepted unpaid → released';

  select q.status::text, s.renewal_quote_id into v_status, v_link
    from public.quotes q join public.subscriptions s on s.id = 'dd259000-0000-4000-8000-00000000b003'
   where q.id = 'Q-R2590-2';
  if v_status <> 'draft' or v_link is distinct from 'Q-R2590-2' then
    raise exception 'FAIL 2: ended 2 days ago was touched → status % link %', v_status, v_link;
  end if;
  raise notice 'PASS 2: ended 2 days ago → untouched (margin)';

  select q.status::text, s.renewal_quote_id into v_status, v_link
    from public.quotes q join public.subscriptions s on s.id = 'dd259000-0000-4000-8000-00000000b004'
   where q.id = 'Q-R2590-3';
  if v_status <> 'sent' or v_link is distinct from 'Q-R2590-3' then
    raise exception 'FAIL 3: part-paid quote was released → status % link %', v_status, v_link;
  end if;
  raise notice 'PASS 3: part-paid → stays linked';

  if exists (select 1 from public.quotes where id in ('Q-R2590-4A', 'Q-R2590-4B') and status::text <> 'draft')
     or exists (select 1 from public.subscriptions
                 where id in ('dd259000-0000-4000-8000-00000000b005', 'dd259000-0000-4000-8000-00000000b006')
                   and renewal_quote_id is null) then
    raise exception 'FAIL 4: a support upgrade / renewal quote was released';
  end if;
  raise notice 'PASS 4: support upgrade + renewal quote untouched';

  select q.status::text, s.renewal_quote_id into v_status, v_link
    from public.quotes q join public.subscriptions s on s.id = 'dd259000-0000-4000-8000-00000000b007'
   where q.id = 'Q-R2590-5';
  if v_status <> 'draft' or v_link is distinct from 'Q-R2590-5L' then
    raise exception 'FAIL 5: unlinked plan-change quote / other link touched → status % link %', v_status, v_link;
  end if;
  raise notice 'PASS 5: not linked → untouched, the other link stays';

  if (select renewal_quote_id from public.subscriptions where id = 'dd259000-0000-4000-8000-00000000b009') is distinct from 'Q-R2590-7' then
    raise exception 'FAIL 7: another tenant''s quote was released by a tenant-1 run';
  end if;
  raise notice 'PASS 7: tenant filter holds';

  select count(*) into v_n from public.release_expired_plan_change_quotes('dd259000-0000-4000-8000-00000000a001');
  if v_n <> 0 then raise exception 'FAIL 6: second run released % again', v_n; end if;
  raise notice 'PASS 6: second run → 0';

  /* all tenants (the cron's call) picks up tenant 2's */
  select count(*) into v_n from public.release_expired_plan_change_quotes(null);
  if v_n < 1 or (select renewal_quote_id from public.subscriptions where id = 'dd259000-0000-4000-8000-00000000b009') is not null then
    raise exception 'FAIL 7c: all-tenant run did not release tenant 2''s quote (n %)', v_n;
  end if;
  raise notice 'PASS 7c: all-tenant run releases tenant 2';
end $$;

rollback;
