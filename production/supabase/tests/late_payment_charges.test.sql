-- R-530 (20261009233000): late payment charges — level precedence in SQL, owner/manager gates,
-- waiver with reason, bill = debit note at the invoice's own GST rate, fee only once, no rate
-- -> refused, every change audited, other tenant sees nothing.
-- Rolled back; safe anywhere. Exit 0 = pass.
begin;

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code) values
  ('cccccccc-0000-0000-0000-000000530000', 'R530 A', 'r530-a@example.in', '07'),
  ('cccccccc-0000-0000-0000-000000530100', 'R530 B', 'r530-b@example.in', '07');
insert into auth.users (id, instance_id, aud, role, email) values
  ('cccccccc-0000-0000-0000-000000530001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r530-owner@example.in'),
  ('cccccccc-0000-0000-0000-000000530002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r530-mgr@example.in'),
  ('cccccccc-0000-0000-0000-000000530003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r530-rep@example.in'),
  ('cccccccc-0000-0000-0000-000000530101', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r530-b-owner@example.in');
insert into public.users (id, tenant_id, email, role) values
  ('cccccccc-0000-0000-0000-000000530001', 'cccccccc-0000-0000-0000-000000530000', 'r530-owner@example.in', 'owner'),
  ('cccccccc-0000-0000-0000-000000530002', 'cccccccc-0000-0000-0000-000000530000', 'r530-mgr@example.in', 'manager'),
  ('cccccccc-0000-0000-0000-000000530003', 'cccccccc-0000-0000-0000-000000530000', 'r530-rep@example.in', 'sales'),
  ('cccccccc-0000-0000-0000-000000530101', 'cccccccc-0000-0000-0000-000000530100', 'r530-b-owner@example.in', 'owner');

insert into public.customers (id, tenant_id, name, state_code) values
  ('cccccccc-0000-0000-0000-0000005300c1', 'cccccccc-0000-0000-0000-000000530000', 'Late Co', '07');

insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, net_payable, status, due_date, tax_rate, paid_amount) values
  ('INV-R530-A', 'cccccccc-0000-0000-0000-000000530000', 'cccccccc-0000-0000-0000-0000005300c1', 'Late Co', 11800, 11800, 'pending', current_date - 30, 18, 0),
  ('INV-R530-B', 'cccccccc-0000-0000-0000-000000530000', 'cccccccc-0000-0000-0000-0000005300c1', 'Late Co', 11800, 11800, 'paid',    current_date - 30, 18, 11800),
  ('INV-R530-NORATE', 'cccccccc-0000-0000-0000-000000530000', 'cccccccc-0000-0000-0000-0000005300c1', 'Late Co', 5000, 5000, 'pending', current_date - 30, null, 0);

set local role authenticated;

do $$ declare v jsonb; v_err boolean; n int; s text; begin
  -- 1. Company default OFF; the rep cannot change modes; a manager can.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000530003', 'role', 'authenticated')::text, true);
  v := public.late_fee_effective('INV-R530-A');
  if (v->>'on')::boolean or v->>'source' <> 'company' then raise exception 'FAIL 1: default is not company Off (%)', v; end if;
  v_err := false;
  begin perform public.set_late_fee_mode('customer', 'cccccccc-0000-0000-0000-0000005300c1', 'on'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 1b: a sales rep switched late charges on'; end if;

  -- 2. Company off + customer on -> on (from customer).
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000530002', 'role', 'authenticated')::text, true);
  perform public.set_late_fee_mode('customer', 'cccccccc-0000-0000-0000-0000005300c1', 'on');
  v := public.late_fee_effective('INV-R530-A');
  if not (v->>'on')::boolean or v->>'source' <> 'customer' then raise exception 'FAIL 2: customer On did not win (%)', v; end if;

  -- 3. Customer on + invoice off -> off (from invoice); back to default -> customer again.
  perform public.set_late_fee_mode('invoice', 'INV-R530-A', 'off');
  v := public.late_fee_effective('INV-R530-A');
  if (v->>'on')::boolean or v->>'source' <> 'invoice' then raise exception 'FAIL 3: invoice Off did not win (%)', v; end if;
  perform public.set_late_fee_mode('invoice', 'INV-R530-A', 'default');
  v := public.late_fee_effective('INV-R530-A');
  if v->>'source' <> 'customer' then raise exception 'FAIL 3b: Default did not fall back to customer (%)', v; end if;
  select count(*) into n from public.late_fee_audit where entity_id in ('INV-R530-A', 'cccccccc-0000-0000-0000-0000005300c1') and action = 'mode';
  if n <> 3 then raise exception 'FAIL 3c: expected 3 audited mode changes, got %', n; end if;

  -- 4. Manager cannot bill, waive or change the company setting.
  v_err := false;
  begin perform public.bill_late_charges('INV-R530-A', 500, 0, null, null); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 4: a manager billed late charges'; end if;
  v_err := false;
  begin perform public.set_late_fee_settings(true, 18, 500, 0, true); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 4b: a manager changed the company setting'; end if;

  -- 5. Owner bills fee + interest: a debit note at the invoice's 18%, invoice amount untouched.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000530001', 'role', 'authenticated')::text, true);
  v := public.bill_late_charges('INV-R530-A', 500, 175, current_date - 29, current_date);
  if (v->>'gross')::int <> 797 or (v->>'taxable')::int <> 675 then raise exception 'FAIL 5: gross/taxable wrong (%)', v; end if;
  select count(*) into n from public.debit_notes where invoice_id = 'INV-R530-A' and taxable_value = 675 and tax_rate = 18 and amount = 797;
  if n <> 1 then raise exception 'FAIL 5b: debit note not written as expected'; end if;
  if (select amount from public.invoices where id = 'INV-R530-A') <> 11800 then raise exception 'FAIL 5c: issued invoice amount changed'; end if;

  -- 6. The fee only once.
  v_err := false;
  begin perform public.bill_late_charges('INV-R530-A', 500, 0, null, null); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 6: late fee billed twice'; end if;

  -- 7. No GST rate on the invoice -> refused (never assumed).
  v_err := false;
  begin perform public.bill_late_charges('INV-R530-NORATE', 500, 0, null, null); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 7: billed an invoice with no GST rate'; end if;

  -- 8. A paid invoice billed late charges is owed again.
  perform public.bill_late_charges('INV-R530-B', 500, 0, null, null);
  select status::text into s from public.invoices where id = 'INV-R530-B';
  if s <> 'pending' then raise exception 'FAIL 8: paid invoice with an unpaid debit note stayed %', s; end if;

  -- 9. Waive needs a reason; then invoice is Off (waived) and billing is refused.
  v_err := false;
  begin perform public.waive_late_charges('INV-R530-A', ' '); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 9: waived without a reason'; end if;
  perform public.waive_late_charges('INV-R530-A', 'Long-time customer, bank delay');
  v := public.late_fee_effective('INV-R530-A');
  if (v->>'on')::boolean or not (v->>'waived')::boolean then raise exception 'FAIL 9b: waiver not effective (%)', v; end if;
  v_err := false;
  begin perform public.bill_late_charges('INV-R530-A', 0, 10, current_date - 1, current_date); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 9c: billed a waived invoice'; end if;
  select count(*) into n from public.late_fee_audit where entity_id = 'INV-R530-A' and action in ('billed', 'waived');
  if n <> 2 then raise exception 'FAIL 9d: expected billed + waived audit rows, got %', n; end if;

  -- 10. Company setting: owner turns it on; audited; enabled_at stamped.
  perform public.set_late_fee_settings(true, 18, 500, 3, true);
  if (select late_fee_enabled_at from public.tenants where id = 'cccccccc-0000-0000-0000-000000530000') is null then
    raise exception 'FAIL 10: enabled_at not stamped';
  end if;
  v_err := false;
  begin perform public.set_late_fee_settings(true, 40, 500, 0, true); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 10b: 40%% interest accepted'; end if;

  -- 11. Another company sees none of it.
  perform set_config('request.jwt.claims', json_build_object('sub', 'cccccccc-0000-0000-0000-000000530101', 'role', 'authenticated')::text, true);
  if exists(select 1 from public.late_fee_overrides where tenant_id = 'cccccccc-0000-0000-0000-000000530000')
     or exists(select 1 from public.late_fee_audit where tenant_id = 'cccccccc-0000-0000-0000-000000530000')
     or exists(select 1 from public.late_charge_bills where tenant_id = 'cccccccc-0000-0000-0000-000000530000') then
    raise exception 'FAIL 11: other tenant reads late-fee rows';
  end if;
  v_err := false;
  begin perform public.set_late_fee_mode('invoice', 'INV-R530-A', 'on'); exception when others then v_err := true; end;
  if not v_err then raise exception 'FAIL 11b: other tenant toggled our invoice'; end if;

  raise notice 'PASS R-530 late payment charges (11 checks)';
end $$;

rollback;
