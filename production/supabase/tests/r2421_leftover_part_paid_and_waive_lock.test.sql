\set ON_ERROR_STOP on
-- R-2421: (1) "Write off small balance" only closes what is LEFT after a part payment — a whole
-- unpaid ₹354 bill is refused; (2) "Waive online fee" works on an invoice dated in a locked month,
-- while every other change to that invoice is still refused by the books lock.
-- Migration: 20261103134813_r2421_leftover_part_paid_and_waive_lock.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2421_leftover_part_paid_and_waive_lock.test.sql
--
-- Expect "PASS r2421_leftover_part_paid_and_waive_lock".
--
--   UNPAID   owner writes off a ₹354 invoice with nothing paid (₹354 ≤ ₹500) → refused, not stamped
--   PAISE    the same with 40 paise paid (rounds to ₹0) → refused
--   PART     accountant writes off the ₹55 left on a part-paid invoice → works (R-2410 path kept)
--   WAIVE    owner waives the online fee on a September invoice (books locked to 30 Sep) → saved
--   LOCK     owner changes that invoice's amount → still refused by the books lock

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2421000-0000-4000-8000-0000000000a1', 'r2421-owner@example.test'),
  ('e2421000-0000-4000-8000-0000000000a2', 'r2421-acct@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2421000-0000-0000-0000-0000000000a0', 'R2421 A', 'r2421a@example.in', '07', 'R42A');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2421000-0000-4000-8000-0000000000a1', 'e2421000-0000-0000-0000-0000000000a0', 'r2421-owner@example.in', 'R2421 Owner', 'owner',      true),
  ('e2421000-0000-4000-8000-0000000000a2', 'e2421000-0000-0000-0000-0000000000a0', 'r2421-acct@example.in',  'R2421 Acct',  'accountant', true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2421000-0000-4000-8000-0000000000c1', 'e2421000-0000-0000-0000-0000000000a0', 'R2421 Hosting Co', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, paid_amount, taxable_value, invoice_date, due_date, status) values
  -- whole unpaid ₹354 hosting bill (₹300 + GST)
  ('R42-354',  'e2421000-0000-0000-0000-0000000000a0', 'R2421 Hosting Co', 'e2421000-0000-4000-8000-0000000000c1',   354,   354,     0,   300, '2026-10-01', '2026-10-05', 'overdue'),
  -- 40 paise "paid" (rounds to ₹0) — still a whole unpaid bill
  ('R42-PAISE', 'e2421000-0000-0000-0000-0000000000a0', 'R2421 Hosting Co', 'e2421000-0000-4000-8000-0000000000c1',   236,   236,   0.4,   200, '2026-10-01', '2026-10-05', 'pending'),
  -- ₹55 left after a part payment
  ('R42-55',   'e2421000-0000-0000-0000-0000000000a0', 'R2421 Hosting Co', 'e2421000-0000-4000-8000-0000000000c1', 11800, 11800, 11745, 10000, '2026-10-01', '2026-10-15', 'pending'),
  -- September, unpaid — books locked to 30 Sep below
  ('R42-SEP',  'e2421000-0000-0000-0000-0000000000a0', 'R2421 Hosting Co', 'e2421000-0000-4000-8000-0000000000c1', 23600, 23600,     0, 20000, '2026-09-10', '2026-09-20', 'overdue');

update public.tenants set books_locked_until = '2026-09-30' where id = 'e2421000-0000-0000-0000-0000000000a0';

create temp table r2421_fail (msg text) on commit drop;
grant all on r2421_fail to authenticated;

create function pg_temp.r2421_try(p_inv text, p_reason text) returns text language plpgsql as $$
begin
  perform public.write_off_small_invoice_balance(p_inv, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2421_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r2421_try(text, text) to authenticated;
grant execute on function pg_temp.r2421_as(text) to authenticated;

do $$
declare
  v_e text; v_r jsonb; v_n int;
begin
  set local role authenticated;

  -- ════ UNPAID / PAISE ═══════════════════════════════════════════════════════════════
  perform pg_temp.r2421_as('e2421000-0000-4000-8000-0000000000a1');
  v_e := pg_temp.r2421_try('R42-354', 'Small hosting bill');
  if v_e is null or v_e not like '22023: Invoice R42-354 has no payment yet — the whole ₹354 is still owed%' then
    insert into r2421_fail values ('unpaid ₹354 not refused: ' || coalesce(v_e, 'ran — WHOLE BILL WRITTEN OFF'));
  end if;
  v_e := pg_temp.r2421_try('R42-PAISE', 'Small hosting bill');
  if v_e is null or v_e not like '22023: Invoice R42-PAISE has no payment yet%' then
    insert into r2421_fail values ('unpaid (40 paise paid) not refused: ' || coalesce(v_e, 'ran — WHOLE BILL WRITTEN OFF'));
  end if;

  -- ════ PART ════════════════════════════════════════════════════════════════════════
  perform pg_temp.r2421_as('e2421000-0000-4000-8000-0000000000a2');
  begin
    v_r := public.write_off_small_invoice_balance('R42-55', 'Bank charges deducted by customer');
    if (v_r->>'amount')::int <> 55 then insert into r2421_fail values ('₹55 result wrong: ' || v_r::text); end if;
  exception when others then insert into r2421_fail values ('part-paid ₹55 write-off raised: ' || sqlerrm);
  end;

  -- ════ WAIVE (locked month) ═════════════════════════════════════════════════════════
  perform pg_temp.r2421_as('e2421000-0000-4000-8000-0000000000a1');
  begin
    update public.invoices set online_fee_waived = true, online_fee_waive_reason = 'Promised on call'
     where id = 'R42-SEP';
    get diagnostics v_n = row_count;
    if v_n <> 1 then insert into r2421_fail values ('waive on locked-month invoice changed ' || v_n || ' rows'); end if;
  exception when others then insert into r2421_fail values ('waive on locked-month invoice refused: ' || sqlerrm);
  end;

  -- ════ LOCK still holds ════════════════════════════════════════════════════════════
  begin
    update public.invoices set amount = 1 where id = 'R42-SEP';
    insert into r2421_fail values ('amount change on a locked-month invoice was NOT refused');
  exception when check_violation then null;
    when others then insert into r2421_fail values ('amount change refused with the wrong error: ' || sqlerrm);
  end;

  set local role postgres;
  select count(*) into v_n from public.invoices where id in ('R42-354', 'R42-PAISE') and written_off_at is not null;
  if v_n <> 0 then insert into r2421_fail values ('an unpaid invoice was stamped written off: ' || v_n); end if;
  select count(*) into v_n from public.invoice_write_off_drafts where invoice_id in ('R42-354', 'R42-PAISE');
  if v_n <> 0 then insert into r2421_fail values ('an unpaid invoice got a write-off record: ' || v_n); end if;
  if not exists (select 1 from public.invoices where id = 'R42-55' and written_off_at is not null) then
    insert into r2421_fail values ('R42-55 not stamped');
  end if;
  if not exists (select 1 from public.invoices where id = 'R42-SEP' and online_fee_waived
                   and online_fee_waive_reason = 'Promised on call' and amount = 23600) then
    insert into r2421_fail values ('R42-SEP waiver not saved (or amount changed)');
  end if;

  select count(*) into v_n from r2421_fail;
  if v_n > 0 then
    raise exception 'FAIL r2421_leftover_part_paid_and_waive_lock: %', (select string_agg(msg, E'\n') from r2421_fail);
  end if;
  raise notice 'PASS r2421_leftover_part_paid_and_waive_lock';
end $$;

rollback;
