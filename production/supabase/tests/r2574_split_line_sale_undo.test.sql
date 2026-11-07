-- R-2574 (7 Nov 2026, p1 money — independent review of R-2179). Migration 20261107212458_r2574_split_line_sale_undo.
-- Self-asserting, ONE transaction, rolled back. RED without the migration (A and B: the preview says the
-- first sale can be undone and lists only it; the undo takes back sale A and leaves the rest on no bank line).
--
-- reconcile_bank_credit_split books every new sale / advance of ONE bank line as its own receipt and points the
-- line at the FIRST receipt only. "Undo this sale too" (_bank_sale_undo_scope) takes back one sale — so on such a line it is refused
-- (nothing changes) and the preview names every other receipt the line booked.
--
--   A. ₹17,700 line → "A new sale" A ₹11,800 + new sale B ₹5,900 (two sales, each with a subscription).
--      Preview: blocked, other_receipts = [B's receipt ₹5,900 on its quote]. Undo refused (check_violation);
--      nothing changed: both receipts still on the line, both subscriptions live, the line still matched.
--   B. ₹15,000 line → new sale A ₹11,800 + ₹3,200 kept as the customer's advance. Same: blocked, the advance
--      listed (kind advance), undo refused, nothing changed.
--   C. A plain un-reconcile (no undo) of the split line still frees it (the way on the block message names).
--   D. A one-sale line (no other receipt) can still be undone — R-2179's path unchanged.

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

insert into auth.users (id, email) values
  ('b2574000-0000-0000-0000-0000000000a1', 'r2574-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('b2574000-0000-0000-0000-0000000000f0', 'R2574 T', 'r2574@example.test', '07', 'R2574');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('b2574000-0000-0000-0000-0000000000a1', 'b2574000-0000-0000-0000-0000000000f0', 'r2574-owner@example.test', 'Owner', 'owner', true, now() - interval '1 day');
update public.tenants set books_start_date = '2025-04-01' where id = 'b2574000-0000-0000-0000-0000000000f0';

insert into public.customers (id, tenant_id, name, gstin, state_code, country, domain) values
  ('b2574000-0000-0000-0000-0000000000c1', 'b2574000-0000-0000-0000-0000000000f0', 'R2574 Split Buyer', '07AAACR2574B1Z5', '07', 'India', 'split2574.in');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_number_last4, opening_balance_date) values
  ('b2574000-0000-0000-0000-0000000000d1', 'b2574000-0000-0000-0000-0000000000f0', 'Current', 'HDFC', '2574', '2025-04-01');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('b2574000-0000-0000-0000-0000000000e1', 'b2574000-0000-0000-0000-0000000000f0', 'b2574000-0000-0000-0000-0000000000d1', '2026-08-15', 'NEFT TWO SALES 2574', 0, 17700, 'R2574UTRA', 'manual'),
  ('b2574000-0000-0000-0000-0000000000e2', 'b2574000-0000-0000-0000-0000000000f0', 'b2574000-0000-0000-0000-0000000000d1', '2026-08-16', 'NEFT SALE ADVANCE 2574', 0, 15000, 'R2574UTRB', 'manual'),
  ('b2574000-0000-0000-0000-0000000000e3', 'b2574000-0000-0000-0000-0000000000f0', 'b2574000-0000-0000-0000-0000000000d1', '2026-08-17', 'NEFT ONE SALE 2574', 0, 11800, 'R2574UTRC', 'manual');

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
grant execute on function pg_temp.as_user(uuid) to authenticated;

-- What the line holds now: its receipts (bank_txn_id = line) and their subscriptions' status.
create function pg_temp.line_state(p_txn uuid) returns jsonb language sql as $f$
  select jsonb_build_object(
    'matched', (select matched_to_id from public.bank_transactions where id = p_txn),
    'receipts', (select coalesce(jsonb_agg(p.id order by p.id), '[]'::jsonb) from public.payments p where p.bank_txn_id = p_txn),
    'live_subs', (select count(*) from public.subscriptions s
                   where s.quote_id in (select p.quote_id from public.payments p where p.bank_txn_id = p_txn)
                     and s.status::text <> 'cancelled'),
    'open_credit', (select coalesce(sum(cc.amount), 0) from public.customer_credits cc
                     where cc.source_payment_id in (select p.id from public.payments p where p.bank_txn_id = p_txn)
                       and cc.status = 'open'));
$f$;
grant execute on function pg_temp.line_state(uuid) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2574000-0000-0000-0000-0000000000a1');

-- ── A. two new sales on one line → undo of the first is refused; the preview names sale B ──────────
do $$
declare r jsonb; p jsonb; before jsonb; after jsonb; ok boolean := false; v_b_quote text; o jsonb;
begin
  r := public.reconcile_bank_credit_split('b2574000-0000-0000-0000-0000000000e1', 'b2574000-0000-0000-0000-0000000000c1', '[]'::jsonb,
         jsonb_build_array(
           jsonb_build_object('lines', '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":10000,"cost":0,"commitment":"annual_yearly","domain":"a.split2574.in"}]'::jsonb,
                              'billing_cycle', 'yearly', 'create_subscription', true, 'amount', 11800),
           jsonb_build_object('lines', '[{"item_id":null,"name":"Google Workspace Business Standard","qty":1,"rate":5000,"cost":0,"commitment":"annual_yearly","domain":"b.split2574.in"}]'::jsonb,
                              'billing_cycle', 'yearly', 'create_subscription', true, 'amount', 5900)),
         null);
  before := pg_temp.line_state('b2574000-0000-0000-0000-0000000000e1');
  if jsonb_array_length(before->'receipts') <> 2 or (before->>'live_subs')::int <> 2 then
    raise exception 'FAIL A setup: want 2 receipts + 2 subscriptions on the line, got % (%)', before, r;
  end if;
  select x->>'quote_id' into v_b_quote from jsonb_array_elements(r->'parts') with ordinality as e(x, n) where n = 2;

  p := public.bank_sale_undo_preview('b2574000-0000-0000-0000-0000000000e1');
  if not coalesce((p->>'blocked')::boolean, false) then
    raise exception 'FAIL A: the preview offers "Undo this sale" on a line that also booked sale B: %', p;
  end if;
  if jsonb_array_length(coalesce(p->'other_receipts', '[]'::jsonb)) <> 1 then
    raise exception 'FAIL A: the preview should name the one other receipt on the line: %', p;
  end if;
  o := p->'other_receipts'->0;
  if o->>'quote_id' is distinct from v_b_quote or (o->>'amount')::int <> 5900 or o->>'kind' is distinct from 'sale' then
    raise exception 'FAIL A: other receipt should be sale % ₹5,900, got %', v_b_quote, o;
  end if;
  if p->>'block_message' not like '%₹5,900%' then
    raise exception 'FAIL A: the block message should name ₹5,900: %', p->>'block_message';
  end if;

  begin
    perform public.unreconcile_bank_receipt('b2574000-0000-0000-0000-0000000000e1', true);
  exception when check_violation then ok := sqlerrm like '%takes back one sale only%';
  end;
  if not ok then raise exception 'FAIL A: undo ran — sale B now has a receipt on no bank line (%)', pg_temp.line_state('b2574000-0000-0000-0000-0000000000e1'); end if;
  after := pg_temp.line_state('b2574000-0000-0000-0000-0000000000e1');
  if after is distinct from before then raise exception 'FAIL A: a refused undo changed something: % → %', before, after; end if;
  raise notice 'A PASS: two sales on one line → undo refused, sale B listed, nothing changed';
end $$;

-- ── B. one new sale + the rest kept as advance → undo refused; the preview names the advance ──────
do $$
declare p jsonb; before jsonb; after jsonb; ok boolean := false; o jsonb;
begin
  perform public.reconcile_bank_credit_split('b2574000-0000-0000-0000-0000000000e2', 'b2574000-0000-0000-0000-0000000000c1', '[]'::jsonb,
         jsonb_build_object('lines', '[{"item_id":null,"name":"Google Workspace Business Plus","qty":1,"rate":10000,"cost":0,"commitment":"annual_yearly","domain":"c.split2574.in"}]'::jsonb,
                            'billing_cycle', 'yearly', 'create_subscription', true, 'amount', 11800),
         'advance');
  before := pg_temp.line_state('b2574000-0000-0000-0000-0000000000e2');
  if jsonb_array_length(before->'receipts') <> 2 or (before->>'open_credit')::int <> 3200 then
    raise exception 'FAIL B setup: want sale + ₹3,200 advance on the line, got %', before;
  end if;

  p := public.bank_sale_undo_preview('b2574000-0000-0000-0000-0000000000e2');
  if not coalesce((p->>'blocked')::boolean, false) then
    raise exception 'FAIL B: the preview offers "Undo this sale" on a line that also kept a ₹3,200 advance: %', p;
  end if;
  o := p->'other_receipts'->0;
  if jsonb_array_length(coalesce(p->'other_receipts', '[]'::jsonb)) <> 1 or o->>'kind' is distinct from 'advance' or (o->>'amount')::int <> 3200 then
    raise exception 'FAIL B: the preview should name the ₹3,200 advance: %', p;
  end if;

  begin
    perform public.unreconcile_bank_receipt('b2574000-0000-0000-0000-0000000000e2', true);
  exception when check_violation then ok := sqlerrm like '%takes back one sale only%';
  end;
  if not ok then raise exception 'FAIL B: undo ran — the ₹3,200 advance is left on no bank line (%)', pg_temp.line_state('b2574000-0000-0000-0000-0000000000e2'); end if;
  after := pg_temp.line_state('b2574000-0000-0000-0000-0000000000e2');
  if after is distinct from before then raise exception 'FAIL B: a refused undo changed something: % → %', before, after; end if;
  raise notice 'B PASS: sale + advance on one line → undo refused, advance listed, nothing changed';
end $$;

-- ── C. un-reconcile WITHOUT undo still frees the split line (the way on) ───────────────────────────
do $$
begin
  perform public.unreconcile_bank_receipt('b2574000-0000-0000-0000-0000000000e1', false);
  if (select matched_to_id from public.bank_transactions where id = 'b2574000-0000-0000-0000-0000000000e1') is not null then
    raise exception 'FAIL C: the line is still matched after a plain un-reconcile';
  end if;
  raise notice 'C PASS: plain un-reconcile frees the split line';
end $$;

-- ── D. one sale on its own line → still undone in full (R-2179 unchanged) ──────────────────────────
do $$
declare r jsonb; p jsonb; v_q text;
begin
  r := public.reconcile_bank_credit_new_sale('b2574000-0000-0000-0000-0000000000e3', 'b2574000-0000-0000-0000-0000000000c1',
         '[{"item_id":null,"name":"Google Workspace Business Starter","qty":1,"rate":10000,"cost":0,"commitment":"annual_yearly","domain":"d.split2574.in"}]'::jsonb,
         true, '2026-08-17', null, 0, null, null, 'yearly');
  v_q := r->>'quote_id';
  p := public.bank_sale_undo_preview('b2574000-0000-0000-0000-0000000000e3');
  if coalesce((p->>'blocked')::boolean, true) or jsonb_array_length(coalesce(p->'other_receipts', '[]'::jsonb)) <> 0 then
    raise exception 'FAIL D: a one-sale line should be undoable with no other receipts: %', p;
  end if;
  perform public.unreconcile_bank_receipt('b2574000-0000-0000-0000-0000000000e3', true);
  if exists (select 1 from public.payments where quote_id = v_q)
     or (select status::text from public.quotes where id = v_q) <> 'rejected' then
    raise exception 'FAIL D: the one-sale undo did not take the sale back';
  end if;
  raise notice 'D PASS: one-sale line still undone in full';
end $$;

select 'R-2574 split line sale undo: ALL PASS' as result;

rollback;
