-- R-2823 (Renewals 12-question audit, 14 Nov 2026): the vendor's own renewal date —
-- subscriptions.vendor_term_end, saved by "Correct details" (correct_subscription_with_vendor_term) in the same one transaction.
-- Migration 20261114224316_r2823_vendor_term_end (column + correct_subscription_with_vendor_term).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
-- Without the migration it FAILs at A (no such column / function).
--
-- Proves:
--   A. owner saves Correct details with a Google renewal date → vendor_term_end set, the R-2545
--      record fields saved with it.
--   B. a blank date clears it (like the dialog's other dates).
--   C. a refused R-2545 step (renewal too early for the term) → vendor_term_end NOT saved either.
--   D. another company's subscription → refused, its vendor_term_end unchanged.
--   E. a billing user (who may run Correct details' plain save) can set it too.
--   F. a plain correct_subscription_details save (vendor date unchanged) leaves vendor_term_end as it was.

begin;

select set_config('request.jwt.claims', '', true);

insert into auth.users (id, email) values
  ('e2823000-0000-4000-8000-00000000000a', 'r2823-owner@example.test'),
  ('e2823000-0000-4000-8000-00000000000b', 'r2823-billing@example.test'),
  ('e2823000-0000-4000-8000-00000000000c', 'r2823-other@example.test');

insert into public.tenants (id, name, email, state_code, state, doc_code) values
  ('e2823000-0000-0000-0000-0000000000a1', 'R2823 Co', 'r2823@example.in', '07', 'Delhi', 'R2823'),
  ('e2823000-0000-0000-0000-0000000000a2', 'R2823 Other', 'r2823o@example.in', '07', 'Delhi', 'R2824');

insert into public.users (id, tenant_id, email, full_name, role, is_active) values
  ('e2823000-0000-4000-8000-00000000000a', 'e2823000-0000-0000-0000-0000000000a1', 'r2823-owner@example.in',   'R2823 Owner',   'owner',   true),
  ('e2823000-0000-4000-8000-00000000000b', 'e2823000-0000-0000-0000-0000000000a1', 'r2823-billing@example.in', 'R2823 Billing', 'billing', true),
  ('e2823000-0000-4000-8000-00000000000c', 'e2823000-0000-0000-0000-0000000000a2', 'r2823-other@example.in',   'R2823 Other',   'owner',   true);

insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr, domain,
                                  start_date, renewal_date, status, billing_cycle, term_months)
values
  ('e2823000-0000-4000-8000-0000000000c1', 'e2823000-0000-0000-0000-0000000000a1', 'R2823 Google Co',
   'Google Workspace Business Starter', 'google', 10, 1500, 'r2823-test.in',
   '2026-03-29', '2027-03-29', 'active', 'yearly', 12),
  ('e2823000-0000-4000-8000-0000000000c2', 'e2823000-0000-0000-0000-0000000000a1', 'R2823 Split Co',
   'Google Workspace Business Starter', 'google', 10, 1500, 'r2823-split.in',
   '2026-03-29', '2027-03-29', 'active', 'quarterly', 12);

create temp table r2823_out (step text, state text, msg text) on commit drop;
grant all on r2823_out to authenticated;

-- ── as the owner ─────────────────────────────────────────────────────────────────
set local role authenticated;
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2823000-0000-4000-8000-00000000000a')::text, true);

-- A. Google renews on 12 Jan 2027 (differs from our 29 Mar 2027).
select public.correct_subscription_with_vendor_term(
  p_subscription_id => 'e2823000-0000-4000-8000-0000000000c1', p_reason => '',
  p_vendor => 'google', p_domain => 'r2823-fixed.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-29', p_payment_due_date => null, p_vendor_term_end => '2027-01-12');

do $$
declare s record;
begin
  select * into s from public.subscriptions where id = 'e2823000-0000-4000-8000-0000000000c1';
  if s.vendor_term_end is distinct from '2027-01-12'::date then
    raise exception 'A: vendor_term_end is % (want 2027-01-12)', s.vendor_term_end;
  end if;
  if s.domain <> 'r2823-fixed.in' then
    raise exception 'A: the R-2545 record fields were not saved with it (domain %)', s.domain;
  end if;
end $$;

-- B. blank clears.
select public.correct_subscription_with_vendor_term(
  p_subscription_id => 'e2823000-0000-4000-8000-0000000000c1', p_reason => '',
  p_vendor => 'google', p_domain => 'r2823-fixed.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-29', p_payment_due_date => null, p_vendor_term_end => null);

do $$
begin
  if (select vendor_term_end from public.subscriptions where id = 'e2823000-0000-4000-8000-0000000000c1') is not null then
    raise exception 'B: a blank vendor renewal date did not clear it';
  end if;
end $$;

-- C. a refused step (quarterly row, renewal far too early for its 12-month term — R-2533) saves nothing.
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_with_vendor_term(
      p_subscription_id => 'e2823000-0000-4000-8000-0000000000c2', p_reason => 'test',
      p_vendor => 'google', p_domain => 'r2823-split.in', p_start_date => '2026-03-29',
      p_renewal_date => '2026-06-29', p_payment_due_date => null, p_vendor_term_end => '2027-02-01');
    insert into r2823_out values ('C', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2823_out values ('C', v_state, v_msg);
  end;
end $$;

-- D. another company's owner.
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2823000-0000-4000-8000-00000000000c')::text, true);
do $$
declare v_state text; v_msg text;
begin
  begin
    perform public.correct_subscription_with_vendor_term(
      p_subscription_id => 'e2823000-0000-4000-8000-0000000000c2', p_reason => 'not mine',
      p_vendor => 'google', p_domain => 'r2823-split.in', p_start_date => '2026-03-29',
      p_renewal_date => '2027-03-29', p_payment_due_date => null, p_vendor_term_end => '2030-01-01');
    insert into r2823_out values ('D', null, 'accepted');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    insert into r2823_out values ('D', v_state, v_msg);
  end;
end $$;

-- E. billing user sets it on the split row.
select set_config('request.jwt.claims',
  json_build_object('role', 'authenticated', 'sub', 'e2823000-0000-4000-8000-00000000000b')::text, true);
select public.correct_subscription_with_vendor_term(
  p_subscription_id => 'e2823000-0000-4000-8000-0000000000c2', p_reason => '',
  p_vendor => 'google', p_domain => 'r2823-split.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-29', p_payment_due_date => null, p_vendor_term_end => '2027-03-01');

-- F. a save that does not change the vendor date → correct_subscription_details (R-2545); vendor_term_end kept.
select public.correct_subscription_details(
  p_subscription_id => 'e2823000-0000-4000-8000-0000000000c2', p_reason => '',
  p_vendor => 'google', p_domain => 'r2823-split2.in', p_start_date => '2026-03-29',
  p_renewal_date => '2027-03-29', p_payment_due_date => null);

reset role;
select set_config('request.jwt.claims', '', true);

do $$
declare r record; s record;
begin
  select * into r from r2823_out where step = 'C';
  if r.state is null then
    raise exception 'C: a renewal of 29 Jun 2026 on a 12-month quarterly term was accepted';
  end if;
  select * into r from r2823_out where step = 'D';
  if r.state is null then
    raise exception 'D: another company''s owner set this subscription''s vendor renewal date';
  end if;
  select * into s from public.subscriptions where id = 'e2823000-0000-4000-8000-0000000000c2';
  if s.vendor_term_end is distinct from '2027-03-01'::date then
    raise exception 'C/D/E/F: split row vendor_term_end is % (want 2027-03-01: C and D refused, E set it, F kept it)', s.vendor_term_end;
  end if;
  if s.domain <> 'r2823-split2.in' then
    raise exception 'F: the old-style call did not save (domain %)', s.domain;
  end if;
  raise notice 'PASS R-2823: vendor_term_end saved with Correct details in one transaction; blank clears; refused step saves nothing; other company refused; plain save keeps it';
end $$;

rollback;
