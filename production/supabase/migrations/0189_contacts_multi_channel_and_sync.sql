-- 0189 — Multiple emails/phones per contact + Google Contacts sync scaffolding.
--
-- Real people have >1 phone (personal + office) and >1 email. Fixed extra
-- columns don't scale and don't map to Google Contacts (which stores arrays of
-- emails/phones, each with a label). So we store arrays and keep the existing
-- `email`/`phone` columns as the PRIMARY (index 0) for backward-compat — every
-- existing consumer (list, reach buttons, dedupe, campaigns, AI) keeps working.
--
-- Also lays the groundwork for two-way Google Contacts sync:
--   • external_id already holds the Google `resourceName` (people/cNNN)
--   • google_etag  — People API etag, required for safe write-back
--   • google_synced_at — last time this row was reconciled with Google
--   • a unique (tenant_id, external_id) index so pull-sync can upsert by resource
--   • an updated_at trigger (contacts never had one) so "who changed last" is real

-- Arrays of { "value": text, "label": "mobile"|"work"|"home"|"other" }.
alter table public.contacts
  add column if not exists emails jsonb not null default '[]'::jsonb,
  add column if not exists phones jsonb not null default '[]'::jsonb,
  add column if not exists google_etag text,
  add column if not exists google_synced_at timestamptz;

-- Backfill the arrays from the existing single primary email/phone so current
-- contacts show their value in the new multi-value UI. Only when the array is
-- still empty (idempotent re-run safe).
update public.contacts
   set emails = jsonb_build_array(jsonb_build_object('value', email, 'label', 'other'))
 where email is not null and email <> '' and emails = '[]'::jsonb;

update public.contacts
   set phones = jsonb_build_array(jsonb_build_object('value', phone, 'label', 'mobile'))
 where phone is not null and phone <> '' and phones = '[]'::jsonb;

-- Pull-sync upserts contacts by their Google resourceName within a tenant.
create unique index if not exists contacts_tenant_external_uidx
  on public.contacts (tenant_id, external_id)
  where external_id is not null;

-- Contacts had no updated_at trigger (the table predates 0001's wiring). Add one
-- using the existing helper so last-write-wins conflict resolution is trustworthy.
drop trigger if exists trg_contacts_updated_at on public.contacts;
create trigger trg_contacts_updated_at
  before update on public.contacts
  for each row execute function public.handle_updated_at();

comment on column public.contacts.emails is 'All emails: array of {value,label}. contacts.email mirrors the primary (index 0).';
comment on column public.contacts.phones is 'All phones: array of {value,label}. contacts.phone mirrors the primary (index 0).';
comment on column public.contacts.google_etag is 'Google People API etag for this contact (for safe write-back).';
comment on column public.contacts.google_synced_at is 'Last time this contact was reconciled with Google Contacts.';
