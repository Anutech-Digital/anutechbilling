-- R-2368 (2 Nov 2026): revising an add-seats / renewal quote keeps its subscription link.
-- Staging 2 Nov: Q-A378-27-0565-R2..0567-R2 and 0880-R2 were made by Revise with no
-- add_seats_subscription_id. revise.ts now copies the add-seats link into the draft (unit test
-- src/lib/quotes/revise.test.ts); migration 20261102123939_r2368_revise_keeps_subscription_link
-- makes the take-back once per family and hands a renewal link to a sent revision.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Owner's real path: Manage seats +3 (13 seats) → quote → Revise (-R2 draft with the link,
--      as revisionDraft builds it) → send -R2 → the old quote is replaced, the seats STAY 13 and
--      the -R2 keeps the link.
--   B. Paying the -R2 (record_payment) — the subscription keeps the 13 seats it was raised to,
--      no second subscription is made, the -R2 is paid.
--   C. A family takes its seats back ONCE: a revision draft closed while its quote is still out
--      takes nothing; the quote itself rejected later takes the 2 seats back once.
--   D. Renewal quote → Revise → send -R2: the subscription's renewal quote is the -R2 and the
--      -R2 carries the renewal link; paying it renews THAT subscription (no new one).

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
  ('dddddddd-0000-0000-0000-000000236801','R2368 Co','r2368@example.in','07','R2368');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000236801','owner2368@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000236801','dddddddd-0000-0000-0000-000000236801','owner2368@example.in','Owner 2368','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000236801','dddddddd-0000-0000-0000-000000236801','Varal 2368','07','varal2368.in');

-- Seats were already raised 10 → 13 by Manage seats (addSeats raises them at once, R-1705).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, term_months, domain)
values ('eeeeeeee-0000-0000-0000-000000236801','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801',
        'Varal 2368','Google Workspace Business Standard','google',13,1300,'2026-04-01','2027-04-01','active',12,'varal2368.in'),
       ('eeeeeeee-0000-0000-0000-000000236802','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801',
        'Varal 2368','Google Workspace Business Starter','google',5,500,'2025-11-20','2026-11-20','active',12,'varal2368b.in');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236801","role":"authenticated"}', true);

-- The add-seats quote (as addSeats writes it) and its revision draft (as revisionDraft builds it).
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items, is_one_off,
                           created_date, is_add_seats, add_seats_subscription_id, add_seats_mrr_added)
values ('Q-R2368-0565','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Standard', 3, 1770, 1500, 1200, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"add-seats-1","name":"Google Workspace Business Standard · +3 seats (pro-rata)","qty":3,"rate":500,"cost":400,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-01', true, 'eeeeeeee-0000-0000-0000-000000236801', 300);
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           is_add_seats, add_seats_subscription_id, add_seats_mrr_added, revision_of, revision_no)
values ('Q-R2368-0565-R2','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Standard', 3, 1770, 1500, 1200, 0, 18, 'draft', 'yearly',
        '[{"id":"add-seats-1","name":"Google Workspace Business Standard · +3 seats (pro-rata)","qty":3,"rate":500,"cost":400,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', true, 'eeeeeeee-0000-0000-0000-000000236801', 300, 'Q-R2368-0565', 2);

-- A. send the revision
update public.quotes set status = 'sent' where id = 'Q-R2368-0565-R2';
do $$
begin
  if (select status::text || '/' || coalesce(superseded_by, '-') from public.quotes where id = 'Q-R2368-0565') <> 'expired/Q-R2368-0565-R2' then
    raise exception 'FAIL A: old quote not replaced by the revision';
  end if;
  if (select seats from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236801') <> 13 then
    raise exception 'FAIL A: seats moved when the revision replaced the quote';
  end if;
  if (select add_seats_subscription_id from public.quotes where id = 'Q-R2368-0565-R2') is distinct from 'eeeeeeee-0000-0000-0000-000000236801'::uuid then
    raise exception 'FAIL A: -R2 lost the subscription link';
  end if;
  raise notice 'PASS A: revise + send keeps the 13 seats and the -R2 link';
end $$;

-- B. pay the -R2
select public.record_payment('Q-R2368-0565-R2', 1770, 'bank_transfer', 'UTR2368B');
do $$
begin
  if (select seats from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236801') <> 13 then
    raise exception 'FAIL B: subscription seats are not 13 after paying the -R2';
  end if;
  if (select count(*) from public.subscriptions where tenant_id = 'dddddddd-0000-0000-0000-000000236801') <> 2 then
    raise exception 'FAIL B: paying the -R2 made another subscription';
  end if;
  if not exists (select 1 from public.payments where quote_id = 'Q-R2368-0565-R2' and status = 'received' and amount = 1770) then
    raise exception 'FAIL B: -R2 not paid';
  end if;
  raise notice 'PASS B: paid -R2 — subscription has the raised 13 seats, no new subscription';
end $$;

-- C. take back once per family
update public.subscriptions set seats = 15, mrr = 1500 where id = 'eeeeeeee-0000-0000-0000-000000236801';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items, is_one_off,
                           created_date, is_add_seats, add_seats_subscription_id, add_seats_mrr_added)
values ('Q-R2368-0566','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Standard', 2, 1180, 1000, 800, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"add-seats-1","name":"+2 seats","qty":2,"rate":500,"cost":400,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-01', true, 'eeeeeeee-0000-0000-0000-000000236801', 200);
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           is_add_seats, add_seats_subscription_id, add_seats_mrr_added, revision_of, revision_no)
values ('Q-R2368-0566-R2','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Standard', 2, 1180, 1000, 800, 0, 18, 'draft', 'yearly',
        '[{"id":"add-seats-1","name":"+2 seats","qty":2,"rate":500,"cost":400,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', true, 'eeeeeeee-0000-0000-0000-000000236801', 200, 'Q-R2368-0566', 2);
update public.quotes set status = 'rejected' where id = 'Q-R2368-0566-R2';
do $$
begin
  if (select seats from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236801') <> 15 then
    raise exception 'FAIL C1: closing the draft revision took seats back while its quote is still out';
  end if;
  raise notice 'PASS C1: draft revision closed — seats stay (the quote still asks for them)';
end $$;
update public.quotes set status = 'rejected' where id = 'Q-R2368-0566';
do $$
begin
  if (select seats || '/' || mrr from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236801') <> '13/1300' then
    raise exception 'FAIL C2: seats not taken back exactly once: %',
      (select seats || '/' || mrr from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236801');
  end if;
  raise notice 'PASS C2: quote rejected — 2 seats taken back once';
end $$;

-- D. renewal quote → revise → send → pay
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, payment_status, billing_cycle, line_items, is_one_off,
                           created_date, is_renewal, renewal_subscription_id, renewal_term_date, domain)
values ('Q-R2368-0880','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Starter', 5, 7080, 6000, 5000, 0, 18, 'sent', 'awaiting', 'yearly',
        '[{"id":"r1","name":"Google Workspace Business Starter","qty":5,"rate":1200,"cost":1000,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-01', true, 'eeeeeeee-0000-0000-0000-000000236802', '2026-11-20', 'varal2368b.in');
update public.subscriptions set renewal_quote_id = 'Q-R2368-0880' where id = 'eeeeeeee-0000-0000-0000-000000236802';
insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                           discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                           is_renewal, domain, revision_of, revision_no)
values ('Q-R2368-0880-R2','dddddddd-0000-0000-0000-000000236801','cccccccc-0000-0000-0000-000000236801','Varal 2368',
        'Google Workspace Business Starter', 5, 7080, 6000, 5000, 0, 18, 'draft', 'yearly',
        '[{"id":"r1","name":"Google Workspace Business Starter","qty":5,"rate":1200,"cost":1000,"commitment":"annual_yearly"}]'::jsonb,
        false, '2026-11-02', true, 'varal2368b.in', 'Q-R2368-0880', 2);
update public.quotes set status = 'sent' where id = 'Q-R2368-0880-R2';
do $$
begin
  if (select renewal_quote_id from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236802') is distinct from 'Q-R2368-0880-R2' then
    raise exception 'FAIL D1: subscription renewal quote not moved to the revision';
  end if;
  if (select renewal_subscription_id::text || '/' || renewal_term_date from public.quotes where id = 'Q-R2368-0880-R2')
     is distinct from 'eeeeeeee-0000-0000-0000-000000236802/2026-11-20' then
    raise exception 'FAIL D1: -R2 has no renewal link';
  end if;
  if (select renewal_subscription_id from public.quotes where id = 'Q-R2368-0880') is not null then
    raise exception 'FAIL D1: old quote kept the renewal link';
  end if;
  raise notice 'PASS D1: sent renewal revision takes over the renewal link';
end $$;
select public.record_payment('Q-R2368-0880-R2', 7080, 'bank_transfer', 'UTR2368D');
do $$
begin
  if (select count(*) from public.subscriptions where tenant_id = 'dddddddd-0000-0000-0000-000000236801') <> 2 then
    raise exception 'FAIL D2: paying the renewal -R2 made a new subscription';
  end if;
  if (select renewal_date from public.subscriptions where id = 'eeeeeeee-0000-0000-0000-000000236802') <= '2026-11-20' then
    raise exception 'FAIL D2: the subscription was not renewed';
  end if;
  raise notice 'PASS D2: paid renewal -R2 renews its subscription';
end $$;

rollback;
