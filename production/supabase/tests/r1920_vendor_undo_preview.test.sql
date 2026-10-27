-- R-1920 (26 Oct 2026, from the R-1906 audit): undo of a vendor-payment bank line shows first
-- what goes back, and refuses with a link when something later depends on it.
-- Migration: 20261026102909_r1920_vendor_undo_preview.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves (owner's path: Sharma Associates, ₹59,000 bill PS-101 paid ₹54,000 + ₹5,000 TDS 194J,
-- with a ₹1,000 advance and a ₹20 bank charge on the same ₹55,020 line):
--   A. vendor_payment_undo_preview lists the three legs: PS-101 paid → unpaid (paid ₹0), TDS ₹5,000;
--      the advance removed; the bank charge removed. Not blocked.
--   B. The preview changed nothing: line still matched, bill still paid, legs still there.
--   C. Un-reconcile does exactly what the preview said.
--   D. TDS for Sep 2026 already deposited (challan) → preview blocked with a Banking link, and
--      the real un-reconcile is refused with the same hint.
--   E. A later part payment on the bill → preview blocked, link to that later line's account.
--   F. The advance already used against a bill → preview blocked, link to the bill's page.
--   G. A line that is not a vendor payment is refused.

begin;

create function pg_temp.r1920_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r1920_supplier before insert on public.tenants for each row execute function pg_temp.r1920_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000192001','R1920 Co','r1920@example.in','07','R1920');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000192001','owner1920@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000192001','dddddddd-0000-0000-0000-000000192001','owner1920@example.in','Owner 1920','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000192001','dddddddd-0000-0000-0000-000000192001','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000192002','dddddddd-0000-0000-0000-000000192001','ICICI Current','ICICI');
insert into public.vendors (id, tenant_id, name, gstin, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000192001','dddddddd-0000-0000-0000-000000192001','Sharma Associates','07AAKFS1920A1Z5','AAKFS1920A','Professional Services');

insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000192001','dddddddd-0000-0000-0000-000000192001','bbbbbbbb-0000-0000-0000-000000192001','2026-10-05','NEFT SHARMA ASSOCIATES',55020,0,'N1','csv_upload'),
  ('11111111-0000-0000-0000-000000192002','dddddddd-0000-0000-0000-000000192001','bbbbbbbb-0000-0000-0000-000000192001','2026-10-06','UPI SHARMA PART 1',20000,0,'U1','csv_upload'),
  ('11111111-0000-0000-0000-000000192003','dddddddd-0000-0000-0000-000000192001','bbbbbbbb-0000-0000-0000-000000192002','2026-10-12','UPI SHARMA PART 2',20000,0,'U2','csv_upload'),
  ('11111111-0000-0000-0000-000000192004','dddddddd-0000-0000-0000-000000192001','bbbbbbbb-0000-0000-0000-000000192001','2026-10-07','SALARY TEST',100,0,'S1','csv_upload');

insert into public.expenses (id, tenant_id, category, vendor_name, vendor_id, expense_date, amount, gst_paid, bill_type, bill_no, paid, payment_method) values
  ('EXP-R1920-PS101','dddddddd-0000-0000-0000-000000192001','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000192001','2026-09-01',59000,9000,'gst','PS-101',false,null),
  ('EXP-R1920-PS102','dddddddd-0000-0000-0000-000000192001','Professional Services','Sharma Associates','eeeeeeee-0000-0000-0000-000000192001','2026-10-01',40000,0,'none','PS-102',false,null);

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000192001","role":"authenticated"}', true);

-- ── A. The preview lists every leg with its before / after ───────────────────────────────────
do $$
declare p jsonb; l jsonb; n int;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192001','eeeeeeee-0000-0000-0000-000000192001', null,
    '[{"source":"expense","doc_id":"EXP-R1920-PS101","amount":59000,"tds_amount":5000,"tds_section":"194J"}]'::jsonb,
    null, 1000, 'Professional Services', 20, null);
  begin
    p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192001');
  exception when undefined_function then
    raise exception 'A FAIL: no vendor_payment_undo_preview — the Undo shows nothing before the click';
  end;
  if (p->>'blocked')::boolean then raise exception 'A FAIL: blocked: % (%)', p->>'block_message', p->>'block_href'; end if;
  if p->>'vendor_name' <> 'Sharma Associates' or (p->>'debit')::int <> 55020 then raise exception 'A FAIL: header %', p; end if;
  n := jsonb_array_length(p->'legs');
  if n <> 3 then raise exception 'A FAIL: % legs (want 3): %', n, p->'legs'; end if;
  select x into l from jsonb_array_elements(p->'legs') x where x->>'kind' = 'expense';
  if l->>'doc_no' <> 'PS-101' or l->>'before_status' <> 'paid' or (l->>'before_paid')::int <> 54000
     or l->>'after_status' <> 'unpaid' or (l->>'after_paid')::int <> 0 or (l->>'removed')::boolean
     or (l->>'tds_amount')::int <> 5000 or (l->>'cash')::int <> 54000 or l->>'href' <> '/accounting/expenses' then
    raise exception 'A FAIL: bill leg %', l;
  end if;
  select x into l from jsonb_array_elements(p->'legs') x where x->>'kind' = 'advance';
  if not (l->>'removed')::boolean or (l->>'cash')::int <> 1000 then raise exception 'A FAIL: advance leg %', l; end if;
  select x into l from jsonb_array_elements(p->'legs') x where x->>'kind' = 'bank_charge';
  if not (l->>'removed')::boolean or (l->>'cash')::int <> 20 then raise exception 'A FAIL: bank charge leg %', l; end if;
  raise notice 'A ok: preview — PS-101 paid → unpaid (₹0), TDS ₹5,000 off; advance ₹1,000 and bank charge ₹20 removed';
end $$;

-- ── B. The preview changed nothing ───────────────────────────────────────────────────────────
do $$
declare t public.bank_transactions; e public.expenses; n int;
begin
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000192001';
  select * into e from public.expenses where id = 'EXP-R1920-PS101';
  select count(*) into n from public.bank_vendor_payment_lines where bank_txn_id = t.id;
  if t.matched_to_type is distinct from 'vendor_payment' or not e.paid or e.tds_amount <> 5000 or n <> 3 then
    raise exception 'B FAIL: preview wrote — line % bill paid % tds % legs %', t.matched_to_type, e.paid, e.tds_amount, n;
  end if;
  raise notice 'B ok: preview left the line, the bill and the legs as they were';
end $$;

-- ── C. Un-reconcile does what the preview said ───────────────────────────────────────────────
do $$
declare t public.bank_transactions; e public.expenses; n int;
begin
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000192001', false);
  select * into t from public.bank_transactions where id = '11111111-0000-0000-0000-000000192001';
  select * into e from public.expenses where id = 'EXP-R1920-PS101';
  select count(*) into n from public.prepaid_advances where tenant_id = 'dddddddd-0000-0000-0000-000000192001';
  if t.matched_to_type is not null or e.paid or coalesce(e.paid_amount, 0) <> 0 or coalesce(e.tds_amount, 0) <> 0 or n <> 0 then
    raise exception 'C FAIL: line % paid % paid_amount % tds % advances %', t.matched_to_type, e.paid, e.paid_amount, e.tds_amount, n;
  end if;
  select count(*) into n from public.expenses where tenant_id = 'dddddddd-0000-0000-0000-000000192001' and id not in ('EXP-R1920-PS101','EXP-R1920-PS102');
  if n <> 0 then raise exception 'C FAIL: bank charge expense left (%)', n; end if;
  raise notice 'C ok: un-reconcile — PS-101 unpaid, TDS off, advance and bank charge gone, line unmatched';
end $$;

-- ── D. TDS already deposited → refused, with a link ──────────────────────────────────────────
do $$
declare p jsonb; msg text; hint text;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192001','eeeeeeee-0000-0000-0000-000000192001', null,
    '[{"source":"expense","doc_id":"EXP-R1920-PS101","amount":59000,"tds_amount":5000,"tds_section":"194J"}]'::jsonb,
    null, 1000, 'Professional Services', 20, null);
  insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, challan_no, period)
    values ('dddddddd-0000-0000-0000-000000192001', 'tds', 5000, '2026-10-07', 'bbbbbbbb-0000-0000-0000-000000192002', 'CIN0920', '2026-09');
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192001');
  if not (p->>'blocked')::boolean or p->>'block_message' not like '%already deposited%CIN0920%'
     or p->>'block_href' <> '/accounting/banking/bbbbbbbb-0000-0000-0000-000000192002' then
    raise exception 'D FAIL: preview %', p;
  end if;
  if jsonb_array_length(p->'legs') <> 3 then raise exception 'D FAIL: legs not listed when blocked: %', p->'legs'; end if;
  begin
    perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000192001', false);
    msg := null;
  exception when others then get stacked diagnostics msg = message_text, hint = pg_exception_hint; end;
  if coalesce(msg, '') not like '%already deposited%' or hint <> '/accounting/banking/bbbbbbbb-0000-0000-0000-000000192002' then
    raise exception 'D FAIL: un-reconcile with the TDS deposited: % / %', msg, hint;
  end if;
  -- the challan without a period, paid the next month, counts too
  update public.statutory_dues_payments set period = null where challan_no = 'CIN0920';
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192001');
  if not (p->>'blocked')::boolean then raise exception 'D FAIL: challan with no period (paid Oct) not seen'; end if;
  -- a challan for another month does not block
  update public.statutory_dues_payments set period = '2026-08', paid_on = '2026-09-07' where challan_no = 'CIN0920';
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192001');
  if (p->>'blocked')::boolean then raise exception 'D FAIL: Aug challan blocked a Sep TDS: %', p->>'block_message'; end if;
  raise notice 'D ok: Sep TDS deposited (CIN0920) — preview blocked with the challan''s Banking link; un-reconcile refused with the same hint';
end $$;

-- ── E. A later part payment → blocked, link to that line's account ───────────────────────────
do $$
declare p jsonb;
begin
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192002','eeeeeeee-0000-0000-0000-000000192001', null,
    '[{"source":"expense","doc_id":"EXP-R1920-PS102","amount":20000,"tds_amount":0}]'::jsonb);
  perform public.reconcile_bank_debit_to_vendor('11111111-0000-0000-0000-000000192003','eeeeeeee-0000-0000-0000-000000192001', null,
    '[{"source":"expense","doc_id":"EXP-R1920-PS102","amount":20000,"tds_amount":0}]'::jsonb);
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192002');
  if not (p->>'blocked')::boolean or p->>'block_message' not like '%later bank payment%'
     or p->>'block_href' <> '/accounting/banking/bbbbbbbb-0000-0000-0000-000000192002' then
    raise exception 'E FAIL: preview %', p;
  end if;
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192003');
  if (p->>'blocked')::boolean then raise exception 'E FAIL: the later part is blocked: %', p->>'block_message'; end if;
  raise notice 'E ok: first part blocked (link to the later line''s ICICI account); the later part can be undone';
end $$;

-- ── F. Advance already used → blocked, link to where it was used ─────────────────────────────
do $$
declare p jsonb; v_adv uuid;
begin
  delete from public.statutory_dues_payments where challan_no = 'CIN0920';
  select prepaid_advance_id into v_adv from public.bank_vendor_payment_lines
   where bank_txn_id = '11111111-0000-0000-0000-000000192001' and kind = 'advance';
  update public.prepaid_advances set consumed_amount = 400 where id = v_adv;
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192001');
  if not (p->>'blocked')::boolean or p->>'block_message' not like '%already used%' or p->>'block_href' <> '/accounting/prepaid' then
    raise exception 'F FAIL: preview %', p;
  end if;
  raise notice 'F ok: advance ₹400 used — preview blocked with the Prepaid link';
end $$;

-- ── G. Not a vendor payment ──────────────────────────────────────────────────────────────────
do $$
declare msg text;
begin
  begin
    perform public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000192004');
    msg := null;
  exception when others then msg := sqlerrm; end;
  if coalesce(msg, '') not like '%not a vendor payment%' then raise exception 'G FAIL: %', msg; end if;
  raise notice 'G ok: an unmatched line is refused';
end $$;

rollback;
