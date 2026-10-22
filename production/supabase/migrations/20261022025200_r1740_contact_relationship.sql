-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contacts' and column_name = 'relationship_type') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contacts' and column_name = 'closeness')
-- ============================================================================
-- R-1740 (22 Oct 2026, Pardeep) — my relationship with a contact: type + closeness.
--
-- BEFORE: contacts.relationship was one dropdown (Partner / Vendor / Employee / Personal /
-- Not decided) that mixed a business ROLE with a personal TIE; no friend / relative /
-- unknown, and it showed nowhere except the Contacts grouping.
--
-- WHAT THIS DOES
--   1. contacts.relationship_type — who they are to me. NOT NULL, default 'unknown', so
--      "not chosen yet" has exactly one meaning at every reader (a fresh lead's anchor
--      contact, an import, an old row). professional: client | partner | vendor |
--      colleague; personal: friend | relative | acquaintance; unknown.
--   2. contacts.closeness — close | known | weak; optional (null = not set).
--   3. Maps the old values once: partner -> partner, vendor -> vendor, employee ->
--      colleague, personal -> friend, other / empty -> unknown. Same rule as
--      mapLegacyRelationship() in src/lib/contacts/relationship.ts.
--
-- The old column contacts.relationship is KEPT (not dropped) and left as it was: from R-1740
-- the app no longer reads or writes it, so a later card can drop it once nothing older is
-- running. No function, policy or grant changes: the table-level grants and the existing
-- contacts RLS policies cover the new columns.
-- ============================================================================

alter table public.contacts
  add column if not exists relationship_type text not null default 'unknown',
  add column if not exists closeness         text;

alter table public.contacts drop constraint if exists contacts_relationship_type_check;
alter table public.contacts add constraint contacts_relationship_type_check
  check (relationship_type in ('client', 'partner', 'vendor', 'colleague',
                               'friend', 'relative', 'acquaintance', 'unknown'));

alter table public.contacts drop constraint if exists contacts_closeness_check;
alter table public.contacts add constraint contacts_closeness_check
  check (closeness is null or closeness in ('close', 'known', 'weak'));

-- One-time mapping of the old values. Only rows still at the default are touched, so a
-- re-run never overwrites a relationship the owner has chosen since.
update public.contacts
   set relationship_type = case lower(btrim(relationship))
                             when 'partner'  then 'partner'
                             when 'vendor'   then 'vendor'
                             when 'employee' then 'colleague'
                             when 'personal' then 'friend'
                             else 'unknown'
                           end
 where relationship is not null
   and btrim(relationship) <> ''
   and relationship_type = 'unknown';

comment on column public.contacts.relationship_type is
  'R-1740: my relationship with this person. client|partner|vendor|colleague (professional), friend|relative|acquaintance (personal), unknown (not chosen, the default).';
comment on column public.contacts.closeness is
  'R-1740: how close: close|known|weak. NULL = not set.';
comment on column public.contacts.relationship is
  'Superseded by relationship_type (R-1740). Kept; not read or written by the app. Drop in a later card.';
