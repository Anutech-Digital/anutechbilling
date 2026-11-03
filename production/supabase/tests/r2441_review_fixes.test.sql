-- R-2441 (3 Nov 2026, fixes from independent money review 2 — Anutech-HQ/drafts/REVIEWS/2026-11-03-money-cards-2.md):
--   1. R-2426 item 1 + minor 2: "who is an owner" uses the app's own role rule (current_user_has_role:
--      active, access not ended, MFA when enrolled). An owner whose access has ENDED neither
--      approves (own quote or anyone's) nor counts as a second owner that blocks the real sole owner.
--   2. R-2424 item 1: a placeholder with a payment-rail prefix ('NEFT-000000000000',
--      'UPI/000000000000', 'UTR:0000000000', 'IMPS/000000') is a placeholder, not a UTR — while
--      real references with such a prefix stay real (same key as before).
--   3. R-2426 item 4 (pre-existing): approving a quote by a direct table UPDATE needs the role for
--      that tier — owner tier (old or new tier 'owner', or below cost) → owner; otherwise owner or
--      manager. A sales / billing login cannot approve, and a manager cannot lower the tier to slip
--      past the owner.
-- Migration 20261103191637_r2441_approval_role_and_prefixed_refs.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only.

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
create function pg_temp.r2441_quote(p_id text, p_tenant uuid, p_customer uuid, p_tier text, p_below_cost boolean default false) returns void
language sql as $q$
  insert into public.quotes (id, tenant_id, customer_id, customer_name, plan, seats, amount, subtotal, total_cost,
                             discount_pct, tax_rate, status, billing_cycle, line_items, is_one_off, created_date,
                             approval_status, approval_tier, below_cost)
  values (p_id, p_tenant, p_customer, 'Cust 2441', 'Google Workspace Business Standard', 3, 1770, 1500, 1470, 0, 18,
          'draft', 'yearly',
          '[{"id":"l1","name":"Google Workspace Business Standard","qty":3,"rate":500,"cost":490,"commitment":"annual_yearly"}]'::jsonb,
          false, '2026-11-03',
          (case when p_tier is null then 'not_required' else 'pending' end)::public.quote_approval_status,
          p_tier::public.quote_approval_tier, p_below_cost)
$q$;

create function pg_temp.r2441_login(p_uid text) returns text language sql as $l$
  select set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true)
$l$;

-- Expect the approval (optionally also writing approval_tier) to be refused with a message starting with p_like.
create function pg_temp.r2441_refused(p_case text, p_id text, p_note text, p_like text, p_set_tier text default null,
                                      p_disc int default 1500, p_margin int default 2000) returns void
language plpgsql as $r$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'approved', approved_at = now(), approval_note = p_note,
           approved_discount_bps = p_disc, approved_margin_bps = p_margin,
           approval_tier = coalesce(p_set_tier::public.quote_approval_tier, approval_tier)
     where id = p_id;
    raise exception 'FAIL %: % was approved', p_case, p_id;
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like p_like || '%' then raise exception 'FAIL %: wrong refusal for %: %', p_case, p_id, v_msg; end if;
  end;
  if (select approval_status::text from public.quotes where id = p_id) = 'approved' then
    raise exception 'FAIL %: % is approved after the refusal', p_case, p_id;
  end if;
end $r$;

-- The drawer signs the quote's current numbers (approved_discount_bps / approved_margin_bps);
-- defaults = manager-tier numbers (15% discount, 20% margin).
create function pg_temp.r2441_approved(p_case text, p_id text, p_note text, p_by uuid,
                                       p_disc int default 1500, p_margin int default 2000) returns void
language plpgsql as $a$
begin
  update public.quotes set approval_status = 'approved', approved_at = now(), approval_note = p_note,
         approved_discount_bps = p_disc, approved_margin_bps = p_margin where id = p_id;
  if (select approval_status::text from public.quotes where id = p_id) <> 'approved'
     or (select approved_by from public.quotes where id = p_id) is distinct from p_by then
    raise exception 'FAIL %: % not approved by %', p_case, p_id, p_by;
  end if;
end $a$;

select set_config('request.jwt.claims', '', true);
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000244101','R2441 Solo','r2441a@example.in','07','R2441A'),
  ('dddddddd-0000-0000-0000-000000244102','R2441 Gone','r2441b@example.in','07','R2441B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000244101','own2441a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244102','exown2441a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244103','mgr2441a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244104','sales2441a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244105','bill2441a@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244106','exown2441b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000244107','mgr2441b@example.in');
insert into public.users (id, tenant_id, email, full_name, role, is_active, access_ends_on, created_at) values
  -- company A: the real sole owner; a co-owner who left (access ended yesterday, is_active still true);
  -- a manager, a sales rep and a billing login
  ('aaaaaaaa-0000-0000-0000-000000244101','dddddddd-0000-0000-0000-000000244101','own2441a@example.in','Solo Owner','owner', true, null, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244102','dddddddd-0000-0000-0000-000000244101','exown2441a@example.in','Exited Owner','owner', true, public.ist_today() - 1, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244103','dddddddd-0000-0000-0000-000000244101','mgr2441a@example.in','Manager A','manager', true, null, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244104','dddddddd-0000-0000-0000-000000244101','sales2441a@example.in','Sales A','sales', true, null, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244105','dddddddd-0000-0000-0000-000000244101','bill2441a@example.in','Billing A','billing', true, null, now() - interval '30 days'),
  -- company B: its ONLY owner row has ended access; plus a manager
  ('aaaaaaaa-0000-0000-0000-000000244106','dddddddd-0000-0000-0000-000000244102','exown2441b@example.in','Exited Owner B','owner', true, public.ist_today() - 1, now() - interval '30 days'),
  ('aaaaaaaa-0000-0000-0000-000000244107','dddddddd-0000-0000-0000-000000244102','mgr2441b@example.in','Manager B','manager', true, null, now() - interval '30 days');
insert into public.customers (id, tenant_id, name, state_code, domain) values
  ('cccccccc-0000-0000-0000-000000244101','dddddddd-0000-0000-0000-000000244101','Cust 2441 A','07','c2441a.in'),
  ('cccccccc-0000-0000-0000-000000244102','dddddddd-0000-0000-0000-000000244102','Cust 2441 B','07','c2441b.in');

-- ── 1. ended-access owner neither approves nor blocks ─────────────────────────────────────
-- 1a. the real sole owner self-approves (with a reason) although the exited co-owner is still is_active
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244101');
select pg_temp.r2441_quote('Q-R2441-A1', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'owner');
do $$
begin
  perform pg_temp.r2441_approved('1a', 'Q-R2441-A1', 'Customer already paid; margin agreed', 'aaaaaaaa-0000-0000-0000-000000244101');
  raise notice 'PASS 1a: an exited co-owner (access ended) does not block the real sole owner';
end $$;

-- 1b. company B's only owner row has ended access → may not self-approve, even with a reason
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244106');
select pg_temp.r2441_quote('Q-R2441-B1', 'dddddddd-0000-0000-0000-000000244102', 'cccccccc-0000-0000-0000-000000244102', 'owner');
do $$
begin
  perform pg_temp.r2441_refused('1b', 'Q-R2441-B1', 'Customer already paid; margin agreed', 'You cannot approve Q-R2441-B1 — you made');
  raise notice 'PASS 1b: an owner whose access ended cannot self-approve';
end $$;

-- 1c. the exited owner of A cannot approve someone else''s (the sales rep''s) quote either
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244104');
select pg_temp.r2441_quote('Q-R2441-A2', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'owner');
select pg_temp.r2441_quote('Q-R2441-A3', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'manager');
select pg_temp.r2441_quote('Q-R2441-A4', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', null);
select pg_temp.r2441_quote('Q-R2441-A5', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'manager', true);
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244102');
do $$
begin
  perform pg_temp.r2441_refused('1c', 'Q-R2441-A2', null, 'Only the owner can approve Q-R2441-A2');
  raise notice 'PASS 1c: an owner whose access ended cannot approve another person''s quote';
end $$;

-- ── 3. the role for the tier is checked in the database ──────────────────────────────────
-- 3a. sales (not the maker) cannot approve a quote at any tier — not even one with no tier recorded
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244103');
select pg_temp.r2441_quote('Q-R2441-A6', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'manager');
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244104');
do $$
begin
  perform pg_temp.r2441_refused('3a', 'Q-R2441-A6', null, 'Only a manager or the owner can approve Q-R2441-A6');
  raise notice 'PASS 3a: a sales login cannot approve a teammate''s manager-tier quote by a direct update';
end $$;
-- 3b. billing cannot approve either
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244105');
do $$
begin
  perform pg_temp.r2441_refused('3b', 'Q-R2441-A2', null, 'Only the owner can approve Q-R2441-A2');
  perform pg_temp.r2441_refused('3b', 'Q-R2441-A4', null, 'Only a manager or the owner can approve Q-R2441-A4');
  raise notice 'PASS 3b: a billing login cannot approve';
end $$;
-- 3c. the manager: not an owner-tier quote, not by lowering the tier, not a below-cost quote;
--     yes a manager-tier quote
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244103');
do $$
begin
  perform pg_temp.r2441_refused('3c', 'Q-R2441-A2', null, 'Only the owner can approve Q-R2441-A2');
  perform pg_temp.r2441_refused('3c', 'Q-R2441-A2', null, 'Only the owner can approve Q-R2441-A2', 'manager');
  perform pg_temp.r2441_refused('3c', 'Q-R2441-A5', null, 'Only the owner can approve Q-R2441-A5');
  perform pg_temp.r2441_approved('3c', 'Q-R2441-A3', null, 'aaaaaaaa-0000-0000-0000-000000244103');
  raise notice 'PASS 3c: a manager clears manager tier only (tier cannot be lowered; below cost needs the owner)';
end $$;
-- 3d. the owner clears the owner-tier and below-cost quotes
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244101');
do $$
begin
  perform pg_temp.r2441_approved('3d', 'Q-R2441-A2', null, 'aaaaaaaa-0000-0000-0000-000000244101');
  perform pg_temp.r2441_approved('3d', 'Q-R2441-A5', null, 'aaaaaaaa-0000-0000-0000-000000244101');
  raise notice 'PASS 3d: the owner clears owner-tier and below-cost quotes';
end $$;
-- 3f. lowering the stored tier in an EARLIER update (the trigger does not watch approval_tier)
--     does not let a manager sign owner-tier numbers: discount over 20%, margin under 12%, or margin unknown
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244104');
select pg_temp.r2441_quote('Q-R2441-A7', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'owner');
select pg_temp.r2441_quote('Q-R2441-A8', 'dddddddd-0000-0000-0000-000000244101', 'cccccccc-0000-0000-0000-000000244101', 'manager');
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244103');
update public.quotes set approval_tier = 'manager' where id = 'Q-R2441-A7';
do $$
begin
  perform pg_temp.r2441_refused('3f', 'Q-R2441-A7', null, 'Only the owner can approve Q-R2441-A7', null, 2500, 2000);
  perform pg_temp.r2441_refused('3f', 'Q-R2441-A7', null, 'Only the owner can approve Q-R2441-A7', null, 1500, 800);
  perform pg_temp.r2441_refused('3f', 'Q-R2441-A7', null, 'Only the owner can approve Q-R2441-A7', null, 1500, null);
  raise notice 'PASS 3f: a pre-lowered tier does not let a manager sign owner-tier numbers';
end $$;
-- 3g. a rejection is a decision too: sales cannot reject in the owner's name; a manager rejects a
--     manager-tier quote in their own name
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244105');
do $$
declare v_msg text;
begin
  begin
    update public.quotes set approval_status = 'rejected', approved_by = 'aaaaaaaa-0000-0000-0000-000000244101',
           approval_rejection_reason = 'too cheap' where id = 'Q-R2441-A8';
    raise exception 'FAIL 3g: billing rejected Q-R2441-A8';
  exception when others then
    v_msg := sqlerrm;
    if v_msg like 'FAIL%' then raise; end if;
    if v_msg not like 'Only a manager or the owner can reject Q-R2441-A8%' then raise exception 'FAIL 3g: wrong refusal: %', v_msg; end if;
  end;
end $$;
select pg_temp.r2441_login('aaaaaaaa-0000-0000-0000-000000244103');
update public.quotes set approval_status = 'rejected', approved_by = 'aaaaaaaa-0000-0000-0000-000000244101',
       approval_rejection_reason = 'too cheap' where id = 'Q-R2441-A8';
do $$
begin
  if (select approved_by from public.quotes where id = 'Q-R2441-A8') is distinct from 'aaaaaaaa-0000-0000-0000-000000244103'::uuid then
    raise exception 'FAIL 3g: the rejection is not in the manager''s own name';
  end if;
  raise notice 'PASS 3g: rejection needs the role and is in the signer''s own name';
end $$;
-- 3e. no login (service / cron path) is unchanged
select set_config('request.jwt.claims', '', true);
do $$
begin
  update public.quotes set approval_status = 'approved', approved_at = now() where id = 'Q-R2441-A6';
  if (select approval_status::text from public.quotes where id = 'Q-R2441-A6') <> 'approved' then
    raise exception 'FAIL 3e: the service path could not approve';
  end if;
  raise notice 'PASS 3e: service path unchanged';
end $$;

-- ── 2. placeholder references with a rail prefix ─────────────────────────────────────────
do $$
declare r text;
begin
  foreach r in array array['NEFT-000000000000', 'UPI/000000000000', 'UTR:0000000000', 'IMPS/000000',
                           'RTGS 000000000000000', 'neft/utr/000000000000', 'UTR NO 000000000', 'UPIREF000000',
                           'NEFT-', 'UPI/XXXXXXXX', 'NEFT N/A', 'UTR NOT AVAILABLE', 'REF NONE', 'UTR NIL',
                           'TXN-001', 'NEFT-12', 'UTR NO 12', 'IMPS NOT PROVIDED'] loop
    if public.bank_reference_is_real(r) then raise exception 'FAIL 2: % counted as a real reference', r; end if;
    if public.payment_ref_key('bank_transfer', r) is not null then raise exception 'FAIL 2: % got a key', r; end if;
  end loop;
  foreach r in array array['UPI/412345678901', 'NEFT-N123260512345678', 'UTR:HDFCN52026051912345678',
                           'IMPS/612345000000', 'TESTUTR123456', '162440272175', '100000', 'NEFT100000'] loop
    if not public.bank_reference_is_real(r) then raise exception 'FAIL 2: real reference % counted as a placeholder', r; end if;
  end loop;
  -- a real prefixed UTR keeps exactly its R-1676 key (spaces/hyphens dropped, upper-case)
  if public.payment_ref_key('upi', 'UPI/412345678901') <> 'BANK:UPI/412345678901'
     or public.payment_ref_key('bank_transfer', 'NEFT-N123260512345678') <> 'BANK:NEFTN123260512345678' then
    raise exception 'FAIL 2: a real prefixed UTR changed its key';
  end if;
  raise notice 'PASS 2: prefixed zero references are placeholders; real prefixed UTRs stay real with the same key';
end $$;

rollback;
