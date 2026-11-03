-- deploy-peek: (to_regclass('public.personal_contacts') is not null and exists(select 1 from pg_policies where schemaname = 'public' and tablename = 'personal_contacts' and policyname = 'personal_contacts_service_role') and exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'personal_transactions' and column_name = 'contact_id'))
-- deploy-key: r2392personalcontacts
-- R-2392 (goal G-PERSONAL, 3 Nov 2026): Private Vault → People (personal contacts).
--
-- Pardeep (3 Nov, "Add a loan you took" → Type "From a person" → Lender was a free-text box):
-- "from a person karne par contact list show honi chahiye". The vault had no personal
-- contacts: the same person was typed (and spelt) differently in Loans, Owe-hold and
-- Income & Expenses, so nothing added up per person.
--
-- What this adds
--   * personal_contacts — the owner's OWN people (family, friends, a business contact):
--       name (1–120), relation family/friend/business/other, phone, email, PAN (optional,
--       ABCDE1234F), note, archived. One active contact per name (case-insensitive) per owner,
--       so "Ramesh" and "ramesh " cannot both be picked.
--     It is NOT the company's customers / contacts and never joins them: a separate table,
--     owner-only RLS, no FK to any business table.
--   * contact_id (optional) on personal_loans, personal_owe_hold and personal_transactions,
--     an owner-safe composite FK (contact_id, owner_user_id) → personal_contacts (id,
--     owner_user_id), like GP-12a's account link: owner A cannot link owner B's contact even
--     from a service-role job that skips RLS. ON DELETE SET NULL (contact_id) — the row keeps
--     its party text.
--   * party stays filled (backward compatible — every screen, CSV and RPC still reads party):
--       vault_contact_fill_party()   BEFORE INSERT/UPDATE on the three tables: when contact_id
--                                    is set, party := the contact's name.
--       vault_contact_rename_party() AFTER UPDATE OF name on personal_contacts: linked rows
--                                    take the new name (one fact, one place).
--     Both SECURITY INVOKER: they read / write only rows the caller's RLS already allows.
--     Not personal_* named on purpose — they are triggers, not RPCs (personal-allowlist ratchet).
--
-- The privacy rule is the one from 20260819170000_owner_personal_vault.sql, unchanged:
--     owner_user_id = auth.uid()  AND  tenant_id = current_tenant_id()
-- plus the R-450 service_role policy (Cloud SQL has no BYPASSRLS).

begin;

-- ─── 1. contacts ───────────────────────────────────────────────────────────
create table if not exists public.personal_contacts (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  owner_user_id uuid not null references public.users(id) on delete cascade,
  name          text not null check (length(btrim(name)) between 1 and 120),
  relation      text not null default 'other' check (relation in ('family', 'friend', 'business', 'other')),
  phone         text check (phone is null or length(phone) <= 20),
  email         text check (email is null or length(email) <= 200),
  pan           text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  note          text check (note is null or length(note) <= 500),
  archived      boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint personal_contacts_id_owner_key unique (id, owner_user_id)
);

comment on table public.personal_contacts is
  'R-2392: the owner''s own people (family, friends) for Private Vault loans, owe/hold and income/expense party. Never the company''s customers or contacts. Private to owner_user_id.';
comment on column public.personal_contacts.pan is 'Optional PAN (ABCDE1234F), e.g. for a loan given with interest.';
comment on column public.personal_contacts.archived is 'Hidden from the person picker; linked rows keep the link.';

create unique index if not exists personal_contacts_owner_name_key
  on public.personal_contacts (owner_user_id, lower(btrim(name)))
  where not archived;

alter table public.personal_contacts enable row level security;

drop policy if exists personal_contacts_all on public.personal_contacts;
create policy personal_contacts_all on public.personal_contacts
  for all
  using      (owner_user_id = auth.uid() and tenant_id = current_tenant_id())
  with check (owner_user_id = auth.uid() and tenant_id = current_tenant_id());

-- R-450: Cloud SQL has no BYPASSRLS; a server job (DPDP export/delete) needs its own policy.
drop policy if exists personal_contacts_service_role on public.personal_contacts;
create policy personal_contacts_service_role on public.personal_contacts
  for all to service_role using (true) with check (true);

revoke all on public.personal_contacts from anon, public;
grant select, insert, update, delete on public.personal_contacts to authenticated;
grant all on public.personal_contacts to service_role;

-- ─── 2. contact_id on loans, owe/hold, transactions (owner-safe FK) ───────
alter table public.personal_loans        add column if not exists contact_id uuid;
alter table public.personal_owe_hold     add column if not exists contact_id uuid;
alter table public.personal_transactions add column if not exists contact_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'personal_loans_contact_owner_fkey') then
    alter table public.personal_loans
      add constraint personal_loans_contact_owner_fkey
      foreign key (contact_id, owner_user_id)
      references public.personal_contacts (id, owner_user_id)
      on delete set null (contact_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_owe_hold_contact_owner_fkey') then
    alter table public.personal_owe_hold
      add constraint personal_owe_hold_contact_owner_fkey
      foreign key (contact_id, owner_user_id)
      references public.personal_contacts (id, owner_user_id)
      on delete set null (contact_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'personal_transactions_contact_owner_fkey') then
    alter table public.personal_transactions
      add constraint personal_transactions_contact_owner_fkey
      foreign key (contact_id, owner_user_id)
      references public.personal_contacts (id, owner_user_id)
      on delete set null (contact_id);
  end if;
end $$;

comment on column public.personal_loans.contact_id is 'R-2392: the person (personal_contacts) for a loan from / to a person. party keeps the name.';
comment on column public.personal_owe_hold.contact_id is 'R-2392: the person the money is owed to / held for. party keeps the name.';
comment on column public.personal_transactions.contact_id is 'R-2392: who paid / was paid, when it is one of the owner''s people. party keeps the name.';

create index if not exists personal_loans_contact_idx
  on public.personal_loans (contact_id, owner_user_id) where contact_id is not null;
create index if not exists personal_owe_hold_contact_idx
  on public.personal_owe_hold (contact_id, owner_user_id) where contact_id is not null;
create index if not exists personal_transactions_contact_idx
  on public.personal_transactions (contact_id, owner_user_id) where contact_id is not null;

-- ─── 3. party follows the contact's name ───────────────────────────────────
create or replace function public.vault_contact_fill_party()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_name text;
begin
  if new.contact_id is not null then
    select c.name into v_name
      from public.personal_contacts c
     where c.id = new.contact_id and c.owner_user_id = new.owner_user_id;
    if v_name is not null then
      new.party := v_name;
    end if;
  end if;
  return new;
end;
$$;

comment on function public.vault_contact_fill_party() is
  'R-2392 trigger: a vault row linked to a personal contact carries the contact''s name in party.';

create or replace function public.vault_contact_rename_party()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.name is distinct from old.name then
    update public.personal_loans        set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
    update public.personal_owe_hold     set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
    update public.personal_transactions set party = new.name where contact_id = new.id and owner_user_id = new.owner_user_id;
  end if;
  return new;
end;
$$;

comment on function public.vault_contact_rename_party() is
  'R-2392 trigger: renaming a personal contact renames the party on every linked loan, owe/hold and transaction row.';

revoke all on function public.vault_contact_fill_party()   from public, anon;
revoke all on function public.vault_contact_rename_party() from public, anon;
grant execute on function public.vault_contact_fill_party()   to authenticated, service_role;
grant execute on function public.vault_contact_rename_party() to authenticated, service_role;

drop trigger if exists personal_loans_contact_party on public.personal_loans;
create trigger personal_loans_contact_party
  before insert or update of contact_id, party on public.personal_loans
  for each row execute function public.vault_contact_fill_party();

drop trigger if exists personal_owe_hold_contact_party on public.personal_owe_hold;
create trigger personal_owe_hold_contact_party
  before insert or update of contact_id, party on public.personal_owe_hold
  for each row execute function public.vault_contact_fill_party();

drop trigger if exists personal_transactions_contact_party on public.personal_transactions;
create trigger personal_transactions_contact_party
  before insert or update of contact_id, party on public.personal_transactions
  for each row execute function public.vault_contact_fill_party();

drop trigger if exists personal_contacts_rename_party on public.personal_contacts;
create trigger personal_contacts_rename_party
  after update of name on public.personal_contacts
  for each row execute function public.vault_contact_rename_party();

commit;
