-- R-2376 (3 Nov 2026): TDS on loan interest to a non-bank lender — the owner's answers
-- (tenants.loan_interest_tds) and their only writer set_loan_interest_tds.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. A company starts with {} (nothing answered → the screen asks; never silently off).
--   B. The owner marks Tata Capital non-bank and HDFC Bank a bank; answers "FY 2025-26 tax-audited:
--      no"; turns the check off and on again — each answer kept, the others untouched.
--   C. null forgets an answer (asked again).
--   D. Refused, nothing written: a sales user (42501), a bad lender type, a bad year, an unknown
--      setting, an empty lender.
--   E. Tenant isolation: another company's owner changes only their own row.

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
  ('dddddddd-0000-0000-0000-000000237601','R2376 Co','r2376@example.in','07','R2376'),
  ('dddddddd-0000-0000-0000-000000237602','R2376 Other','r2376b@example.in','07','R2376B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000237601','owner2376@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000237602','owner2376b@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000237603','sales2376@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000237601','dddddddd-0000-0000-0000-000000237601','owner2376@example.in','Owner 2376','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000237602','dddddddd-0000-0000-0000-000000237602','owner2376b@example.in','Other owner','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000237603','dddddddd-0000-0000-0000-000000237601','sales2376@example.in','Sales 2376','sales', now() - interval '1 day');

-- ── A. nothing answered ─────────────────────────────────────────────────────────────────
do $$
begin
  if (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601') <> '{}'::jsonb then
    raise exception 'FAIL A: a new company should start with {}';
  end if;
end $$;

-- ── B. the owner answers ────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237601","role":"authenticated"}', true);
select public.set_loan_interest_tds('lender', 'tata capital', 'non_bank');
select public.set_loan_interest_tds('lender', 'HDFC Bank', 'bank');
select public.set_loan_interest_tds('audited', '2025', 'false');
select public.set_loan_interest_tds('off', null, 'true');
do $$
declare v jsonb := (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601');
begin
  if v <> '{"off": true, "audited": {"2025": false}, "lenders": {"tata capital": "non_bank", "hdfc bank": "bank"}}'::jsonb then
    raise exception 'FAIL B: answers not kept: %', v;
  end if;
end $$;
select public.set_loan_interest_tds('off', null, 'false');
do $$
declare v jsonb := (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601');
begin
  if (v ->> 'off') <> 'false' or (v -> 'lenders' ->> 'tata capital') <> 'non_bank' then
    raise exception 'FAIL B2: turning back on lost an answer: %', v;
  end if;
end $$;

-- ── C. null forgets ─────────────────────────────────────────────────────────────────────
select public.set_loan_interest_tds('lender', 'hdfc bank', null);
select public.set_loan_interest_tds('audited', '2025', null);
do $$
declare v jsonb := (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601');
begin
  if v -> 'lenders' ? 'hdfc bank' or v -> 'audited' ? '2025' then raise exception 'FAIL C: not forgotten: %', v; end if;
  if (v -> 'lenders' ->> 'tata capital') <> 'non_bank' then raise exception 'FAIL C: forgot the wrong lender: %', v; end if;
end $$;

-- ── D. refusals, nothing written ────────────────────────────────────────────────────────
do $$
declare
  v_before jsonb := (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601');
  v_case   record;
begin
  for v_case in
    select * from (values
      ('lender', 'bajaj finance', 'nbfc', 'Lender type must be bank or non_bank'),
      ('lender', '   ', 'bank', 'Enter the lender'),
      ('audited', '25', 'true', 'The year must be the FY start year%'),
      ('audited', '2025', 'maybe', 'Tax-audited must be true or false'),
      ('off', null, 'yes', 'Off must be true or false'),
      ('rate', null, '5', 'Unknown setting%')
    ) as t(what, k, val, msg)
  loop
    begin
      perform public.set_loan_interest_tds(v_case.what, v_case.k, v_case.val);
      raise exception 'FAIL D: accepted % / % / %', v_case.what, v_case.k, v_case.val;
    exception when others then
      if sqlerrm like 'FAIL%' then raise; end if;
      if sqlerrm not like v_case.msg then raise exception 'FAIL D: wrong refusal for %: %', v_case.what, sqlerrm; end if;
    end;
  end loop;
  if (select loan_interest_tds from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601') <> v_before then
    raise exception 'FAIL D: a refused call wrote something';
  end if;
end $$;

select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237603","role":"authenticated"}', true);
do $$
begin
  perform public.set_loan_interest_tds('off', null, 'true');
  raise exception 'FAIL D: a sales user changed the setting';
exception when others then
  if sqlerrm like 'FAIL%' then raise; end if;
  if sqlstate <> '42501' then raise exception 'FAIL D: wrong refusal for sales: % %', sqlstate, sqlerrm; end if;
end $$;

-- ── E. another company's owner touches only their own row ───────────────────────────────
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000237602","role":"authenticated"}', true);
select public.set_loan_interest_tds('lender', 'tata capital', 'bank');
select set_config('request.jwt.claims', '', true);
do $$
begin
  if (select loan_interest_tds -> 'lenders' ->> 'tata capital' from public.tenants where id = 'dddddddd-0000-0000-0000-000000237601') <> 'non_bank' then
    raise exception 'FAIL E: another company changed this one';
  end if;
  if (select loan_interest_tds -> 'lenders' ->> 'tata capital' from public.tenants where id = 'dddddddd-0000-0000-0000-000000237602') <> 'bank' then
    raise exception 'FAIL E: the other company''s own answer was not kept';
  end if;
end $$;

select 'R-2376 loan interest TDS settings: all checks passed' as result;

rollback;
