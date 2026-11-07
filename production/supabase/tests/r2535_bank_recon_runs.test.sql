\set ON_ERROR_STOP on
-- R-2535 (P1 money, G-RECON): "Reconcile from Zoho" books on the server under a run id with
-- "Undo this run". These checks cover the database half: which lines a run may book (screen), the
-- run's record of what it booked, and the undo.
-- Migration: 20261107043907_r2535_bank_recon_runs.sql
-- Self-asserting, ONE transaction, rolled back — safe anywhere:
--
--   docker exec -i supabase_db_resellerosv3 psql -U postgres -d postgres -v ON_ERROR_STOP=1 < supabase/tests/r2535_bank_recon_runs.test.sql
--
-- Expect "PASS r2535_bank_recon_runs".
--   SCREEN   own free line → ok; a line already matched → 'matched'; a line in a locked month →
--            'locked'; company B's line id, or a line of another account → 'not_found' (never
--            booked, nothing said about B).
--   RECORD   a booked line is recorded once (a second record — double run — adds nothing; a second
--            live run cannot take it); an
--            unmatched line is not recorded; company B's run id is refused.
--   UNDO     the run's new-sale line goes back to unmatched and its receipt is removed; a line
--            re-matched by hand since the run is left alone and listed; a second undo changes
--            nothing; company B cannot undo A's run; a billing user cannot run any of it.

begin;
select set_config('request.jwt.claims', '', true);

create temp table r2535_fail (msg text) on commit drop;
grant all on r2535_fail to authenticated;

insert into auth.users (id, email) values
  ('e2535000-0000-4000-8000-0000000000a2', 'r2535-owner@example.test'),
  ('e2535000-0000-4000-8000-0000000000a3', 'r2535-billing@example.test'),
  ('e2535000-0000-4000-8000-0000000000b2', 'r2535-b-owner@example.test');
insert into public.tenants (id, name, email, state_code, doc_code, books_locked_until) values
  ('e2535000-0000-0000-0000-0000000000a0', 'R2535 Co', 'r2535@example.in', '07', 'R253', '2026-09-30'),
  ('e2535000-0000-0000-0000-0000000000b0', 'R2535 Other Co', 'r2535b@example.in', '07', 'R25B', null);
insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2535000-0000-4000-8000-0000000000a2', 'e2535000-0000-0000-0000-0000000000a0', 'r2535-owner@example.in', 'R2535 Owner', 'owner', true),
  ('e2535000-0000-4000-8000-0000000000a3', 'e2535000-0000-0000-0000-0000000000a0', 'r2535-billing@example.in', 'R2535 Billing', 'billing', true),
  ('e2535000-0000-4000-8000-0000000000b2', 'e2535000-0000-0000-0000-0000000000b0', 'r2535-b-owner@example.in', 'R2535 B Owner', 'owner', true);
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('e2535000-0000-4000-8000-0000000000c1', 'e2535000-0000-0000-0000-0000000000a0', 'R2535 Buyer', '07', 'India');
insert into public.bank_accounts (id, tenant_id, name, bank_name) values
  ('e2535000-0000-4000-8000-0000000000ba', 'e2535000-0000-0000-0000-0000000000a0', 'R2535 Current', 'R2535 Bank'),
  ('e2535000-0000-4000-8000-0000000000bb', 'e2535000-0000-0000-0000-0000000000a0', 'R2535 Second', 'R2535 Bank'),
  ('e2535000-0000-4000-8000-0000000000b9', 'e2535000-0000-0000-0000-0000000000b0', 'R2535 B Current', 'R2535 Bank');

-- L1 free · L2 already matched (manual) · L3 in the locked month · L4 other account · LB company B
-- L5 / L6 the run's two lines (booked below as new sales from the bank).
insert into public.bank_transactions (id, tenant_id, bank_account_id, txn_date, description, credit, debit) values
  ('e2535000-0000-4000-8000-0000000000e1', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000ba', '2026-10-10', 'NEFT CR R2535 FREE', 1000, 0),
  ('e2535000-0000-4000-8000-0000000000e2', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000ba', '2026-10-11', 'NEFT CR R2535 MATCHED', 2000, 0),
  ('e2535000-0000-4000-8000-0000000000e3', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000ba', '2026-09-15', 'NEFT CR R2535 LOCKED', 3000, 0),
  ('e2535000-0000-4000-8000-0000000000e4', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000bb', '2026-10-12', 'NEFT CR R2535 OTHER ACCOUNT', 4000, 0),
  ('e2535000-0000-4000-8000-0000000000e5', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000ba', '2026-10-13', 'NEFT CR R2535 SALE ONE', 5000, 0),
  ('e2535000-0000-4000-8000-0000000000e6', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000ba', '2026-10-14', 'NEFT CR R2535 SALE TWO', 6000, 0),
  ('e2535000-0000-4000-8000-0000000000e9', 'e2535000-0000-0000-0000-0000000000b0', 'e2535000-0000-4000-8000-0000000000b9', '2026-10-10', 'NEFT CR R2535 B LINE', 100, 0);
update public.bank_transactions set matched_to_type = 'manual', matched_at = now(), match_confidence = 'manual'
 where id = 'e2535000-0000-4000-8000-0000000000e2';

-- The two sales the run "booked": quote + a receipt made from the bank line (notes as
-- reconcile_bank_credit_new_sale writes them), the line matched to it.
insert into public.quotes (id, tenant_id, lead_id, customer_id, customer_name, amount, subtotal, tax_rate, status, payment_status, line_items) values
  ('Q-R2535-5', 'e2535000-0000-0000-0000-0000000000a0', null, 'e2535000-0000-4000-8000-0000000000c1', 'R2535 Buyer', 5000, 4237, 18, 'accepted', 'received', '[]'::jsonb),
  ('Q-R2535-6', 'e2535000-0000-0000-0000-0000000000a0', null, 'e2535000-0000-4000-8000-0000000000c1', 'R2535 Buyer', 6000, 5085, 18, 'accepted', 'received', '[]'::jsonb);
insert into public.payments (id, tenant_id, customer_id, amount, method, reference, status, received_at, quote_id, notes) values
  ('e2535000-0000-4000-8000-0000000000f5', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000c1', 5000, 'bank_transfer', 'BANK-e2535000-0000-4000-8000-0000000000e5', 'received', '2026-10-13 10:00+05:30', 'Q-R2535-5', 'Reconciled from bank receipt'),
  ('e2535000-0000-4000-8000-0000000000f6', 'e2535000-0000-0000-0000-0000000000a0', 'e2535000-0000-4000-8000-0000000000c1', 6000, 'bank_transfer', 'BANK-e2535000-0000-4000-8000-0000000000e6', 'received', '2026-10-14 10:00+05:30', 'Q-R2535-6', 'Reconciled from bank receipt');
update public.bank_transactions set matched_to_type = 'payment', matched_to_id = 'e2535000-0000-4000-8000-0000000000f5', matched_at = now(), match_confidence = 'manual'
 where id = 'e2535000-0000-4000-8000-0000000000e5';
update public.bank_transactions set matched_to_type = 'payment', matched_to_id = 'e2535000-0000-4000-8000-0000000000f6', matched_at = now(), match_confidence = 'manual'
 where id = 'e2535000-0000-4000-8000-0000000000e6';

do $$
declare v_r record; v_run uuid; v_b_run uuid; v_ok boolean; v_n integer; v_res jsonb; v_code text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2535000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);

  -- ════ SCREEN ══════════════════════════════════════════════════════════════════════
  for v_r in
    select s.txn_id, s.ok, s.reason, s.credit
      from public.bank_recon_run_screen('e2535000-0000-4000-8000-0000000000ba', array[
        'e2535000-0000-4000-8000-0000000000e1', 'e2535000-0000-4000-8000-0000000000e2', 'e2535000-0000-4000-8000-0000000000e3',
        'e2535000-0000-4000-8000-0000000000e4', 'e2535000-0000-4000-8000-0000000000e9']::uuid[]) s
  loop
    if v_r.txn_id = 'e2535000-0000-4000-8000-0000000000e1' and not (v_r.ok and v_r.reason is null and v_r.credit = 1000) then
      insert into r2535_fail values ('screen: the free line is not ok (' || coalesce(v_r.reason, 'null') || ')');
    elsif v_r.txn_id = 'e2535000-0000-4000-8000-0000000000e2' and (v_r.ok or v_r.reason is distinct from 'matched') then
      insert into r2535_fail values ('screen: the matched line says ' || coalesce(v_r.reason, 'ok'));
    elsif v_r.txn_id = 'e2535000-0000-4000-8000-0000000000e3' and (v_r.ok or v_r.reason is distinct from 'locked') then
      insert into r2535_fail values ('screen: the locked-month line says ' || coalesce(v_r.reason, 'ok'));
    elsif v_r.txn_id = 'e2535000-0000-4000-8000-0000000000e4' and (v_r.ok or v_r.reason is distinct from 'not_found') then
      insert into r2535_fail values ('screen: the other account''s line says ' || coalesce(v_r.reason, 'ok'));
    elsif v_r.txn_id = 'e2535000-0000-4000-8000-0000000000e9' and (v_r.ok or v_r.reason is distinct from 'not_found' or v_r.credit is not null) then
      insert into r2535_fail values ('screen: company B''s line says ' || coalesce(v_r.reason, 'ok') || ' / credit ' || coalesce(v_r.credit::text, 'null'));
    end if;
  end loop;
  select count(*) into v_n from public.bank_recon_run_screen('e2535000-0000-4000-8000-0000000000ba', array['e2535000-0000-4000-8000-0000000000e1', 'e2535000-0000-4000-8000-0000000000e9']::uuid[]);
  if v_n <> 2 then insert into r2535_fail values ('screen returned ' || v_n || ' rows for 2 ids'); end if;

  -- ════ RECORD ══════════════════════════════════════════════════════════════════════
  v_run := public.bank_recon_run_start('e2535000-0000-4000-8000-0000000000ba');
  v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e5', 'new_sale');
  if not v_ok then insert into r2535_fail values ('record: the booked L5 was not recorded'); end if;
  v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e5', 'new_sale');   -- double run
  v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e6', 'new_sale');
  v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e1', 'new_sale');
  if v_ok then insert into r2535_fail values ('record: an unmatched line (L1) was recorded as booked'); end if;
  select count(*) into v_n from public.bank_recon_run_lines where run_id = v_run;
  if v_n <> 2 then insert into r2535_fail values ('record: run holds ' || v_n || ' lines (want 2: L5 once, L6)'); end if;
  v_code := null;
  begin
    v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e9', 'new_sale');
  exception when others then v_code := sqlstate; end;
  if v_code is null then insert into r2535_fail values ('record: company B''s line was accepted into A''s run'); end if;
  -- a second live run cannot take L5 (run 1 holds it): its Undo must never reverse run 1's booking.
  if public.bank_recon_run_record(public.bank_recon_run_start('e2535000-0000-4000-8000-0000000000ba'), 'e2535000-0000-4000-8000-0000000000e5', 'new_sale') then
    insert into r2535_fail values ('record: a second run took L5 although run 1 holds it');
  end if;

  -- L6 is re-matched by hand after the run (to something else): undo must leave it.
  set local role postgres;
  update public.bank_transactions set matched_to_type = 'manual', matched_to_id = null where id = 'e2535000-0000-4000-8000-0000000000e6';
  set local role authenticated;

  -- ════ company B and a billing user cannot touch A's run ═══════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2535000-0000-4000-8000-0000000000b2', 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    v_res := public.undo_bank_recon_run(v_run);
  exception when others then v_code := sqlstate; end;
  if v_code is null then insert into r2535_fail values ('company B undid company A''s run'); end if;
  v_code := null;
  begin
    v_ok := public.bank_recon_run_record(v_run, 'e2535000-0000-4000-8000-0000000000e9', 'new_sale');
  exception when others then v_code := sqlstate; end;
  if v_code is null then insert into r2535_fail values ('company B recorded into company A''s run'); end if;
  v_b_run := null;
  begin
    v_b_run := public.bank_recon_run_start('e2535000-0000-4000-8000-0000000000ba');
  exception when others then v_code := sqlstate; end;
  if v_b_run is not null then insert into r2535_fail values ('company B started a run on company A''s account'); end if;

  perform set_config('request.jwt.claims', json_build_object('sub', 'e2535000-0000-4000-8000-0000000000a3', 'role', 'authenticated')::text, true);
  v_code := null;
  begin
    perform public.bank_recon_run_screen('e2535000-0000-4000-8000-0000000000ba', array['e2535000-0000-4000-8000-0000000000e1']::uuid[]);
  exception when others then v_code := sqlstate; end;
  if v_code is distinct from '42501' then insert into r2535_fail values ('a billing user could screen a run (' || coalesce(v_code, 'no error') || ')'); end if;

  -- ════ UNDO ════════════════════════════════════════════════════════════════════════
  perform set_config('request.jwt.claims', json_build_object('sub', 'e2535000-0000-4000-8000-0000000000a2', 'role', 'authenticated')::text, true);
  v_res := public.undo_bank_recon_run(v_run);
  if (v_res->>'undone')::int is distinct from 1 then insert into r2535_fail values ('undo: undone = ' || coalesce(v_res->>'undone', 'null') || ' (want 1)'); end if;
  if jsonb_array_length(coalesce(v_res->'left', '[]'::jsonb)) <> 1 then insert into r2535_fail values ('undo: left = ' || coalesce(v_res->>'left', 'null') || ' (want L6 only)'); end if;
  v_res := public.undo_bank_recon_run(v_run);
  if (v_res->>'undone')::int is distinct from 0 then insert into r2535_fail values ('undo twice: undone = ' || coalesce(v_res->>'undone', 'null') || ' (want 0)'); end if;

  set local role postgres;
  if exists (select 1 from public.bank_transactions where id = 'e2535000-0000-4000-8000-0000000000e5' and matched_to_type is not null) then
    insert into r2535_fail values ('undo: L5 is still matched');
  end if;
  if exists (select 1 from public.payments where id = 'e2535000-0000-4000-8000-0000000000f5') then
    insert into r2535_fail values ('undo: L5''s receipt is still there');
  end if;
  if not exists (select 1 from public.payments where id = 'e2535000-0000-4000-8000-0000000000f6') then
    insert into r2535_fail values ('undo: L6''s receipt was removed although L6 was re-matched by hand');
  end if;
  if not exists (select 1 from public.bank_transactions where id = 'e2535000-0000-4000-8000-0000000000e6' and matched_to_type = 'manual') then
    insert into r2535_fail values ('undo: L6 (re-matched by hand) was changed');
  end if;
end $$;

do $$
declare v_msgs text;
begin
  select string_agg(msg, E'\n  - ') into v_msgs from r2535_fail;
  if v_msgs is not null then
    raise exception E'FAIL r2535_bank_recon_runs:\n  - %', v_msgs;
  end if;
  raise notice 'PASS r2535_bank_recon_runs';
end $$;

rollback;
