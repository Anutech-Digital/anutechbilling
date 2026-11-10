-- R-2527 (independent review rv-r2519d of R-2519c/d, 6 Nov 2026). Migration 20261106120956_r2527_review_followups.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   L.  undo_cancel_quote locks the subscription's billing rows FOR UPDATE (the lock
--       bill_subscription_instalment takes) BEFORE its "a new proforma exists" check — else the billing
--       job billing the freed Oct while Undo cancel runs leaves two open proformas for Oct.
--   T.  cancel_quote / bill_subscription_instalment / undo_cancel_quote trust only the LOGIN, never a JWT
--       role claim (R-2519c's rule): a direct client login claiming service_role with no sub is refused;
--       the real service role (PostgREST's `set role service_role`) still bills.
--   X.  A second company cannot see the first company's freed part in freed_parts_due, nor bill it.
--   C.  A freed Oct billed again uses the subscription's CURRENT seats (18 after Manage seats), not the
--       cancelled proforma's 17.
--   D.  Deleting an OPEN proforma (not only a cancelled one) is refused for a signed-in user.
--   S3. Cancelling Oct while Nov already has a proforma is refused with the exact message.

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
  ('dddddddd-0000-0000-0000-000000252701','R2527 Co','r2527@example.in','07','RS71'),
  ('dddddddd-0000-0000-0000-000000252702','R2527 Other Co','r2527b@example.in','07','RS72');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000252701','owner2527@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000252702','owner2527b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000252701','dddddddd-0000-0000-0000-000000252701','owner2527@example.in','Owner 2527','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000252702','dddddddd-0000-0000-0000-000000252702','owner2527b@example.in','Owner 2527b','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, country) values
  ('cccccccc-0000-0000-0000-000000252701','dddddddd-0000-0000-0000-000000252701','Bit 2527','27','India');

-- 1: Oct (earlier, A) and Nov (laid, B) — the BITDECENTRO shape. 2: one current part (D, T).
insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr,
                                  billing_cycle, term_months, start_date, renewal_date, status, domain)
select ('eeeeeeee-0000-0000-0000-00000025270' || n)::uuid, 'dddddddd-0000-0000-0000-000000252701', 'cccccccc-0000-0000-0000-000000252701',
       'Bit 2527', 'Google Workspace Business Starter', 'google'::vendor, 17, 5100, 'monthly'::billing_cycle, 1,
       public.ist_today() - 65, public.ist_today() + 25, 'active', 'r2527-' || n || '.in'
  from generate_series(1, 2) n;
insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on,
                                          period_start, period_end, taxable_amount, tax_rate) values
  ('bbbbbbbb-0000-0000-0000-00000025270a', 'dddddddd-0000-0000-0000-000000252701', 'eeeeeeee-0000-0000-0000-000000252701',
   public.ist_today() - 35, 1, public.ist_today() - 35, public.ist_today() - 35, public.ist_today() - 5, 5100, 18),
  ('bbbbbbbb-0000-0000-0000-00000025270b', 'dddddddd-0000-0000-0000-000000252701', 'eeeeeeee-0000-0000-0000-000000252701',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18),
  ('bbbbbbbb-0000-0000-0000-00000025270c', 'dddddddd-0000-0000-0000-000000252701', 'eeeeeeee-0000-0000-0000-000000252702',
   public.ist_today() - 5, 1, public.ist_today() - 5, public.ist_today() - 5, public.ist_today() + 25, 5100, 18);

create temp table r2527_ids(k text primary key, id text) on commit drop;
grant select on r2527_ids to authenticated, service_role;

-- L: the lock comes before the "new proforma" check (a race cannot be run in one session — the body is read).
do $$
declare v_src text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('public.undo_cancel_quote(text)');
  if v_src !~* 'from public\.subscription_billings[^;]*subscription_id[^;]*for update[^;]*;[\s\S]*A new proforma \(%\)' then
    raise exception 'L FAIL: undo_cancel_quote does not lock the subscription''s billing rows FOR UPDATE before the new-proforma check';
  end if;
  if v_src !~* 'from public\.subscription_billings[^;]*subscription_id[^;]*for update[^;]*;[\s\S]*Proforma % now bills this sale' then
    raise exception 'L FAIL: undo_cancel_quote (sale quote) does not lock the billing rows FOR UPDATE before its check';
  end if;
  raise notice 'L PASS: billing rows locked before both new-proforma checks';
end $$;

-- S3 + C (server path: psql login, no claim)
do $$
declare r jsonb; v_oct text; v_nov text; v_msg text; v_line jsonb;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270a', false);
  v_oct := r->>'quote_id';
  perform public.cancel_quote(v_oct, 'Seats 18 karni hain');
  insert into r2527_ids values ('oct_cancelled', v_oct);
  -- Manage seats → 18; the unbilled Oct row is re-synced to the new amount (syncSubscriptionInstalments)
  update public.subscriptions set seats = 18, mrr = 5400 where id = 'eeeeeeee-0000-0000-0000-000000252701';
  update public.subscription_billings set taxable_amount = 5400
   where subscription_id = 'eeeeeeee-0000-0000-0000-000000252701' and invoice_id is null;
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270a', false);
  if r->>'action' <> 'request' then raise exception 'C FAIL: freed Oct not billed again: %', r; end if;
  select q.line_items->0 into v_line from public.quotes q where q.id = r->>'quote_id';
  if (select q.seats from public.quotes q where q.id = r->>'quote_id') <> 18
     or (v_line->>'qty')::int <> 18 or (v_line->>'rate')::int <> 300 then
    raise exception 'C FAIL: re-billed Oct is not 18 seats × ₹300: seats %, line %',
      (select q.seats from public.quotes q where q.id = r->>'quote_id'), v_line; end if;
  raise notice 'C PASS: re-billed freed Oct = 18 seats × ₹300 (%)', r->>'quote_id';
  v_oct := r->>'quote_id';
  insert into r2527_ids values ('oct_open', v_oct);
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270b', false);
  v_nov := r->>'quote_id';
  begin
    perform public.cancel_quote(v_oct, 'Oct again, Nov requested');
    raise exception 'S3 FAIL: freed Oct while Nov has a proforma';
  exception when invalid_parameter_value then
    get stacked diagnostics v_msg = message_text;
    if v_msg is distinct from format('A later period of this subscription is already billed (%s) — cancel the later proforma(s) first; a paid or invoiced later period needs a credit note, not a cancel here.', v_nov) then
      raise exception 'S3 FAIL: message %', v_msg; end if;
    raise notice 'S3 PASS: %', v_msg;
  end;
  -- cancel Nov then Oct, so X has a freed part to look for
  perform public.cancel_quote(v_nov, 'Nov first for the X case');
  perform public.cancel_quote(v_oct, 'Oct freed for the X case');
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270c', false);
  insert into r2527_ids values ('open', r->>'quote_id');
end $$;

-- X: the second company's owner
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252702","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if exists (select 1 from public.freed_parts_due(public.ist_today()) f
              where f.tenant_id = 'dddddddd-0000-0000-0000-000000252701') then
    raise exception 'X FAIL: another company sees the freed parts'; end if;
  begin
    perform public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270a', false);
    raise exception 'X FAIL: another company billed the freed Oct';
  exception when insufficient_privilege then raise notice 'X PASS: %', sqlerrm; end;
end $$;
reset role;

-- D: the OWNER deletes an OPEN proforma
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000252701","role":"authenticated"}', true);
set local role authenticated;
do $$
begin
  if not exists (select 1 from public.freed_parts_due(public.ist_today()) f where f.billing_id = 'bbbbbbbb-0000-0000-0000-00000025270a') then
    raise exception 'X FAIL: the company itself does not see its freed Oct'; end if;
  begin
    delete from public.quotes where id = (select id from r2527_ids where k = 'open');
    raise exception 'D FAIL: delete of an open proforma was not refused';
  exception when invalid_parameter_value then raise notice 'D PASS (open proforma): %', sqlerrm; end;
end $$;
reset role;

-- T: a forged service_role claim (no sub) on a direct client login
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role authenticated;
do $$
begin
  begin
    perform public.cancel_quote((select id from r2527_ids where k = 'open'), 'Forged claim cancel');
    raise exception 'T FAIL: cancel_quote trusted a forged service_role claim';
  exception when invalid_authorization_specification then raise notice 'T PASS (cancel_quote): %', sqlerrm; end;
  begin
    perform public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270a', false);
    raise exception 'T FAIL: bill_subscription_instalment trusted a forged service_role claim';
  exception when invalid_authorization_specification then raise notice 'T PASS (bill): %', sqlerrm; end;
  begin
    perform public.undo_cancel_quote((select id from r2527_ids where k = 'oct_cancelled'));
    raise exception 'T FAIL: undo_cancel_quote trusted a forged service_role claim';
  exception when invalid_authorization_specification then raise notice 'T PASS (undo): %', sqlerrm; end;
end $$;
reset role;

-- T: the real service role (PostgREST with the service key) still bills the freed Oct — the cron path
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
set local role service_role;
do $$
declare r jsonb;
begin
  r := public.bill_subscription_instalment('bbbbbbbb-0000-0000-0000-00000025270a', false);
  if r->>'action' <> 'request' then raise exception 'T FAIL: the service role could not bill the freed Oct: %', r; end if;
  raise notice 'T PASS: service role billed the freed Oct (%)', r->>'quote_id';
end $$;
reset role;

select 'R-2527 review follow-ups: ALL PASS' as result;

rollback;
