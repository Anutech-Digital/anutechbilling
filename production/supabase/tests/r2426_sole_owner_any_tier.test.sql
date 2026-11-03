-- R-2426 (3 Nov 2026, p0): the company's ONLY active owner may approve their own quote — at ANY
-- tier — with a written reason (min 10 chars), audited. Maker-checker stays for everyone else.
-- Why: staging 3 Nov, a one-owner company that still has a MANAGER login — R-2383 counted that
-- manager as "another approver" on a manager-tier quote, so the owner saw "You cannot approve
-- your own quote" with no way on. Pardeep: "single owner ko ye power honi chahiye live me bhi".
-- Migration 20261103153445_r2426_sole_owner_any_tier (tg_quote_approval_not_by_maker).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Sole owner (+ an active manager + sales) — own MANAGER-tier and no-tier quotes, NO
--      reason → refused ("You are the only owner of this company, so approving … needs a reason").
--   B. Same, with a reason → approved; approval_note saved; approved_by = owner;
--      activity_log 'quote.self_approved' "Self-approved by sole owner: <reason>".
--   C. Two active owners → the maker owner is refused even with a reason (owner tier and
--      manager tier), and no activity row is written.
--   D. Non-owner (the manager) who made a quote → refused even with a reason.
--   E. Another company's quote: company A's sole owner made a quote filed under company B
--      → refused (not an owner of THAT company), even with a reason.
--   F. An inactive (is_active = false) owner trying to self-approve → refused.

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

-- One quote factory: inserted under the CURRENT login, so created_by = that login.
create function pg_temp.r2426_quote(p_id text, p_tenant uuid, p_customer uuid, p_tier text) returns void
language sql as $q$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier)
  values (p_id, p_tenant, p_customer, 'Cust 2426', 'Google Workspace Business Standard', 3, 1770, 1500, 1470, 0, 18,
          'draft', 'yearly',
          '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":490,"commitment":"annual_yearly"}]'::jsonb,
          false, '2026-11-03',
          (case when p_tier is null then 'not_required' else 'pending' end)::public.quote_approval_status,
          p_tier::public.quote_approval_tier)
$q$;

create function pg_temp.r2426_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$l$;

-- Expect the approval to be refused with a message starting with p_like.
create function pg_temp.r2426_refused(p_case text, p_id text, p_note text, p_like text) returns void
language plpgsql as $r$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now(), approval_note = p_note where id = p_id;
    raise exception 'FAIL %: % was approved', p_case, p_id;
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like p_like || '%' then raise exception 'FAIL %: wrong refusal for %: %', p_case, p_id, v_msg; end if;
  end;
  if exists (select 1 from public.activity_log where entity_id = p_id and action = 'quote.self_approved') then
    raise exception 'FAIL %: a refused approval left an activity log row for %', p_case, p_id;
  end if;
end $r$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000242601','R2426 Solo','r2426a@example.in','07','R2426A'),
  ('dddddddd-0000-0000-0000-000000242602','R2426 Two','r2426b@example.in','07','R2426B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000242601','own2426a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000242602','mgr2426a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000242603','sales2426a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000242604','own2426b1@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000242605','own2426b2@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000242606','oldown2426a@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000242601','dddddddd-0000-0000-0000-000000242601','own2426a@example.in','Solo Owner','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000242602','dddddddd-0000-0000-0000-000000242601','mgr2426a@example.in','Manager A','manager', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000242603','dddddddd-0000-0000-0000-000000242601','sales2426a@example.in','Sales A','sales', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000242604','dddddddd-0000-0000-0000-000000242602','own2426b1@example.in','Owner B1','owner', true, now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000242605','dddddddd-0000-0000-0000-000000242602','own2426b2@example.in','Owner B2','owner', true, now() - interval '1 day'),
  -- a switched-off former owner of A: does not count as a second owner, and cannot approve
  ('aaaaaaaa-0000-0000-0000-000000242606','dddddddd-0000-0000-0000-000000242601','oldown2426a@example.in','Old Owner A','owner', false, now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000242601','dddddddd-0000-0000-0000-000000242601','Cust 2426 A','07','c2426a.in'),
  ('cccccccc-0000-0000-0000-000000242602','dddddddd-0000-0000-0000-000000242602','Cust 2426 B','07','c2426b.in');

-- ── Company A: one active owner + an active manager + a sales rep ───────────────────────
select pg_temp.r2426_login('aaaaaaaa-0000-0000-0000-000000242601');
select pg_temp.r2426_quote('Q-R2426-A1', 'dddddddd-0000-0000-0000-000000242601', 'cccccccc-0000-0000-0000-000000242601', 'manager');
select pg_temp.r2426_quote('Q-R2426-A2', 'dddddddd-0000-0000-0000-000000242601', 'cccccccc-0000-0000-0000-000000242601', null);
-- E. company A's owner files a quote under company B (B's customer) — still "made" by A's owner
select pg_temp.r2426_quote('Q-R2426-X1', 'dddddddd-0000-0000-0000-000000242602', 'cccccccc-0000-0000-0000-000000242602', 'owner');

-- A. no reason → refused, at manager tier and with no tier recorded
do $$
begin
  perform pg_temp.r2426_refused('A', 'Q-R2426-A1', null, 'You are the only owner of this company, so approving Q-R2426-A1 yourself needs a reason');
  perform pg_temp.r2426_refused('A', 'Q-R2426-A2', '   short  ', 'You are the only owner of this company, so approving Q-R2426-A2 yourself needs a reason');
  raise notice 'PASS A: sole owner without a (long enough) reason refused';
end $$;

-- B. with a reason → approved (a manager in the company no longer blocks the sole owner)
update public.quotes set approval_status = 'approved', approved_at = now(),
       approval_note = '  Customer already paid; margin agreed  ' where id in ('Q-R2426-A1', 'Q-R2426-A2');
do $$
declare q record; v_n int; v_label text;
begin
  for q in select id, approval_status::text as st, approved_by, approval_note from public.quotes
            where id in ('Q-R2426-A1', 'Q-R2426-A2') loop
    if q.st <> 'approved' then raise exception 'FAIL B: % not approved (%)', q.id, q.st; end if;
    if q.approved_by <> 'aaaaaaaa-0000-0000-0000-000000242601'::uuid then raise exception 'FAIL B: % approved_by is not the owner', q.id; end if;
    if q.approval_note <> 'Customer already paid; margin agreed' then raise exception 'FAIL B: % note not saved trimmed: %', q.id, q.approval_note; end if;
    select count(*), max(label) into v_n, v_label from public.activity_log
     where tenant_id = 'dddddddd-0000-0000-0000-000000242601' and entity = 'quote' and entity_id = q.id
       and action = 'quote.self_approved' and user_id = 'aaaaaaaa-0000-0000-0000-000000242601';
    if v_n <> 1 or v_label is distinct from 'Self-approved by sole owner: Customer already paid; margin agreed' then
      raise exception 'FAIL B: % activity log % rows, label %', q.id, v_n, v_label;
    end if;
  end loop;
  raise notice 'PASS B: sole owner + reason approved at manager tier / no tier, with a manager in the company; audited';
end $$;

-- E. another company's quote → refused (A's owner is not an owner of company B)
do $$
begin
  perform pg_temp.r2426_refused('E', 'Q-R2426-X1', 'Customer already paid; margin agreed', 'You cannot approve Q-R2426-X1 — you made');
  raise notice 'PASS E: another company''s quote refused';
end $$;

-- D. the manager's own quote → refused even with a reason (not an owner)
select pg_temp.r2426_login('aaaaaaaa-0000-0000-0000-000000242602');
select pg_temp.r2426_quote('Q-R2426-A3', 'dddddddd-0000-0000-0000-000000242601', 'cccccccc-0000-0000-0000-000000242601', 'manager');
do $$
begin
  perform pg_temp.r2426_refused('D', 'Q-R2426-A3', 'I am sure this price is fine', 'You cannot approve Q-R2426-A3 — you made');
  raise notice 'PASS D: non-owner maker refused';
end $$;

-- F. the switched-off former owner made a quote → refused even with a reason
select pg_temp.r2426_login('aaaaaaaa-0000-0000-0000-000000242606');
select pg_temp.r2426_quote('Q-R2426-A4', 'dddddddd-0000-0000-0000-000000242601', 'cccccccc-0000-0000-0000-000000242601', 'owner');
do $$
begin
  perform pg_temp.r2426_refused('F', 'Q-R2426-A4', 'Customer already paid; margin agreed', 'You cannot approve Q-R2426-A4 — you made');
  raise notice 'PASS F: inactive owner refused';
end $$;

-- ── Company B: two active owners ────────────────────────────────────────────────────────
select pg_temp.r2426_login('aaaaaaaa-0000-0000-0000-000000242604');
select pg_temp.r2426_quote('Q-R2426-B1', 'dddddddd-0000-0000-0000-000000242602', 'cccccccc-0000-0000-0000-000000242602', 'owner');
select pg_temp.r2426_quote('Q-R2426-B2', 'dddddddd-0000-0000-0000-000000242602', 'cccccccc-0000-0000-0000-000000242602', 'manager');
do $$
begin
  perform pg_temp.r2426_refused('C', 'Q-R2426-B1', 'Customer already paid; margin agreed', 'You cannot approve Q-R2426-B1 — you made');
  perform pg_temp.r2426_refused('C', 'Q-R2426-B2', 'Customer already paid; margin agreed', 'You cannot approve Q-R2426-B2 — you made');
  raise notice 'PASS C: two owners → self-approval refused';
end $$;

-- C2. the OTHER owner can still approve it (maker-checker works as before)
select pg_temp.r2426_login('aaaaaaaa-0000-0000-0000-000000242605');
update public.quotes set approval_status = 'approved', approved_at = now() where id = 'Q-R2426-B1';
do $$
begin
  if (select approval_status::text from public.quotes where id = 'Q-R2426-B1') <> 'approved' then
    raise exception 'FAIL C2: the second owner could not approve';
  end if;
  raise notice 'PASS C2: the other owner approves as before';
end $$;

rollback;
