-- Regression test: cancel_subscription (R-455). Migration 20261009151000_cancel_subscription.sql.
-- Rolled back — safe anywhere.
--
--   ALLOWED  owner cancels: status cancelled, auto_renew off, renewal_date = last day,
--            due cleared when asked, reason on the history row
--   KEPT     due stays when clear_due is false (a customer who still owes, still owes)
--   BLOCKED  a sales login (refund-level action)
--   BLOCKED  another tenant's subscription
--   BLOCKED  a reason under 5 characters, a last day before the start, a second cancel
--
-- Fixture owns its data (L11). Ids are literals carried in the JWT (L14).

begin;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

insert into public.tenants (id, name, email, state_code, doc_code) values
  ('45500000-0000-4000-8000-000000000001', 'R455 TEST A', 'r455a@example.in', '07', 'R55A'),
  ('45500000-0000-4000-8000-000000000002', 'R455 TEST B', 'r455b@example.in', '07', 'R55B');

insert into auth.users (id, instance_id, aud, role, email) values
  ('45500000-0000-4000-8000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r455-owner@example.in'),
  ('45500000-0000-4000-8000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'r455-sales@example.in');

insert into public.users (id, tenant_id, email, role, is_active) values
  ('45500000-0000-4000-8000-00000000000a', '45500000-0000-4000-8000-000000000001', 'r455-owner@example.in', 'owner', true),
  ('45500000-0000-4000-8000-00000000000b', '45500000-0000-4000-8000-000000000001', 'r455-sales@example.in', 'sales', true);

insert into public.subscriptions (id, tenant_id, customer_name, plan, vendor, seats, mrr, start_date, renewal_date, status, outstanding_amount, auto_renew) values
  ('45500000-0000-4000-8000-0000000000f1', '45500000-0000-4000-8000-000000000001', 'Verma Clinic', 'Business Starter', 'google', 3, 810, '2026-10-08', '2026-11-08', 'active', 956, true),
  ('45500000-0000-4000-8000-0000000000f2', '45500000-0000-4000-8000-000000000001', 'Owes Still', 'Business Starter', 'google', 3, 810, '2026-10-08', '2026-11-08', 'active', 956, true),
  ('45500000-0000-4000-8000-0000000000f3', '45500000-0000-4000-8000-000000000002', 'Other Tenant', 'Business Starter', 'google', 3, 810, '2026-10-08', '2026-11-08', 'active', 0, true);

-- ── as the SALES login ──────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"45500000-0000-4000-8000-00000000000b"}', true);
set local role authenticated;
do $$
declare v_err text;
begin
  begin
    perform public.cancel_subscription('45500000-0000-4000-8000-0000000000f1', '2026-10-09', 'Customer left', true);
  exception when insufficient_privilege then v_err := sqlerrm; end;
  if v_err is null or v_err not like 'Only an owner%' then
    raise exception 'FAIL 1: a sales login cancelled a subscription (%).', coalesce(v_err, 'no error');
  end if;
end $$;
reset role;

-- ── as the OWNER ────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"45500000-0000-4000-8000-00000000000a"}', true);
set local role authenticated;
do $$
declare v_err text; v_out jsonb;
begin
  -- BLOCKED: short reason
  v_err := null;
  begin perform public.cancel_subscription('45500000-0000-4000-8000-0000000000f1', '2026-10-09', 'no', true);
  exception when invalid_parameter_value then v_err := sqlerrm; end;
  if v_err is null then raise exception 'FAIL 2: a 2-character reason was accepted'; end if;

  -- BLOCKED: last day before the start
  v_err := null;
  begin perform public.cancel_subscription('45500000-0000-4000-8000-0000000000f1', '2026-10-01', 'Customer left', true);
  exception when invalid_parameter_value then v_err := sqlerrm; end;
  if v_err is null then raise exception 'FAIL 3: a last day before the start was accepted'; end if;

  -- BLOCKED: another tenant
  v_err := null;
  begin perform public.cancel_subscription('45500000-0000-4000-8000-0000000000f3', '2026-10-09', 'Customer left', true);
  exception when insufficient_privilege then v_err := sqlerrm; end;
  if v_err is null then raise exception 'FAIL 4: another tenant''s subscription was cancelled'; end if;

  -- ALLOWED: refund + leaving → clear the due
  v_out := public.cancel_subscription('45500000-0000-4000-8000-0000000000f1', '2026-10-09', 'Refunded, customer left', true);
  if (v_out->>'due_cleared')::int <> 956 then raise exception 'FAIL 5: due_cleared %, expected 956', v_out->>'due_cleared'; end if;

  -- KEPT: clear_due false leaves what is owed
  v_out := public.cancel_subscription('45500000-0000-4000-8000-0000000000f2', null, 'Stopped service, still owes', false);
  if (v_out->>'due_cleared')::int <> 0 then raise exception 'FAIL 6: due cleared without being asked'; end if;

  -- BLOCKED: second cancel
  v_err := null;
  begin perform public.cancel_subscription('45500000-0000-4000-8000-0000000000f1', '2026-10-09', 'Again please', true);
  exception when invalid_parameter_value then v_err := sqlerrm; end;
  if v_err is null then raise exception 'FAIL 7: a cancelled subscription was cancelled again'; end if;
end $$;
reset role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare s record; a record;
begin
  select * into s from public.subscriptions where id = '45500000-0000-4000-8000-0000000000f1';
  if s.status <> 'cancelled' then raise exception 'FAIL 8: status is %', s.status; end if;
  if s.auto_renew then raise exception 'FAIL 9: auto_renew still on'; end if;
  if s.outstanding_amount <> 0 then raise exception 'FAIL 10: still ₹% due after clear', s.outstanding_amount; end if;
  if s.renewal_date <> date '2026-10-09' then raise exception 'FAIL 11: renewal_date %, expected the last day 2026-10-09', s.renewal_date; end if;
  if s.written_off_at is not null then raise exception 'FAIL 12: marked written off (that means uncollectable)'; end if;
  if s.cancel_reason <> 'Refunded, customer left' or s.cancel_due_cleared <> 956 or s.cancelled_at is null then
    raise exception 'FAIL 13: cancel record is % / % / %', s.cancel_reason, s.cancel_due_cleared, s.cancelled_at;
  end if;

  select * into a from public.contract_amendments where subscription_id = s.id order by created_at desc limit 1;
  if a.kind is null or a.kind not like '%status_changed%' then
    raise exception 'FAIL 16: the contract history did not record the cancel (kind %)', coalesce(a.kind, 'none');
  end if;

  select * into s from public.subscriptions where id = '45500000-0000-4000-8000-0000000000f2';
  if s.status <> 'cancelled' or s.outstanding_amount <> 956 then
    raise exception 'FAIL 14: status % due %, expected cancelled with ₹956 still due', s.status, s.outstanding_amount;
  end if;

  select * into s from public.subscriptions where id = '45500000-0000-4000-8000-0000000000f3';
  if s.status <> 'active' then raise exception 'FAIL 15: other tenant''s subscription changed'; end if;

  raise notice 'cancel_subscription: all 15 checks passed';
end $$;

rollback;
