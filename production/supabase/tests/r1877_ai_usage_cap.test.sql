-- R-1877 (24 Oct 2026): per-company AI usage counter + monthly call cap.
-- Migration 20261024220000_r1877_ai_usage_cap.
-- Self-asserting, ONE transaction, rolled back. Run on a local/test DB only:
--   begin; <migration without begin/commit>; <this file without begin/rollback>; rollback;
--
-- Proves:
--   A. ai_usage_reserve counts calls per company per IST month and refuses the call after the cap
--      (cap 2 → third call refused, counter stays 2); a refused call is not counted.
--   B. p_enforce = false (the company's own Gemini key) counts but never refuses.
--   C. Default cap (no tenant_ai_limits row) comes from ai_monthly_call_cap; another company's
--      counter is separate.
--   D. ai_usage_add_tokens adds tokens without adding a call; negative tokens count as 0.
--   E. ai_usage_summary returns used / cap / month for the owner; a sales login is refused (42501).
--   F. Guards: a signed-in user cannot reserve or add tokens (server only, 42501); a no-company
--      login is refused (28000); an owner cannot read another company's summary (42501).
--   G. RLS: a user sees only their own company's usage rows and cannot write them.

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
  ('dddddddd-0000-0000-0000-000000187701','R1877 Co','r1877@example.in','07','R1877'),
  ('dddddddd-0000-0000-0000-000000187702','R1877 Other','r1877b@example.in','07','R1877B');
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-000000187701','owner1877@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187702','sales1877@example.in'),
  ('aaaaaaaa-0000-0000-0000-000000187703','nocompany1877@example.in');
insert into public.users (id, tenant_id, email, full_name, role, created_at) values
  ('aaaaaaaa-0000-0000-0000-000000187701','dddddddd-0000-0000-0000-000000187701','owner1877@example.in','Owner 1877','owner', now() - interval '1 day'),
  ('aaaaaaaa-0000-0000-0000-000000187702','dddddddd-0000-0000-0000-000000187701','sales1877@example.in','Sales 1877','sales', now() - interval '1 day');

insert into public.tenant_ai_limits (tenant_id, monthly_call_cap) values
  ('dddddddd-0000-0000-0000-000000187701', 2);

-- ── As the SERVER (service role) ─────────────────────────────────────────────
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

-- A. cap 2 → third call refused
do $$
declare r jsonb; v_month date := (date_trunc('month', now() at time zone 'Asia/Kolkata'))::date;
begin
  r := public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'ai/test', true);
  if (r->>'allowed')::boolean is not true or (r->>'used')::int <> 1 or (r->>'cap')::int <> 2 then
    raise exception 'FAIL A1: first call %', r; end if;
  r := public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'copilot/copy', true);
  if (r->>'allowed')::boolean is not true or (r->>'used')::int <> 2 then
    raise exception 'FAIL A2: second call (other feature, same month) %', r; end if;
  r := public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'ai/test', true);
  if (r->>'allowed')::boolean is not false or (r->>'used')::int <> 2 or (r->>'cap')::int <> 2 then
    raise exception 'FAIL A3: third call should be refused %', r; end if;
  if (r->>'month')::date <> v_month then raise exception 'FAIL A4: month % (want IST %)', r->>'month', v_month; end if;
  if (select sum(calls) from public.ai_usage_monthly where tenant_id = 'dddddddd-0000-0000-0000-000000187701') <> 2 then
    raise exception 'FAIL A5: refused call was counted'; end if;
  if (select calls from public.ai_usage_monthly where tenant_id = 'dddddddd-0000-0000-0000-000000187701' and feature = 'ai/test') <> 1 then
    raise exception 'FAIL A6: per-feature count wrong'; end if;
  raise notice 'PASS A: cap 2 → 3rd call refused, refused call not counted, per feature + IST month';
end $$;

-- A7. last month's calls do not count toward this month
do $$
declare r jsonb;
begin
  insert into public.ai_usage_monthly (tenant_id, month, feature, calls)
  values ('dddddddd-0000-0000-0000-000000187702',
          ((date_trunc('month', now() at time zone 'Asia/Kolkata'))::date - interval '1 month')::date, 'ai/test', 99999);
  r := public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187702', 'ai/test', true);
  if (r->>'allowed')::boolean is not true or (r->>'used')::int <> 1 then
    raise exception 'FAIL A7: last month leaked into this month %', r; end if;
  raise notice 'PASS A7: last month''s calls do not count';
end $$;

-- B. own key → counted, never refused
do $$
declare r jsonb;
begin
  r := public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'ai/test', false);
  if (r->>'allowed')::boolean is not true or (r->>'used')::int <> 3 then
    raise exception 'FAIL B: own-key call %', r; end if;
  raise notice 'PASS B: own key counted (3) but not refused';
end $$;

-- C. default cap
do $$
declare r jsonb;
begin
  r := public.ai_usage_summary('dddddddd-0000-0000-0000-000000187702');
  if (r->>'cap')::int <> public.ai_monthly_call_cap('dddddddd-0000-0000-0000-000000187702')
     or (r->>'cap')::int <> 1000 then
    raise exception 'FAIL C1: default cap %', r; end if;
  if (r->>'used')::int <> 1 then raise exception 'FAIL C2: other company count %', r; end if;
  raise notice 'PASS C: default cap 1000, companies counted apart';
end $$;

-- D. tokens
do $$
declare r jsonb;
begin
  perform public.ai_usage_add_tokens('dddddddd-0000-0000-0000-000000187701', 'ai/test', 1200, 340);
  perform public.ai_usage_add_tokens('dddddddd-0000-0000-0000-000000187701', 'ai/test', -5, 10);
  r := public.ai_usage_summary('dddddddd-0000-0000-0000-000000187701');
  if (r->>'input_tokens')::bigint <> 1200 or (r->>'output_tokens')::bigint <> 350 then
    raise exception 'FAIL D1: tokens %', r; end if;
  if (r->>'used')::int <> 3 then raise exception 'FAIL D2: tokens added a call %', r; end if;
  raise notice 'PASS D: tokens added, no extra call, negatives → 0';
end $$;

-- ── As the OWNER ─────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187701","role":"authenticated"}', true);
do $$
declare r jsonb;
begin
  r := public.ai_usage_summary('dddddddd-0000-0000-0000-000000187701');
  if (r->>'used')::int <> 3 or (r->>'cap')::int <> 2 then raise exception 'FAIL E1: owner summary %', r; end if;
  raise notice 'PASS E1: owner reads own summary';
  begin
    perform public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'ai/test', false);
    raise exception 'FAIL F1: a signed-in user reserved a call';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ai_usage_add_tokens('dddddddd-0000-0000-0000-000000187701', 'ai/test', 1, 1);
    raise exception 'FAIL F2: a signed-in user added tokens';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.ai_usage_summary('dddddddd-0000-0000-0000-000000187702');
    raise exception 'FAIL F3: owner read another company''s summary';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS F1-3: user cannot reserve / add tokens / read another company';
end $$;

-- G. RLS (as the authenticated role)
set local role authenticated;
do $$
begin
  if exists (select 1 from public.ai_usage_monthly where tenant_id <> 'dddddddd-0000-0000-0000-000000187701') then
    raise exception 'FAIL G1: saw another company''s usage'; end if;
  if not exists (select 1 from public.ai_usage_monthly) then raise exception 'FAIL G2: own usage not visible'; end if;
  begin
    update public.ai_usage_monthly set calls = 0;
    raise exception 'FAIL G3: user reset the counter';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.tenant_ai_limits set monthly_call_cap = 999999;
    raise exception 'FAIL G4: user raised own cap';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS G: RLS — own rows only, no writes to counter or cap';
end $$;
reset role;

-- ── As SALES ─────────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187702","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.ai_usage_summary('dddddddd-0000-0000-0000-000000187701');
    raise exception 'FAIL E2: sales read the AI usage summary';
  exception when insufficient_privilege then null;
  end;
  raise notice 'PASS E2: sales refused (42501)';
end $$;

-- ── No company ───────────────────────────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-0000-0000-0000-000000187703","role":"authenticated"}', true);
do $$
begin
  begin
    perform public.ai_usage_summary('dddddddd-0000-0000-0000-000000187701');
    raise exception 'FAIL F4: no-company login read a summary';
  exception when invalid_authorization_specification then null;
  end;
  begin
    perform public.ai_usage_reserve('dddddddd-0000-0000-0000-000000187701', 'ai/test', true);
    raise exception 'FAIL F5: no-company login reserved';
  exception when invalid_authorization_specification then null;
  end;
  raise notice 'PASS F4-5: no-company login refused (28000)';
end $$;

rollback;
