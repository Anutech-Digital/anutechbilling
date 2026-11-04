-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'consent_events' and column_name = 'form') and exists(select 1 from pg_constraint where conname = 'consent_events_source_check' and pg_get_constraintdef(oid) like '%form%')
-- deploy-key: r2011formconsent
-- 20261101203103_r2011_form_consent.sql
--
-- R-2011 (1 Nov 2026, goal G-DPDP). Every website form now shows a short data notice next to its
-- button and a separate, UNTICKED "Send me offers on email/WhatsApp" box. When the form is sent,
-- the server records ONE row in consent_events (R-2010, insert-only):
--   purpose 'marketing' · choice granted (box ticked) / denied (box left empty — the notice was
--   shown and no offers were asked for) · notice_version · lead_id · source 'form' · form (which
--   form: buy_checkout, enquiry, trial, …) · time · IP only as the HMAC.
-- WhatsApp broadcasts and email campaigns then send only to leads whose LATEST marketing row is
-- 'granted'; a lead with no row (all older leads) is skipped as "no consent".
--
-- ─── WHAT CHANGES ──────────────────────────────────────────────────────────
--   source   + 'form' (was banner, checkout, signup, upgrade).
--   form     new text column: which website form recorded the row (lower-case key, ≤ 40).
-- Nothing else: still insert-only (the GP-03 trigger compares the whole row, form included),
-- same grants and RLS. No existing row changes.
--
-- Test: supabase/tests/r2011_form_consent.test.sql

begin;

alter table public.consent_events add column if not exists form text;

alter table public.consent_events drop constraint if exists consent_events_form_check;
alter table public.consent_events
  add constraint consent_events_form_check
  check (form is null or form ~ '^[a-z][a-z0-9_]{0,39}$');

alter table public.consent_events drop constraint if exists consent_events_source_check;
alter table public.consent_events
  add constraint consent_events_source_check
  check (source in ('banner', 'checkout', 'signup', 'upgrade', 'form'));

comment on column public.consent_events.form is
  'R-2011: the website form that recorded this row (source = form), e.g. buy_checkout, enquiry, trial.';

commit;
