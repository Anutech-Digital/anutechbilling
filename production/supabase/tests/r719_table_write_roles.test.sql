\set ON_ERROR_STOP on
-- Regression test: direct (PostgREST) writes to money / catalogue / customer tables need a ROLE,
-- not just the tenant. Migration 20261011083000_r719_table_write_roles.sql (R-719).
-- Rolled back — safe anywhere.
--
--   For each table: a sales / support login's direct write is refused where the app does not
--   do it; the roles the app uses still write; sales keeps exactly the columns its record-
--   payment / AI Entry flows touch; another tenant's owner still reaches nothing; a SECURITY
--   DEFINER function called by sales is unaffected.

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('71900000-0000-4000-8000-000000000001', 'R719 SELLER', 'r719-a@example.in', '07', 'R79A'),
  ('71900000-0000-4000-8000-000000000002', 'R719 OTHER',  'r719-b@example.in', '07', 'R79B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('71900000-0000-4000-8000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-owner@example.in'),
  ('71900000-0000-4000-8000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-manager@example.in'),
  ('71900000-0000-4000-8000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-accountant@example.in'),
  ('71900000-0000-4000-8000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-billing@example.in'),
  ('71900000-0000-4000-8000-0000000000a5', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-sales@example.in'),
  ('71900000-0000-4000-8000-0000000000a6', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-support@example.in'),
  ('71900000-0000-4000-8000-0000000000a7', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r719-other@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('71900000-0000-4000-8000-0000000000a1', '71900000-0000-4000-8000-000000000001', 'r719-owner@example.in',      'owner',      true),
  ('71900000-0000-4000-8000-0000000000a2', '71900000-0000-4000-8000-000000000001', 'r719-manager@example.in',    'manager',    true),
  ('71900000-0000-4000-8000-0000000000a3', '71900000-0000-4000-8000-000000000001', 'r719-accountant@example.in', 'accountant', true),
  ('71900000-0000-4000-8000-0000000000a4', '71900000-0000-4000-8000-000000000001', 'r719-billing@example.in',    'billing',    true),
  ('71900000-0000-4000-8000-0000000000a5', '71900000-0000-4000-8000-000000000001', 'r719-sales@example.in',      'sales',      true),
  ('71900000-0000-4000-8000-0000000000a6', '71900000-0000-4000-8000-000000000001', 'r719-support@example.in',    'support',    true),
  ('71900000-0000-4000-8000-0000000000a7', '71900000-0000-4000-8000-000000000002', 'r719-other@example.in',      'owner',      true);

/* Seed rows of our tenant, written as the migration owner (RLS does not apply here).
   The customer is backdated so it is not "just created" for the delete-undo window. */
insert into public.customers (id, tenant_id, name, gstin, created_at) values
  ('71900000-0000-4000-8000-0000000000c1', '71900000-0000-4000-8000-000000000001', 'R719 Customer', '07AAAAA0000A1Z5', now() - interval '2 days');
insert into public.quotes (id, tenant_id, customer_name, customer_id) values
  ('R719-Q-1', '71900000-0000-4000-8000-000000000001', 'R719 Customer', '71900000-0000-4000-8000-0000000000c1');
insert into public.payments (id, tenant_id, quote_id, customer_id, amount, method) values
  ('71900000-0000-4000-8000-0000000000f2', '71900000-0000-4000-8000-000000000001', 'R719-Q-1', '71900000-0000-4000-8000-0000000000c1', 1000, 'upi');
insert into public.invoices (id, tenant_id, customer_name, customer_id, amount) values
  ('R719-INV-1', '71900000-0000-4000-8000-000000000001', 'R719 Customer', '71900000-0000-4000-8000-0000000000c1', 1180);
insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate) values
  ('R719-CN-1', '71900000-0000-4000-8000-000000000001', 'R719-INV-1', 118, 100, 18, 18);
insert into public.debit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate) values
  ('R719-DN-1', '71900000-0000-4000-8000-000000000001', 'R719-INV-1', 118, 100, 18, 18);
insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values
  ('R719-ITEM-1', '71900000-0000-4000-8000-000000000001', 'R719 Plan', 'google', 500, 400);
insert into public.coupons (tenant_id, code, discount_value) values
  ('71900000-0000-4000-8000-000000000001', 'R719TEN', 10);
insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total) values
  ('R719-BILL-1', '71900000-0000-4000-8000-000000000001', 'R719 Vendor', current_date, 5000);
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('71900000-0000-4000-8000-0000000000b1', '71900000-0000-4000-8000-000000000001', 'R719 Current', 'R719 Bank');
insert into public.bank_aa_connections (id, tenant_id, bank_account_id, vua) values
  ('71900000-0000-4000-8000-0000000000b2', '71900000-0000-4000-8000-000000000001', '71900000-0000-4000-8000-0000000000b1', '9999999999@r719');
insert into public.employee_loans (id, tenant_id, employee_name, principal, disbursed_on) values
  ('71900000-0000-4000-8000-0000000000e1', '71900000-0000-4000-8000-000000000001', 'R719 Staff', 10000, current_date);
insert into public.referral_partners (id, tenant_id, name) values
  ('71900000-0000-4000-8000-0000000000d1', '71900000-0000-4000-8000-000000000001', 'R719 Partner');
insert into public.customer_credits (id, tenant_id, customer_id, amount, status) values
  ('71900000-0000-4000-8000-0000000000cc', '71900000-0000-4000-8000-000000000001', '71900000-0000-4000-8000-0000000000c1', 300, 'open');

do $$
declare
  v_err boolean; v_n int; v_code text; v_new uuid;
  c_seller constant uuid := '71900000-0000-4000-8000-000000000001';
  c_cust   constant uuid := '71900000-0000-4000-8000-0000000000c1';
  u_owner  constant text := '71900000-0000-4000-8000-0000000000a1';
  u_mgr    constant text := '71900000-0000-4000-8000-0000000000a2';
  u_acct   constant text := '71900000-0000-4000-8000-0000000000a3';
  u_bill   constant text := '71900000-0000-4000-8000-0000000000a4';
  u_sales  constant text := '71900000-0000-4000-8000-0000000000a5';
  u_supp   constant text := '71900000-0000-4000-8000-0000000000a6';
  u_other  constant text := '71900000-0000-4000-8000-0000000000a7';
begin
  set local role authenticated;

  -- ════ customer_credits ═══════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.customer_credits (tenant_id, customer_id, amount, status) values (c_seller, c_cust, 100000, 'open');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 1: a sales login minted a customer credit'; end if;
  update public.customer_credits set amount = 99999 where id = '71900000-0000-4000-8000-0000000000cc';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 2: a sales login changed a credit amount (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.customer_credits (tenant_id, customer_id, amount, status) values (c_seller, c_cust, 100, 'open');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 3: a support login minted a customer credit'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  insert into public.customer_credits (tenant_id, customer_id, amount, source, status, note)
    values (c_seller, c_cust, 50, 'overpayment', 'open', 'R719 restored by billing');  -- the record-payment compensation

  /* R-718 (11 Oct): redeeming credit is a money action — sales is refused by the function's
     own role gate (Pardeep's role table); billing's call goes through and consumes the credit. */
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    perform public.redeem_customer_credits(c_cust, 100, 'R719 redeem by sales');
  exception when insufficient_privilege then v_err := true;
  end;
  if not v_err then raise exception 'FAIL 4: redeem_customer_credits by sales was not refused (R-718)'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  select public.redeem_customer_credits(c_cust, 100, 'R719 redeem') into v_n;
  if v_n <> 100 then raise exception 'FAIL 4: redeem_customer_credits by billing consumed % (expected 100)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.customer_credits (tenant_id, customer_id, amount, status) values (c_seller, c_cust, 100, 'open');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 5: another tenant''s owner wrote a credit into our tenant'; end if;

  -- ════ credit_notes / debit_notes ═════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate)
      values ('R719-CN-SALES', c_seller, 'R719-INV-1', 118, 100, 18, 18);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 6: a sales login inserted a credit note outside issue_credit_note'; end if;
  update public.credit_notes set amount = 1 where id = 'R719-CN-1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 7: a sales login changed a credit note (% rows)', v_n; end if;
  v_err := false;
  begin
    insert into public.debit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate)
      values ('R719-DN-SALES', c_seller, 'R719-INV-1', 118, 100, 18, 18);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 8: a sales login inserted a debit note'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.credit_notes (id, tenant_id, invoice_id, amount, taxable_value, tax_amount, tax_rate)
      values ('R719-CN-OWNER', c_seller, 'R719-INV-1', 118, 100, 18, 18);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 9: even the owner can insert a credit note directly (Rule 46 series bypass)'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_acct, 'role', 'authenticated')::text, true);
  update public.credit_notes set notes = 'R719 accountant note' where id = 'R719-CN-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 10: the accountant could not annotate a credit note (% rows)', v_n; end if;
  update public.debit_notes set notes = 'R719 accountant note' where id = 'R719-DN-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 11: the accountant could not annotate a debit note (% rows)', v_n; end if;

  -- ════ items / coupons ════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  update public.items set msrp = 1 where id = 'R719-ITEM-1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 12: a sales login changed a catalogue price (% rows)', v_n; end if;
  v_err := false;
  begin
    insert into public.coupons (tenant_id, code, discount_type, discount_value) values (c_seller, 'R719FREE', 'percent', 100);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 13: a sales login created a 100%% coupon'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.items (id, tenant_id, name, vendor, msrp, wholesale) values ('R719-ITEM-B', c_seller, 'R719 Billing item', 'other', 1, 1);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 14: a billing login added a catalogue item'; end if;
  update public.coupons set is_active = false where code = 'R719TEN';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 15: a billing login switched a coupon off (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_mgr, 'role', 'authenticated')::text, true);
  update public.items set msrp = 550 where id = 'R719-ITEM-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 16: our manager could not change a price (% rows)', v_n; end if;
  insert into public.coupons (tenant_id, code, discount_value) values (c_seller, 'R719MGR', 5);

  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  update public.items set msrp = 1 where id = 'R719-ITEM-1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 17: another tenant''s owner changed our price'; end if;

  -- ════ customers ══════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.customers (tenant_id, name) values (c_seller, 'R719 support customer');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 18: a support login created a customer'; end if;
  update public.customers set gstin = '07ZZZZZ9999Z1Z5' where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 19: a support login changed a GSTIN (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    update public.customers set gstin = '07ZZZZZ9999Z1Z5' where id = c_cust;
  exception when insufficient_privilege then v_code := 'refused'; end;
  if v_code is null then raise exception 'FAIL 20: a sales login changed a customer''s GSTIN'; end if;
  /* What the record-payment dialog / AI Help do for sales: state, domain, TAN + TDS defaults. */
  update public.customers set state_code = '07', state = 'Delhi', domain = 'r719.example.in', tan = 'DELR71900A',
                              tds_default_section = '194J', tds_default_rate_pct = 10 where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 21: sales could not save state / domain / TDS after a payment (% rows)', v_n; end if;
  /* AI Entry / lead → customer: sales creates a customer, and may take a fresh one back. */
  insert into public.customers (tenant_id, name, gstin) values (c_seller, 'R719 sales customer', '07BBBBB1111B1Z5') returning id into v_new;
  delete from public.customers where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 22: a sales login deleted an old customer (% rows)', v_n; end if;
  delete from public.customers where id = v_new;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 23: sales could not undo the customer it just created (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  update public.customers set gstin = '07CCCCC2222C1Z5', name = 'R719 Customer Pvt Ltd' where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 24: our owner could not change the GSTIN (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_other, 'role', 'authenticated')::text, true);
  update public.customers set gstin = '07ZZZZZ9999Z1Z5' where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 25: another tenant''s owner changed our customer'; end if;

  -- ════ payments ═══════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.payments (tenant_id, quote_id, customer_id, amount, method) values (c_seller, 'R719-Q-1', c_cust, 5000, 'cash');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 26: a sales login inserted a payment directly'; end if;
  v_code := null;
  begin
    update public.payments set amount = 1 where id = '71900000-0000-4000-8000-0000000000f2';
  exception when insufficient_privilege then v_code := 'refused'; end;
  if v_code is null then raise exception 'FAIL 27: a sales login changed a payment amount'; end if;
  /* record-payment dialog step 2b: tag the receipt date + bank account. */
  update public.payments set received_at = now() - interval '1 day', bank_account_id = '71900000-0000-4000-8000-0000000000b1'
   where id = '71900000-0000-4000-8000-0000000000f2';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 28: sales could not tag date / bank on its payment (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  update public.payments set notes = 'R719 support' where id = '71900000-0000-4000-8000-0000000000f2';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 29: a support login edited a payment (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  update public.payments set method = 'bank_transfer', reference = 'R719UTR', notes = 'R719 edit' where id = '71900000-0000-4000-8000-0000000000f2';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 30: billing could not edit payment details (% rows)', v_n; end if;

  -- ════ invoices ═══════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    update public.invoices set amount = 1 where id = 'R719-INV-1';
  exception when insufficient_privilege then v_code := 'refused'; end;
  if v_code is null then raise exception 'FAIL 31: a sales login changed an invoice amount'; end if;
  update public.invoices set paid_date = current_date - 1 where id = 'R719-INV-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 32: sales could not move paid_date to the receipt date (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  update public.invoices set paid_date = current_date where id = 'R719-INV-1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 33: a support login changed an invoice (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_acct, 'role', 'authenticated')::text, true);
  update public.invoices set paid_date = current_date where id = 'R719-INV-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 34: the accountant could not update an invoice (% rows)', v_n; end if;

  -- ════ vendor_bills ═══════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total) values ('R719-BILL-SUP', c_seller, 'R719 x', current_date, 1);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 35: a support login booked a vendor bill'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  insert into public.vendor_bills (id, tenant_id, vendor_name, bill_date, total) values ('R719-BILL-AI', c_seller, 'R719 AI Entry', current_date, 100);
  update public.vendor_bills set total = 1 where id = 'R719-BILL-1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 36: a sales login changed a vendor bill total (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_acct, 'role', 'authenticated')::text, true);
  update public.vendor_bills set notes = 'R719 checked' where id = 'R719-BILL-1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 37: the accountant could not edit a vendor bill (% rows)', v_n; end if;

  -- ════ bank_aa_connections ════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  update public.bank_aa_connections set vua = '8888888888@evil' where id = '71900000-0000-4000-8000-0000000000b2';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 38: a sales login repointed the bank feed (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.bank_aa_connections (tenant_id, bank_account_id, vua) values (c_seller, '71900000-0000-4000-8000-0000000000b1', '7777777777@r719');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 39: a billing login connected a bank feed (bank writes are money roles)'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_acct, 'role', 'authenticated')::text, true);
  insert into public.bank_aa_connections (tenant_id, bank_account_id, vua) values (c_seller, '71900000-0000-4000-8000-0000000000b1', '6666666666@r719');

  -- ════ employee_loans ═════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  update public.employee_loans set principal = 1 where id = '71900000-0000-4000-8000-0000000000e1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 40: a sales login changed a staff loan (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_supp, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.employee_loans (tenant_id, employee_name, principal, disbursed_on) values (c_seller, 'R719 x', 1, current_date);
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 41: a support login created a staff loan'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  update public.employee_loans set notes = 'R719 purpose' where id = '71900000-0000-4000-8000-0000000000e1';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 42: billing could not edit a loan''s purpose (% rows)', v_n; end if;

  -- ════ referral_partners ══════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', u_sales, 'role', 'authenticated')::text, true);
  v_err := false;
  begin
    insert into public.referral_partners (tenant_id, name) values (c_seller, 'R719 sales partner');
  exception when insufficient_privilege then v_err := true; end;
  if not v_err then raise exception 'FAIL 43: a sales login added a referral partner'; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_acct, 'role', 'authenticated')::text, true);
  update public.referral_partners set name = 'R719 hijack' where id = '71900000-0000-4000-8000-0000000000d1';
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'FAIL 44: the read-only accountant changed a referral partner (% rows)', v_n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_bill, 'role', 'authenticated')::text, true);
  insert into public.referral_partners (tenant_id, name) values (c_seller, 'R719 billing partner');

  reset role;

  /* The guard leaves the service-role client (webhooks, GSTIN verify) alone. */
  set local role service_role;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  update public.customers set gstin = '07DDDDD3333D1Z5' where id = c_cust;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FAIL 45: the service-role client could not update a customer (% rows)', v_n; end if;
  reset role;

  select coalesce(sum(amount), 0) into v_n from public.customer_credits where tenant_id = c_seller and status = 'open';
  if v_n <> 250 then raise exception 'FAIL 46: expected Rs 250 open credit (seed 300 + billing 50 - 100 redeemed), found %', v_n; end if;

  raise notice 'r719_table_write_roles: all 46 checks passed';
end $$;

rollback;
