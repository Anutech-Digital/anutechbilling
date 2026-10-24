-- deploy-peek: exists(select 1 from pg_attribute where attrelid = to_regclass('public.tenants') and attname = 'gst_rc_date' and not attisdropped) and exists(select 1 from pg_constraint where conname = 'tenants_gst_rc_date_check')
-- deploy-key: r1531gstrcdate
-- 20261019002811_r1531_gst_rc_date.sql
--
-- R-1531 (P2, Pardeep — owner decision q4 on R-1529): CGST Section 31(3)(a). A business that
-- gets GST-registered with an effective date in the past must issue a REVISED Tax Invoice for
-- each Bill of Supply it made from that effective date until its registration certificate
-- (REG-06) was issued — within ONE MONTH of the certificate date. The app reminds (on
-- /compliance and /today); it changes nothing by itself.
--
-- R-1529 stored the effective date (tenants.gst_registered_from) but not the certificate
-- date, so the last day (certificate + 1 month) could not be shown. This adds it.
--
-- ══ WHAT THIS MIGRATION DOES ═════════════════════════════════════════════════════
--  1. tenants.gst_rc_date date NULL — the day the registration certificate was issued.
--     NULL = not entered (the reminder still shows, and asks for it).
--  2. tenants_gst_rc_date_check: the certificate cannot be dated before the effective date.
--     (Not-after-today is checked by the Settings card — a CHECK cannot read the clock.)
--
-- NOT CHANGED: no row is updated (nullable, no default — no table rewrite); no policy, grant,
-- trigger or function. Owner-only update of tenants is the existing tenants_self_update policy;
-- r720_tenants_column_guard does not list this column, so the owner may set it like
-- gst_registered_from.
--
-- Proof: supabase/tests/r1531_gst_rc_date.test.sql (one rollback).

begin;

alter table public.tenants add column if not exists gst_rc_date date;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_gst_rc_date_check') then
    alter table public.tenants add constraint tenants_gst_rc_date_check
      check (gst_rc_date is null or gst_registered_from is null or gst_rc_date >= gst_registered_from);
  end if;
end $$;

comment on column public.tenants.gst_rc_date is
  'R-1531: date the GST registration certificate (REG-06) was issued. Bills of Supply dated from gst_registered_from to this date need a revised tax invoice within one month of it (CGST Section 31(3)(a)) — /compliance and /today remind. NULL = not entered.';

commit;
