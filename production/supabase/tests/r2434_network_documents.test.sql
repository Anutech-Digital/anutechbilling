-- R-2434 (G-NETWORK N2, slice 1) — my issued invoice lands as a PENDING copy in my connected
-- customer's app; the customer Accepts (→ one bill), Rejects (reason the seller sees) or leaves it
-- Pending, like GST IMS. Migration: 2026110*_r2434_network_documents.sql. FAILS without it (no
-- network_documents, no network_* document functions; the R-2432 mirror made a bill straight away).
--
--   1. a draft makes no copy; issuing makes ONE pending copy frozen at issue (GST split, lines
--      without the seller's cost / list price), and no R-2432 mirror bill for a connected pair
--   2. who sees it: only the buyer's owner / manager / accountant; a sales user, another company,
--      and the seller itself cannot read or act on the buyer's copy
--   3. accept → exactly one bill (vendor = seller GSTIN, frozen amounts, the buyer's own category);
--      accepting again is refused
--   4. seller edits after accept are refused (void, amount, even with app.invoice_amend_reason);
--      the buyer's bill keeps its amounts locked but the buyer's own choices (category) change
--   5. reject needs a reason; the seller sees "rejected" + the reason
--   6. a manual bill the buyer already typed (same seller GSTIN + number + FY) is linked, not
--      duplicated
--   7. a credit note follows: pending copy → accept → the bill comes down on its own heads
--   8. void before accept cancels the pending copy (accept then refused)
--   9. no copy without the 'invoices' scope, without owner-proved GSTINs (even on an operator
--      parent link), or without a connection
--  10. tenant isolation of the seller-status list
--
-- SAFETY: synthetic tenants + identities, one transaction ending in ROLLBACK.
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/r2434_network_documents.test.sql

begin;

-- ── fixture ─────────────────────────────────────────────────────────────────────────
-- S seller (proved 07…S), B buyer (proved 07…B, connected, S shares invoices),
-- N connected but S shares only payments, U parent-link child sharing invoices but GSTIN not proved,
-- O proved but not connected.
insert into auth.users (id, email) values
  ('24340000-0000-4000-8000-0000000000a1', 'r2434-owner-s@example.test'),
  ('24340000-0000-4000-8000-0000000000b1', 'r2434-owner-b@example.test'),
  ('24340000-0000-4000-8000-0000000000b2', 'r2434-acct-b@example.test'),
  ('24340000-0000-4000-8000-0000000000b3', 'r2434-sales-b@example.test'),
  ('24340000-0000-4000-8000-0000000000c1', 'r2434-owner-o@example.test');

insert into public.tenants (id, name, email, state_code, doc_code, gstin, gstin_verified_at, workspace_kind) values
  ('24340000-0000-4000-8000-00000000000a', 'R2434 Seller', 'r2434s@example.test', '07', 'R234S', '07AAACR2434S1Z5', now(), 'business'),
  ('24340000-0000-4000-8000-00000000000b', 'R2434 Buyer',  'r2434b@example.test', '07', 'R234B', '07AAACR2434B1Z5', now(), 'business'),
  ('24340000-0000-4000-8000-00000000000c', 'R2434 Other',  'r2434o@example.test', '27', 'R234O', '27AAACR2434O1Z5', now(), 'business'),
  ('24340000-0000-4000-8000-00000000000d', 'R2434 NoScope','r2434n@example.test', '07', 'R234N', '07AAACR2434N1Z5', now(), 'business'),
  ('24340000-0000-4000-8000-00000000000e', 'R2434 Unproved','r2434u@example.test','07', 'R234U', '07AAACR2434U1Z5', now(), 'business');

update public.tenants
   set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = upper(btrim(gstin)),
       gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
 where id in ('24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-00000000000b',
              '24340000-0000-4000-8000-00000000000c', '24340000-0000-4000-8000-00000000000d');
-- B is also an old operator-set child of S (so the R-2432 mirror WOULD fire for it)
update public.tenants set parent_tenant_id = '24340000-0000-4000-8000-00000000000a'
 where id in ('24340000-0000-4000-8000-00000000000b', '24340000-0000-4000-8000-00000000000e');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('24340000-0000-4000-8000-0000000000a1', '24340000-0000-4000-8000-00000000000a', 'r2434-owner-s@example.test', 'R2434 Owner S', 'owner', true),
  ('24340000-0000-4000-8000-0000000000b1', '24340000-0000-4000-8000-00000000000b', 'r2434-owner-b@example.test', 'R2434 Owner B', 'owner', true),
  ('24340000-0000-4000-8000-0000000000b2', '24340000-0000-4000-8000-00000000000b', 'r2434-acct-b@example.test',  'R2434 Acct B',  'accountant', true),
  ('24340000-0000-4000-8000-0000000000b3', '24340000-0000-4000-8000-00000000000b', 'r2434-sales-b@example.test', 'R2434 Sales B', 'sales', true),
  ('24340000-0000-4000-8000-0000000000c1', '24340000-0000-4000-8000-00000000000c', 'r2434-owner-o@example.test', 'R2434 Owner O', 'owner', true);

insert into public.tenant_connections (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, b_scopes, origin) values
  ('24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-00000000000b', '07AAACR2434S1Z5', '07AAACR2434B1Z5',
   'accepted', array['invoices'], array['payments'], 'request'),
  ('24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-00000000000d', '07AAACR2434S1Z5', '07AAACR2434N1Z5',
   'accepted', array['payments'], array['invoices'], 'request'),
  ('24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-00000000000e', '07AAACR2434S1Z5', '07AAACR2434U1Z5',
   'accepted', array['invoices'], array['partner_metrics'], 'parent_link');

insert into public.customers (id, tenant_id, name, gstin, linked_tenant_id) values
  ('24340000-0000-4000-8000-0000000001b0', '24340000-0000-4000-8000-00000000000a', 'R2434 Buyer',   '07AAACR2434B1Z5', '24340000-0000-4000-8000-00000000000b'),
  ('24340000-0000-4000-8000-0000000001c0', '24340000-0000-4000-8000-00000000000a', 'R2434 Other',   '27AAACR2434O1Z5', null),
  ('24340000-0000-4000-8000-0000000001d0', '24340000-0000-4000-8000-00000000000a', 'R2434 NoScope', '07AAACR2434N1Z5', null),
  ('24340000-0000-4000-8000-0000000001e0', '24340000-0000-4000-8000-00000000000a', 'R2434 Unproved','07AAACR2434U1Z5', '24340000-0000-4000-8000-00000000000e');

create function pg_temp.as_user(p uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.must_fail(p_label text, p_sql text, p_word text default null) returns void
language plpgsql as $$
declare v_st text; v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_st = returned_sqlstate, v_msg = message_text;
    if p_word is not null and position(p_word in v_msg) = 0 then
      raise exception 'FAIL %: wrong refusal % %', p_label, v_st, v_msg;
    end if;
    return;
  end;
  raise exception 'FAIL %: passed but must be refused', p_label;
end $$;
grant execute on function pg_temp.as_user(uuid) to authenticated;
grant execute on function pg_temp.must_fail(text, text, text) to authenticated;

-- ── 1. draft → nothing; issue → one pending copy, frozen, no mirror bill ──────────────
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, due_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin, line_items)
values ('INV-R2434-A', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        11800, 'draft', current_date, current_date + 15, 11800, 10000, 1800, 18, false, '07AAACR2434B1Z5', '07AAACR2434S1Z5',
        '[{"name": "Workspace Starter", "qty": 10, "rate": 1000, "cost": 600, "list_rate": 1200, "hsn": "998315"}]'::jsonb);

do $$ begin
  if exists (select 1 from public.network_documents where seller_invoice_id = 'INV-R2434-A') then
    raise exception 'FAIL 1a: a DRAFT invoice reached the buyer';
  end if;
end $$;

update public.invoices set status = 'pending' where id = 'INV-R2434-A';

do $$
declare d record; n int;
begin
  select count(*) into n from public.network_documents where seller_invoice_id = 'INV-R2434-A' and kind = 'invoice';
  if n <> 1 then raise exception 'FAIL 1b: % copies of the issued invoice (want 1)', n; end if;
  select * into d from public.network_documents where seller_invoice_id = 'INV-R2434-A';
  if d.status <> 'pending' or d.buyer_tenant_id <> '24340000-0000-4000-8000-00000000000b'
     or d.seller_gstin <> '07AAACR2434S1Z5' or d.buyer_gstin <> '07AAACR2434B1Z5' or d.doc_number <> 'INV-R2434-A' then
    raise exception 'FAIL 1c: copy % % % % %', d.status, d.buyer_tenant_id, d.seller_gstin, d.buyer_gstin, d.doc_number;
  end if;
  if (d.taxable_value, d.cgst, d.sgst, d.igst, d.total) is distinct from (10000, 900, 900, 0, 11800) then
    raise exception 'FAIL 1d: frozen split % / % / % / % / %', d.taxable_value, d.cgst, d.sgst, d.igst, d.total;
  end if;
  if d.payload::text like '%"cost"%' or d.payload::text like '%list_rate%' then
    raise exception 'FAIL 1e: the seller''s cost / list price leaked into the buyer copy: %', d.payload;
  end if;
  if d.payload -> 'lines' -> 0 ->> 'hsn_sac' is distinct from '998315' or (d.payload -> 'lines' -> 0 ->> 'amount')::int <> 10000 then
    raise exception 'FAIL 1f: lines not copied with HSN/SAC + amount: %', d.payload -> 'lines';
  end if;
  if exists (select 1 from public.vendor_bills where source_tenant_invoice_id = 'INV-R2434-A') then
    raise exception 'FAIL 1g: a bill was made before the buyer accepted (R-2432 mirror still fires for a connected pair)';
  end if;
end $$;

-- the copy is frozen: a later amendment by the seller (before accept) does not change it
set local app.invoice_amend_reason = 'R2434 test: fix due date';
update public.invoices set due_date = current_date + 30 where id = 'INV-R2434-A';
reset app.invoice_amend_reason;
do $$ begin
  if (select payload ->> 'due_date' from public.network_documents where seller_invoice_id = 'INV-R2434-A') <> (current_date + 15)::text then
    raise exception 'FAIL 1h: the buyer copy followed a later seller edit (must be frozen at issue)';
  end if;
end $$;

-- ── 2. who sees it ──────────────────────────────────────────────────────────────────
do $$ begin
  perform set_config('r2434.docA', (select id::text from public.network_documents where seller_invoice_id = 'INV-R2434-A'), true);
end $$;
set local role authenticated;
do $$
declare n int;
begin
  -- the table itself is closed to request roles
  begin
    select count(*) into n from public.network_documents;
    raise exception 'FAIL 2a: authenticated can read network_documents directly';
  exception when insufficient_privilege then null;
  end;

  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b2');     -- B accountant
  select count(*) into n from public.network_inbox() where id = current_setting('r2434.docA')::uuid and status = 'pending';
  if n <> 1 then raise exception 'FAIL 2b: buyer accountant does not see the pending copy'; end if;

  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b3');     -- B sales
  select count(*) into n from public.network_inbox();
  if n <> 0 then raise exception 'FAIL 2c: a sales user sees % network documents', n; end if;
  perform pg_temp.must_fail('2d sales accepts', format($q$select public.network_accept_document(%L)$q$, current_setting('r2434.docA')), null);

  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000c1');     -- another company
  select count(*) into n from public.network_inbox();
  if n <> 0 then raise exception 'FAIL 2e: another company sees % network documents', n; end if;
  perform pg_temp.must_fail('2f other accepts', format($q$select public.network_accept_document(%L)$q$, current_setting('r2434.docA')), 'not found');
  perform pg_temp.must_fail('2g other rejects', format($q$select public.network_reject_document(%L, 'not ours')$q$, current_setting('r2434.docA')), 'not found');

  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000a1');     -- the seller itself
  perform pg_temp.must_fail('2h seller accepts its own', format($q$select public.network_accept_document(%L)$q$, current_setting('r2434.docA')), 'not found');
  select count(*) into n from public.network_seller_documents('INV-R2434-A') where status = 'pending';
  if n <> 1 then raise exception 'FAIL 2i: the seller does not see its own sent copy as pending'; end if;
end $$;

-- ── 3. accept → one bill ─────────────────────────────────────────────────────────────
do $$
declare r record; b record; n int;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b2');
  select * into r from public.network_accept_document(current_setting('r2434.docA')::uuid, 'COGS-Workspace');
  if r.vendor_bill_id is null or r.linked_existing then
    raise exception 'FAIL 3a: accept gave % / linked %', r.vendor_bill_id, r.linked_existing;
  end if;
  perform set_config('r2434.billA', r.vendor_bill_id, true);
  perform pg_temp.must_fail('3b accept twice', format($q$select public.network_accept_document(%L)$q$, current_setting('r2434.docA')), 'already accepted');
end $$;
reset role;
do $$
declare b record; v record; n int;
begin
  select count(*) into n from public.vendor_bills where tenant_id = '24340000-0000-4000-8000-00000000000b' and bill_no = 'INV-R2434-A';
  if n <> 1 then raise exception 'FAIL 3c: % bills for INV-R2434-A (want exactly 1)', n; end if;
  select * into b from public.vendor_bills where id = current_setting('r2434.billA');
  if (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (10000, 900, 900, 0, 11800)
     or b.vendor_gstin <> '07AAACR2434S1Z5' or b.category <> 'COGS-Workspace' or b.document_type <> 'tax_invoice'
     or b.status <> 'unpaid' or b.bill_date <> current_date or b.due_date <> current_date + 15 then
    raise exception 'FAIL 3d: bill % % % % % gstin % cat % doc % status % date % due %',
      b.subtotal, b.cgst, b.sgst, b.igst, b.total, b.vendor_gstin, b.category, b.document_type, b.status, b.bill_date, b.due_date;
  end if;
  select * into v from public.vendors where id = b.vendor_id;
  if v.tenant_id <> '24340000-0000-4000-8000-00000000000b' or v.gstin <> '07AAACR2434S1Z5' then
    raise exception 'FAIL 3e: vendor % / % (want a buyer vendor with the seller GSTIN)', v.tenant_id, v.gstin;
  end if;
  if b.line_items::text like '%"cost"%' then raise exception 'FAIL 3f: seller cost on the buyer bill'; end if;
  if exists (select 1 from public.vendor_bills where id = 'VB-PARTNER-INV-R2434-A') then
    raise exception 'FAIL 3g: the R-2432 mirror bill exists beside the network bill (double booking)';
  end if;
end $$;

-- ── 4. locks after accept ────────────────────────────────────────────────────────────
select pg_temp.must_fail('4a seller voids accepted', $q$update public.invoices set status = 'void' where id = 'INV-R2434-A'$q$, 'accepted');
set local app.invoice_amend_reason = 'R2434 test: try to change amount';
select pg_temp.must_fail('4b seller amends accepted', $q$update public.invoices set amount = 11000 where id = 'INV-R2434-A'$q$, 'accepted');
reset app.invoice_amend_reason;
select pg_temp.must_fail('4c buyer changes bill total', format($q$update public.vendor_bills set total = 100, subtotal = 100 where id = %L$q$, current_setting('r2434.billA')), 'credit note');
select pg_temp.must_fail('4d buyer deletes bill', format($q$delete from public.vendor_bills where id = %L$q$, current_setting('r2434.billA')), 'undo that accept');
-- the seller's INTERNAL line cost (never in the buyer copy) may still be filled in on an accepted invoice
set local app.invoice_amend_reason = 'R2434 test: fill missing cost';
update public.invoices set line_items = jsonb_set(line_items, '{0,cost}', '650') where id = 'INV-R2434-A';
reset app.invoice_amend_reason;
-- the buyer's own choices still change
update public.vendor_bills set category = 'office_expenses', notes = 'our note' where id = current_setting('r2434.billA');
-- payment still works (status / paid_amount are the buyer's)
update public.vendor_bills set paid_amount = 0, status = 'unpaid' where id = current_setting('r2434.billA');
set local role authenticated;
do $$ begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000a1');
  if (select status from public.network_seller_documents('INV-R2434-A') limit 1) <> 'accepted' then
    raise exception 'FAIL 4e: seller does not see accepted';
  end if;
end $$;
reset role;

-- ── 5. reject needs a reason; the seller sees it ─────────────────────────────────────
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin)
values ('INV-R2434-B', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        5900, 'pending', current_date, 5900, 5000, 900, 18, false, '07AAACR2434B1Z5', '07AAACR2434S1Z5');
set local role authenticated;
do $$
declare v_doc uuid; s record;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b1');
  select id into v_doc from public.network_inbox() where doc_number = 'INV-R2434-B';
  if v_doc is null then raise exception 'FAIL 5a: INV-R2434-B not in the buyer inbox'; end if;
  perform pg_temp.must_fail('5b reject without reason', format($q$select public.network_reject_document(%L, '  ')$q$, v_doc), 'reason');
  perform public.network_reject_document(v_doc, 'We never ordered this');
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000a1');
  select * into s from public.network_seller_documents('INV-R2434-B');
  if s.status <> 'rejected' or s.reject_reason <> 'We never ordered this' then
    raise exception 'FAIL 5c: seller sees % / %', s.status, s.reject_reason;
  end if;
  -- reject is final: the buyer cannot accept that copy later
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('5e accept after reject', format($q$select public.network_accept_document(%L)$q$, v_doc), 'You rejected');
  perform set_config('r2434.docB', v_doc::text, true);
end $$;
reset role;
do $$ begin
  if exists (select 1 from public.vendor_bills where bill_no = 'INV-R2434-B') then
    raise exception 'FAIL 5d: a rejected copy made a bill';
  end if;
end $$;
-- the seller voids the rejected invoice → its copy is cancelled
update public.invoices set status = 'void' where id = 'INV-R2434-B';
do $$ begin
  if (select status from public.network_documents where id = current_setting('r2434.docB')::uuid) <> 'cancelled' then
    raise exception 'FAIL 5f: the rejected copy of a voided invoice is not cancelled';
  end if;
end $$;

-- ── 6. a manual bill already typed is linked, not duplicated ─────────────────────────
insert into public.vendor_bills (id, tenant_id, vendor_name, vendor_gstin, bill_no, bill_date, subtotal, cgst, sgst, igst, total, paid_amount, status, category)
values ('VB-R2434-MANUAL', '24340000-0000-4000-8000-00000000000b', 'R2434 Seller', '07aaacr2434s1z5', ' inv-r2434-c ', current_date,
        2000, 180, 180, 0, 2360, 0, 'unpaid', 'COGS-Workspace');
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin)
values ('INV-R2434-C', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        2360, 'pending', current_date, 2360, 2000, 360, 18, false, '07AAACR2434B1Z5', '07AAACR2434S1Z5');
set local role authenticated;
do $$
declare v_doc uuid; r record;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b1');
  select id into v_doc from public.network_inbox() where doc_number = 'INV-R2434-C';
  select * into r from public.network_accept_document(v_doc);
  if r.vendor_bill_id <> 'VB-R2434-MANUAL' or not r.linked_existing then
    raise exception 'FAIL 6a: accept made % (linked %), want the manual bill linked', r.vendor_bill_id, r.linked_existing;
  end if;
end $$;
reset role;
do $$
declare n int;
begin
  select count(*) into n from public.vendor_bills where tenant_id = '24340000-0000-4000-8000-00000000000b'
     and upper(btrim(bill_no)) = 'INV-R2434-C';
  if n <> 1 then raise exception 'FAIL 6b: % bills for INV-R2434-C (want the one manual bill)', n; end if;
end $$;

-- ── 7. credit note follows ───────────────────────────────────────────────────────────
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2434-1', '24340000-0000-4000-8000-00000000000a', 'INV-R2434-A', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        1180, 1000, 180, 18, false);
-- a credit note of ANOTHER company naming the seller's invoice sends nothing
insert into public.credit_notes (id, tenant_id, invoice_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2434-X', '24340000-0000-4000-8000-00000000000c', 'INV-R2434-A', 'Someone', 1180, 1000, 180, 18, false);
do $$
declare d record;
begin
  if exists (select 1 from public.network_documents where seller_note_id = 'CN-R2434-X') then
    raise exception 'FAIL 7a: another company''s credit note reached the buyer';
  end if;
  select * into d from public.network_documents where seller_note_id = 'CN-R2434-1';
  if d.id is null or d.kind <> 'credit_note' or d.status <> 'pending' or d.buyer_tenant_id <> '24340000-0000-4000-8000-00000000000b'
     or (d.taxable_value, d.cgst, d.sgst, d.igst, d.total) is distinct from (1000, 90, 90, 0, 1180) then
    raise exception 'FAIL 7b: credit note copy % % % % / % / % / % / %', d.id, d.kind, d.status, d.buyer_tenant_id,
      d.taxable_value, d.cgst, d.sgst, d.total;
  end if;
  perform set_config('r2434.docCN', d.id::text, true);
end $$;
set local role authenticated;
do $$
declare r record;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b2');
  select * into r from public.network_accept_document(current_setting('r2434.docCN')::uuid);
  if r.vendor_bill_id <> current_setting('r2434.billA') then
    raise exception 'FAIL 7c: credit note applied to % (want %)', r.vendor_bill_id, current_setting('r2434.billA');
  end if;
end $$;
reset role;
do $$
declare b record;
begin
  select * into b from public.vendor_bills where id = current_setting('r2434.billA');
  if (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (9000, 810, 810, 0, 10620) then
    raise exception 'FAIL 7d: bill after credit note % / % / % / % / % (want 9000 / 810 / 810 / 0 / 10620)',
      b.subtotal, b.cgst, b.sgst, b.igst, b.total;
  end if;
end $$;
select pg_temp.must_fail('7e seller deletes accepted credit note', $q$delete from public.credit_notes where id = 'CN-R2434-1'$q$, 'accepted');

-- 7f: a pending credit note the seller deletes → its copy is cancelled (never accepted as an orphan)
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2434-2', '24340000-0000-4000-8000-00000000000a', 'INV-R2434-A', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        590, 500, 90, 18, false);
delete from public.credit_notes where id = 'CN-R2434-2';
do $$ begin
  if (select status from public.network_documents where seller_note_id = 'CN-R2434-2') <> 'cancelled' then
    raise exception 'FAIL 7f: the copy of a deleted pending credit note is still %',
      (select status from public.network_documents where seller_note_id = 'CN-R2434-2');
  end if;
end $$;

-- 7g: debit note → pending copy → accept makes a NEW bill dated the note (its own ITC month)
insert into public.debit_notes (id, tenant_id, invoice_id, customer_id, customer_name, debit_date, reason_code, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('DN-R2434-1', '24340000-0000-4000-8000-00000000000a', 'INV-R2434-A', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        current_date, 'other', 2360, 2000, 360, 18, false);
do $$
declare d record;
begin
  select * into d from public.network_documents where seller_note_id = 'DN-R2434-1';
  if d.id is null or d.kind <> 'debit_note' or d.status <> 'pending'
     or (d.taxable_value, d.cgst, d.sgst, d.igst, d.total) is distinct from (2000, 180, 180, 0, 2360) then
    raise exception 'FAIL 7g: debit note copy % % % / % / % / %', d.kind, d.status, d.taxable_value, d.cgst, d.sgst, d.total;
  end if;
  perform set_config('r2434.docDN', d.id::text, true);
end $$;
set local role authenticated;
do $$
declare r record;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b2');
  select * into r from public.network_accept_document(current_setting('r2434.docDN')::uuid);
  perform set_config('r2434.billDN', r.vendor_bill_id, true);
end $$;
reset role;
do $$
declare b record;
begin
  select * into b from public.vendor_bills where id = current_setting('r2434.billDN');
  if b.id is null or b.id = current_setting('r2434.billA') or b.bill_no <> 'DN-R2434-1' or b.bill_date <> current_date
     or (b.subtotal, b.cgst, b.sgst, b.igst, b.total) is distinct from (2000, 180, 180, 0, 2360) or b.vendor_gstin <> '07AAACR2434S1Z5' then
    raise exception 'FAIL 7h: debit note bill % no % date % % / % / % / %', b.id, b.bill_no, b.bill_date, b.subtotal, b.cgst, b.sgst, b.total;
  end if;
  -- the invoice bill did not move
  if (select total from public.vendor_bills where id = current_setting('r2434.billA')) <> 10620 then
    raise exception 'FAIL 7i: the debit note changed the invoice bill';
  end if;
end $$;
select pg_temp.must_fail('7j seller deletes accepted debit note', $q$delete from public.debit_notes where id = 'DN-R2434-1'$q$, 'accepted');

-- 7k: buyer books locked over the bill date → a credit note cannot rewrite it (clear next step)
insert into public.credit_notes (id, tenant_id, invoice_id, customer_id, customer_name, amount, taxable_value, tax_amount, tax_rate, inter_state)
values ('CN-R2434-3', '24340000-0000-4000-8000-00000000000a', 'INV-R2434-A', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        118, 100, 18, 18, false);
update public.tenants set books_locked_until = current_date where id = '24340000-0000-4000-8000-00000000000b';
set local role authenticated;
do $$ begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b2');
  perform pg_temp.must_fail('7k credit note into locked books',
    format($q$select public.network_accept_document(%L)$q$, (select id from public.network_inbox() where doc_number = 'CN-R2434-3')), 'books are locked');
end $$;
reset role;
update public.tenants set books_locked_until = null where id = '24340000-0000-4000-8000-00000000000b';

-- 7l: undo accept — a credit note cannot be undone; the invoice with accepted notes stays;
--     the linked manual bill (INV-R2434-C) is just unlinked; the debit-note bill goes
set local role authenticated;
do $$
declare v_c uuid;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('7l undo credit note', format($q$select public.network_undo_accept(%L)$q$, current_setting('r2434.docCN')), 'debit note');
  perform pg_temp.must_fail('7m undo invoice with accepted notes', format($q$select public.network_undo_accept(%L)$q$, current_setting('r2434.docA')), 'stays accepted');
  select id into v_c from public.network_inbox() where doc_number = 'INV-R2434-C';
  if public.network_undo_accept(v_c) <> 'pending' then raise exception 'FAIL 7n: undo of the linked invoice'; end if;
  if public.network_undo_accept(current_setting('r2434.docDN')::uuid) <> 'pending' then raise exception 'FAIL 7o: undo of the debit note'; end if;
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b3');
  perform pg_temp.must_fail('7p sales undoes', format($q$select public.network_undo_accept(%L)$q$, v_c), null);
end $$;
reset role;
do $$ begin
  if not exists (select 1 from public.vendor_bills where id = 'VB-R2434-MANUAL') then
    raise exception 'FAIL 7q: undo deleted the buyer''s own typed bill';
  end if;
  if exists (select 1 from public.vendor_bills where id = current_setting('r2434.billDN')) then
    raise exception 'FAIL 7r: undo left the debit-note bill behind';
  end if;
  if (select status from public.network_documents where seller_invoice_id = 'INV-R2434-C' and kind = 'invoice') <> 'pending' then
    raise exception 'FAIL 7s: the undone copy is not pending again';
  end if;
end $$;

-- ── 8. void before accept cancels the pending copy ───────────────────────────────────
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin)
values ('INV-R2434-D', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
        1180, 'pending', current_date, 1180, 1000, 180, 18, false, '07AAACR2434B1Z5', '07AAACR2434S1Z5');
update public.invoices set status = 'void' where id = 'INV-R2434-D';
do $$ begin
  if (select status from public.network_documents where seller_invoice_id = 'INV-R2434-D' and kind = 'invoice') <> 'cancelled' then
    raise exception 'FAIL 8a: voided invoice copy is not cancelled';
  end if;
  perform set_config('r2434.docD', (select id::text from public.network_documents where seller_invoice_id = 'INV-R2434-D'), true);
end $$;
set local role authenticated;
do $$ begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b1');
  perform pg_temp.must_fail('8b accept a cancelled copy', format($q$select public.network_accept_document(%L)$q$, current_setting('r2434.docD')), 'cancelled');
end $$;
reset role;

-- ── 9. no scope / no proof / no connection → no copy ─────────────────────────────────
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin)
values
  ('INV-R2434-N', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001d0', 'R2434 NoScope',
   1180, 'pending', current_date, 1180, 1000, 180, 18, false, '07AAACR2434N1Z5', '07AAACR2434S1Z5'),
  ('INV-R2434-U', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001e0', 'R2434 Unproved',
   1180, 'pending', current_date, 1180, 1000, 180, 18, false, '07AAACR2434U1Z5', '07AAACR2434S1Z5'),
  ('INV-R2434-O', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001c0', 'R2434 Other',
   1180, 'pending', current_date, 1180, 1000, 180, 18, true, '27AAACR2434O1Z5', '07AAACR2434S1Z5');
do $$ begin
  if exists (select 1 from public.network_documents where seller_invoice_id in ('INV-R2434-N', 'INV-R2434-U', 'INV-R2434-O')) then
    raise exception 'FAIL 9a: a copy went without the invoices scope / owner proof / connection: %',
      (select string_agg(seller_invoice_id, ', ') from public.network_documents where seller_invoice_id in ('INV-R2434-N', 'INV-R2434-U', 'INV-R2434-O'));
  end if;
  -- the unproved parent-link child keeps the old R-2432 mirror (no connection with proof)
  if not exists (select 1 from public.vendor_bills where id = 'VB-PARTNER-INV-R2434-U') then
    raise exception 'FAIL 9b: the old parent-link mirror stopped for a pair the network does not cover';
  end if;
end $$;
-- 9c: U "proved" but no longer registered with GSTN (gstin_verified_at gone) → still nothing
update public.tenants
   set gstin_verified_at = null, gstin_owner_verified_at = now(), gstin_owner_verified_gstin = '07AAACR2434U1Z5',
       gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
 where id = '24340000-0000-4000-8000-00000000000e';
-- 9d: the SELLER loses its proof → nothing flows to B either
update public.tenants set gstin_owner_verified_at = null where id = '24340000-0000-4000-8000-00000000000a';
insert into public.invoices (id, tenant_id, customer_id, customer_name, amount, status, invoice_date, net_payable,
                             taxable_value, tax_amount, tax_rate, inter_state, customer_gstin, seller_gstin)
values
  ('INV-R2434-U2', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001e0', 'R2434 Unproved',
   1180, 'pending', current_date, 1180, 1000, 180, 18, false, '07AAACR2434U1Z5', '07AAACR2434S1Z5'),
  ('INV-R2434-E', '24340000-0000-4000-8000-00000000000a', '24340000-0000-4000-8000-0000000001b0', 'R2434 Buyer',
   1180, 'pending', current_date, 1180, 1000, 180, 18, false, '07AAACR2434B1Z5', '07AAACR2434S1Z5');
do $$ begin
  if exists (select 1 from public.network_documents where seller_invoice_id in ('INV-R2434-U2', 'INV-R2434-E')) then
    raise exception 'FAIL 9c/9d: a copy went although a GSTIN is not (or no longer) owner-proved';
  end if;
end $$;
update public.tenants
   set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = '07AAACR2434S1Z5',
       gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = 'admin@example.test'
 where id = '24340000-0000-4000-8000-00000000000a';

-- ── 10. isolation of the seller list ─────────────────────────────────────────────────
set local role authenticated;
do $$
declare n int;
begin
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000c1');
  select count(*) into n from public.network_seller_documents(null);
  if n <> 0 then raise exception 'FAIL 10a: another company sees % of the seller''s sent documents', n; end if;
  perform pg_temp.as_user('24340000-0000-4000-8000-0000000000b3');
  select count(*) into n from public.network_seller_documents(null);
  if n <> 0 then raise exception 'FAIL 10b: a sales user sees % sent documents', n; end if;
end $$;
reset role;

select set_config('request.jwt.claims', '', true);
select 'R-2434 network documents: all checks passed' as result;

rollback;
