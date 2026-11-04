-- deploy-peek: exists (select 1 from pg_attrdef d join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum where d.adrelid = to_regclass('public.personal_owe_hold') and a.attname = 'occurred_on' and pg_get_expr(d.adbin, d.adrelid) ~* 'ist_today\(\)')
-- deploy-key: r2391oweholdistdefault
-- 20261102191625_r2391_owe_hold_ist_default
--
-- R-2391 (p0, 3 Nov 2026). R-2386 (20261102183751) made public.personal_owe_hold with
-- `occurred_on date not null default current_date` — the UTC day on Cloud SQL, so an entry
-- saved between 00:00 and 05:30 IST got yesterday's date. supabase/tests/night_ist_pin.test.sql
-- (R-1826 ratchet) caught it and turned the SQL tests red. Same rule as R-1828: the IST day.
alter table public.personal_owe_hold alter column occurred_on set default public.ist_today();
