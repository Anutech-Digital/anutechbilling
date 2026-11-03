-- deploy-peek: to_regclass('public.gstin_ownership_claims') is not null and exists(select 1 from pg_proc where oid = to_regprocedure('public.network_has_scope(uuid,uuid,text)') and prosrc like '%R-2445%')
-- deploy-key: r2445gstinownerverified
-- 20261103215416_r2445_gstin_owner_verified.sql
--
-- R-2445 (goal G-NETWORK, 3 Nov 2026): a company must PROVE it owns its GSTIN before it can
-- connect with another business. Spec: docs/specs/g-network.md → "GSTIN ownership".
--
-- ══ THE GAP ═══════════════════════════════════════════════════════════════════════════
--   R-2433 connected companies by tenants.gstin_verified_at. That only says the GSTIN is
--   REGISTERED and active on GSTN (/api/gstin/verify, Sandbox public search) — anyone can save
--   another firm's public GSTIN and "verify" it. The squatter then showed up in that firm's
--   customers' suggestions under its own name, and when the real firm signed up every request
--   to the GSTIN stopped with "More than one business … ask support" (first come blocks).
--
-- ══ WHY A PLATFORM-ADMIN CHECK (not OTP) ══════════════════════════════════════════════
--   Our GSTN lookup (Sandbox public search) returns legal / trade name, address, status — NOT
--   the registered email or mobile, so an OTP to the GST contact cannot be sent without a new
--   paid API (GSP taxpayer-OTP flow). So: the owner asks ("Prove you own this GSTIN"), the
--   platform admin sees company + GSTIN + GSTN legal name + any other company on the same
--   GSTIN, checks it (GST certificate REG-06 / a call to the GST-registered contact), and
--   approves or rejects. Never first come: the admin approves the real owner even if a
--   squatter asked first; approving one rejects every other pending claim on that GSTIN.
--
-- ══ WHAT IS HERE ══════════════════════════════════════════════════════════════════════
--   tenants.gstin_owner_verified_at / _gstin / _how / _by   the proof, for ONE GSTIN. A unique
--       index lets only one company hold a GSTIN. Request roles can never set these columns
--       (trigger a01_r2445…); any GSTIN change (by anyone) drops the proof at once.
--   table gstin_ownership_claims      the queue + history (pending → approved / rejected /
--       withdrawn; 'revoked' rows record a platform revoke). RLS on, no grant to request roles.
--   network_gstin_owned(tenant)       internal (no grant): GSTIN registered + proved + same
--                                     GSTIN as proved + not personal.
--   network_claim_gstin_ownership(note)   owner: ask for the check
--   network_my_gstin_ownership()          owner / manager / accountant: my status + next step
--   platform_gstin_claims(status)         service_role only (the /platform route checks the
--   platform_decide_gstin_claim(…)        founder allowlist first, then calls these with the
--   platform_revoke_gstin_owner(…)        admin's own email, which is stored as "by")
--   network_request_connection / network_respond_connection / network_has_scope /
--   network_suggestions / network_my_connections — redefined from R-2433 (latest bodies,
--   20261103195606) with owner-verified instead of gstin_verified_at; my_connections gains
--   other_owner_verified so the screen can say why a request cannot be accepted yet.
--
-- ══ EXISTING PARENT LINKS ═════════════════════════════════════════════════════════════
--   R-2433's backfilled connections (origin parent_link, set by the operator) keep working —
--   network_has_scope does not ask them for a GSTIN at all, as before. In addition, the two
--   tenants of each such operator-set pair are marked owner-verified here (how 'parent_link',
--   by 'R-2445 migration: operator-set parent link'), only when their GSTIN is filled in AND
--   registered with GSTN (gstin_verified_at) and no other non-personal company has the same
--   GSTIN — the operator set that link by hand, which is the same check an admin approval is.
--   Each gets an 'approved' claim row so the admin can Revoke it from the queue. Nobody else is
--   backfilled. R-2433's own 'request' connections (accepted in the hour since it merged, if
--   any) pause until both sides prove their GSTIN; the screen says so on each one.
--
-- Test: supabase/tests/r2445_gstin_owner_verified.test.sql (rolled back; red without this file).
-- Idempotent: if not exists / create or replace / drop … if exists.

begin;

-- ── tenants: the proof ────────────────────────────────────────────────────────────────
alter table public.tenants add column if not exists gstin_owner_verified_at    timestamptz;
alter table public.tenants add column if not exists gstin_owner_verified_gstin text;
alter table public.tenants add column if not exists gstin_owner_verified_how   text;
alter table public.tenants add column if not exists gstin_owner_verified_by    text;

alter table public.tenants drop constraint if exists tenants_gstin_owner_how_check;
alter table public.tenants add constraint tenants_gstin_owner_how_check
  check (gstin_owner_verified_how is null or gstin_owner_verified_how in ('platform_admin', 'parent_link'));
alter table public.tenants drop constraint if exists tenants_gstin_owner_complete;
alter table public.tenants add constraint tenants_gstin_owner_complete
  check (gstin_owner_verified_at is null
         or (gstin_owner_verified_gstin is not null and gstin_owner_verified_how is not null));

/* One owner per GSTIN — two companies can never both hold it. */
create unique index if not exists tenants_gstin_owner_uq
  on public.tenants (gstin_owner_verified_gstin) where gstin_owner_verified_at is not null;

create or replace function public.r2445_tenants_owner_guard()
returns trigger
language plpgsql
set search_path = public
as $function$
begin
  /* R-2445. Request roles (the browser) can never write the proof; service_role (the platform
     route), SECURITY DEFINER functions and scripts may — the R-720 rule. */
  if current_user::text in ('authenticated', 'anon', 'app_runtime') then
    if tg_op = 'INSERT' then
      if new.gstin_owner_verified_at is not null or new.gstin_owner_verified_gstin is not null
         or new.gstin_owner_verified_how is not null or new.gstin_owner_verified_by is not null then
        raise exception 'GSTIN ownership is recorded only by the ResellerOS check (Settings → Network → Prove you own this GSTIN).'
          using errcode = '42501';
      end if;
    elsif (new.gstin_owner_verified_at is not null and new.gstin_owner_verified_at is distinct from old.gstin_owner_verified_at)
       or (new.gstin_owner_verified_gstin is not null and new.gstin_owner_verified_gstin is distinct from old.gstin_owner_verified_gstin)
       or (new.gstin_owner_verified_how is not null and new.gstin_owner_verified_how is distinct from old.gstin_owner_verified_how)
       or (new.gstin_owner_verified_by is not null and new.gstin_owner_verified_by is distinct from old.gstin_owner_verified_by) then
      raise exception 'GSTIN ownership is recorded only by the ResellerOS check (Settings → Network → Prove you own this GSTIN).'
        using errcode = '42501';
    end if;
  end if;

  /* Any role: the proof is for one GSTIN. A different GSTIN (or none) drops it, which also
     frees the old GSTIN for its real owner. */
  if new.gstin_owner_verified_at is not null
     and upper(btrim(coalesce(new.gstin, ''))) is distinct from new.gstin_owner_verified_gstin then
    new.gstin_owner_verified_at    := null;
    new.gstin_owner_verified_gstin := null;
    new.gstin_owner_verified_how   := null;
    new.gstin_owner_verified_by    := null;
  end if;
  return new;
end;
$function$;

revoke all on function public.r2445_tenants_owner_guard() from public, anon, authenticated;

drop trigger if exists a01_r2445_tenants_owner_guard on public.tenants;
create trigger a01_r2445_tenants_owner_guard
  before insert or update on public.tenants
  for each row execute function public.r2445_tenants_owner_guard();

-- ── claims queue ──────────────────────────────────────────────────────────────────────
create table if not exists public.gstin_ownership_claims (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  gstin            text not null,
  status           text not null default 'pending',
  gstn_legal_name  text,
  gstn_trade_name  text,
  note             text,
  requested_by     uuid,
  requested_at     timestamptz not null default now(),
  decided_by       text,
  decided_at       timestamptz,
  decision_note    text,
  updated_at       timestamptz not null default now(),
  constraint gstin_ownership_claims_status_check
    check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'revoked')),
  constraint gstin_ownership_claims_note_len check (note is null or length(note) <= 1000),
  constraint gstin_ownership_claims_decision_len check (decision_note is null or length(decision_note) <= 1000)
);
create unique index if not exists gstin_ownership_claims_one_pending
  on public.gstin_ownership_claims (tenant_id) where status = 'pending';
create index if not exists gstin_ownership_claims_gstin_idx on public.gstin_ownership_claims (gstin);
create index if not exists gstin_ownership_claims_status_idx on public.gstin_ownership_claims (status, requested_at);

alter table public.gstin_ownership_claims enable row level security;
revoke all on public.gstin_ownership_claims from public, anon, authenticated;
grant all on public.gstin_ownership_claims to service_role;
/* R-450: Cloud SQL has no BYPASSRLS — the server (service_role) client needs its own policy. */
drop policy if exists gstin_ownership_claims_service_role on public.gstin_ownership_claims;
create policy gstin_ownership_claims_service_role on public.gstin_ownership_claims
  for all to service_role using (true) with check (true);

-- ── the one ownership check ───────────────────────────────────────────────────────────
create or replace function public.network_gstin_owned(p_tenant uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2445: registered on GSTN (gstin_verified_at) AND proved to be this company's
     (gstin_owner_verified_at) for the GSTIN it holds now; never a personal workspace. */
  select exists (
    select 1 from public.tenants t
     where t.id = p_tenant
       and t.gstin_verified_at is not null
       and t.gstin_owner_verified_at is not null
       and t.gstin_owner_verified_gstin = upper(btrim(coalesce(t.gstin, '')))
       and t.workspace_kind is distinct from 'personal'
  );
$function$;

-- ── owner: ask for the check ──────────────────────────────────────────────────────────
create or replace function public.network_claim_gstin_ownership(p_note text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2445 */
  v_t     uuid := public.network_owner_tenant();
  v_me    public.tenants;
  v_gstin text;
  v_note  text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
  v_open  public.gstin_ownership_claims;
  v_id    uuid;
begin
  select * into v_me from public.tenants where id = v_t for update;
  if v_me.workspace_kind = 'personal' then
    raise exception 'A personal workspace cannot connect to other businesses, so it has no GSTIN to prove.' using errcode = '42501';
  end if;
  v_gstin := upper(btrim(coalesce(v_me.gstin, '')));
  if v_gstin = '' or v_me.gstin_verified_at is null then
    raise exception 'Verify your GSTIN with GSTN first (Settings → Company → Verify), then ask to prove you own it.'
      using errcode = '22023';
  end if;
  if public.network_gstin_owned(v_t) then
    raise exception 'You have already proved you own GSTIN % — nothing more to do.', v_gstin using errcode = '22023';
  end if;
  if exists (select 1 from public.tenants t
              where t.id <> v_t and t.gstin_owner_verified_at is not null and t.gstin_owner_verified_gstin = v_gstin) then
    raise exception 'Another business on ResellerOS has already proved it owns GSTIN %. If this GSTIN is yours, contact ResellerOS support with your GST registration certificate (REG-06); the team checks it and moves the GSTIN to you.', v_gstin
      using errcode = '23505';
  end if;

  select * into v_open from public.gstin_ownership_claims
   where tenant_id = v_t and status = 'pending' for update;
  if found then
    if v_open.gstin = v_gstin then
      update public.gstin_ownership_claims
         set note = v_note, requested_by = auth.uid(), updated_at = now()
       where id = v_open.id;
      return v_open.id;
    end if;
    /* the company changed its GSTIN since it asked — the old claim is for another number */
    update public.gstin_ownership_claims
       set status = 'withdrawn', decided_at = now(), decision_note = 'The company changed its GSTIN before the check.', updated_at = now()
     where id = v_open.id;
  end if;

  insert into public.gstin_ownership_claims (tenant_id, gstin, gstn_legal_name, gstn_trade_name, note, requested_by)
  values (v_t, v_gstin, v_me.gstin_verification ->> 'legal_name', v_me.gstin_verification ->> 'trade_name', v_note, auth.uid())
  returning id into v_id;
  return v_id;
end $function$;

-- ── my status (Settings → Network) ────────────────────────────────────────────────────
create or replace function public.network_my_gstin_ownership()
returns table (
  gstin text, gstin_verified boolean, owner_verified boolean, owner_verified_at timestamptz,
  owner_verified_how text, claim_id uuid, claim_status text, claim_requested_at timestamptz,
  claim_note text, claim_decided_at timestamptz, claim_decision_note text, held_by_other boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2445: owner / manager / accountant of the caller's company; anyone else sees nothing. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return;
  end if;
  return query
  select nullif(upper(btrim(coalesce(t.gstin, ''))), ''),
         t.gstin_verified_at is not null and nullif(btrim(coalesce(t.gstin, '')), '') is not null,
         public.network_gstin_owned(t.id),
         case when public.network_gstin_owned(t.id) then t.gstin_owner_verified_at end,
         case when public.network_gstin_owned(t.id) then t.gstin_owner_verified_how end,
         c.id, c.status, c.requested_at, c.note, c.decided_at, c.decision_note,
         exists (select 1 from public.tenants o
                  where o.id <> t.id and o.gstin_owner_verified_at is not null
                    and o.gstin_owner_verified_gstin = upper(btrim(coalesce(t.gstin, ''))))
    from public.tenants t
    left join lateral (
      select g.* from public.gstin_ownership_claims g
       where g.tenant_id = t.id and g.gstin = upper(btrim(coalesce(t.gstin, '')))
       order by g.requested_at desc, g.updated_at desc
       limit 1) c on true
   where t.id = v_t;
end $function$;

-- ── platform admin (service_role only — the route checks the founder allowlist) ───────
create or replace function public.platform_gstin_claims(p_status text default 'pending')
returns table (
  claim_id uuid, tenant_id uuid, tenant_name text, tenant_email text, gstin text,
  gstn_legal_name text, gstn_trade_name text, status text, note text, requested_at timestamptz,
  requested_by_email text, same_gstin_tenants int, holder_tenant_id uuid, holder_name text,
  decided_by text, decided_at timestamptz, decision_note text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2445 */
  select c.id, c.tenant_id, t.name::text, t.email::text, c.gstin,
         /* the name GSTN gave for THIS claim's GSTIN (stored when asked) — the company may have
            moved to another GSTIN since */
         coalesce(c.gstn_legal_name, case when upper(btrim(coalesce(t.gstin, ''))) = c.gstin then t.gstin_verification ->> 'legal_name' end),
         coalesce(c.gstn_trade_name, case when upper(btrim(coalesce(t.gstin, ''))) = c.gstin then t.gstin_verification ->> 'trade_name' end),
         /* an approval whose company no longer holds the GSTIN (it changed its GSTIN) reads 'lapsed' */
         case when c.status = 'approved' and h.id is distinct from c.tenant_id then 'lapsed' else c.status end, c.note, c.requested_at,
         (select u.email::text from public.users u where u.id = c.requested_by),
         (select count(*)::int from public.tenants o
           where upper(btrim(coalesce(o.gstin, ''))) = c.gstin and o.workspace_kind is distinct from 'personal'),
         h.id, h.name::text,
         c.decided_by, c.decided_at, c.decision_note
    from public.gstin_ownership_claims c
    join public.tenants t on t.id = c.tenant_id
    left join public.tenants h on h.gstin_owner_verified_at is not null and h.gstin_owner_verified_gstin = c.gstin
   where p_status is null or p_status = 'all'
      or (c.status = p_status and (p_status <> 'approved' or h.id = c.tenant_id))
   order by case c.status when 'pending' then 0 else 1 end, c.requested_at desc
   limit 500;
$function$;

create or replace function public.platform_decide_gstin_claim(
  p_claim uuid, p_approve boolean, p_admin_email text, p_note text default null)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2445 */
  v_admin text := lower(btrim(coalesce(p_admin_email, '')));
  v_note  text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
  v_c     public.gstin_ownership_claims;
  v_t     public.tenants;
  v_holder text;
begin
  if v_admin = '' then
    raise exception 'The deciding admin''s email is required (it is stored as who decided).' using errcode = '22023';
  end if;
  /* One decision per GSTIN at a time (two admins, two tabs): the GSTIN lock is taken BEFORE any
     claim row is locked — the other way round two decisions on one GSTIN deadlock (each holds
     its own claim row and waits for the other's when rejecting the rest). */
  select gstin into v_holder from public.gstin_ownership_claims where id = p_claim;
  if not found then
    raise exception 'Ownership claim not found — refresh the list.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('r2445:' || v_holder, 0));
  v_holder := null;

  select * into v_c from public.gstin_ownership_claims where id = p_claim for update;
  if v_c.status <> 'pending' then
    raise exception 'This claim is already % — refresh the list.', v_c.status using errcode = '22023';
  end if;

  if not coalesce(p_approve, false) then
    update public.gstin_ownership_claims
       set status = 'rejected', decided_by = v_admin, decided_at = now(),
           decision_note = coalesce(v_note, 'We could not confirm that this company owns the GSTIN. Reply with your GST registration certificate (REG-06) and ask again.'),
           updated_at = now()
     where id = p_claim;
    return 'rejected';
  end if;

  select * into v_t from public.tenants where id = v_c.tenant_id for update;
  if upper(btrim(coalesce(v_t.gstin, ''))) <> v_c.gstin or v_t.gstin_verified_at is null
     or v_t.workspace_kind = 'personal' then
    raise exception 'This company''s GSTIN changed or is no longer verified since it asked — reject this claim; the owner asks again after verifying.'
      using errcode = '22023';
  end if;
  select name into v_holder from public.tenants
   where id <> v_t.id and gstin_owner_verified_at is not null and gstin_owner_verified_gstin = v_c.gstin;
  if v_holder is not null then
    raise exception '% already holds GSTIN % as its proved owner. If this company is the real owner, revoke % first (Revoke ownership), then approve.', v_holder, v_c.gstin, v_holder
      using errcode = '22023';
  end if;

  update public.tenants
     set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = v_c.gstin,
         gstin_owner_verified_how = 'platform_admin', gstin_owner_verified_by = v_admin
   where id = v_t.id;
  update public.gstin_ownership_claims
     set status = 'approved', decided_by = v_admin, decided_at = now(), decision_note = v_note, updated_at = now()
   where id = p_claim;
  /* never first come: every other open claim on this GSTIN is answered now */
  update public.gstin_ownership_claims
     set status = 'rejected', decided_by = v_admin, decided_at = now(),
         decision_note = 'Another business was confirmed as the owner of this GSTIN. If it is yours, contact ResellerOS support with your GST registration certificate (REG-06).',
         updated_at = now()
   where gstin = v_c.gstin and status = 'pending' and id <> p_claim;
  return 'approved';
end $function$;

create or replace function public.platform_revoke_gstin_owner(p_tenant uuid, p_admin_email text, p_note text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2445: the admin approved the wrong company, or the owner gave the GSTIN up. Every
     connection made on that GSTIN stops flowing at once (network_has_scope). */
  v_admin text := lower(btrim(coalesce(p_admin_email, '')));
  v_note  text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
  v_t     public.tenants;
begin
  if v_admin = '' then
    raise exception 'The deciding admin''s email is required (it is stored as who revoked).' using errcode = '22023';
  end if;
  if v_note is null then
    raise exception 'Write why the ownership is revoked — the company sees it in Settings → Network.' using errcode = '22023';
  end if;
  select * into v_t from public.tenants where id = p_tenant for update;
  if not found or v_t.gstin_owner_verified_at is null then
    raise exception 'This company has no proved GSTIN to revoke — refresh the list.' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('r2445:' || v_t.gstin_owner_verified_gstin, 0));
  /* The approval that made it the owner turns 'revoked' (so the Approved list shows only real
     owners); who approved it stays in the note. An owner with no approval row (set by hand) gets
     a 'revoked' row so the revoke is still on record. */
  update public.gstin_ownership_claims
     set status = 'revoked',
         decision_note = left(v_note || coalesce(' (approved earlier by ' || decided_by
                                       || coalesce(' on ' || to_char(decided_at at time zone 'Asia/Kolkata', 'DD Mon YYYY'), '')
                                       || coalesce(': ' || decision_note, '') || ')', ''), 1000),
         decided_by = v_admin, decided_at = now(), updated_at = now()
   where tenant_id = v_t.id and gstin = v_t.gstin_owner_verified_gstin and status = 'approved';
  if not found then
    insert into public.gstin_ownership_claims (tenant_id, gstin, status, gstn_legal_name, gstn_trade_name,
                                               decided_by, decided_at, decision_note)
    values (v_t.id, v_t.gstin_owner_verified_gstin, 'revoked', v_t.gstin_verification ->> 'legal_name',
            v_t.gstin_verification ->> 'trade_name', v_admin, now(), v_note);
  end if;
  update public.tenants
     set gstin_owner_verified_at = null, gstin_owner_verified_gstin = null,
         gstin_owner_verified_how = null, gstin_owner_verified_by = null
   where id = v_t.id;
  return 'revoked';
end $function$;

-- ── the cross-company check (from R-2433 20261103195606; owner-verified now) ─────────
create or replace function public.network_has_scope(p_sharer uuid, p_viewer uuid, p_scope text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  /* R-2433. A requested connection also needs both sides to STILL hold the GSTIN it was made
     with — a company that changes or loses its GSTIN stops receiving at once.
     R-2445: and to have PROVED it owns that GSTIN (network_gstin_owned) — registered is not
     enough. (Backfilled parent links, origin parent_link, were made by the operator before
     GSTINs were required; they keep working until either side revokes.) */
  select exists (
    select 1 from public.tenant_connections c
     where c.status = 'accepted'
       and ((c.a_tenant_id = p_sharer and c.b_tenant_id = p_viewer and p_scope = any (c.a_scopes))
         or (c.b_tenant_id = p_sharer and c.a_tenant_id = p_viewer and p_scope = any (c.b_scopes)))
       and (c.origin = 'parent_link' or (
             public.network_gstin_owned(c.a_tenant_id)
         and exists (select 1 from public.tenants t where t.id = c.a_tenant_id and upper(btrim(t.gstin)) = c.a_gstin)
         and public.network_gstin_owned(c.b_tenant_id)
         and exists (select 1 from public.tenants t where t.id = c.b_tenant_id and upper(btrim(t.gstin)) = c.b_gstin)))
  );
$function$;

-- ── request (from R-2433; owner-verified on both sides) ───────────────────────────────
create or replace function public.network_request_connection(
  p_gstin text, p_scopes text[] default '{}'::text[], p_related_party boolean default false)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433, R-2445 */
  v_t       uuid := public.network_owner_tenant();
  v_me      public.tenants;
  v_gstin   text := upper(btrim(coalesce(p_gstin, '')));
  v_target  uuid;
  v_tgstin  text;
  v_open    public.tenant_connections;
  v_scopes  text[] := public.network_clean_scopes(p_scopes);
  v_id      uuid;
begin
  select * into v_me from public.tenants where id = v_t;
  if v_me.workspace_kind = 'personal' then
    raise exception 'A personal workspace cannot connect to other businesses.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(v_me.gstin, '')), '') is null or v_me.gstin_verified_at is null then
    raise exception 'Verify your own GSTIN first (Settings → Company), then Prove you own it (Settings → Network) — connections are made between proved GSTINs.'
      using errcode = '22023';
  end if;
  if not public.network_gstin_owned(v_t) then
    raise exception 'Prove you own your GSTIN first: Settings → Network → Prove you own this GSTIN. ResellerOS checks it, then you can connect.'
      using errcode = '22023';
  end if;
  if v_gstin = '' then
    raise exception 'Enter the GSTIN of the business to connect with.' using errcode = '22023';
  end if;
  if v_gstin = upper(btrim(v_me.gstin)) then
    raise exception 'That is your own GSTIN.' using errcode = '22023';
  end if;

  /* R-2445: only the company that PROVED it owns the GSTIN (at most one — unique index).
     A company that merely saved / registered it is never found, so it cannot block or
     intercept the real owner. One message for "nobody" and "not proved yet": nothing leaks. */
  select t.id, upper(btrim(t.gstin)) into v_target, v_tgstin
    from public.tenants t
   where t.gstin_owner_verified_at is not null
     and t.gstin_owner_verified_gstin = v_gstin
     and t.id <> v_t
     and public.network_gstin_owned(t.id)
   limit 1;
  if v_target is null then
    raise exception 'No business that has proved it owns GSTIN % is on ResellerOS yet. If they use ResellerOS, ask their owner to open Settings → Network → Prove you own this GSTIN, then send the request again.', v_gstin
      using errcode = 'P0002';
  end if;

  /* One request at a time per pair (two tabs, or A and B asking each other at once). */
  perform pg_advisory_xact_lock(hashtextextended('r2433:' || least(v_t, v_target)::text || greatest(v_t, v_target)::text, 0));

  select * into v_open from public.tenant_connections c
   where least(c.a_tenant_id, c.b_tenant_id) = least(v_t, v_target)
     and greatest(c.a_tenant_id, c.b_tenant_id) = greatest(v_t, v_target)
     and c.status in ('requested', 'accepted')
   for update;
  if found then
    if v_open.status = 'accepted' then
      raise exception 'You are already connected with this business.' using errcode = '23505';
    end if;
    if v_open.a_tenant_id = v_t then
      /* asked again: same open request, with what the owner chose this time */
      update public.tenant_connections
         set a_scopes = v_scopes, related_party = coalesce(p_related_party, false), updated_at = now()
       where id = v_open.id;
      return v_open.id;
    end if;
    raise exception 'This business has already asked to connect with you — accept it under Requests received.'
      using errcode = '23505';
  end if;

  begin
    insert into public.tenant_connections
      (a_tenant_id, b_tenant_id, a_gstin, b_gstin, status, a_scopes, related_party, origin, requested_by)
    values
      (v_t, v_target, upper(btrim(v_me.gstin)), v_tgstin, 'requested', v_scopes, coalesce(p_related_party, false),
       'request', auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'A request between your two businesses is already open — refresh Settings → Network.'
      using errcode = '23505';
  end;
  return v_id;
end $function$;

-- ── accept / reject (from R-2433; owner-verified on both sides to ACCEPT) ─────────────
create or replace function public.network_respond_connection(
  p_id uuid, p_accept boolean, p_scopes text[] default '{}'::text[])
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433, R-2445 */
  v_t      uuid := public.network_owner_tenant();
  v_c      public.tenant_connections;
  v_scopes text[] := public.network_clean_scopes(p_scopes);
  v_ok     boolean;
begin
  select * into v_c from public.tenant_connections where id = p_id and b_tenant_id = v_t for update;
  if not found then
    raise exception 'Connection request not found.' using errcode = 'P0002';
  end if;
  if v_c.status <> 'requested' then
    raise exception 'This request is no longer open (it is %).', v_c.status using errcode = '22023';
  end if;

  if not coalesce(p_accept, false) then
    update public.tenant_connections
       set status = 'rejected', responded_by = auth.uid(), responded_at = now(), updated_at = now()
     where id = p_id;
    return 'rejected';
  end if;

  if not public.network_gstin_owned(v_t) then
    raise exception 'Prove you own your GSTIN first: Settings → Network → Prove you own this GSTIN. After ResellerOS confirms it, accept this request.'
      using errcode = '22023';
  end if;

  /* Both sides must STILL be proved owners, not personal, and on the GSTIN the request named. */
  select count(*) = 2 into v_ok
    from public.tenants t
   where (t.id = v_c.a_tenant_id and upper(btrim(t.gstin)) = v_c.a_gstin
          or t.id = v_c.b_tenant_id and upper(btrim(t.gstin)) = v_c.b_gstin)
     and public.network_gstin_owned(t.id);
  if not v_ok then
    raise exception 'The other business changed its GSTIN or has not proved it owns it any more — ask them to send a new request.'
      using errcode = '22023';
  end if;

  update public.tenant_connections
     set status = 'accepted', b_scopes = v_scopes, responded_by = auth.uid(), responded_at = now(), updated_at = now()
   where id = p_id;
  return 'accepted';
end $function$;

-- ── list my connections (from R-2433; + other_owner_verified) ────────────────────────
drop function if exists public.network_my_connections();
create function public.network_my_connections()
returns table (
  id uuid, other_tenant_id uuid, other_name text, other_gstin text, status text, direction text,
  my_scopes text[], their_scopes text[], related_party boolean, origin text,
  requested_at timestamptz, responded_at timestamptz, revoked_at timestamptz, revoked_by_me boolean,
  other_owner_verified boolean)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433: owner / manager / accountant of the caller's company; anyone else sees nothing.
     R-2445: other_owner_verified — the other side still holds a proved GSTIN (what the
     connection was made with), so the screen can say why a request cannot be accepted. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner', 'manager', 'accountant') then
    return;
  end if;
  return query
  select c.id,
         case when c.a_tenant_id = v_t then c.b_tenant_id else c.a_tenant_id end,
         o.name::text,
         case when c.a_tenant_id = v_t then c.b_gstin else c.a_gstin end,
         c.status,
         case when c.a_tenant_id = v_t then 'sent' else 'received' end,
         case when c.a_tenant_id = v_t then c.a_scopes else c.b_scopes end,
         case when c.a_tenant_id = v_t then c.b_scopes else c.a_scopes end,
         c.related_party, c.origin, c.requested_at, c.responded_at, c.revoked_at,
         c.revoked_by_tenant_id = v_t,
         public.network_gstin_owned(o.id)
           and upper(btrim(coalesce(o.gstin, ''))) = coalesce(case when c.a_tenant_id = v_t then c.b_gstin else c.a_gstin end, '')
    from public.tenant_connections c
    join public.tenants o on o.id = case when c.a_tenant_id = v_t then c.b_tenant_id else c.a_tenant_id end
   where v_t in (c.a_tenant_id, c.b_tenant_id)
   order by case c.status when 'requested' then 0 when 'accepted' then 1 else 2 end, c.updated_at desc;
end $function$;

-- ── suggestions (from R-2433; only proved owners, and only to a proved owner) ─────────
create or replace function public.network_suggestions()
returns table (tenant_id uuid, tenant_name text, gstin text, matched_as text, matched_name text)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  /* R-2433: owner only (only the owner can act on one); never from or to a personal workspace.
     R-2445: the caller and the suggested company must both have PROVED their GSTIN — a company
     that only saved someone else's GSTIN is never shown under that GSTIN. */
  v_t uuid := public.current_tenant_id();
begin
  if v_t is null or not public.current_user_has_role('owner') then
    return;
  end if;
  if not public.network_gstin_owned(v_t) then
    return;
  end if;
  return query
  with mine as (
    select upper(btrim(cu.gstin)) as g, 'customer'::text as kind, cu.name::text as nm
      from public.customers cu
     where cu.tenant_id = v_t and cu.is_active and nullif(btrim(coalesce(cu.gstin, '')), '') is not null
    union all
    select upper(btrim(v.gstin)), 'vendor', v.name::text
      from public.vendors v
     where v.tenant_id = v_t and nullif(btrim(coalesce(v.gstin, '')), '') is not null
  )
  select distinct on (t.id) t.id, t.name::text, upper(btrim(t.gstin)), m.kind, m.nm
    from mine m
    join public.tenants t on t.gstin_owner_verified_at is not null and t.gstin_owner_verified_gstin = m.g
   where t.id <> v_t
     and public.network_gstin_owned(t.id)
     and not exists (
       select 1 from public.tenant_connections c
        where least(c.a_tenant_id, c.b_tenant_id) = least(v_t, t.id)
          and greatest(c.a_tenant_id, c.b_tenant_id) = greatest(v_t, t.id)
          and c.status in ('requested', 'accepted', 'rejected'))
   order by t.id, m.kind, m.nm;
end $function$;

-- ── backfill: the operator-set parent/child pairs are the proved owners ──────────────
with pair_tenants as (
  select c.a_tenant_id as id from public.tenant_connections c where c.origin = 'parent_link' and c.status = 'accepted'
  union
  select c.b_tenant_id from public.tenant_connections c where c.origin = 'parent_link' and c.status = 'accepted'
), candidates as (
  select t.id, upper(btrim(t.gstin)) as g
    from public.tenants t
    join pair_tenants p on p.id = t.id
   where nullif(btrim(coalesce(t.gstin, '')), '') is not null
     and t.gstin_verified_at is not null          -- registered with GSTN: an unchecked GSTIN is never locked to anyone
     and t.workspace_kind is distinct from 'personal'
     and t.gstin_owner_verified_at is null
     and not exists (select 1 from public.tenants o
                      where o.id <> t.id and o.workspace_kind is distinct from 'personal'
                        and upper(btrim(coalesce(o.gstin, ''))) = upper(btrim(t.gstin)))
), marked as (
  update public.tenants t
     set gstin_owner_verified_at = now(), gstin_owner_verified_gstin = c.g,
         gstin_owner_verified_how = 'parent_link', gstin_owner_verified_by = 'R-2445 migration: operator-set parent link'
    from candidates c
   where t.id = c.id
  returning t.id, t.gstin_owner_verified_gstin as g, t.gstin_verification
)
/* an 'approved' row per backfilled owner, so the platform admin sees it under Approved and can
   Revoke it like any other */
insert into public.gstin_ownership_claims (tenant_id, gstin, status, gstn_legal_name, gstn_trade_name,
                                           decided_by, decided_at, decision_note)
select m.id, m.g, 'approved', m.gstin_verification ->> 'legal_name', m.gstin_verification ->> 'trade_name',
       'R-2445 migration', now(), 'Operator-set parent link (set by ResellerOS before ownership checks existed).'
  from marked m;

-- ── grants ────────────────────────────────────────────────────────────────────────────
revoke all on function public.network_gstin_owned(uuid) from public, anon, authenticated;
revoke all on function public.network_claim_gstin_ownership(text) from public, anon;
revoke all on function public.network_my_gstin_ownership() from public, anon;
revoke all on function public.platform_gstin_claims(text) from public, anon, authenticated;
revoke all on function public.platform_decide_gstin_claim(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.platform_revoke_gstin_owner(uuid, text, text) from public, anon, authenticated;
revoke all on function public.network_has_scope(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.network_request_connection(text, text[], boolean) from public, anon;
revoke all on function public.network_respond_connection(uuid, boolean, text[]) from public, anon;
revoke all on function public.network_my_connections() from public, anon;
revoke all on function public.network_suggestions() from public, anon;

grant execute on function public.network_gstin_owned(uuid) to service_role;
grant execute on function public.network_claim_gstin_ownership(text) to authenticated;
grant execute on function public.network_my_gstin_ownership() to authenticated;
grant execute on function public.platform_gstin_claims(text) to service_role;
grant execute on function public.platform_decide_gstin_claim(uuid, boolean, text, text) to service_role;
grant execute on function public.platform_revoke_gstin_owner(uuid, text, text) to service_role;
grant execute on function public.network_request_connection(text, text[], boolean) to authenticated;
grant execute on function public.network_respond_connection(uuid, boolean, text[]) to authenticated;
grant execute on function public.network_my_connections() to authenticated;
grant execute on function public.network_suggestions() to authenticated;

commit;
