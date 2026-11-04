-- R-2423 (Pardeep, 3 Nov 2026 — staging Q-A378-27-0930): a NEW part payment request's line names
-- the product, domain, seats, period and which part of the term it is.
-- Migration 20261103141332_r2423_part_request_line_name.
-- Self-asserting, ONE transaction, rolled back. Run on a dev/test DB only.
--
--   A. Monthly renewal part 1 of 12         → "Google Workspace Business Starter · acme.in · 10 seats ·
--                                              1 Nov–30 Nov 2026 (part 1 of 12)"
--   B. One seat, no domain                  → "Plan · 1 seat · <period> (part 2 of 4)" (nothing blank)
--   C. Term that does not divide (N null)   → "(part 3)" — never a made-up N
--   D. Part index past N                    → "(part 5)" — never "part 5 of 4"
--   F. part_request_parts_in_term          → 12/4/2/1 by cycle; null when the term does not divide
--   E. bill_subscription_instalment uses it → its body carries the R-2423 wording (the full request
--                                              path is asserted in r2044_part_payment_requests C).

begin;

do $$
declare
  v text;
begin
  v := public.part_request_line_name('Google Workspace Business Starter', 'acme.in', 10, '1 Nov–30 Nov 2026', 1, 12);
  if v is distinct from 'Google Workspace Business Starter · acme.in · 10 seats · 1 Nov–30 Nov 2026 (part 1 of 12)' then
    raise exception 'A FAIL: %', v; end if;
  raise notice 'A PASS: %', v;

  v := public.part_request_line_name('Plan', null, 1, '1 Feb–30 Apr 2027', 2, 4);
  if v is distinct from 'Plan · 1 seat · 1 Feb–30 Apr 2027 (part 2 of 4)' then raise exception 'B FAIL: %', v; end if;
  v := public.part_request_line_name('  ', '', 0, '1 Feb–30 Apr 2027', 2, 4);
  if v is distinct from '1 Feb–30 Apr 2027 (part 2 of 4)' then raise exception 'B FAIL (blank parts): %', v; end if;
  raise notice 'B PASS';

  v := public.part_request_line_name('Plan', 'x.in', 3, '1 Mar–31 May 2027', 3, null);
  if v is distinct from 'Plan · x.in · 3 seats · 1 Mar–31 May 2027 (part 3)' then raise exception 'C FAIL: %', v; end if;
  raise notice 'C PASS';

  v := public.part_request_line_name('Plan', 'x.in', 3, '1 Mar–31 May 2027', 5, 4);
  if v is distinct from 'Plan · x.in · 3 seats · 1 Mar–31 May 2027 (part 5)' then raise exception 'D FAIL: %', v; end if;
  raise notice 'D PASS';

  -- F. N = term ÷ cycle months (CYCLE_MONTHS), null when unknown / not whole
  if public.part_request_parts_in_term(12, 'monthly') is distinct from 12 or public.part_request_parts_in_term(12, 'quarterly') is distinct from 4
     or public.part_request_parts_in_term(12, 'half_yearly') is distinct from 2 or public.part_request_parts_in_term(12, 'yearly') is distinct from 1
     or public.part_request_parts_in_term(1, 'monthly') is distinct from 1
     or public.part_request_parts_in_term(10, 'quarterly') is not null
     or public.part_request_parts_in_term(null, 'monthly') is not null
     or public.part_request_parts_in_term(12, 'weekly') is not null then
    raise exception 'F FAIL: parts_in_term'; end if;
  raise notice 'F PASS';

  if not exists (select 1 from pg_proc
                  where oid = to_regprocedure('public.bill_subscription_instalment(uuid,boolean)')
                    and prosrc like '%part_request_line_name%' and prosrc like '%R-2230%') then
    raise exception 'E FAIL: bill_subscription_instalment does not name the line with part_request_line_name (or lost R-2230)'; end if;
  raise notice 'E PASS';
end $$;

select 'R-2423 part line text: ALL PASS' as result;

rollback;
