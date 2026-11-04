-- R-2383 (2 Nov 2026): the company's SOLE owner may approve a quote they made, with a written
-- reason (min 10 chars) — kept on the quote and in activity_log. Everyone else stays refused.
-- Owner decision 2 Nov: "Haan, reason ke saath". After R-2367 nobody who made a quote family
-- could approve it, so a one-owner company could never approve quotes made under the owner
-- login.
-- Migration 20261102132142_r2383_sole_owner_self_approval (quotes.approval_note +
-- tg_quote_approval_not_by_maker sole-owner branch).
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.
--
-- Proves:
--   A. Sole owner, own below-cost quote, NO reason → refused ("only approver … write why").
--   B. Sole owner, reason under 10 characters → refused.
--   C. Sole owner + reason → approved; approval_note saved (trimmed); approved_by = owner;
--      activity_log 'quote.self_approved' "Self-approved by sole owner: <reason>".
--      (A non-approver role in the company — sales — does not count as a second approver.)
--   D. A manager who made the quote, with a reason → still refused (not an owner).
--   E. Owner with an active manager in the company → since R-2426 (3 Nov) the manager does not
--      count: the only owner clears manager-tier, no-tier and owner-tier quotes with a reason.
--   F. Second active owner exists → owner maker refused even with a reason; once that owner is
--      deactivated → allowed again.

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
create function pg_temp.r2383_quote(p_id text, p_tenant uuid, p_customer uuid, p_tier text) returns void
language sql as $q$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier)
  values (p_id, p_tenant, p_customer, 'Cust 2383', 'Google Workspace Business Standard', 3, 1770, 1500, 1800, 0, 18,
          'draft', 'yearly',
          '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":600,"commitment":"annual_yearly"}]'::jsonb,
          false, '2026-11-02',
          (case when p_tier is null then 'not_required' else 'pending' end)::public.quote_approval_status,
          p_tier::public.quote_approval_tier)
$q$;

create function pg_temp.r2383_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$l$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000238301','R2383 Solo','r2383a@example.in','07','R2383A'),
  ('dddddddd-0000-0000-0000-000000238302','R2383 Mgr','r2383b@example.in','07','R2383B'),
  ('dddddddd-0000-0000-0000-000000238303','R2383 Two','r2383c@example.in','07','R2383C');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000238301','solo2383@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238302','sales2383@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238303','own2383b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238304','mgr2383b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238305','own2383c1@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000238306','own2383c2@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000238301','dddddddd-0000-0000-0000-000000238301','solo2383@example.in','Solo Owner','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238302','dddddddd-0000-0000-0000-000000238301','sales2383@example.in','Sales Rep','sales', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238303','dddddddd-0000-0000-0000-000000238302','own2383b@example.in','Owner B','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238304','dddddddd-0000-0000-0000-000000238302','mgr2383b@example.in','Manager B','manager', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238305','dddddddd-0000-0000-0000-000000238303','own2383c1@example.in','Owner C1','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000238306','dddddddd-0000-0000-0000-000000238303','own2383c2@example.in','Owner C2','owner', now() - interval '1 day');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000238301','dddddddd-0000-0000-0000-000000238301','Cust 2383 A','07','c2383a.in'),
  ('cccccccc-0000-0000-0000-000000238302','dddddddd-0000-0000-0000-000000238302','Cust 2383 B','07','c2383b.in'),
  ('cccccccc-0000-0000-0000-000000238303','dddddddd-0000-0000-0000-000000238303','Cust 2383 C','07','c2383c.in');

-- ── Company A: one owner (+ a sales rep) ────────────────────────────────────────────────
select pg_temp.r2383_login('aaaaaaaa-0000-0000-0000-000000238301');
select pg_temp.r2383_quote('Q-R2383-A1', 'dddddddd-0000-0000-0000-000000238301', 'cccccccc-0000-0000-0000-000000238301', 'owner');

-- A. no reason → refused
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now() where id = 'Q-R2383-A1';
    raise exception 'FAIL A: sole owner approved own quote without a reason';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You are the only owner of this company, so approving Q-R2383-A1 yourself needs a reason%' then
      raise exception 'FAIL A: wrong refusal: %', v_msg;
    end if;
  end;
  raise notice 'PASS A: sole owner without a reason refused';
end $$;

-- B. reason too short (9 characters after trim) → refused
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now(), approval_note = '  too short  '
     where id = 'Q-R2383-A1';
    raise exception 'FAIL B: a 9-character reason was accepted';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You are the only owner of this company, so approving Q-R2383-A1%' then raise exception 'FAIL B: wrong refusal: %', v_msg; end if;
  end;
  raise notice 'PASS B: short reason refused';
end $$;

-- C. reason given → approved, recorded on the quote and in the activity log
update public.quotes
   set approval_status = 'approved', approved_at = now(), approved_by = 'aaaaaaaa-0000-0000-0000-000000238302',
       approved_margin_bps = -2000, approved_discount_bps = 0,
       approval_note = '  Strategic customer, renewal at full price next year  '
 where id = 'Q-R2383-A1';
do $$
declare q record; v_n int; v_label text;
begin
  select approval_status::text as st, approved_by, approval_note into q from public.quotes where id = 'Q-R2383-A1';
  if q.st <> 'approved' then raise exception 'FAIL C: not approved (%)', q.st; end if;
  if q.approved_by <> 'aaaaaaaa-0000-0000-0000-000000238301'::uuid then raise exception 'FAIL C: approved_by is not the owner'; end if;
  if q.approval_note <> 'Strategic customer, renewal at full price next year' then
    raise exception 'FAIL C: approval_note not saved trimmed: %', q.approval_note;
  end if;
  select count(*), max(label) into v_n, v_label from public.activity_log
   where tenant_id = 'dddddddd-0000-0000-0000-000000238301' and entity = 'quote' and entity_id = 'Q-R2383-A1'
     and action = 'quote.self_approved' and user_id = 'aaaaaaaa-0000-0000-0000-000000238301';
  if v_n <> 1 or v_label is distinct from 'Self-approved by sole owner: Strategic customer, renewal at full price next year' then
    raise exception 'FAIL C: activity log % rows, label %', v_n, v_label;
  end if;
  raise notice 'PASS C: sole owner + reason approved, note on quote, activity logged';
end $$;

-- ── Company B: owner + manager ──────────────────────────────────────────────────────────
-- D. the manager's own quote — refused even with a reason
select pg_temp.r2383_login('aaaaaaaa-0000-0000-0000-000000238304');
select pg_temp.r2383_quote('Q-R2383-B1', 'dddddddd-0000-0000-0000-000000238302', 'cccccccc-0000-0000-0000-000000238302', 'manager');
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now(),
           approval_note = 'I am sure this price is fine' where id = 'Q-R2383-B1';
    raise exception 'FAIL D: manager approved his own quote with a reason';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2383-B1 — you made%' then raise exception 'FAIL D: wrong refusal: %', v_msg; end if;
  end;
  raise notice 'PASS D: manager maker refused';
end $$;

-- E1. owner's own MANAGER-tier (and no-tier) quote — R-2426 (3 Nov): a manager no longer counts
--     as a second approver; the company's only owner may clear it with a reason.
select pg_temp.r2383_login('aaaaaaaa-0000-0000-0000-000000238303');
select pg_temp.r2383_quote('Q-R2383-B2', 'dddddddd-0000-0000-0000-000000238302', 'cccccccc-0000-0000-0000-000000238302', 'manager');
select pg_temp.r2383_quote('Q-R2383-B3', 'dddddddd-0000-0000-0000-000000238302', 'cccccccc-0000-0000-0000-000000238302', null);
update public.quotes set approval_status = 'approved', approved_at = now(),
       approval_note = 'Owner says this is fine, long reason' where id in ('Q-R2383-B2', 'Q-R2383-B3');
do $$
begin
  if (select count(*) from public.quotes where id in ('Q-R2383-B2', 'Q-R2383-B3') and approval_status::text = 'approved') <> 2 then
    raise exception 'FAIL E1: the only owner could not clear a manager-tier / no-tier quote with a reason';
  end if;
  raise notice 'PASS E1: a manager in the company does not block the only owner (R-2426)';
end $$;

-- E2. owner's own OWNER-tier quote — the manager cannot clear it, so the owner is the sole approver
select pg_temp.r2383_quote('Q-R2383-B4', 'dddddddd-0000-0000-0000-000000238302', 'cccccccc-0000-0000-0000-000000238302', 'owner');
update public.quotes set approval_status = 'approved', approved_at = now(),
       approval_note = 'Below cost to win the account' where id = 'Q-R2383-B4';
do $$
begin
  if (select approval_status::text from public.quotes where id = 'Q-R2383-B4') <> 'approved' then
    raise exception 'FAIL E2: owner-tier quote not approvable by its only possible approver';
  end if;
  raise notice 'PASS E2: owner-tier quote — managers cannot clear it, sole owner approves with reason';
end $$;

-- ── Company C: two owners ───────────────────────────────────────────────────────────────
select pg_temp.r2383_login('aaaaaaaa-0000-0000-0000-000000238305');
select pg_temp.r2383_quote('Q-R2383-C1', 'dddddddd-0000-0000-0000-000000238303', 'cccccccc-0000-0000-0000-000000238303', 'owner');
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now(),
           approval_note = 'Strategic customer, keep the deal' where id = 'Q-R2383-C1';
    raise exception 'FAIL F1: owner self-approved while a second owner exists';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'You cannot approve Q-R2383-C1 — you made%' then raise exception 'FAIL F1: wrong refusal: %', v_msg; end if;
  end;
  if exists (select 1 from public.activity_log where entity_id = 'Q-R2383-C1' and action = 'quote.self_approved') then
    raise exception 'FAIL F1: a refused approval left an activity log row';
  end if;
  raise notice 'PASS F1: second owner exists → owner maker refused';
end $$;

-- F2. the second owner is deactivated → the first is the sole approver again
select set_config('request.jwt.claims', '', true);
update public.users set is_active = false where id = 'aaaaaaaa-0000-0000-0000-000000238306';
select pg_temp.r2383_login('aaaaaaaa-0000-0000-0000-000000238305');
update public.quotes set approval_status = 'approved', approved_at = now(),
       approval_note = 'Strategic customer, keep the deal' where id = 'Q-R2383-C1';
do $$
begin
  if (select approval_status::text from public.quotes where id = 'Q-R2383-C1') <> 'approved' then
    raise exception 'FAIL F2: inactive second owner still blocked the sole owner';
  end if;
  raise notice 'PASS F2: inactive users do not count as approvers';
end $$;

rollback;
