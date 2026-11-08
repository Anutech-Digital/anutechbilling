-- R-2601 (8 Nov 2026, p0, R-1916 review BLOCK): un-reconciling a bank line whose vendor ADVANCE
-- carries TDS is refused once that TDS month is deposited by challan (rule R-1920).
-- Migration: 20261108073000_r2601_advance_tds_undo_lock.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Owner's path: a contractor's ₹90,000 bank line → Banking → "Paying a vendor?" → advance with
-- TDS 194J ₹10,000 (05 Oct) → the October TDS challan is paid (Banking) → Un-reconcile the
-- advance line.
--   A. No challan yet → the Undo preview is not blocked (the advance would just go).
--   B. Challan for Oct 2026 → preview blocked ("already deposited", challan no, Banking link) and
--      un-reconcile refused with the same hint; the advance and its TDS row stay.
--   C. Challan with no period, paid next month (Nov) → still refused.
--   D. Challan for another month only → un-reconcile goes through (advance + TDS gone).

begin;

create function pg_temp.r2601_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2601_supplier before insert on public.tenants for each row execute function pg_temp.r2601_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000260101','R2601 Co','r2601@example.in','07','R2601');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000260101','owner2601@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000260101','dddddddd-0000-0000-0000-000000260101','owner2601@example.in','Owner 2601','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000260101','dddddddd-0000-0000-0000-000000260101','HDFC Current','HDFC'),
  ('bbbbbbbb-0000-0000-0000-000000260102','dddddddd-0000-0000-0000-000000260101','ICICI Tax','ICICI');
insert into public.vendors (id, tenant_id, name, pan, default_category) values
  ('eeeeeeee-0000-0000-0000-000000260101','dddddddd-0000-0000-0000-000000260101','Sharma Design Studio','ABCPS2601K','Professional Fees');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, reference, source) values
  ('11111111-0000-0000-0000-000000260101','dddddddd-0000-0000-0000-000000260101','bbbbbbbb-0000-0000-0000-000000260101','2026-10-05','NEFT SHARMA DESIGN ADV',90000,0,'S1','csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000260101","role":"authenticated"}', true);

select public.reconcile_bank_debit_to_vendor(
  p_txn_id => '11111111-0000-0000-0000-000000260101', p_vendor_id => 'eeeeeeee-0000-0000-0000-000000260101',
  p_new_vendor => null, p_items => '[]'::jsonb, p_new_bill => null,
  p_advance => 90000, p_advance_category => null, p_bank_charge => 0, p_note => null,
  p_advance_tds => 10000, p_advance_tds_section => '194J', p_advance_tds_override_reason => null);

-- ── A. No challan → not blocked ──────────────────────────────────────────────────────────────
do $$
declare p jsonb;
begin
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000260101');
  if (p->>'blocked')::boolean then raise exception 'A FAIL: blocked with no challan: %', p->>'block_message'; end if;
  raise notice 'A ok: no challan — undo allowed';
end $$;

-- ── B. October challan deposited → preview blocked, un-reconcile refused ─────────────────────
insert into public.statutory_dues_payments (tenant_id, kind, amount, paid_on, bank_account_id, challan_no, period)
  values ('dddddddd-0000-0000-0000-000000260101', 'tds', 10000, '2026-11-07', 'bbbbbbbb-0000-0000-0000-000000260102', 'CIN2601', '2026-10');

do $$
declare p jsonb; msg text; hint text; n int;
begin
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000260101');
  if not coalesce((p->>'blocked')::boolean, false) or p->>'block_message' not like '%already deposited%CIN2601%'
     or p->>'block_message' not like '%advance%'
     or p->>'block_href' is distinct from '/accounting/banking/bbbbbbbb-0000-0000-0000-000000260102' then
    raise exception 'B FAIL: preview %', p;
  end if;
  begin
    perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000260101', false);
    msg := null;
  exception when others then get stacked diagnostics msg = message_text, hint = pg_exception_hint; end;
  if coalesce(msg, '') not like '%already deposited%' or hint is distinct from '/accounting/banking/bbbbbbbb-0000-0000-0000-000000260102' then
    raise exception 'B FAIL: un-reconcile with the advance TDS deposited: % / %', msg, hint;
  end if;
  select count(*) into n from public.bank_vendor_payment_lines l
   where l.bank_txn_id = '11111111-0000-0000-0000-000000260101' and l.kind = 'advance' and l.tds_amount = 10000;
  if n <> 1 then raise exception 'B FAIL: advance TDS row gone after the refusal (%)', n; end if;
  raise notice 'B ok: Oct challan — preview blocked with Banking link, un-reconcile refused';
end $$;

-- ── C. Challan with no period, paid the next month → still refused ───────────────────────────
update public.statutory_dues_payments set period = null where challan_no = 'CIN2601';
do $$
declare p jsonb;
begin
  p := public.vendor_payment_undo_preview('11111111-0000-0000-0000-000000260101');
  if not coalesce((p->>'blocked')::boolean, false) then raise exception 'C FAIL: challan with no period (paid Nov) not seen'; end if;
  raise notice 'C ok: no-period challan paid in Nov blocks too';
end $$;

-- ── D. Challan for another month only → undo goes through ────────────────────────────────────
update public.statutory_dues_payments set period = '2026-08', paid_on = '2026-09-07' where challan_no = 'CIN2601';
do $$
declare n int;
begin
  perform public.unreconcile_bank_receipt('11111111-0000-0000-0000-000000260101', false);
  select count(*) into n from public.prepaid_advances where tenant_id = 'dddddddd-0000-0000-0000-000000260101';
  if n <> 0 then raise exception 'D FAIL: % advance(s) left', n; end if;
  select count(*) into n from public.bank_vendor_payment_lines where bank_txn_id = '11111111-0000-0000-0000-000000260101';
  if n <> 0 then raise exception 'D FAIL: % payment row(s) left', n; end if;
  raise notice 'D ok: Aug challan does not block — advance and its TDS gone';
end $$;

rollback;
