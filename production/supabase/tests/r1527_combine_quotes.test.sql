\set ON_ERROR_STOP on
-- R-1527 (P2): several accepted, unpaid, un-invoiced quotes of ONE customer → ONE new quote,
-- then today's generate_invoice issues ONE tax invoice on it.
-- Migration: 20261017161500_r1527_combine_quotes (combine_quotes).
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r1527_combine_quotes.test.sql
--
-- Expect "PASS r1527_combine_quotes". Every check is collected and failures listed together.
--
--   COMBINE   3 quotes → 1 new accepted quote: amount = sum (18880), subtotal 16000, all 3 lines
--             in order with item_id / commitment / start_date / domain kept; originals expired,
--             superseded_by the new quote, audit line in notes; an original cannot be accepted again
--   INVOICE   generate_invoice on the new quote: ONE invoice, amount 18880, taxable 16000, tax
--             2880, intra-state (07/07); new quote linked; originals carry no invoice
--   REFUSED   (each leaves NOTHING behind) already-invoiced quote; other customer; other
--             currency; other GST treatment (0% vs 18%); other company's quote; NULL company
--             (service_role with no user); signed-in user with no company; sales role; payment /
--             advance on a quote; advance credit linked; quote not accepted; only one quote; a
--             quote listed twice; saved total ≠ lines; quotes for different domains; lines
--             without a domain in two quotes; same plan + domain in two quotes; monthly + annual mix

begin;

-- R-1643: issuing a Tax Invoice needs the company's own GSTIN + address (supplier_invoice_problem).
-- Every company this test creates gets both unless the test sets them itself (an unregistered
-- one gets only the address). Rolled back with the test.
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

insert into auth.users (id, email) values
  ('e1527000-0000-4000-8000-0000000000a2', 'r1527-billing@example.test'),
  ('e1527000-0000-4000-8000-0000000000a3', 'r1527-sales@example.test'),
  ('e1527000-0000-4000-8000-0000000000d9', 'r1527-nocompany@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e1527000-0000-0000-0000-0000000000a0', 'R1527 A', 'r1527a@example.in', '07', 'R17A'),
  ('e1527000-0000-0000-0000-0000000000b0', 'R1527 B', 'r1527b@example.in', '07', 'R17B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e1527000-0000-4000-8000-0000000000a2', 'e1527000-0000-0000-0000-0000000000a0', 'r1527-billing@example.in', 'R1527 Billing', 'billing', true),
  ('e1527000-0000-4000-8000-0000000000a3', 'e1527000-0000-0000-0000-0000000000a0', 'r1527-sales@example.in',   'R1527 Sales',   'sales',   true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e1527000-0000-4000-8000-0000000000c1', 'e1527000-0000-0000-0000-0000000000a0', 'R1527 Cust',   '07', 'India'),
  ('e1527000-0000-4000-8000-0000000000c2', 'e1527000-0000-0000-0000-0000000000a0', 'R1527 Other',  '07', 'India'),
  ('e1527000-0000-4000-8000-0000000000cb', 'e1527000-0000-0000-0000-0000000000b0', 'R1527 B Cust', '07', 'India');

-- (id, tenant, customer, domain, currency, tax, status, lines, subtotal, amount)
--  Lines are priced so every saved total = the builder formula (round(subtotal × 18%)).
insert into public.quotes (id, tenant_id, customer_id, customer_name, domain, currency, exchange_rate, tax_rate,
                           status, payment_status, discount_pct, line_items, subtotal, amount, created_at)
select v.id, v.t::uuid, v.c::uuid, 'R1527', v.dom, v.cur, 1, v.tax, v.st::quote_status, 'awaiting', 0,
       v.lines::jsonb, v.sub, v.amt, v.at::timestamptz
  from (values
    -- the three to combine: Workspace (a.com) + one-time setup + Zoho (a.com)
    ('R17-Q1', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'a.com', 'INR', 18, 'accepted',
     '[{"id":"L1","item_id":"item-ws","name":"Workspace Business","qty":10,"rate":1000,"cost":800,"commitment":"annual_yearly","start_date":"2026-11-01","domain":"a.com"}]',
     10000, 11800, '2026-10-01T10:00:00Z'),
    ('R17-Q2', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'a.com', 'INR', 18, 'accepted',
     '[{"id":"L2","name":"Setup and migration","qty":1,"rate":5001,"cost":0}]',
     5001, 5901, '2026-10-02T10:00:00Z'),
    ('R17-Q3', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'a.com', 'INR', 18, 'accepted',
     '[{"id":"L3","item_id":"item-zoho","name":"Zoho Mail","qty":3,"rate":333,"cost":200,"commitment":"annual_yearly","domain":"a.com"}]',
     999, 1179, '2026-10-03T10:00:00Z'),
    -- refusal fixtures (all customer c1 unless noted)
    ('R17-OK1', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"K1","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T10:00:00Z'),
    ('R17-OK2', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"K2","name":"Training","qty":1,"rate":2000,"cost":0}]', 2000, 2360, '2026-10-04T11:00:00Z'),
    ('R17-INV', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"K3","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-OCU', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c2', null, 'INR', 18, 'accepted',
     '[{"id":"K4","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-USD', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'USD', 18, 'accepted',
     '[{"id":"K5","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-GST0', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 0, 'accepted',
     '[{"id":"K6","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1000, '2026-10-04T12:00:00Z'),
    ('R17-BQ', 'e1527000-0000-0000-0000-0000000000b0', 'e1527000-0000-4000-8000-0000000000cb', null, 'INR', 18, 'accepted',
     '[{"id":"K7","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-PAY', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"K8","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-CRD', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"K9","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-SENT', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'sent',
     '[{"id":"KA","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-BAD', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', null, 'INR', 18, 'accepted',
     '[{"id":"KB","name":"Consulting","qty":1,"rate":1000,"cost":0}]', 1000, 1200, '2026-10-04T12:00:00Z'),
    ('R17-DOMB', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'b.com', 'INR', 18, 'accepted',
     '[{"id":"KC","name":"Workspace Starter","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"b.com"}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-NOD1', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'a.com', 'INR', 18, 'accepted',
     '[{"id":"KD","name":"Workspace Starter","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly"}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-NOD2', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'a.com', 'INR', 18, 'accepted',
     '[{"id":"KE","name":"Zoho Mail","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly"}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-DUPA', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'c.com', 'INR', 18, 'accepted',
     '[{"id":"KF","name":"Workspace Starter","qty":1,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"c.com"}]', 1000, 1180, '2026-10-04T12:00:00Z'),
    ('R17-DUPB', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'c.com', 'INR', 18, 'accepted',
     '[{"id":"KG","name":"Workspace Starter","qty":2,"rate":1000,"cost":0,"commitment":"annual_yearly","domain":"c.com"}]', 2000, 2360, '2026-10-04T12:00:00Z'),
    ('R17-MON', 'e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 'c.com', 'INR', 18, 'accepted',
     '[{"id":"KH","name":"Workspace Flex","qty":1,"rate":1000,"cost":0,"commitment":"monthly","domain":"c.com"}]', 1000, 1180, '2026-10-04T12:00:00Z')
  ) v(id, t, c, dom, cur, tax, st, lines, sub, amt, at);

-- R17-INV already invoiced, R17-PAY has an advance payment, R17-CRD a linked credit.
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, taxable_value, invoice_date, quote_id)
values ('R17-I-INV', 'e1527000-0000-0000-0000-0000000000a0', 'R1527', 'e1527000-0000-4000-8000-0000000000c1', 1180, 1180, 1000, '2026-10-05', 'R17-INV');
update public.quotes set invoice_id = 'R17-I-INV', payment_status = 'invoiced' where id = 'R17-INV';
insert into public.payments (tenant_id, quote_id, amount, method, status, reference)
values ('e1527000-0000-0000-0000-0000000000a0', 'R17-PAY', 500, 'upi', 'received', 'UTR-R1527-ADV');
insert into public.customer_credits (tenant_id, customer_id, amount, source, source_quote_id, status)
values ('e1527000-0000-0000-0000-0000000000a0', 'e1527000-0000-4000-8000-0000000000c1', 100, 'overpayment', 'R17-CRD', 'open');

create temp table r1527_fail (msg text) on commit drop;
grant all on r1527_fail to authenticated, service_role;

-- Calls the RPC as the current claims; returns null on success, else 'SQLSTATE: message'.
create function pg_temp.r1527_try(p_ids text[]) returns text language plpgsql as $$
begin
  perform public.combine_quotes(p_ids);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r1527_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r1527_try(text[]) to authenticated, service_role;
grant execute on function pg_temp.r1527_as(text) to authenticated;

do $$
declare
  v_r jsonb; v_e text; v_new text; v_q record; v_inv record; v_n int;
  v_quotes_before int; v_fp_before text; v_case record;
begin
  -- ════ REFUSALS first — each must leave NOTHING behind ═════════════════════════════
  select count(*) into v_quotes_before from public.quotes where tenant_id = 'e1527000-0000-0000-0000-0000000000a0';
  select string_agg(id || ':' || status::text || ':' || coalesce(superseded_by, '-'), ',' order by id) into v_fp_before
    from public.quotes where id like 'R17-%';

  set local role authenticated;
  perform pg_temp.r1527_as('e1527000-0000-4000-8000-0000000000a2');

  for v_case in
    select * from (values
      ('already invoiced',      array['R17-OK1','R17-INV'],          'already has invoice R17-I-INV'),
      ('other customer',        array['R17-OK1','R17-OCU'],          'Only quotes of ONE customer'),
      ('other currency',        array['R17-OK1','R17-USD'],          'same currency'),
      ('other GST treatment',   array['R17-OK1','R17-GST0'],         'Different GST treatment'),
      ('other company quote',   array['R17-OK1','R17-BQ'],           'R17-BQ was not found in your company'),
      ('payment / advance',     array['R17-OK1','R17-PAY'],          'R17-PAY has a payment or advance'),
      ('advance credit linked', array['R17-OK1','R17-CRD'],          'R17-CRD has advance credit'),
      ('not accepted',          array['R17-OK1','R17-SENT'],         'R17-SENT is sent'),
      ('only one quote',        array['R17-OK1'],                    'at least two quotes'),
      ('listed twice',          array['R17-OK1','R17-OK1','R17-OK2'],'listed twice'),
      ('total != lines',        array['R17-OK1','R17-BAD'],          'R17-BAD''s saved total'),
      ('different domains',     array['R17-Q1','R17-DOMB'],          'different domains'),
      ('no-domain lines x2',    array['R17-NOD1','R17-NOD2'],        'no domain on the line'),
      ('same plan+domain x2',   array['R17-DUPA','R17-DUPB'],        'Workspace Starter for c.com'),
      ('monthly + annual mix',  array['R17-DUPA','R17-MON'],         'one billing term'),
      ('good + bad together',   array['R17-Q1','R17-Q2','R17-PAY'],  'R17-PAY has a payment')
    ) t(label, ids, want)
  loop
    v_e := pg_temp.r1527_try(v_case.ids);
    if v_e is null then
      insert into r1527_fail values ('REFUSE ' || v_case.label || ': was ACCEPTED');
    elsif position(v_case.want in v_e) = 0 then
      insert into r1527_fail values ('REFUSE ' || v_case.label || ': wrong message: ' || v_e);
    end if;
  end loop;

  -- sales role
  perform pg_temp.r1527_as('e1527000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r1527_try(array['R17-OK1','R17-OK2']);
  if v_e is null or v_e not like '42501:%' then
    insert into r1527_fail values ('REFUSE sales role: ' || coalesce(v_e, 'ACCEPTED'));
  end if;
  -- signed-in user with no company
  perform pg_temp.r1527_as('e1527000-0000-4000-8000-0000000000d9');
  v_e := pg_temp.r1527_try(array['R17-OK1','R17-OK2']);
  if v_e is null or (v_e not like '42501:%' and v_e not like '28000:%') then
    insert into r1527_fail values ('REFUSE no-company user: ' || coalesce(v_e, 'ACCEPTED'));
  end if;
  -- service_role with no user → NULL company → 28000 (fail-closed even when trusted)
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  set local role service_role;
  v_e := pg_temp.r1527_try(array['R17-OK1','R17-OK2']);
  if v_e is null or v_e not like '28000:%' then
    insert into r1527_fail values ('REFUSE NULL company (service_role): ' || coalesce(v_e, 'ACCEPTED'));
  end if;

  set local role postgres;
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from public.quotes where tenant_id = 'e1527000-0000-0000-0000-0000000000a0') <> v_quotes_before then
    insert into r1527_fail values ('a refusal left a new quote behind');
  end if;
  if (select string_agg(id || ':' || status::text || ':' || coalesce(superseded_by, '-'), ',' order by id)
        from public.quotes where id like 'R17-%') <> v_fp_before then
    insert into r1527_fail values ('a refusal changed an original quote');
  end if;

  -- ════ COMBINE: 3 quotes → 1 ═══════════════════════════════════════════════════════
  set local role authenticated;
  perform pg_temp.r1527_as('e1527000-0000-4000-8000-0000000000a2');
  begin
    v_r := public.combine_quotes(array['R17-Q3', 'R17-Q1', 'R17-Q2']);
    v_new := v_r->>'quote_id';
    if (v_r->>'amount')::int <> 18880 or (v_r->>'sum_of_quotes')::int <> 18880
       or (v_r->>'subtotal')::int <> 16000 or (v_r->>'tax')::int <> 2880 then
      insert into r1527_fail values ('COMBINE result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r1527_fail values ('COMBINE failed: ' || sqlerrm);
  end;

  set local role postgres;
  if v_new is null then
    insert into r1527_fail values ('COMBINE gave no quote id');
  else
    select * into v_q from public.quotes where id = v_new;
    if v_q.tenant_id <> 'e1527000-0000-0000-0000-0000000000a0' or v_q.customer_id <> 'e1527000-0000-4000-8000-0000000000c1'
       or v_q.status::text <> 'accepted' or v_q.payment_status::text <> 'awaiting' or v_q.invoice_id is not null
       or v_q.amount <> 18880 or v_q.subtotal <> 16000 or v_q.tax_rate <> 18 or coalesce(v_q.discount_pct, 0) <> 0
       or v_q.domain <> 'a.com' or v_q.currency <> 'INR' then
      insert into r1527_fail values ('new quote fields wrong: ' || row_to_json(v_q)::text);
    end if;
    if v_new like 'R17-%' then
      insert into r1527_fail values ('new quote id not from next_document_number: ' || v_new);
    end if;
    if jsonb_array_length(v_q.line_items) <> 3
       or v_q.line_items->0->>'id' <> 'L1' or v_q.line_items->1->>'id' <> 'L2' or v_q.line_items->2->>'id' <> 'L3'
       or v_q.line_items->0->>'item_id' <> 'item-ws' or v_q.line_items->0->>'commitment' <> 'annual_yearly'
       or v_q.line_items->0->>'start_date' <> '2026-11-01' or v_q.line_items->2->>'domain' <> 'a.com' then
      insert into r1527_fail values ('new quote lines not copied in order / intact: ' || v_q.line_items::text);
    end if;
    select count(*) into v_n from public.quotes
     where id in ('R17-Q1', 'R17-Q2', 'R17-Q3') and status = 'expired' and superseded_by = v_new
       and superseded_at is not null and notes like '%Combined into ' || v_new || '%';
    if v_n <> 3 then insert into r1527_fail values ('originals not expired + superseded + noted: ' || v_n); end if;

    -- an original can never be accepted again
    begin
      update public.quotes set status = 'accepted' where id = 'R17-Q1';
      insert into r1527_fail values ('original R17-Q1 could be accepted again');
    exception when others then null;
    end;

    -- combining again the same originals is refused
    set local role authenticated;
    v_e := pg_temp.r1527_try(array['R17-Q1','R17-Q2']);
    if v_e is null or position('already replaced' in v_e) = 0 then
      insert into r1527_fail values ('re-combine of originals: ' || coalesce(v_e, 'ACCEPTED'));
    end if;

    -- ════ INVOICE: today's generate_invoice on the new quote ═══════════════════════
    begin
      perform public.generate_invoice(v_new);
    exception when others then insert into r1527_fail values ('generate_invoice failed: ' || sqlerrm);
    end;
    set local role postgres;
    select * into v_inv from public.invoices where quote_id = v_new;
    if not found then
      insert into r1527_fail values ('no invoice on the new quote');
    elsif v_inv.amount <> 18880 or v_inv.taxable_value <> 16000 or v_inv.tax_amount <> 2880
          or v_inv.inter_state is not false or v_inv.customer_id <> 'e1527000-0000-4000-8000-0000000000c1' then
      insert into r1527_fail values ('invoice wrong: ' || row_to_json(v_inv)::text);
    elsif (select invoice_id from public.quotes where id = v_new) is distinct from v_inv.id then
      insert into r1527_fail values ('new quote not linked to its invoice');
    end if;
    if exists (select 1 from public.quotes where id in ('R17-Q1', 'R17-Q2', 'R17-Q3') and invoice_id is not null)
       or exists (select 1 from public.invoices where quote_id in ('R17-Q1', 'R17-Q2', 'R17-Q3')) then
      insert into r1527_fail values ('an original quote got an invoice');
    end if;
  end if;

  if exists (select 1 from r1527_fail) then
    raise exception E'FAIL r1527_combine_quotes:\n%', (select string_agg(msg, E'\n') from r1527_fail);
  end if;
  raise notice 'PASS r1527_combine_quotes';
end $$;

rollback;
