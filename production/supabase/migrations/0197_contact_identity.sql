-- 0197 — Durable contact identity (Layer 2).
--
-- Problem: one real person enquires from several emails / phones over time. The
-- contact book deduped only at display time (0197 L1, client-side). There was no
-- persistent identity: nothing stopped a fresh enquiry from a new address from
-- looking like a brand-new person, and nothing accumulated a person's channels.
--
-- This migration makes the identity durable:
--   1. leads.contact_id  — every lead points at the ONE master contact (person).
--   2. resolve_or_create_contact() — given an email/phone, finds the existing
--      person who already owns that email OR phone (India: last-10-digit match)
--      and enriches their channel arrays, else creates a new master contact.
--   3. A BEFORE INSERT trigger on leads auto-links every lead (inbound webhook,
--      manual add, promote-from-contact — all paths) with zero app rewiring.
--   4. Backfill: link every existing lead to a master contact.
--
-- Google-sync safety: auto-created master contacts get source='enquiry'. The
-- Google push loop (lib/google/contacts.ts) skips source='enquiry' so these
-- shadow rows are NOT pushed to Google — the lead/customer already carries the
-- person there, so no duplicate Google contacts. The in-app unified view (L1)
-- merges the shadow with its lead by shared email/phone + contact_id, so the
-- person never shows twice.

-- ── 1. Allow the new 'enquiry' source on contacts ────────────────────────────
alter table public.contacts drop constraint if exists contacts_source_check;
alter table public.contacts add constraint contacts_source_check
  check (source = any (array[
    'manual','google_csv','google_api','outlook','linkedin','event','other','enquiry'
  ]));

-- ── 2. Link a lead to the master contact (person) it belongs to ──────────────
alter table public.leads
  add column if not exists contact_id text references public.contacts(id) on delete set null;

create index if not exists leads_contact_id_idx on public.leads (contact_id) where contact_id is not null;

comment on column public.leads.contact_id is
  'The master contact (person) this lead belongs to. Auto-linked on insert via resolve_or_create_contact; one person can have many leads.';

-- ── 3. Identity resolver ─────────────────────────────────────────────────────
-- Returns the id of the ONE master contact owning this email/phone within the
-- tenant, creating it if none exists and enriching its channel arrays otherwise.
-- Matching is India-aware: phones compare on the last 10 significant digits so
-- +91 / 0 / spaced variants of one number unify. Returns NULL when there is no
-- usable identity signal (no email and no >=10-digit phone).
create or replace function public.resolve_or_create_contact(
  p_tenant  uuid,
  p_email   text,
  p_phone   text,
  p_name    text,
  p_company text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := nullif(lower(trim(coalesce(p_email, ''))), '');
  v_digits   text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_phone10  text;
  v_id       text;
begin
  if length(v_digits) >= 10 then
    v_phone10 := right(v_digits, 10);
  else
    v_phone10 := null;
  end if;

  -- An email needs an '@' to be a real signal.
  if v_email is not null and position('@' in v_email) = 0 then
    v_email := null;
  end if;

  if v_email is null and v_phone10 is null then
    return null;  -- nothing to identify on
  end if;

  -- Find an existing identity that already owns this email OR phone.
  select c.id into v_id
  from public.contacts c
  where c.tenant_id = p_tenant
    and (
      (v_email is not null and exists (
        select 1 from jsonb_array_elements(c.emails) e
        where lower(trim(e->>'value')) = v_email
      ))
      or (v_phone10 is not null and exists (
        select 1 from jsonb_array_elements(c.phones) ph
        where right(regexp_replace(coalesce(ph->>'value', ''), '\D', '', 'g'), 10) = v_phone10
      ))
    )
  order by c.created_at asc
  limit 1;

  if v_id is not null then
    -- Enrich: append this email if the identity doesn't already carry it.
    if v_email is not null and not exists (
      select 1 from jsonb_array_elements((select emails from public.contacts where id = v_id)) e
      where lower(trim(e->>'value')) = v_email
    ) then
      update public.contacts
         set emails = emails || jsonb_build_array(jsonb_build_object('value', trim(p_email), 'label', 'other')),
             email  = coalesce(nullif(email, ''), trim(p_email))
       where id = v_id;
    end if;
    -- Enrich phone (compare on last-10).
    if v_phone10 is not null and not exists (
      select 1 from jsonb_array_elements((select phones from public.contacts where id = v_id)) ph
      where right(regexp_replace(coalesce(ph->>'value', ''), '\D', '', 'g'), 10) = v_phone10
    ) then
      update public.contacts
         set phones = phones || jsonb_build_array(jsonb_build_object('value', trim(p_phone), 'label', 'mobile')),
             phone  = coalesce(nullif(phone, ''), trim(p_phone))
       where id = v_id;
    end if;
    return v_id;
  end if;

  -- No match → create a new master contact (a 'shadow' of the lead/customer;
  -- not pushed to Google — see migration header).
  v_id := 'C-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
  insert into public.contacts (id, tenant_id, full_name, company, email, phone, emails, phones, source, status)
  values (
    v_id,
    p_tenant,
    coalesce(nullif(trim(coalesce(p_name, '')), ''), nullif(trim(coalesce(p_company, '')), ''), v_email, 'Unknown'),
    nullif(trim(coalesce(p_company, '')), ''),
    v_email,
    nullif(trim(coalesce(p_phone, '')), ''),
    case when v_email  is not null then jsonb_build_array(jsonb_build_object('value', trim(p_email), 'label', 'other'))  else '[]'::jsonb end,
    case when v_phone10 is not null then jsonb_build_array(jsonb_build_object('value', trim(p_phone), 'label', 'mobile')) else '[]'::jsonb end,
    'enquiry',
    'engaged'
  );
  return v_id;
end;
$$;

-- Internal-only: called by the trigger (definer) and by the inbound webhook via
-- the service-role admin client. NOT granted to authenticated (clients create
-- contacts through the existing RLS-guarded insert path, not this resolver).
revoke all on function public.resolve_or_create_contact(uuid, text, text, text, text) from public;
grant execute on function public.resolve_or_create_contact(uuid, text, text, text, text) to service_role;

-- ── 4. Auto-link every new lead to its master contact ────────────────────────
create or replace function public.leads_autolink_contact()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.contact_id is null then
    begin
      new.contact_id := public.resolve_or_create_contact(
        new.tenant_id, new.contact_email, new.contact_phone, new.contact_name, new.company
      );
    exception when others then
      -- Identity resolution must NEVER block a lead from being created.
      new.contact_id := null;
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leads_autolink_contact on public.leads;
create trigger trg_leads_autolink_contact
  before insert on public.leads
  for each row execute function public.leads_autolink_contact();

-- ── 5. Backfill: link every existing lead to a master contact ────────────────
do $$
declare
  r   record;
  cid text;
begin
  for r in
    select id, tenant_id, contact_email, contact_phone, contact_name, company
    from public.leads
    where contact_id is null
  loop
    cid := public.resolve_or_create_contact(r.tenant_id, r.contact_email, r.contact_phone, r.contact_name, r.company);
    if cid is not null then
      update public.leads set contact_id = cid where id = r.id;
    end if;
  end loop;
end $$;
