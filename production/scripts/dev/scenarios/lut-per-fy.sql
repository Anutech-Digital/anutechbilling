-- R-2458 scenario "lut-per-fy" — loaded by scripts/dev/scenario.mjs (after _common.sql, one transaction).
-- R-2444 / R-2440: the company's LUT (Letter of Undertaking, RFD-11) for the last FY and this FY, so a
-- 0% export (USD receipt, foreign-customer invoice) has its LUT. Needs tenant_luts (migration R-2444).
-- To see the "No LUT for FY …" refusal, delete this FY's row in Settings → Company → LUT (or --clear).

-- The scenario owns E2E Test Co's LUT for these two FYs (one per FY): a row someone added by hand goes.
delete from public.tenant_luts
 where tenant_id = :'tenant'
   and fy_start >= (make_date(extract(year from current_date - interval '3 months')::int, 4, 1) - interval '1 year')::date;

insert into public.tenant_luts (id, tenant_id, fy_start, arn, valid_from, valid_upto) values
  ('c2458000-0000-4000-8000-000000000031', :'tenant',
   (make_date(extract(year from current_date - interval '3 months')::int, 4, 1) - interval '1 year')::date,
   'AD2703250024581', (make_date(extract(year from current_date - interval '3 months')::int, 4, 1) - interval '1 year')::date,
   (make_date(extract(year from current_date - interval '3 months')::int, 4, 1) - interval '1 day')::date),
  ('c2458000-0000-4000-8000-000000000032', :'tenant',
   make_date(extract(year from current_date - interval '3 months')::int, 4, 1),
   'AD2704260024582', make_date(extract(year from current_date - interval '3 months')::int, 4, 1),
   (make_date(extract(year from current_date - interval '3 months')::int, 4, 1) + interval '1 year' - interval '1 day')::date);
