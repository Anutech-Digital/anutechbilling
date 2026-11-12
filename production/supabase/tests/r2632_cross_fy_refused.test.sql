-- R-2632 (10 Nov 2026, p2 money): an issued invoice's date never crosses into another financial year - the
-- number is per FY (CGST Rule 46) and it is the invoice id; the fix is a credit note + a fresh invoice.
-- Migration 20261110010000_r2632_cross_fy_refused. Self-asserting, ONE transaction, rolled back.
-- RED without the migration (the old message said "not available yet" and named no next step).
--
--   A. Unpaid 20 Apr 2026 invoice (FY2627) -> 20 Mar 2026 (FY2526): refused, message names both years and the
--      next step (credit note for this invoice + fresh invoice dated in FY2526); nothing changed, no log row.
--   B. Paid 25 Mar 2026 invoice (FY2526, receipt on 25 Mar) -> 2 Apr 2026 (FY2627): refused by the same rule.
--   C. Repeat of A: refused again, still nothing changed (no half write on retry).
--   D. Same-FY move still works: 20 Apr -> 10 Apr 2026, one invoice.date_corrected log row.
--   E. GST filed up to Mar 2026: a cross-FY move INTO a filed month is refused by the filed rule first.

begin;

insert into auth.users (id, email) values
  ('b2632000-0000-0000-0000-0000000000a1', 'r2632-owner@example.test');
insert into public.tenants (id, name, email, state_code, gstin, doc_code, address) values
  ('b2632000-0000-0000-0000-0000000000f0', 'R2632 T', 'r2632@example.test', '07', '07AAACR2632A1Z5', 'R2632', 'Test street, Delhi');
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('b2632000-0000-0000-0000-0000000000a1', 'b2632000-0000-0000-0000-0000000000f0', 'r2632-owner@example.test', 'Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country, domain) values
  ('b2632000-0000-0000-0000-0000000000c1', 'b2632000-0000-0000-0000-0000000000f0', 'R2632 Buyer', '07', 'India', 'r2632buyer.in');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, invoice_date, due_date,
                             taxable_value, tax_amount, tax_rate, inter_state, paid_amount, paid_date, document_kind, line_items)
select v.id, 'b2632000-0000-0000-0000-0000000000f0', 'b2632000-0000-0000-0000-0000000000c1', 'R2632 Buyer', 1180, 1180,
       v.status::public.invoice_status, v.d::date, (v.d::date + 15), 1000, 180, 18, false,
       case when v.status = 'paid' then 1180 else 0 end, case when v.status = 'paid' then v.d::date end,
       'tax_invoice', '[{"name":"R2632 Seat","qty":1,"rate":1000}]'::jsonb
  from (values ('INV-R2632-A', 'pending', '2026-04-20'), ('INV-R2632-B', 'paid', '2026-03-25'),
               ('INV-R2632-D', 'pending', '2026-04-20'), ('INV-R2632-E', 'pending', '2026-04-05')) v(id, status, d);

create function pg_temp.as_user(p uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$f$;
create function pg_temp.refused(p_id text, p_date date, p_like text)
returns void language plpgsql as $f$
declare v_msg text; v_state text; v_before jsonb; v_logs bigint;
begin
  select to_jsonb(i) into v_before from public.invoices i where i.id = p_id;
  select count(*) into v_logs from public.activity_log where action = 'invoice.date_corrected' and entity_id = p_id;
  begin
    perform public.correct_invoice_date(p_id, p_date, 'Receipt was in the other year');
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
  end;
  if v_msg is null then raise exception 'FAIL %: % -> % was NOT refused', p_like, p_id, p_date; end if;
  if v_state <> '22023' or v_msg not ilike p_like then
    raise exception 'FAIL %: % -> % refused with [%] %', p_like, p_id, p_date, v_state, v_msg;
  end if;
  if (select to_jsonb(i) from public.invoices i where i.id = p_id) is distinct from v_before then
    raise exception 'FAIL %: % changed although refused', p_like, p_id;
  end if;
  if (select count(*) from public.activity_log where action = 'invoice.date_corrected' and entity_id = p_id) <> v_logs then
    raise exception 'FAIL %: % got a log row although refused', p_like, p_id;
  end if;
end $f$;
grant execute on function pg_temp.as_user(uuid), pg_temp.refused(text, date, text) to authenticated;

set local role authenticated;
select pg_temp.as_user('b2632000-0000-0000-0000-0000000000a1');

-- A. FY2627 -> FY2526: refused for good, with the next step
select pg_temp.refused('INV-R2632-A', '2026-03-20',
  '%INV-R2632-A is numbered in financial year FY2627%20 Mar 2026 is in financial year FY2526%needs a new number%keeps its number%credit note for this invoice%fresh invoice dated in FY2526%');

-- B. FY2526 -> FY2627 (paid; moving later) - the year rule speaks first
select pg_temp.refused('INV-R2632-B', '2026-04-02',
  '%INV-R2632-B is numbered in financial year FY2526%2 Apr 2026 is in financial year FY2627%credit note for this invoice%fresh invoice dated in FY2627%');

-- C. Retry of A (the very same call): same refusal, nothing written - then another FY2526 day too
select pg_temp.refused('INV-R2632-A', '2026-03-20', '%financial year FY2526%credit note for this invoice%');
select pg_temp.refused('INV-R2632-A', '2026-03-31', '%financial year FY2526%credit note for this invoice%');

-- D. Same FY still works
do $$
declare r jsonb;
begin
  r := public.correct_invoice_date('INV-R2632-D', '2026-04-10', 'Money came on 10 Apr');
  if (select invoice_date from public.invoices where id = 'INV-R2632-D') <> date '2026-04-10' then
    raise exception 'FAIL D: same-FY move did not happen (%)', r;
  end if;
  if (select count(*) from public.activity_log where action = 'invoice.date_corrected' and entity_id = 'INV-R2632-D') <> 1 then
    raise exception 'FAIL D: expected one invoice.date_corrected row';
  end if;
end $$;

-- E. GST filed up to Mar 2026: a cross-FY move into a filed month gets the filed refusal (unchanged order)
select public.set_gst_filed_through('2026-03-31');
select pg_temp.refused('INV-R2632-E', '2026-03-15', '%GST for Mar 2026 is already filed%');

select 'R-2632 cross-FY refused: all cases passed' as result;
rollback;
