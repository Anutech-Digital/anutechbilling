\set ON_ERROR_STOP on
-- R-2410: "Write off small balance" on Payment Follow-up closes ONE invoice's leftover
-- (₹1–₹500) — stamps it written off with the reason, keeps every money column, records a
-- confirmed write-off row — and refuses everything else.
-- Migration: 20261103121500_r2410_write_off_small_balance.
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2410_write_off_small_balance.test.sql
--
-- Expect "PASS r2410_write_off_small_balance".
--
--   GUARDS  no reason; a billing user; another company; a ₹501 balance; a paid invoice → refused, nothing stamped
--   WRITE   accountant writes off ₹55 (in a LOCKED month) → stamped + reason; status, amount, net_payable,
--           paid_amount unchanged; a confirmed write-off row; the customer's other invoice untouched
--   DRAFT   owner writes off ₹1 that had an open R-116 draft → that draft is confirmed (no second row)
--   ONCE    the same invoice again → refused

begin;
select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2410000-0000-4000-8000-0000000000a1', 'r2410-owner@example.test'),
  ('e2410000-0000-4000-8000-0000000000a2', 'r2410-acct@example.test'),
  ('e2410000-0000-4000-8000-0000000000a3', 'r2410-billing@example.test'),
  ('e2410000-0000-4000-8000-0000000000b1', 'r2410-owner-b@example.test');

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('e2410000-0000-0000-0000-0000000000a0', 'R2410 A', 'r2410a@example.in', '07', 'R41A'),
  ('e2410000-0000-0000-0000-0000000000b0', 'R2410 B', 'r2410b@example.in', '07', 'R41B');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2410000-0000-4000-8000-0000000000a1', 'e2410000-0000-0000-0000-0000000000a0', 'r2410-owner@example.in',   'R2410 Owner',   'owner',      true),
  ('e2410000-0000-4000-8000-0000000000a2', 'e2410000-0000-0000-0000-0000000000a0', 'r2410-acct@example.in',    'R2410 Acct',    'accountant', true),
  ('e2410000-0000-4000-8000-0000000000a3', 'e2410000-0000-0000-0000-0000000000a0', 'r2410-billing@example.in', 'R2410 Billing', 'billing',    true),
  ('e2410000-0000-4000-8000-0000000000b1', 'e2410000-0000-0000-0000-0000000000b0', 'r2410-owner-b@example.in', 'R2410 Owner B', 'owner',      true);

insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2410000-0000-4000-8000-0000000000c1', 'e2410000-0000-0000-0000-0000000000a0', 'R2410 Dust Co', '07', 'India');

insert into public.invoices (id, tenant_id, customer_name, customer_id, amount, net_payable, paid_amount, taxable_value, invoice_date, due_date, status) values
  -- ₹55 left, September (locked below), 172 days-ish late
  ('R41-55',   'e2410000-0000-0000-0000-0000000000a0', 'R2410 Dust Co', 'e2410000-0000-4000-8000-0000000000c1', 11800, 11800, 11745, 10000, '2026-05-01', '2026-05-15', 'pending'),
  -- ₹1 left, with an open R-116 draft
  ('R41-1',    'e2410000-0000-0000-0000-0000000000a0', 'R2410 Dust Co', 'e2410000-0000-4000-8000-0000000000c1',  1180,  1180,  1179,  1000, '2026-05-01', '2026-05-30', 'overdue'),
  -- ₹501 left — over the limit
  ('R41-501',  'e2410000-0000-0000-0000-0000000000a0', 'R2410 Dust Co', 'e2410000-0000-4000-8000-0000000000c1',  5900,  5900,  5399,  5000, '2026-10-01', '2026-10-05', 'pending'),
  -- paid
  ('R41-PAID', 'e2410000-0000-0000-0000-0000000000a0', 'R2410 Dust Co', 'e2410000-0000-4000-8000-0000000000c1',  1180,  1180,  1180,  1000, '2026-10-01', '2026-10-05', 'paid');

insert into public.invoice_write_off_drafts (tenant_id, invoice_id, amount, days_overdue, reason, status) values
  ('e2410000-0000-0000-0000-0000000000a0', 'R41-1', 1, 181, 'suggested', 'draft');

update public.tenants set books_locked_until = '2026-09-30' where id = 'e2410000-0000-0000-0000-0000000000a0';

create temp table r2410_fail (msg text) on commit drop;
grant all on r2410_fail to authenticated;

create function pg_temp.r2410_try(p_inv text, p_reason text) returns text language plpgsql as $$
begin
  perform public.write_off_small_invoice_balance(p_inv, p_reason);
  return null;
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
create function pg_temp.r2410_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
end $$;
grant execute on function pg_temp.r2410_try(text, text) to authenticated;
grant execute on function pg_temp.r2410_as(text) to authenticated;

do $$
declare
  v_e text; v_r jsonb; v_i record; v_n int;
begin
  set local role authenticated;

  -- ════ GUARDS ══════════════════════════════════════════════════════════════════════
  perform pg_temp.r2410_as('e2410000-0000-4000-8000-0000000000a2');
  v_e := pg_temp.r2410_try('R41-55', ' ');
  if v_e is null or v_e not like '22023: Write why this balance is written off%' then
    insert into r2410_fail values ('no reason not refused: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r2410_try('R41-501', 'Round-off');
  if v_e is null or v_e not like '22023: Invoice R41-501 still has ₹501 due — only balances up to ₹500%' then
    insert into r2410_fail values ('₹501 not refused: ' || coalesce(v_e, 'ran'));
  end if;
  v_e := pg_temp.r2410_try('R41-PAID', 'Round-off');
  if v_e is null or v_e not like '22023: Invoice R41-PAID is paid%' then
    insert into r2410_fail values ('paid invoice not refused: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r2410_as('e2410000-0000-4000-8000-0000000000a3');
  v_e := pg_temp.r2410_try('R41-55', 'Round-off');
  if v_e is null or v_e not like '42501: Only the owner or the accountant%' then
    insert into r2410_fail values ('billing user wrote off: ' || coalesce(v_e, 'ran'));
  end if;
  perform pg_temp.r2410_as('e2410000-0000-4000-8000-0000000000b1');
  v_e := pg_temp.r2410_try('R41-55', 'Round-off');
  if v_e is null or v_e not like '42501: Invoice R41-55 was not found in your company%' then
    insert into r2410_fail values ('other company wrote off: ' || coalesce(v_e, 'ran'));
  end if;

  -- ════ WRITE ═══════════════════════════════════════════════════════════════════════
  perform pg_temp.r2410_as('e2410000-0000-4000-8000-0000000000a2');
  begin
    v_r := public.write_off_small_invoice_balance('R41-55', 'Bank charges deducted by customer');
    if v_r->>'invoice_id' <> 'R41-55' or (v_r->>'amount')::int <> 55 or v_r->>'record_id' is null then
      insert into r2410_fail values ('₹55 result wrong: ' || v_r::text);
    end if;
  exception when others then insert into r2410_fail values ('₹55 write-off raised: ' || sqlerrm);
  end;

  -- ════ DRAFT ═══════════════════════════════════════════════════════════════════════
  perform pg_temp.r2410_as('e2410000-0000-4000-8000-0000000000a1');
  begin
    v_r := public.write_off_small_invoice_balance('R41-1', 'Paid ₹1 short — round-off');
  exception when others then insert into r2410_fail values ('₹1 write-off raised: ' || sqlerrm);
  end;

  -- ════ ONCE ════════════════════════════════════════════════════════════════════════
  v_e := pg_temp.r2410_try('R41-55', 'Again');
  if v_e is null or v_e not like '22023: Invoice R41-55 was already written off%' then
    insert into r2410_fail values ('second write-off not refused: ' || coalesce(v_e, 'ran'));
  end if;

  set local role postgres;
  select status::text as status, written_off_at is not null as wo, write_off_reason, amount, net_payable, paid_amount
    into v_i from public.invoices where id = 'R41-55';
  if v_i.status <> 'pending' or not v_i.wo
     or v_i.write_off_reason <> 'Small balance ₹55 written off: Bank charges deducted by customer'
     or v_i.amount <> 11800 or v_i.net_payable <> 11800 or v_i.paid_amount <> 11745 then
    insert into r2410_fail values ('R41-55 wrong after write-off: ' || row_to_json(v_i)::text);
  end if;
  select count(*) into v_n from public.invoice_write_off_drafts
   where invoice_id = 'R41-55' and status = 'confirmed' and amount = 55
     and decided_by = 'e2410000-0000-4000-8000-0000000000a2';
  if v_n <> 1 then insert into r2410_fail values ('R41-55 confirmed record missing: ' || v_n); end if;
  select count(*) into v_n from public.invoice_write_off_drafts where invoice_id = 'R41-1';
  if v_n <> 1 then insert into r2410_fail values ('R41-1 should keep ONE record (the draft, confirmed): ' || v_n); end if;
  select count(*) into v_n from public.invoice_write_off_drafts where invoice_id = 'R41-1' and status = 'confirmed' and reason like 'Small balance ₹1 written off:%';
  if v_n <> 1 then insert into r2410_fail values ('R41-1 draft not confirmed'); end if;
  select count(*) into v_n from public.invoices where id in ('R41-501', 'R41-PAID') and written_off_at is not null;
  if v_n <> 0 then insert into r2410_fail values ('a refused invoice was stamped: ' || v_n); end if;

  select count(*) into v_n from r2410_fail;
  if v_n > 0 then
    raise exception 'FAIL r2410_write_off_small_balance: %', (select string_agg(msg, E'\n') from r2410_fail);
  end if;
  raise notice 'PASS r2410_write_off_small_balance';
end $$;

rollback;
