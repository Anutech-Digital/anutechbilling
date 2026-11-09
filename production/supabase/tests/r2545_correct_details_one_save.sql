-- R-2545 (found 7 Nov 2026 on localhost, R-2543 check): "Correct details" saved in steps — on
-- R800 Check Co (yearly → quarterly + renewal 29 Mar 2027 in one save) the R-2533 trigger refused
-- the renewal date, but the payment frequency had already been saved.
-- Migration 20261109034726_r2545_correct_details_one_save (correct_subscription_details).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- Without the migration it FAILs at A (no such function).
--
-- Proves:
--   A. the owner's case: yearly → quarterly with a renewal date too early for the 12-month term
--      → refused with the R-2533 message; billing_cycle, renewal and the amendment rows unchanged.
--   B. owner data fix (seats/MRR) + plan change + a refused date in the same save → seats, MRR,
--      plan and the data-correction activity_log row all rolled back.
--   C. a valid save (quarterly + renewal on the term's last day + domain + plan) → every field saved.
--   D. another company's subscription → refused, nothing changed.
--   E. a billing user's plain save (no data fix / plan / commitment) still works (no owner-only
--      step is run when its inputs are empty).

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2545000-0000-4000-8000-00000000000a', 'r2545-owner@example.test'),
  ('e2545000-0000-4000-8000-00000000000b', 'r2545-billing@example.test'),
  ('e2545000-0000-4000-8000-00000000000c', 'r2545-other@example.test');

insert into public.tenants (id, name, email, state_code, state, doc_code) values
  ('e2545000-0000-0000-0000-0000000000a1', 'R2545 Co', 'r2545@example.in', '07', 'Delhi', 'R2545'),
  ('e2545000-0000-0000-0000-0000000000a2', 'R2545 Other', 'r2545o@example.in', '07', 'Delhi', 'R2546');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2545000-0000-4000-8000-00000000000a', 'e2545000-0000-0000-0000-0000000000a1', 'r2545-owner@example.in',   'R2545 Owner',   'owner',   true),
  ('e2545000-0000-4000-8000-00000000000b', 'e2545000-0000-0000-0000-0000000000a1', 'r2545-billing@example.in', 'R2545 Billing', 'billing', true),
  ('e2545000-0000-4000-8000-00000000000c', 'e2545000-0000-0000-0000-0000000000a2', 'r2545-other@example.in',   'R2545 Other',   'owner',   true);

insert into public.items (id, tenant_id, name, vendor, msrp, wholesale, prices) values
  ('R2545-STARTER', 'e2545000-0000-0000-0000-0000000000a1', 'R2545 Workspace Starter',  'google', 150, 120,
   '{"annual":{"msrp":150,"wholesale":120}}'::jsonb),
  ('R2545-STD',     'e2545000-0000-0000-0000-0000000000a1', 'R2545 Workspace Standard', 'google', 300, 264,
   '{"annual":{"msrp":300,"wholesale":264}}'::jsonb);

-- s1: the R800 shape — yearly, 12-month term, starts 29 Mar 2026, renews 29 Mar 2027.
-- s2: quarterly, 12-month term, same dates (split-billed: the R-2533 guard applies to its renewal).
insert into public.subscriptions (id, tenant_id, customer_name, plan, item_id, vendor, seats, mrr, domain,
                                  start_date, renewal_date, status, billing_cycle, term_months, vendor_cost_per_seat_month)
values
  ('e2545000-0000-4000-8000-0000000000c1', 'e2545000-0000-0000-0000-0000000000a1', 'R2545 R800 Check',
   'R2545 Workspace Starter', 'R2545-STARTER', 'google', 10, 1500, 'r800-test.in',
   '2026-03-29', '2027-03-29', 'active', 'yearly', 12, 120),
  ('e2545000-0000-4000-8000-0000000000c2', 'e2545000-0000-0000-0000-0000000000a1', 'R2545 Split',
   'R2545 Workspace Starter', 'R2545-STARTER', 'google', 10, 1500, 'split-test.in',
   '2026-03-29', '2027-03-29', 'active', 'quarterly', 12, 120);

create temp table r2545_out (step text, state text, msg text) on commit drop;
grant all on r2545_out to authenticated;
create temp table r2545_before (k text primary key, n bigint) on commit drop;
grant all on r2545_before to authenticated;
insert into r2545_before values
  ('amend_c1', (select count(*) from public.contract_amendments where subscription_id = 'e2545000-0000-4000-8000-0000000000c1')),
  ('amend_c2', (select count(*) from public.contract_amendments where subscription_id = 'e2545000-0000-4000-8000-0000000000c2')),
  ('log_c2',   (select count(*) from public.activity_log where entity_id = 'e2545000-0000-4000-8000-0000000000c2'));

-- ── as the owner ─────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2545000-0000-4000-8000-00000000000a')::text, true);

do $$
declare v_state text; v_msg text;
begin
  -- A. yearly → quarterly, renewal 31 Dec 2026 (the 12-month term from 29 Mar 2026 needs ≥ 28 Mar 2027).
  begin
    perform public.correct_subscription_details(
      p_subscription_id => 'e2545000-0000-4000-8000-0000000000c1', p_reason => 'Customer pays quarterly',
      p_vendor => 'google', p_domain => 'r800-test.in', p_start_date => '2026-03-29',
      p_renewal_date => '2026-12-31', p_payment_due_date => null,
      p_term_months => 12, p_billing_cycle => 'quarterly', p_commitment_renewal => '2026-12-31');
    insert into r2545_out values ('A', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2545_out values ('A', v_state, v_msg);
  end;

  -- B. data fix 10 → 12 seats + plan Starter → Standard + a too-early renewal on the split row.
  begin
    perform public.correct_subscription_details(
      p_subscription_id => 'e2545000-0000-4000-8000-0000000000c2', p_reason => 'Record had the wrong seat count',
      p_vendor => 'google', p_domain => 'split-test.in', p_start_date => '2026-03-29',
      p_renewal_date => '2026-06-29', p_payment_due_date => null,
      p_data_seats => 12, p_data_mrr => 1800,
      p_item_id => 'R2545-STD', p_seats => 12, p_mrr => 1800);
    insert into r2545_out values ('B', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2545_out values ('B', v_state, v_msg);
  end;
end $$;

do $$
declare r record;
begin
  select * into r from r2545_out where step = 'A';
  if r.state is null then
    raise exception 'A: yearly → quarterly with renewal 31 Dec 2026 was accepted (R-2533 should refuse it)';
  end if;
  if r.state <> '22023' or r.msg not like '%too early%' then
    raise exception 'A: refused with the wrong error: % %', r.state, r.msg;
  end if;
  select * into r from r2545_out where step = 'B';
  if r.state is null then
    raise exception 'B: a renewal of 29 Jun 2026 on a 12-month quarterly term was accepted';
  end if;
end $$;

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare s record;
begin
  select * into s from public.subscriptions where id = 'e2545000-0000-4000-8000-0000000000c1';
  if s.billing_cycle::text <> 'yearly' then
    raise exception 'A: FAIL (R-2545) — the date was refused but the payment frequency was saved: %', s.billing_cycle;
  end if;
  if s.renewal_date <> '2027-03-29' then
    raise exception 'A: renewal changed to % although the save was refused', s.renewal_date;
  end if;
  if (select count(*) from public.contract_amendments where subscription_id = s.id)
     <> (select n from r2545_before where k = 'amend_c1') then
    raise exception 'A: an amendment row was written for a refused save';
  end if;

  select * into s from public.subscriptions where id = 'e2545000-0000-4000-8000-0000000000c2';
  if s.seats <> 10 or s.mrr <> 1500 then
    raise exception 'B: FAIL (R-2545) — data fix saved (% seats, MRR %) although the save was refused', s.seats, s.mrr;
  end if;
  if s.item_id <> 'R2545-STARTER' or s.plan <> 'R2545 Workspace Starter' then
    raise exception 'B: FAIL (R-2545) — plan changed to % although the save was refused', s.plan;
  end if;
  if (select count(*) from public.activity_log where entity_id = s.id::text)
     <> (select n from r2545_before where k = 'log_c2') then
    raise exception 'B: the data-correction activity_log row stayed although the save was refused';
  end if;
  if (select count(*) from public.contract_amendments where subscription_id = s.id)
     <> (select n from r2545_before where k = 'amend_c2') then
    raise exception 'B: an amendment row was written for a refused save';
  end if;
end $$;

-- ── C. a valid save, D. another company, as the owner / other owner ─────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2545000-0000-4000-8000-00000000000a')::text, true);
select public.correct_subscription_details(
  p_subscription_id => 'e2545000-0000-4000-8000-0000000000c1', p_reason => 'Customer pays quarterly',
  p_vendor => 'google', p_domain => 'r800-fixed.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-28', p_payment_due_date => '2026-12-15',
  p_item_id => 'R2545-STD', p_seats => 10, p_mrr => 1500,
  p_term_months => 12, p_billing_cycle => 'quarterly', p_commitment_renewal => '2027-03-28');

select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2545000-0000-4000-8000-00000000000c')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_details(
      p_subscription_id => 'e2545000-0000-4000-8000-0000000000c2', p_reason => 'not mine',
      p_vendor => 'microsoft', p_domain => 'stolen.in', p_start_date => '2026-03-29',
      p_renewal_date => '2027-03-29', p_payment_due_date => null);
    insert into r2545_out values ('D', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2545_out values ('D', v_state, v_msg);
  end;
end $$;

-- E. billing user, plain fields only.
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2545000-0000-4000-8000-00000000000b')::text, true);
select public.correct_subscription_details(
  p_subscription_id => 'e2545000-0000-4000-8000-0000000000c2', p_reason => '',
  p_vendor => 'google', p_domain => 'split-fixed.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-29', p_payment_due_date => '2026-05-01');

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare s record;
begin
  select * into s from public.subscriptions where id = 'e2545000-0000-4000-8000-0000000000c1';
  if s.billing_cycle::text <> 'quarterly' or s.renewal_date <> '2027-03-28' or s.domain <> 'r800-fixed.in'
     or s.item_id <> 'R2545-STD' or s.payment_due_date <> '2026-12-15' then
    raise exception 'C: valid save not fully applied: cycle % renewal % domain % item % due %',
      s.billing_cycle, s.renewal_date, s.domain, s.item_id, s.payment_due_date;
  end if;
  if (select state from r2545_out where step = 'D') is null then
    raise exception 'D: another company''s owner corrected this subscription';
  end if;
  select * into s from public.subscriptions where id = 'e2545000-0000-4000-8000-0000000000c2';
  if s.vendor::text <> 'google' or s.domain <> 'split-fixed.in' or s.payment_due_date <> '2026-05-01' then
    raise exception 'D/E: split row is vendor % domain % due % (want google / split-fixed.in / 1 May 2026)',
      s.vendor, s.domain, s.payment_due_date;
  end if;
  raise notice 'PASS R-2545: a refused step saves nothing (cycle, seats, plan, logs); a valid save lands whole; other company refused; plain save still works';
end $$;

rollback;
