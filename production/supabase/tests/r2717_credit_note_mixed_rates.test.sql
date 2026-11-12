-- R-2717 (12 Nov 2026): a credit / debit note on an invoice whose LINES carry different GST rates.
-- Owner's example (R-2702: INV/25-26/1248, 1953, 2065 — a 0% line + an 18% line): ₹10,000 at 0% +
-- ₹20,000 at 18%, GST ₹3,600, total ₹33,600; invoices.tax_rate NULL (no single rate).
-- Before: issue_credit_note / issue_debit_note backed the tax out at coalesce(tax_rate, 18) —
-- a ₹16,800 credit became ₹14,237 + ₹2,563 "at 18%" instead of ₹15,000 + ₹1,800.
-- Migration: *_r2717_note_follows_line_rates.sql.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   C0. one rate (as every invoice before): 18% invoice ₹11,800 credit → ₹10,000 + ₹1,800, rate 18;
--       legacy NULL-rate invoice with no line rates → still the 18% default (old rule untouched).
--   C1. mixed invoice, half credited (₹16,800) → ₹15,000 + ₹1,800, credit_notes.tax_rate NULL,
--       invoice net ₹16,800 (red without the migration: ₹14,237 + ₹2,563, rate 18).
--   C2. the other half → again ₹15,000 + ₹1,800: the two notes are the invoice's exact figures;
--       the unpaid invoice is settled (Paid) — R-1566's rule, unchanged.
--   D1. debit note ₹3,360 on a mixed invoice → ₹3,000 + ₹360, rate NULL (same rule; the undo of a credit note).
--   M.  [0% line, line with no rate] on an 18% invoice is two rates → the invoice's proportion.
--   N.  every line at the same own rate / an adjustment line with a rate → ONE rate, old rule.
--   R.  mixed lines but no taxable / GST on the invoice → refused, nothing written.
--   E.  invoice_note_gst_split is internal (no anon / authenticated execute).

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

insert into auth.users (id, email) values ('e2717000-0000-4000-8000-0000000000a2', 'r2717-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code)
  values ('e2717000-0000-0000-0000-0000000000a0', 'R2717 Co', 'r2717@example.in', '07', 'R2717');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2717000-0000-4000-8000-0000000000a2', 'e2717000-0000-0000-0000-0000000000a0', 'r2717-owner@example.in', 'R2717 Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2717000-0000-4000-8000-0000000000c1', 'e2717000-0000-0000-0000-0000000000a0', 'R2717 Acme', '29', 'India');

create temp table r2717_fail (msg text) on commit drop;
grant all on r2717_fail to authenticated;

-- Invoices as the Zoho FY import writes them (amount / taxable / GST as filed; lines with name, qty, rate, amount).
create function pg_temp.r2717_inv(p_id text, p_amount int, p_taxable int, p_tax int, p_rate int, p_lines jsonb) returns void
language sql as $f$
  insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, paid_amount, status,
                               invoice_date, due_date, taxable_value, tax_amount, tax_rate, inter_state, line_items)
  values (p_id, 'e2717000-0000-0000-0000-0000000000a0', 'e2717000-0000-4000-8000-0000000000c1', 'R2717 Acme',
          p_amount, p_amount, 0, 'pending', public.ist_today(), public.ist_today() + 15, p_taxable, p_tax, p_rate, true, p_lines);
$f$;

select pg_temp.r2717_inv('TESTINV-R2717-ONE', 11800, 10000, 1800, 18,
  '[{"name":"Workspace","qty":1,"rate":10000,"amount":10000}]');
select pg_temp.r2717_inv('TESTINV-R2717-LEGACY', 1180, null, null, null,
  '[{"name":"Old line","qty":1,"rate":1000}]');
select pg_temp.r2717_inv('TESTINV-R2717-MIX', 33600, 30000, 3600, null,
  '[{"name":"Domain renewal","qty":1,"rate":10000,"amount":10000,"tax_rate":0},{"name":"Workspace","qty":2,"rate":10000,"amount":20000,"tax_rate":18}]');
select pg_temp.r2717_inv('TESTINV-R2717-MIXD', 33600, 30000, 3600, null,
  '[{"name":"Domain renewal","qty":1,"rate":10000,"amount":10000,"tax_rate":0},{"name":"Workspace","qty":2,"rate":10000,"amount":20000,"tax_rate":18}]');
select pg_temp.r2717_inv('TESTINV-R2717-HALF', 33600, 30000, 3600, 18,
  '[{"name":"Domain renewal","qty":1,"rate":10000,"tax_rate":0},{"name":"Workspace","qty":2,"rate":10000}]');
select pg_temp.r2717_inv('TESTINV-R2717-SAME', 35400, 30000, 5400, null,
  '[{"name":"A","qty":1,"rate":10000,"tax_rate":18},{"name":"B","qty":2,"rate":10000,"tax_rate":18},{"name":"Adjustment","qty":1,"rate":-250,"kind":"adjustment","tax_rate":5},{"name":"Free","qty":1,"rate":0,"tax_rate":0}]');
select pg_temp.r2717_inv('TESTINV-R2717-NOFIG', 33600, null, null, null,
  '[{"name":"Domain renewal","qty":1,"rate":10000,"tax_rate":0},{"name":"Workspace","qty":2,"rate":10000,"tax_rate":18}]');

create function pg_temp.r2717_as_owner() returns void language plpgsql as $f$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2717000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
end $f$;
grant execute on function pg_temp.r2717_as_owner() to authenticated;

-- ── The notes, as the owner ──────────────────────────────────────────────────────────────
do $$
declare v jsonb; v_msg text;
begin
  set local role authenticated;
  perform pg_temp.r2717_as_owner();

  -- C0. one rate.
  v := public.issue_credit_note('TESTINV-R2717-ONE', 11800, 'other', 'C0', null);
  if (v->>'taxable_value')::int <> 10000 or (v->>'tax_amount')::int <> 1800 or (v->>'tax_rate')::int is distinct from 18 then
    insert into r2717_fail values ('C0: 18% invoice, ₹11,800 credit → ' || v::text || ' (want 10,000 + 1,800, rate 18)');
  end if;
  v := public.issue_credit_note('TESTINV-R2717-LEGACY', 1180, 'other', 'C0 legacy', null);
  if (v->>'taxable_value')::int <> 1000 or (v->>'tax_amount')::int <> 180 or (v->>'tax_rate')::int is distinct from 18 then
    insert into r2717_fail values ('C0: legacy NULL-rate invoice, ₹1,180 credit → ' || v::text || ' (want 1,000 + 180 at the 18% default)');
  end if;

  -- C1. mixed, half.
  v := public.issue_credit_note('TESTINV-R2717-MIX', 16800, 'other', 'C1', null);
  if (v->>'taxable_value')::int <> 15000 or (v->>'tax_amount')::int <> 1800 or (v->'tax_rate') <> 'null'::jsonb then
    insert into r2717_fail values ('C1: mixed 0% + 18% invoice (30,000 + 3,600), ₹16,800 credit → ' || v::text || ' (want 15,000 + 1,800, rate null)');
  end if;
  if (v->>'new_net_payable')::int <> 16800 then
    insert into r2717_fail values ('C1: net payable ' || (v->>'new_net_payable') || ' (want 16,800)');
  end if;

  -- C2. the other half.
  v := public.issue_credit_note('TESTINV-R2717-MIX', 16800, 'other', 'C2', null);
  if (v->>'taxable_value')::int <> 15000 or (v->>'tax_amount')::int <> 1800 then
    insert into r2717_fail values ('C2: second half → ' || v::text || ' (want 15,000 + 1,800)');
  end if;

  -- D1. debit note on a mixed invoice.
  v := public.issue_debit_note('TESTINV-R2717-MIXD', 3360, 'other', 'D1', null);
  if (v->>'taxable_value')::int <> 3000 or (v->>'tax_amount')::int <> 360 or (v->'tax_rate') <> 'null'::jsonb then
    insert into r2717_fail values ('D1: mixed invoice, ₹3,360 debit note → ' || v::text || ' (want 3,000 + 360, rate null)');
  end if;
  if (v->>'new_net_payable')::int <> 36960 then
    insert into r2717_fail values ('D1: net payable ' || (v->>'new_net_payable') || ' (want 36,960)');
  end if;

  -- M. [0% line, line with no rate] on an 18% invoice = two rates.
  v := public.issue_credit_note('TESTINV-R2717-HALF', 3360, 'other', 'M', null);
  if (v->>'taxable_value')::int <> 3000 or (v->>'tax_amount')::int <> 360 or (v->'tax_rate') <> 'null'::jsonb then
    insert into r2717_fail values ('M: 0% line + a line at the invoice rate, ₹3,360 credit → ' || v::text || ' (want 3,000 + 360, rate null)');
  end if;

  -- N. one rate on every valued line (adjustment + ₹0 lines do not count) → the old rule.
  v := public.issue_credit_note('TESTINV-R2717-SAME', 1180, 'other', 'N', null);
  if (v->>'taxable_value')::int <> 1000 or (v->>'tax_amount')::int <> 180 or (v->>'tax_rate')::int is distinct from 18 then
    insert into r2717_fail values ('N: every valued line at 18% → ' || v::text || ' (want 1,000 + 180, rate 18)');
  end if;

  -- R. mixed lines, no figures → refused.
  v_msg := null;
  begin
    perform public.issue_credit_note('TESTINV-R2717-NOFIG', 1000, 'other', 'R', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%lines at different GST rates but no taxable value and GST on record%' then
    insert into r2717_fail values ('R: credit note on a mixed invoice with no taxable / GST not refused: ' || coalesce(v_msg, 'ran'));
  end if;
  v_msg := null;
  begin
    perform public.issue_debit_note('TESTINV-R2717-NOFIG', 1000, 'other', 'R', null);
  exception when others then v_msg := sqlerrm; end;
  if v_msg is null or v_msg not like '%lines at different GST rates but no taxable value and GST on record%' then
    insert into r2717_fail values ('R: debit note on a mixed invoice with no taxable / GST not refused: ' || coalesce(v_msg, 'ran'));
  end if;

  -- E. the helper is internal.
  v_msg := null;
  begin
    perform * from public.invoice_note_gst_split('TESTINV-R2717-MIX', 100);
  exception when insufficient_privilege then v_msg := 'denied'; when others then v_msg := sqlerrm; end;
  if v_msg is distinct from 'denied' then
    insert into r2717_fail values ('E: an authenticated user can call invoice_note_gst_split directly: ' || coalesce(v_msg, 'ran'));
  end if;
end $$;
reset role;
select set_config('request.jwt.claims', '', true);

-- ── What was stored ──────────────────────────────────────────────────────────────────────
do $$
declare v record; v_n int;
begin
  -- C1 + C2: two notes on the mixed invoice, rate NULL, together = the invoice's own figures.
  select count(*) as n, sum(amount) as amt, sum(taxable_value) as taxable, sum(tax_amount) as tax,
         count(*) filter (where tax_rate is null) as null_rates
    into v from public.credit_notes where invoice_id = 'TESTINV-R2717-MIX';
  if v.n <> 2 or v.amt <> 33600 or v.taxable <> 30000 or v.tax <> 3600 or v.null_rates <> 2 then
    insert into r2717_fail values ('C1+C2 stored: ' || to_jsonb(v)::text || ' (want 2 notes, 33,600 = 30,000 + 3,600, both tax_rate NULL)');
  end if;
  select i.status::text as status, coalesce(i.net_payable, i.amount) as net into v from public.invoices i where i.id = 'TESTINV-R2717-MIX';
  if v.status <> 'paid' or v.net <> 0 then
    insert into r2717_fail values ('C2: fully credited unpaid invoice is ' || to_jsonb(v)::text || ' (want paid, net 0 — R-1566)');
  end if;
  -- No customer credit: nothing was paid on it.
  select count(*) into v_n from public.customer_credits where source_invoice_id = 'TESTINV-R2717-MIX';
  if v_n <> 0 then insert into r2717_fail values ('C2: ' || v_n || ' customer credit row(s) on an unpaid invoice (want 0)'); end if;

  -- C0: the single-rate note keeps its rate.
  if (select tax_rate from public.credit_notes where invoice_id = 'TESTINV-R2717-ONE') is distinct from 18 then
    insert into r2717_fail values ('C0 stored: the 18% note lost its rate');
  end if;
  -- D1 stored.
  select taxable_value as taxable, tax_amount as tax, tax_rate as rate into v from public.debit_notes where invoice_id = 'TESTINV-R2717-MIXD';
  if v.taxable <> 3000 or v.tax <> 360 or v.rate is not null then
    insert into r2717_fail values ('D1 stored: ' || to_jsonb(v)::text || ' (want 3,000 + 360, rate NULL)');
  end if;
  -- R: nothing written on the refused invoice.
  select (select count(*) from public.credit_notes where invoice_id = 'TESTINV-R2717-NOFIG')
       + (select count(*) from public.debit_notes where invoice_id = 'TESTINV-R2717-NOFIG') into v_n;
  if v_n <> 0 then insert into r2717_fail values ('R: ' || v_n || ' note(s) written on the refused invoice'); end if;
  if (select coalesce(net_payable, amount) from public.invoices where id = 'TESTINV-R2717-NOFIG') <> 33600 then
    insert into r2717_fail values ('R: the refused note changed the invoice''s net payable');
  end if;
  -- E: grants.
  if to_regprocedure('public.invoice_note_gst_split(text,integer)') is null then
    insert into r2717_fail values ('E: invoice_note_gst_split does not exist (migration not applied)');
  elsif has_function_privilege('authenticated', 'public.invoice_note_gst_split(text, integer)', 'execute')
     or has_function_privilege('anon', 'public.invoice_note_gst_split(text, integer)', 'execute') then
    insert into r2717_fail values ('E: invoice_note_gst_split is executable by anon / authenticated');
  end if;
end $$;

do $$
declare v_list text;
begin
  select string_agg(msg, E'\n  ') into v_list from r2717_fail;
  if v_list is not null then
    raise exception E'FAIL r2717_credit_note_mixed_rates:\n  %', v_list;
  end if;
  raise notice 'PASS r2717_credit_note_mixed_rates';
end $$;

rollback;
