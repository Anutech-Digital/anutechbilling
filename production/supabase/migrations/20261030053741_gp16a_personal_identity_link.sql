-- deploy-peek: to_regclass('public.personal_identity_link') is not null and to_regprocedure('public.link_personal_identity(uuid,uuid,uuid)') is not null
-- deploy-key: gp16apersonalidentitylink
-- deploy-user: postgres
-- 20261030053741_gp16a_personal_identity_link.sql
--
-- R-2118 (GP-16a, goal G-PERSONAL, 30 Oct 2026): a verified personal signup gets, all together
-- (Pardeep's decision D4): ONE Anutech individual customer, a customer panel (DMS) account
-- request and a Free support desk.
--
-- THE GAP (G-PERSONAL audit): nothing connected a personal workspace to the person's customer
-- record or DMS account. A DMS account was queued only by a received payment (R-2103) and a Free
-- desk only by an active subscription (R-2102/R-2107), so a free personal signup got neither,
-- and SSO into the DMS panel refused them.
--
-- THE TRAP (not used): customers.linked_tenant_id / tenants.parent_tenant_id would mirror every
-- Anutech invoice into the personal tenant as a "Wholesale supply … your distributor" vendor bill
-- (tg_mirror_invoice_to_child_vendor_bill) and show the person in get_partner_metrics. This
-- migration sets neither; the link lives in its own table.
--
-- WHAT IS HERE
--   table personal_identity_link    one row per login (auth_user_id PK); the person reads only
--                                   their own row; nobody writes from the browser
--   support_sync_outbox.subscription_id  now NULLABLE — a signup Free desk has no subscription
--                                   (the cron and DSP never read the column)
--   panel_account_outbox.source     + 'personal-signup'
--   link_personal_identity(p_user, p_tenant, p_seller_tenant)   SECURITY DEFINER, service_role
--                                   only. p_seller_tenant = the website company (BUY_PAGE_TENANT_ID,
--                                   lib/website-tenant.ts) — the database does not know Anutech's id.
--     · raises unless auth.users.email_confirmed_at is set (password + Google/Auth.js both stamp it):
--       email is the only cross-app identity, an unverified address must never reach DMS/support;
--     · p_tenant must be a 'personal' workspace and p_user its member;
--     · matches the seller's INDIVIDUAL customer with that email, else creates one
--       (customer_type 'individual' → gst_treatment 'consumer' by the R-1736 trigger);
--     · email already on a COMPANY customer of the seller → GATED (owner decision open on the
--       card: link to it / separate individual / ask the person): returns needs_decision, stores
--       the link without a customer, creates and queues nothing;
--     · queues panel_account_outbox (source personal-signup) and a Free support_sync_outbox row
--       (skipped when the customer already has a support row or a live paid support plan);
--     · idempotent: a second call returns already_linked and writes nothing.
--   trg_gp16a_link_dms_user        panel account done → dms_user_id copied into the link.
-- Test: supabase/tests/gp16a_personal_identity_link.test.sql
--
-- WHY deploy-user: postgres (R-2118 fix, 30 Oct 2026): the staging DB step stopped here with
-- "permission denied for table users" — auth_user_id references auth.users(id), and on Cloud SQL
-- resellersos_migration has SELECT on auth.users (cloudsql/06) but not REFERENCES. postgres has it
-- (member of supabase_auth_admin). At the end the table and both functions are handed back to
-- resellersos_migration (postgres is a member of it, cloudsql/05-07), like every other app object:
-- RLS on customers/outboxes is skipped only for their owner (no BYPASSRLS on Cloud SQL, R-450),
-- the definer reads auth.users with that same SELECT, and later migrations run as that user.
-- Grants to anon/authenticated/service_role are kept by the owner change. No such role (local
-- Supabase) → skipped. Re-runnable: if not exists / or replace / drop … if exists throughout,
-- and the whole file is one transaction, so the failed run left nothing behind.

begin;

-- ── table ───────────────────────────────────────────────────────────────────
create table if not exists public.personal_identity_link (
  auth_user_id        uuid primary key references auth.users(id) on delete cascade,
  personal_tenant_id  uuid not null references public.tenants(id) on delete cascade,
  seller_tenant_id    uuid references public.tenants(id) on delete set null,
  anutech_customer_id uuid references public.customers(id) on delete set null,
  dms_user_id         text,
  email               text not null,
  link_status         text not null default 'linked'
                      check (link_status in ('linked', 'needs_decision')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint personal_identity_link_tenant_uq unique (personal_tenant_id)
);

comment on table public.personal_identity_link is
  'R-2118 GP-16a: a personal login ↔ its personal workspace, its Anutech individual customer and its DMS panel user. Written only by link_personal_identity (service_role).';

create index if not exists personal_identity_link_customer_idx
  on public.personal_identity_link (anutech_customer_id) where anutech_customer_id is not null;

alter table public.personal_identity_link enable row level security;
drop policy if exists personal_identity_link_own_read on public.personal_identity_link;
create policy personal_identity_link_own_read on public.personal_identity_link
  for select to authenticated using (auth_user_id = auth.uid());
drop policy if exists personal_identity_link_service_role on public.personal_identity_link;
-- R-450: Cloud SQL has no BYPASSRLS; the server client needs its own policy.
create policy personal_identity_link_service_role on public.personal_identity_link
  for all to service_role using (true) with check (true);
revoke all on public.personal_identity_link from public, anon, authenticated;
grant select on public.personal_identity_link to authenticated;
grant all on public.personal_identity_link to service_role;

-- ── outboxes ────────────────────────────────────────────────────────────────
alter table public.support_sync_outbox alter column subscription_id drop not null;

alter table public.panel_account_outbox drop constraint if exists panel_account_outbox_source_check;
alter table public.panel_account_outbox add constraint panel_account_outbox_source_check
  check (source in ('payment', 'backfill', 'panel-order', 'personal-signup'));

-- ── the link ────────────────────────────────────────────────────────────────
create or replace function public.link_personal_identity(
  p_user          uuid,
  p_tenant        uuid,
  p_seller_tenant uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
-- R-2118
declare
  v_link      public.personal_identity_link%rowtype;
  v_auth      record;
  v_email     text;
  v_kind      text;
  v_name      text;
  v_customer  uuid;
  v_created   boolean := false;
  v_c         record;
  v_panel     boolean := false;
  v_support   boolean := false;
  v_dms       text;
  v_n         integer;
begin
  if p_user is null or p_tenant is null or p_seller_tenant is null then
    raise exception 'link_personal_identity: user, personal workspace and seller company are all required'
      using errcode = '22023';
  end if;
  if p_tenant = p_seller_tenant then
    raise exception 'link_personal_identity: the personal workspace cannot be the seller company'
      using errcode = '22023';
  end if;

  -- One signup at a time per login (both doors may call at once).
  perform pg_advisory_xact_lock(hashtextextended('gp16a:' || p_user::text, 0));

  select * into v_link from public.personal_identity_link where auth_user_id = p_user;
  if found and v_link.personal_tenant_id <> p_tenant then
    raise exception 'link_personal_identity: this login is already linked to another personal workspace'
      using errcode = '23505';
  end if;
  if found and v_link.link_status = 'linked' then
    return jsonb_build_object('status', 'already_linked', 'customer_id', v_link.anutech_customer_id,
                              'panel_queued', false, 'support_queued', false);
  end if;

  -- Email must be confirmed: it is the identity DMS and the support desk trust.
  select u.email, u.email_confirmed_at, u.raw_user_meta_data
    into v_auth
    from auth.users u
   where u.id = p_user and u.deleted_at is null;
  if not found then
    raise exception 'link_personal_identity: no such login' using errcode = '22023';
  end if;
  if v_auth.email_confirmed_at is null then
    raise exception 'link_personal_identity: the email is not confirmed yet — nothing is linked until it is'
      using errcode = '42501';
  end if;
  v_email := lower(btrim(v_auth.email));
  if not public.panel_account_email_ok(v_email) then
    raise exception 'link_personal_identity: the login has no usable email' using errcode = '22023';
  end if;

  select t.workspace_kind into v_kind from public.tenants t where t.id = p_tenant;
  if v_kind is distinct from 'personal' then
    raise exception 'link_personal_identity: workspace % is not a personal workspace', p_tenant
      using errcode = '22023';
  end if;
  select coalesce(nullif(btrim(u.full_name), ''), nullif(btrim(v_auth.raw_user_meta_data->>'full_name'), ''),
                  nullif(btrim(v_auth.raw_user_meta_data->>'name'), ''))
    into v_name
    from public.users u
   where u.id = p_user and u.tenant_id = p_tenant;
  if not found then
    raise exception 'link_personal_identity: this login is not a member of that personal workspace'
      using errcode = '42501';
  end if;
  v_name := coalesce(v_name, split_part(v_email, '@', 1));

  select t.workspace_kind into v_kind from public.tenants t where t.id = p_seller_tenant;
  if v_kind is distinct from 'business' then
    raise exception 'link_personal_identity: seller company % not found', p_seller_tenant
      using errcode = '22023';
  end if;

  -- The seller's customers with this email (contact_email or the primary contact's, R-2108).
  select c.id, c.customer_type
    into v_c
    from public.customers c
   where c.tenant_id = p_seller_tenant
     and (lower(btrim(c.contact_email)) = v_email
          or exists (select 1 from public.customer_contacts cc
                       join public.contacts p on p.id = cc.contact_id and p.tenant_id = c.tenant_id
                      where cc.customer_id = c.id and cc.tenant_id = c.tenant_id and cc.is_primary
                        and lower(btrim(p.email)) = v_email))
     and lower(public.customer_primary_email(c.id)) = v_email
   order by (c.customer_type = 'individual') desc, c.is_active desc, c.created_at
   limit 1;

  if found and v_c.customer_type <> 'individual' then
    -- GATED (owner decision on R-2118): the email is a company customer's. Store the login so
    -- the decision can be applied later; create and queue nothing.
    insert into public.personal_identity_link
      (auth_user_id, personal_tenant_id, seller_tenant_id, anutech_customer_id, email, link_status)
    values (p_user, p_tenant, p_seller_tenant, null, v_email, 'needs_decision')
    on conflict (auth_user_id) do update
      set updated_at = now();
    return jsonb_build_object('status', 'needs_decision', 'customer_id', null,
                              'reason', 'company_customer_email',
                              'panel_queued', false, 'support_queued', false);
  end if;

  if found then
    v_customer := v_c.id;
  else
    insert into public.customers (tenant_id, name, contact_name, contact_email, customer_type)
    values (p_seller_tenant, v_name, v_name, btrim(v_auth.email), 'individual')
    returning id into v_customer;
    v_created := true;
  end if;

  -- Customer panel (DMS) account — one per customer, ever (R-2103).
  insert into public.panel_account_outbox (tenant_id, customer_id, status, source)
  values (p_seller_tenant, v_customer, 'pending', 'personal-signup')
  on conflict (customer_id) do nothing;
  get diagnostics v_n = row_count;
  v_panel := v_n > 0;
  select o.dms_user_id into v_dms from public.panel_account_outbox o where o.customer_id = v_customer;

  -- Free support desk, unless they already have one queued/sent or a live paid plan (R-2102).
  if not exists (select 1 from public.support_sync_outbox so where so.customer_id = v_customer)
     and not exists (select 1 from public.subscriptions s
                      where s.customer_id = v_customer and s.tenant_id = p_seller_tenant
                        and s.vendor = 'support' and s.status <> 'cancelled'
                        and public.support_plan_key(s.item_id, s.plan) in ('standard', 'enterprise')) then
    insert into public.support_sync_outbox (tenant_id, subscription_id, customer_id, payload)
    select p_seller_tenant, null, c.id,
           jsonb_build_object(
             'event_type', 'subscription.updated',
             'data', jsonb_build_object(
               'billing_customer_id', coalesce(c.customer_number, c.id::text),
               'name',        coalesce(c.contact_name, c.name),
               'email',       public.customer_primary_email(c.id),
               'plan',        'free',
               'plan_key',    'free',
               'sku',         null,
               'plan_status', 'active',
               'plan_expiry', null,
               'domain',      c.domain))
      from public.customers c
     where c.id = v_customer;
    v_support := true;
  end if;

  insert into public.personal_identity_link
    (auth_user_id, personal_tenant_id, seller_tenant_id, anutech_customer_id, dms_user_id, email, link_status)
  values (p_user, p_tenant, p_seller_tenant, v_customer, v_dms, v_email, 'linked')
  on conflict (auth_user_id) do update
    set anutech_customer_id = excluded.anutech_customer_id,
        seller_tenant_id    = excluded.seller_tenant_id,
        dms_user_id         = coalesce(excluded.dms_user_id, personal_identity_link.dms_user_id),
        link_status         = 'linked',
        updated_at          = now();

  return jsonb_build_object('status', 'linked', 'customer_id', v_customer,
                            'customer_created', v_created,
                            'panel_queued', v_panel, 'support_queued', v_support);
end;
$$;

comment on function public.link_personal_identity(uuid, uuid, uuid) is
  'R-2118 GP-16a: link a verified personal login to an individual customer of the seller company + queue its DMS panel account and Free support desk. service_role only; idempotent; a company-customer email is gated (needs_decision).';
revoke all on function public.link_personal_identity(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.link_personal_identity(uuid, uuid, uuid) to service_role;

-- ── DMS user id → link ──────────────────────────────────────────────────────
create or replace function public.tg_gp16a_link_dms_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
-- R-2118: never blocks the outbox write.
begin
  begin
    update public.personal_identity_link l
       set dms_user_id = new.dms_user_id, updated_at = now()
     where l.anutech_customer_id = new.customer_id
       and l.dms_user_id is distinct from new.dms_user_id;
  exception when others then
    raise warning 'R-2118 dms_user_id not copied for customer %: %', new.customer_id, sqlerrm;
  end;
  return null;
end;
$$;
revoke all on function public.tg_gp16a_link_dms_user() from public, anon, authenticated;

drop trigger if exists trg_gp16a_link_dms_user on public.panel_account_outbox;
create trigger trg_gp16a_link_dms_user
  after insert or update of dms_user_id on public.panel_account_outbox
  for each row
  when (new.dms_user_id is not null)
  execute function public.tg_gp16a_link_dms_user();

-- ── owner back to the migration user (R-2118 fix) ───────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'resellersos_migration') then
    return;                                   -- local Supabase: no such role, postgres keeps them
  end if;
  begin   -- also when already a member: a creator may hold ADMIN but no SET (PG16+)
    execute 'grant resellersos_migration to ' || quote_ident(current_user);   -- as cloudsql/05-07
  exception when others then
    raise warning 'R-2118: could not grant resellersos_migration to %: %', current_user, sqlerrm;
  end;
  begin
    alter table public.personal_identity_link owner to resellersos_migration;
    alter function public.link_personal_identity(uuid, uuid, uuid) owner to resellersos_migration;
    alter function public.tg_gp16a_link_dms_user() owner to resellersos_migration;
  exception when others then
    -- Never stop the DB step for this: the objects work, owned by postgres. Logged so it is fixed by hand.
    raise warning 'R-2118: personal_identity_link / link_personal_identity stay owned by % (%) — run cloudsql/05 then re-run this file', current_user, sqlerrm;
  end;
end
$$;

commit;
