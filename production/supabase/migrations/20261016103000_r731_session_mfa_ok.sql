-- deploy-peek: to_regprocedure('public.session_mfa_ok()') is not null
-- deploy-key: r731mfaok
-- deploy-user: postgres
-- 20261016103000_r731_session_mfa_ok.sql
--
-- R-731 (P1 SECURITY, launch blocker) — part 1 of 2: the helper that knows whether this
-- session has finished two-step sign-in.
--
-- ══ THE HOLE ═════════════════════════════════════════════════════════════════════
--   R-701 made /api refuse a half-signed-in MFA user (password given, authenticator code not).
--   The DATA path never looked: no RLS policy read the token's `aal` claim, and the R-161 data
--   gateway (Prisma) told the database only app.user_id — so a password-only session of an
--   MFA-enrolled owner read and wrote every tenant row exactly like a full one.
--
-- ══ WHAT THIS FILE ADDS ══════════════════════════════════════════════════════════
--   public.session_mfa_ok() → boolean, for the CURRENT session:
--     • true  when the user has no verified factor (MFA not enrolled — nothing changes for them)
--     • true  when the session is aal2 — app.aal = 'aal2' (gateway / withTenant, set
--             transaction-locally by src/server/db/context.ts) or request.jwt.claims->>'aal'
--             (GoTrue + PostgREST path)
--     • false otherwise — enrolled, but this session has not passed the second step. Unknown
--             level counts as aal1 (fail closed).
--   No argument on purpose: it only ever answers for the caller's own session (app.user_id,
--   else auth.uid()), so execute may be public without telling anyone who has MFA.
--
-- ══ WHY deploy-user: postgres ════════════════════════════════════════════════════
--   The helper reads auth.mfa_factors (GoTrue's table; the app's Auth.js two-step stores its
--   factors there, src/server/auth/mfa.ts). On Cloud SQL only postgres (through
--   supabase_auth_admin) may read it, so the SECURITY DEFINER must be owned by postgres.
--   resellersos_migration stays the owner of current_tenant_id(); part 2
--   (20261016103100_r731_mfa_tenant.sql) runs as that user and only CALLS this helper.
--   The DO block at the end executes the helper once: if the owner cannot read
--   auth.mfa_factors the apply fails here, loudly, instead of every policy failing later.
--
-- Staging's apply() rewrites auth.uid() → public.current_user_id(); written plainly.
-- Idempotent: create or replace.

begin;

create or replace function public.session_mfa_ok() returns boolean
  language sql stable security definer set search_path = ''
as $$
  /* R-731: second sign-in step enforced on the data path. */
  select coalesce(nullif(current_setting('app.aal', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal',
                  'aal1') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors f
         where f.user_id = coalesce(nullif(current_setting('app.user_id', true), '')::uuid, auth.uid())
           and f.status = 'verified');
$$;

comment on function public.session_mfa_ok() is
  'R-731: true unless the caller has a verified MFA factor and this session is not aal2 (app.aal / request.jwt.claims).';

revoke all on function public.session_mfa_ok() from public;
grant execute on function public.session_mfa_ok() to public;

-- Prove the owner can read auth.mfa_factors — fail the apply here if not.
do $$
begin
  if public.session_mfa_ok() is null then
    raise exception 'R-731: session_mfa_ok() returned null';
  end if;
end $$;

commit;
