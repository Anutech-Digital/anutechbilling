-- R-2611 (8 Nov 2026): bulk "Book selected" + the Reconcile sheet could book ONE bank line twice
-- (book_bank_txn_as_expense read the line without a lock; its update had no "still unreconciled"
-- condition). Migration: 20261108160059_r2611_book_expense_row_lock.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Owner's path: a line booked once → booked; the same line booked again (a second "Book
--      selected" after a lost answer) → REFUSED 'already reconciled'; exactly ONE expense.
--   B. The function locks the line (for update) and its update only touches an unreconciled line,
--      and raises when nothing was updated — so two bookings at the same moment cannot both win.
--   C. R-1917's open-bill guard is still there (newest body kept).

begin;

create function pg_temp.r2611_fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2611_supplier before insert on public.tenants for each row execute function pg_temp.r2611_fill_supplier();

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000261101','R2611 Co','r2611@example.in','07','R2611');
insert into auth.users (id, email) values ('aaaaaaaa-0000-0000-0000-000000261101','owner2611@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000261101','dddddddd-0000-0000-0000-000000261101','owner2611@example.in','Owner 2611','owner', now() - interval '1 day');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('bbbbbbbb-0000-0000-0000-000000261101','dddddddd-0000-0000-0000-000000261101','HDFC Current','HDFC');
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, debit, credit, source) values
  ('cccccccc-0000-0000-0000-000000261101','dddddddd-0000-0000-0000-000000261101','bbbbbbbb-0000-0000-0000-000000261101','2026-10-05','POS ZQXR2611 QZW',2000,0,'csv_upload');

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000261101","role":"authenticated"}', true);

do $$
declare v_id text; v_err text; n int;
begin
  v_id := public.book_bank_txn_as_expense('cccccccc-0000-0000-0000-000000261101', 'Advertising', 'Zqxr', 0, null);
  if v_id is null then raise exception 'A FAIL: first booking returned no expense id'; end if;
  begin
    perform public.book_bank_txn_as_expense('cccccccc-0000-0000-0000-000000261101', 'Advertising', 'Zqxr', 0, null);
    raise exception 'A FAIL: the same line was booked a second time';
  exception when others then
    v_err := sqlerrm;
    if v_err like 'A FAIL%' then raise; end if;
    if v_err not ilike '%already reconciled%' then raise exception 'A FAIL: unexpected refusal: %', v_err; end if;
  end;
  select count(*) into n from public.expenses where reconciled_txn_id = 'cccccccc-0000-0000-0000-000000261101';
  if n <> 1 then raise exception 'A FAIL: % expenses for one bank line', n; end if;
  if (select matched_to_id from public.bank_transactions where id = 'cccccccc-0000-0000-0000-000000261101') <> v_id then
    raise exception 'A FAIL: the line does not point at the first expense';
  end if;
  raise notice 'A PASS: second booking of the same line refused; one expense';
end $$;

do $$
declare src text := (select prosrc from pg_proc where oid = to_regprocedure('public.book_bank_txn_as_expense(uuid,text,text,integer,text)'));
begin
  if src !~* 'tenant_id = v_tenant\s+for update' then raise exception 'B FAIL: the line is not read for update'; end if;
  if src !~* 'and matched_to_type is null' then raise exception 'B FAIL: the update can overwrite another booking'; end if;
  if src !~* 'if not found then\s+raise exception ''This line is already reconciled''' then raise exception 'B FAIL: 0 rows updated is not refused'; end if;
  raise notice 'B PASS: row lock + unreconciled-only update + refusal on 0 rows';
  if src !~ 'R-1917' or src !~* 'bank_debit_vendor_open_items' then raise exception 'C FAIL: R-1917 open-bill guard lost'; end if;
  raise notice 'C PASS: R-1917 guard kept';
end $$;

rollback;
