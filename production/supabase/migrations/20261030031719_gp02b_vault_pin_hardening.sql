-- deploy-peek: to_regprocedure('public.vault_pin_begin_attempt(uuid)') is not null and not exists (select 1 from pg_policy where polname = 'personal_vault_pin_all')
-- deploy-key: gp02bvaultpin
-- 20261030031719_gp02b_vault_pin_hardening.sql
--
-- R-2112 / GP-02b (30 Oct 2026, G-PERSONAL) — the Private Vault PIN lock, hardened.
--
-- THREE HOLES IT CLOSES
--   1. The PIN row was writable by its owner (`personal_vault_pin_all` FOR ALL, migration
--      20260819170000:213-217). Anyone holding the signed-in session could open devtools and
--      PATCH failed_attempts = 0 / locked_until = null — the lockout was a suggestion.
--      Now: SELECT only for the owner (the status screen needs it); every write goes through
--      the API route, which calls the service-role-only functions below.
--   2. The attempt counter was read in one request and written in another (read → verify →
--      write failed+1). Five or fifty parallel wrong guesses all read 0 and all wrote 1, so
--      the lock never closed and every guess got checked. Now vault_pin_begin_attempt()
--      COUNTS the attempt in one UPDATE … RETURNING *before* the PIN is checked, and only
--      while the lock is open; a correct PIN then clears it. At most MAX_ATTEMPTS (5) guesses
--      can ever be in flight per lock window, however many requests arrive at once.
--   3. (UI side, vault-pin-gate.tsx) the gate opened when the status request failed.
--
-- The numbers 5 and 15 minutes are pin-rules.ts MAX_ATTEMPTS / LOCKOUT_MINUTES; they are
-- written here, not passed in, so a caller cannot ask for a longer leash
-- (route.test.ts checks the two stay equal).
--
-- Functions are SECURITY DEFINER (owner bypasses RLS — also on Cloud SQL, where service_role
-- has no BYPASSRLS) and EXECUTE is granted to service_role only, with a trusted-caller check
-- inside as well (CLAUDE.md §17c pattern).

-- ─── 1. The row is read-only for browser roles ─────────────────────────────────────────
drop policy if exists personal_vault_pin_all on public.personal_vault_pin;
drop policy if exists personal_vault_pin_select on public.personal_vault_pin;
create policy personal_vault_pin_select on public.personal_vault_pin
  for select
  using (user_id = auth.uid() and tenant_id = current_tenant_id());

-- With no INSERT/UPDATE/DELETE policy, RLS already refuses every browser write (an UPDATE
-- or DELETE matches 0 rows, an INSERT raises). INSERT and DELETE privileges are revoked
-- too; UPDATE is left to RLS so personal_vault_owner_isolation.test.sql case 7 (another
-- owner's UPDATE is a silent no-op) keeps its meaning.
revoke insert, delete on table public.personal_vault_pin from anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_runtime') then
    execute 'revoke insert, delete on table public.personal_vault_pin from app_runtime';
  end if;
end $$;

-- ─── 2. Trusted-caller check shared by the four functions (definer: it reads only the
--        request role and session user; EXECUTE is service_role only) ─────────────────
create or replace function public.gp02b_vault_pin_trusted()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') = 'service_role'
      or (auth.role() is null
          and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
$$;
revoke all on function public.gp02b_vault_pin_trusted() from public, anon, authenticated;
grant execute on function public.gp02b_vault_pin_trusted() to service_role;

-- ─── 3. Count an attempt, atomically, before the PIN is checked ─────────────────────────
-- status: 'ok'     → attempt counted; pin_hash/pin_salt returned for the check
--         'locked' → lock closed; nothing counted, no hash handed out
--         'none'   → no PIN is set
create or replace function public.vault_pin_begin_attempt(p_user_id uuid)
returns table (status text, pin_hash text, pin_salt text, failed_attempts int, locked_until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max  constant int := 5;                       -- pin-rules.ts MAX_ATTEMPTS
  v_lock constant interval := interval '15 minutes'; -- pin-rules.ts LOCKOUT_MINUTES
  r public.personal_vault_pin%rowtype;
begin
  if not public.gp02b_vault_pin_trusted() then
    raise exception 'Only the server may change the vault PIN.' using errcode = '42501';
  end if;

  update public.personal_vault_pin p
     set failed_attempts = p.failed_attempts + 1,
         locked_until = case when p.failed_attempts + 1 >= v_max then now() + v_lock else null end,
         updated_at = now()
   where p.user_id = p_user_id
     and (p.locked_until is null or p.locked_until <= now())
  returning p.* into r;

  if found then
    return query select 'ok'::text, r.pin_hash, r.pin_salt, r.failed_attempts, r.locked_until;
    return;
  end if;

  select * into r from public.personal_vault_pin p where p.user_id = p_user_id;
  if not found then
    return query select 'none'::text, null::text, null::text, 0, null::timestamptz;
  else
    return query select 'locked'::text, null::text, null::text, r.failed_attempts, r.locked_until;
  end if;
end;
$$;
revoke all on function public.vault_pin_begin_attempt(uuid) from public, anon, authenticated;
grant execute on function public.vault_pin_begin_attempt(uuid) to service_role;

-- ─── 4. Correct PIN: wipe the slate ─────────────────────────────────────────────────────
create or replace function public.vault_pin_clear_attempts(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.gp02b_vault_pin_trusted() then
    raise exception 'Only the server may change the vault PIN.' using errcode = '42501';
  end if;
  update public.personal_vault_pin
     set failed_attempts = 0, locked_until = null, updated_at = now()
   where user_id = p_user_id;
end;
$$;
revoke all on function public.vault_pin_clear_attempts(uuid) from public, anon, authenticated;
grant execute on function public.vault_pin_clear_attempts(uuid) to service_role;

-- ─── 5. Set / change the PIN ────────────────────────────────────────────────────────────
-- p_replace = false: only when no PIN exists (returns false if one does — a first-time set
-- racing an existing PIN must never replace it without the current PIN).
-- p_replace = true: the route has already checked the current PIN.
create or replace function public.vault_pin_save(
  p_user_id uuid, p_tenant_id uuid, p_hash text, p_salt text, p_replace boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not public.gp02b_vault_pin_trusted() then
    raise exception 'Only the server may change the vault PIN.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id and u.tenant_id = p_tenant_id) then
    raise exception 'This login does not belong to that workspace.' using errcode = '42501';
  end if;

  if p_replace then
    insert into public.personal_vault_pin (user_id, tenant_id, pin_hash, pin_salt, failed_attempts, locked_until, updated_at)
    values (p_user_id, p_tenant_id, p_hash, p_salt, 0, null, now())
    on conflict (user_id) do update
      set tenant_id = excluded.tenant_id, pin_hash = excluded.pin_hash, pin_salt = excluded.pin_salt,
          failed_attempts = 0, locked_until = null, updated_at = now();
  else
    insert into public.personal_vault_pin (user_id, tenant_id, pin_hash, pin_salt)
    values (p_user_id, p_tenant_id, p_hash, p_salt)
    on conflict (user_id) do nothing;
  end if;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;
revoke all on function public.vault_pin_save(uuid, uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.vault_pin_save(uuid, uuid, text, text, boolean) to service_role;

-- ─── 6. Remove the PIN (route has checked the current PIN) ──────────────────────────────
create or replace function public.vault_pin_remove(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.gp02b_vault_pin_trusted() then
    raise exception 'Only the server may change the vault PIN.' using errcode = '42501';
  end if;
  delete from public.personal_vault_pin where user_id = p_user_id;
end;
$$;
revoke all on function public.vault_pin_remove(uuid) from public, anon, authenticated;
grant execute on function public.vault_pin_remove(uuid) to service_role;
