-- R-2361 (2 Nov 2026, staging reconcile), P1: "Mark reconciled manually" reconciled a ₹12,00,000
-- line in one click, with no reason. Migration 20261102091144_r2361_manual_reconcile_reason.
-- Self-asserting, ONE transaction, rolled back.
--
--   A. No reason / a too-short reason → refused (22023), the line stays open.
--   B. A reason → line matched 'manual', the reason saved on the line AND in activity_log.
--   C. Pairing checks: other account, different amount, same side, already reconciled, the line
--      itself, another company's line → each refused, nothing reconciled.
--   D. Valid pair (₹12,00,000 out + ₹12,00,000 back in) → both 'manual', each points at the other,
--      both carry the reason.
--   E. Un-reconcile ONE line of the pair → both lines open again, notes + links cleared.
--   F. A plain manual line un-reconciled loses its note.

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
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000236101','R2361 Co','r2361@example.in','07','R361'),
  ('dddddddd-0000-0000-0000-000000236102','R2361 Other Co','r2361b@example.in','07','R362');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000236101','owner2361@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000236101','dddddddd-0000-0000-0000-000000236101','owner2361@example.in','Owner 2361','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name, account_type, opening_balance) values
  ('bbbbbbbb-0000-0000-0000-000000236101','dddddddd-0000-0000-0000-000000236101','HDFC Current','HDFC','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000236102','dddddddd-0000-0000-0000-000000236101','ICICI Current','ICICI','current', 0),
  ('bbbbbbbb-0000-0000-0000-000000236103','dddddddd-0000-0000-0000-000000236102','Other Co bank','SBI','current', 0);
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  -- the pair: ₹12,00,000 out, the same back in two days later
  ('11111111-0000-0000-0000-000000236101','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-10','RTGS OUT FAILED',1200000,0,'manual'),
  ('11111111-0000-0000-0000-000000236102','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-12','RTGS RETURN',0,1200000,'manual'),
  -- wrong candidates
  ('11111111-0000-0000-0000-000000236103','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236102','2026-10-12','OTHER ACCOUNT IN',0,1200000,'manual'),
  ('11111111-0000-0000-0000-000000236104','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-12','SMALLER IN',0,1199999,'manual'),
  ('11111111-0000-0000-0000-000000236105','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-12','SAME SIDE OUT',1200000,0,'manual'),
  ('11111111-0000-0000-0000-000000236106','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-13','ALREADY DONE IN',0,1200000,'manual'),
  ('11111111-0000-0000-0000-000000236107','dddddddd-0000-0000-0000-000000236102','bbbbbbbb-0000-0000-0000-000000236103','2026-10-12','OTHER CO IN',0,1200000,'manual'),
  -- a plain line for A/B/F
  ('11111111-0000-0000-0000-000000236108','dddddddd-0000-0000-0000-000000236101','bbbbbbbb-0000-0000-0000-000000236101','2026-10-14','BANK CHARGES REVERSAL',0,59,'manual');

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000236101","role":"authenticated"}', true);

do $$
declare ok boolean; v_bad uuid; v_msg text;
begin
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000236106', 'manual', null, 'manual');

  -- A
  foreach v_msg in array array['', '   ', 'abc', ' ab  '] loop
    ok := false;
    begin perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236108', v_msg, null);
    exception when sqlstate '22023' then ok := true; end;
    if not ok then raise exception 'FAIL A: reason "%" was accepted', v_msg; end if;
  end loop;
  ok := false;
  begin perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236108', null, null);
  exception when sqlstate '22023' then ok := true; end;
  if not ok then raise exception 'FAIL A: null reason accepted'; end if;
  if (select matched_to_type from public.bank_transactions where id = '11111111-0000-0000-0000-000000236108') is not null then
    raise exception 'FAIL A: line reconciled without a reason'; end if;
  raise notice 'A PASS: reason required';

  -- B
  perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236108', '  Bank reversed its own charge  ', null);
  if (select matched_to_type || '|' || coalesce(reconcile_note, '-') || '|' || coalesce(reversal_of::text, '-')
        from public.bank_transactions where id = '11111111-0000-0000-0000-000000236108')
     is distinct from 'manual|Bank reversed its own charge|-' then
    raise exception 'FAIL B: line not manual with the reason'; end if;
  if not exists (select 1 from public.activity_log
                  where entity = 'bank_transactions' and entity_id = '11111111-0000-0000-0000-000000236108'
                    and changes->'reconcile_note'->>'new' = 'Bank reversed its own charge') then
    raise exception 'FAIL B: reason not in activity_log'; end if;
  raise notice 'B PASS: reason on the line and in the audit log';

  -- C
  foreach v_bad in array array[
      '11111111-0000-0000-0000-000000236103'::uuid,  -- other account
      '11111111-0000-0000-0000-000000236104'::uuid,  -- different amount
      '11111111-0000-0000-0000-000000236105'::uuid,  -- same side
      '11111111-0000-0000-0000-000000236101'::uuid]  -- itself
  loop
    ok := false;
    begin perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236101', 'RTGS failed and came back', v_bad);
    exception when sqlstate '22023' then ok := true; end;
    if not ok then raise exception 'FAIL C: pair with % accepted', v_bad; end if;
  end loop;
  ok := false;
  begin perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236101', 'RTGS failed and came back', '11111111-0000-0000-0000-000000236106');
  exception when sqlstate '23514' then ok := true; end;
  if not ok then raise exception 'FAIL C: pair with an already reconciled line accepted'; end if;
  ok := false;
  begin perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236101', 'RTGS failed and came back', '11111111-0000-0000-0000-000000236107');
  exception when sqlstate 'P0002' then ok := true; end;
  if not ok then raise exception 'FAIL C: pair with another company''s line accepted'; end if;
  if exists (select 1 from public.bank_transactions
              where id in ('11111111-0000-0000-0000-000000236101','11111111-0000-0000-0000-000000236103',
                           '11111111-0000-0000-0000-000000236104','11111111-0000-0000-0000-000000236105',
                           '11111111-0000-0000-0000-000000236107')
                and matched_to_type is not null) then
    raise exception 'FAIL C: a refused pair left a line reconciled'; end if;
  raise notice 'C PASS: pair checks';

  -- D
  perform public.reconcile_bank_txn_manual('11111111-0000-0000-0000-000000236101', 'RTGS failed and came back', '11111111-0000-0000-0000-000000236102');
  if (select count(*) from public.bank_transactions
       where (id = '11111111-0000-0000-0000-000000236101' and reversal_of = '11111111-0000-0000-0000-000000236102')
          or (id = '11111111-0000-0000-0000-000000236102' and reversal_of = '11111111-0000-0000-0000-000000236101')) <> 2 then
    raise exception 'FAIL D: lines do not point at each other'; end if;
  if (select count(*) from public.bank_transactions
       where id in ('11111111-0000-0000-0000-000000236101','11111111-0000-0000-0000-000000236102')
         and matched_to_type = 'manual' and reconcile_note = 'RTGS failed and came back') <> 2 then
    raise exception 'FAIL D: both lines not manual with the reason'; end if;
  raise notice 'D PASS: reversal pair reconciled together';

  -- E
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000236102', null, null, null);
  if exists (select 1 from public.bank_transactions
              where id in ('11111111-0000-0000-0000-000000236101','11111111-0000-0000-0000-000000236102')
                and (matched_to_type is not null or reconcile_note is not null or reversal_of is not null)) then
    raise exception 'FAIL E: un-reconciling one line left the pair half-reconciled'; end if;
  raise notice 'E PASS: un-reconcile one line un-pairs both';

  -- F
  perform public.reconcile_bank_txn('11111111-0000-0000-0000-000000236108', null, null, null);
  if (select reconcile_note from public.bank_transactions where id = '11111111-0000-0000-0000-000000236108') is not null then
    raise exception 'FAIL F: note kept after un-reconcile'; end if;
  raise notice 'F PASS';
end $$;

select 'R-2361 manual reconcile reason + reversal pair: ALL PASS' as result;

rollback;
