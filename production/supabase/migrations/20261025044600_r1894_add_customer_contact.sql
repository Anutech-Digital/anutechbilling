-- deploy-peek: to_regprocedure('public.add_customer_contact(uuid,text,text,text,text,text)') is not null and to_regprocedure('public.r1894_link_orphan_contacts()') is not null
-- R-1894 (25 Oct 2026, Pardeep, localhost check of R-1893): "Add contact" on a company profile
-- saved the person and they vanished.
--
-- The Contacts card's "Add contact" inserted only a `contacts` row (with the legacy
-- customer_id). Everything that shows or uses a customer's people — the Contacts card, the
-- header, primaryContactsFor (invoice and reminder recipient) — reads the LINK table
-- customer_contacts (since 20260918090000), and nothing created the link. So the person was
-- saved and served nobody.
--
-- This migration:
--   1. add_customer_contact(...) — the ONE step that adds a person to a customer: finds the
--      same person in this company's address book (email, else the last 10 digits of the
--      phone) or creates them, and links them to the customer — in one transaction, so a
--      person can never be saved without the link. The link is primary when it is the
--      customer's first; an existing person's details are never overwritten.
--   2. r1894_link_orphan_contacts() — run once: every contact whose customer_id is set but has
--      no customer_contacts row for that customer gets its link. A customer with no primary
--      gets its oldest such contact as primary; an existing primary is never changed and an
--      existing link is never touched.

create or replace function public.add_customer_contact(
  p_customer_id uuid,
  p_full_name   text,
  p_email       text default null,
  p_phone       text default null,
  p_title       text default null,
  p_role        text default 'poc'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_trusted   boolean;
  v_caller    uuid;
  v_tenant    uuid;
  v_company   text;
  v_name      text := nullif(trim(coalesce(p_full_name, '')), '');
  v_email     text := nullif(trim(coalesce(p_email, '')), '');
  v_phone     text := nullif(trim(coalesce(p_phone, '')), '');
  v_title     text := nullif(trim(coalesce(p_title, '')), '');
  v_role      text := coalesce(nullif(trim(coalesce(p_role, '')), ''), 'poc');
  v_digits    text;
  v_contact   text;
  v_existing  boolean := false;
  v_primary   boolean;
  v_linked    boolean;
begin
  -- §17c: fail CLOSED for a caller with no company.
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null and session_user::text not in ('authenticator','anon','authenticated','app_runtime'));
  v_caller := public.current_tenant_id();
  if v_caller is null and not v_trusted then
    raise exception 'R-1894: sign in to a company to add a contact.' using errcode = '28000';
  end if;

  select c.tenant_id, coalesce(nullif(trim(c.display_name), ''), c.name)
    into v_tenant, v_company
    from public.customers c
   where c.id = p_customer_id;
  if v_tenant is null or (v_caller is not null and v_tenant <> v_caller) then
    raise exception 'R-1894: customer not found.' using errcode = 'P0002';
  end if;

  if v_name is null then
    raise exception 'R-1894: a contact needs a name.' using errcode = '22023';
  end if;
  if v_role not in ('owner','accountant','it_head','poc','other') then
    raise exception 'R-1894: unknown role %.', v_role using errcode = '22023';
  end if;

  -- The same person already in this company's address book? Email first (one email is one
  -- person — contacts_unique_email_per_tenant), else the last 10 digits of the phone.
  if v_email is not null then
    select p.id into v_contact
      from public.contacts p
     where p.tenant_id = v_tenant and lower(p.email) = lower(v_email)
     order by p.created_at, p.id
     limit 1;
  end if;
  v_digits := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
  if v_contact is null and length(v_digits) >= 10 then
    select p.id into v_contact
      from public.contacts p
     where p.tenant_id = v_tenant
       and right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 10) = right(v_digits, 10)
     order by p.created_at, p.id
     limit 1;
  end if;
  v_existing := v_contact is not null;

  -- Already linked to this customer: nothing to add, say so (never a second link).
  select true, cc.is_primary into v_linked, v_primary
    from public.customer_contacts cc
   where cc.customer_id = p_customer_id and cc.contact_id = v_contact;
  if coalesce(v_linked, false) then
    return jsonb_build_object('contact_id', v_contact, 'existing', true,
                              'already_linked', true, 'is_primary', v_primary);
  end if;

  -- The customer's first person receives the invoices and reminders.
  v_primary := not exists (select 1 from public.customer_contacts cc
                            where cc.customer_id = p_customer_id and cc.is_primary);

  if not v_existing then
    v_contact := 'C-' || upper(to_hex((extract(epoch from clock_timestamp()) * 1000)::bigint))
                 || '-' || upper(substr(md5(random()::text), 1, 4));
    insert into public.contacts (
      id, tenant_id, full_name, email, phone, title, company, role,
      customer_id, is_primary, emails, phones, source, status)
    values (
      v_contact, v_tenant, v_name, v_email, v_phone, v_title, v_company, v_role,
      -- Legacy home customer + legacy primary flag, kept only for old readers; the legacy
      -- one-primary index (contacts_one_primary_per_customer) must not be broken.
      p_customer_id,
      v_primary and not exists (select 1 from public.contacts o
                                 where o.customer_id = p_customer_id and o.is_primary),
      case when v_email is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('value', v_email, 'label', 'other')) end,
      case when v_phone is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object('value', v_phone, 'label', 'mobile')) end,
      'manual', 'engaged');
  end if;

  insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary)
  values (v_tenant, p_customer_id, v_contact, v_role, v_primary);

  return jsonb_build_object('contact_id', v_contact, 'existing', v_existing,
                            'already_linked', false, 'is_primary', v_primary);
end;
$$;

revoke all on function public.add_customer_contact(uuid,text,text,text,text,text) from public, anon;
grant execute on function public.add_customer_contact(uuid,text,text,text,text,text) to authenticated, service_role;

comment on function public.add_customer_contact(uuid,text,text,text,text,text) is
  'R-1894: add a person to a customer in one step — reuse the same person (email, else last 10 '
  'phone digits) or create them, and link them (customer_contacts). First link = primary. '
  'An existing person is never overwritten.';

-- ── One-time repair: link the contacts that were saved without their link ──────────────
-- A function (not a bare INSERT) so the SQL test can run it against its own rows.
create or replace function public.r1894_link_orphan_contacts()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  with orphan as (
    select p.id as contact_id, p.tenant_id, p.customer_id,
           case when p.role in ('owner','accountant','it_head','poc','other') then p.role else 'poc' end as role,
           row_number() over (partition by p.customer_id order by p.created_at, p.id) as rn
      from public.contacts p
      join public.customers c on c.id = p.customer_id and c.tenant_id = p.tenant_id
     where p.customer_id is not null
       and not exists (select 1 from public.customer_contacts cc
                        where cc.customer_id = p.customer_id and cc.contact_id = p.id)
  )
  insert into public.customer_contacts (tenant_id, customer_id, contact_id, role, is_primary)
  select o.tenant_id, o.customer_id, o.contact_id, o.role,
         o.rn = 1 and not exists (select 1 from public.customer_contacts cc
                                   where cc.customer_id = o.customer_id and cc.is_primary)
    from orphan o
  on conflict (customer_id, contact_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.r1894_link_orphan_contacts() from public, anon, authenticated;
grant execute on function public.r1894_link_orphan_contacts() to service_role;

select public.r1894_link_orphan_contacts();
