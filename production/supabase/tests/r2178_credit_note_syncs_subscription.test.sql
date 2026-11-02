-- R-2178 (31 Oct 2026, staging reconcile — LOOK BOOK FLY, Q-A378-27-0241): a credit note on an
-- invoice did not refresh subscriptions.outstanding_amount. The quote was ₹1,78,416 (a typed rate
-- multiplied by 12 — the other half of R-2178), ₹14,868 was received, record_payment stored
-- ₹1,63,548 on the subscription; CN-A378-27-0003 for ₹1,63,548 netted the invoice to ₹14,868 paid —
-- and the subscription still said ₹1,63,548 owed.
-- Migration 20261031032023_r2178_credit_note_syncs_subscription.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (with subscription_dues_drift() from R-2154 as the judge):
--   S. setup = the staging shape: stored ₹1,63,548 before the note, no drift (the invoice owes it).
--   A. credit note ₹1,63,548 → stored 0 and subscription_dues_drift() gives 0 rows for the company
--      (red without the migration: stored stays ₹1,63,548, one drift row).
--   B. the undo — a debit note for the same ₹1,63,548 re-opens the invoice → stored ₹1,63,548
--      again, 0 drift rows.
--   C. the quote itself is NOT re-priced by the note (quotes.amount stays as sold); the quote's
--      open balance (the figure lists and dues read) is the net one.
--   E. the sync helper is internal (no anon / authenticated execute).
--   F. (3) one renewal rule: correct_subscription_commitment reads renewal_date as the next term's start.

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

insert into auth.users (id, email) values ('e2178000-0000-4000-8000-0000000000a2', 'r2178-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2178000-0000-0000-0000-0000000000a0', 'R2178 Co', 'r2178@example.in', '07', 'R2178');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2178000-0000-4000-8000-0000000000a2', 'e2178000-0000-0000-0000-0000000000a0', 'r2178-owner@example.in', 'R2178 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2178000-0000-4000-8000-0000000000c1', 'e2178000-0000-0000-0000-0000000000a0', 'R2178 Look Book', '07', 'India');

-- The staging quote: 7 users × ₹21,600 (the ×12 rate) = ₹1,51,200 + 18% = ₹1,78,416, yearly.
insert into public.quotes (id, tenant_id, customer_id, customer_name, tax_rate, amount, subtotal, billing_cycle,
                           status, payment_status, line_items)
values ('TESTQ-R2178-A', 'e2178000-0000-0000-0000-0000000000a0', 'e2178000-0000-4000-8000-0000000000c1', 'R2178 Look Book',
        18, 178416, 151200, 'yearly', 'accepted', 'awaiting',
        '[{"name":"Google Workspace Business Starter","qty":7,"rate":21600,"commitment":"annual_yearly"}]'::jsonb);

create temp table r2178_fail (msg text) on commit drop;
grant all on r2178_fail to authenticated;
create temp table r2178_ids (k text primary key, v text) on commit drop;
grant all on r2178_ids to authenticated;

do $$
declare
  v_inv text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2178000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  -- The receipt (Record payment / reconcile), then the tax invoice.
  perform public.record_payment('TESTQ-R2178-A', 14868, 'bank_transfer', 'R2178-UTR');
  select invoice_id into v_inv from public.generate_invoice('TESTQ-R2178-A');
  insert into r2178_ids values ('inv', v_inv);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- S. the staging shape before the note.
do $$
declare v_stored int; v_inv record;
begin
  select coalesce(sum(outstanding_amount), 0) into v_stored from public.subscriptions where quote_id = 'TESTQ-R2178-A';
  if v_stored <> 163548 then
    raise exception 'SETUP S: stored % (want 1,63,548 = 1,78,416 − 14,868)', v_stored;
  end if;
  select i.amount, coalesce(i.net_payable, i.amount) as net, i.paid_amount, i.status::text as status into v_inv
    from public.invoices i where i.id = (select v from r2178_ids where k = 'inv');
  if v_inv.amount <> 178416 or v_inv.status = 'paid' then
    raise exception 'SETUP S: invoice %', to_jsonb(v_inv);
  end if;
  if exists (select 1 from public.subscription_dues_drift() d where d.quote_id = 'TESTQ-R2178-A') then
    raise exception 'SETUP S: drift before the note (want none — the invoice owes ₹1,63,548): %',
      (select to_jsonb(d) from public.subscription_dues_drift() d where d.quote_id = 'TESTQ-R2178-A');
  end if;
end $$;

-- A. the credit note (CN-A378-27-0003's amount).
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2178000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.issue_credit_note((select v from r2178_ids where k = 'inv'), 163548, 'other', 'Rate was 12x — correct ₹1,800/user/year', null);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_stored int; v_rows text;
begin
  select coalesce(sum(outstanding_amount), 0) into v_stored from public.subscriptions where quote_id = 'TESTQ-R2178-A';
  if v_stored <> 0 then
    insert into r2178_fail values ('A: after the ₹1,63,548 credit note the subscription still says ₹' || v_stored || ' owed (want 0 — the invoice is ₹14,868, paid)');
  end if;
  select string_agg(d.quote_id || ' stored ' || d.stored_outstanding || ' expected ' || d.expected_outstanding, ', ') into v_rows
    from public.subscription_dues_drift() d where d.tenant_id = 'e2178000-0000-0000-0000-0000000000a0';
  if v_rows is not null then insert into r2178_fail values ('A: subscription_dues_drift() after the CN: ' || v_rows); end if;
  -- C. the quote stays as sold; its open balance is net.
  if (select amount from public.quotes where id = 'TESTQ-R2178-A') <> 178416 then
    insert into r2178_fail values ('C: the credit note re-priced the quote (want quotes.amount 1,78,416 kept — the CN is the correction)');
  end if;
  if public.quote_open_balance('TESTQ-R2178-A') <> 0 then
    insert into r2178_fail values ('C: quote_open_balance ' || public.quote_open_balance('TESTQ-R2178-A') || ' after the CN (want 0)');
  end if;
end $$;

-- B. the undo: a debit note for the same amount.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2178000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  perform public.issue_debit_note((select v from r2178_ids where k = 'inv'), 163548, 'other', 'Undo the credit note', null);
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_stored int; v_rows text;
begin
  select coalesce(sum(outstanding_amount), 0) into v_stored from public.subscriptions where quote_id = 'TESTQ-R2178-A';
  if v_stored <> 163548 then
    insert into r2178_fail values ('B: after the debit note (undo) the subscription says ₹' || v_stored || ' (want 1,63,548 again)');
  end if;
  select string_agg(d.quote_id || ' stored ' || d.stored_outstanding || ' expected ' || d.expected_outstanding, ', ') into v_rows
    from public.subscription_dues_drift() d where d.tenant_id = 'e2178000-0000-0000-0000-0000000000a0';
  if v_rows is not null then insert into r2178_fail values ('B: subscription_dues_drift() after the undo: ' || v_rows); end if;
end $$;

-- E. grants: the sync is internal.
do $$
begin
  if to_regprocedure('public.sync_invoice_subscription_outstanding(text)') is null then
    insert into r2178_fail values ('E: sync_invoice_subscription_outstanding(text) does not exist');
  elsif has_function_privilege('anon', 'public.sync_invoice_subscription_outstanding(text)', 'execute')
     or has_function_privilege('authenticated', 'public.sync_invoice_subscription_outstanding(text)', 'execute') then
    insert into r2178_fail values ('E: anon/authenticated can call sync_invoice_subscription_outstanding directly');
  end if;
end $$;

-- F. (3) one renewal rule: renewal_date = the NEXT term's start (anniversary). An annual sub whose
--    anniversary is TODAY has finished its term → it may become Flexible (before: read as the last
--    covered day, refused). One mid-term (anniversary 6 months away) is still refused, and the
--    message names the last covered day (renewal − 1).
insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr,
                                  start_date, renewal_date, status, billing_cycle, term_months)
values ('e2178000-0000-4000-8000-0000000000f1', 'e2178000-0000-0000-0000-0000000000a0', 'R2178 Ended today',
        'R2178 Workspace', 'google', 2, 600,
        (public.ist_today() - interval '12 months')::date, public.ist_today(), 'active', 'yearly', 12),
       ('e2178000-0000-4000-8000-0000000000f2', 'e2178000-0000-0000-0000-0000000000a0', 'R2178 Mid-term',
        'R2178 Workspace', 'google', 2, 600,
        (public.ist_today() - interval '6 months')::date, (public.ist_today() + interval '6 months')::date, 'active', 'yearly', 12);
update public.subscriptions set renewal_date = (start_date + interval '12 months')::date
 where id in ('e2178000-0000-4000-8000-0000000000f1', 'e2178000-0000-4000-8000-0000000000f2');

do $$
declare v_msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2178000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  begin
    perform public.correct_subscription_commitment('e2178000-0000-4000-8000-0000000000f1', 1, 'monthly', null, 'Term ended, now flexible');
  exception when others then
    insert into r2178_fail values ('F: anniversary today (term ended) refused: ' || sqlerrm);
  end;
  v_msg := null;
  begin
    perform public.correct_subscription_commitment('e2178000-0000-4000-8000-0000000000f2', 1, 'monthly', null, 'Try flexible mid-term');
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%cannot be reduced mid-term%'
     || to_char((select renewal_date from public.subscriptions where id = 'e2178000-0000-4000-8000-0000000000f2') - 1, 'DD Mon YYYY') || '%' then
    insert into r2178_fail values ('F: mid-term reduce not refused with the last covered day: ' || coalesce(v_msg, 'ran'));
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2178_fail;
  if v_list is not null then
    raise exception E'FAIL r2178_credit_note_syncs_subscription:\n  %', v_list;
  end if;
  raise notice 'PASS r2178_credit_note_syncs_subscription';
end $$;

rollback;
