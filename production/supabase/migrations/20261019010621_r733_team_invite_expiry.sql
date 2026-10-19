-- deploy-peek: exists(select 1 from information_schema.columns where table_schema = 'public' and table_name = 'team_invites' and column_name = 'expires_at') and to_regprocedure('public.accept_team_invite(text,uuid,text,text,uuid)') is not null
-- deploy-key: r733inviteexpiry
-- 20261019010621_r733_team_invite_expiry.sql
--
-- R-733 (security audit 9 Oct 2026) — a team invite link never expired and could be used twice.
--
-- ══ THE HOLES ═════════════════════════════════════════════════════════════════════
--   1. team_invites had no expiry (20260901090000 added only the token). A link forwarded,
--      leaked from an old mailbox or found in a shared drive months later still let its holder
--      join the company in the invited role (owner included).
--   2. Accepting was two separate writes from the app: insert the users row, THEN
--      `update team_invites set accepted_at = now()` — signup/route.ts and
--      (auth)/callback/route.ts. Two requests racing on one invite both passed the
--      "accepted_at is null" read and both joined; a crash between the writes left the invite
--      open after the member existed. The Google path also marked the invite used by email
--      (ilike) rather than the row it had read.
--
-- ══ THE FIX ═════════════════════════════════════════════════════════════════════
--   • team_invites.expires_at, default now() + 7 days. Existing open invites get 7 days from
--     the moment this runs (the volatile default fills them), so nobody's pending invite
--     dies on deploy day without warning.
--   • public.accept_team_invite(email, user_id, full_name, initials, token) — ONE transaction
--     (CLAUDE.md §17b): a single conditional UPDATE … where accepted_at is null and
--     expires_at > now() [and token = p_token] RETURNING claims the invite, then the users
--     row is inserted. Only one caller can win the UPDATE; if the insert fails, the claim
--     rolls back with it. Refusals say what to do next (§24) and are told apart:
--     expired / already used / not found.
--   • Trusted callers only (§17c): the sign-up route and the OAuth callback use the admin
--     client (service_role). A signed-in user calling it directly is refused with 28000 —
--     otherwise anyone could join a company by naming an invited address. EXECUTE is
--     revoked from public/anon/authenticated and granted to service_role.
--   The owner's re-invite renews expires_at (api/team/invite/route.ts).
--
-- Cloud SQL: no auth.users reference; staging rewrites auth.role() → current_request_role().
-- Test: supabase/tests/r733_team_invite_accept.test.sql (double accept, expiry, token, caller).

begin;

alter table public.team_invites
  add column if not exists expires_at timestamptz not null default (now() + interval '7 days');

comment on column public.team_invites.expires_at is
  'R-733: invite link stops working after this (default 7 days). Re-inviting the same email renews it.';

create or replace function public.accept_team_invite(
  p_email     text,
  p_user_id   uuid,
  p_full_name text,
  p_initials  text,
  p_token     uuid default null
)
returns table (tenant_id uuid, role public.user_role)
language plpgsql
security definer
set search_path to 'public'
as $function$
#variable_conflict use_column
-- R-733: claim the invite and create the membership in one transaction.
declare
  v_trusted boolean;
  v_email   text := lower(btrim(coalesce(p_email, '')));
  v_tenant  uuid;
  v_role    public.user_role;
  v_inv     record;
begin
  v_trusted := coalesce(auth.role(), '') = 'service_role'
               or (auth.role() is null
                   and session_user::text not in ('authenticator', 'anon', 'authenticated', 'app_runtime'));
  if not v_trusted then
    raise exception 'Invites are accepted only by the sign-up page. Open the invite link from your email, or sign in with Google using the invited address.'
      using errcode = '28000';
  end if;
  if v_email = '' or p_user_id is null then
    raise exception 'accept_team_invite: email and user id are required.' using errcode = '22023';
  end if;

  -- The one conditional write: only the first caller can flip accepted_at.
  update public.team_invites ti
     set accepted_at = now()
   where lower(ti.email) = v_email
     and ti.accepted_at is null
     and ti.expires_at > now()
     and (p_token is null or ti.token = p_token)
  returning ti.tenant_id, ti.role into v_tenant, v_role;

  if v_tenant is null then
    select ti.accepted_at, ti.expires_at into v_inv
      from public.team_invites ti
     where lower(ti.email) = v_email
       and (p_token is null or ti.token = p_token)
     limit 1;
    if not found then
      raise exception 'This invite link is not valid for this email. Ask the workspace owner to send a new invite (Team → Invite member).'
        using errcode = 'P0002';
    elsif v_inv.accepted_at is not null then
      raise exception 'This invite has already been used. Sign in with that email instead — or ask the workspace owner for a new invite.'
        using errcode = 'P0001';
    else
      raise exception 'This invite expired on %. Ask the workspace owner to send a new invite (Team → Invite member).',
        to_char(v_inv.expires_at at time zone 'Asia/Kolkata', 'DD Mon YYYY')
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.users (id, tenant_id, email, full_name, initials, role, color)
  values (p_user_id, v_tenant, v_email, coalesce(nullif(btrim(p_full_name), ''), split_part(v_email, '@', 1)),
          p_initials, v_role, 'indigo');

  return query select v_tenant, v_role;
end;
$function$;

revoke all on function public.accept_team_invite(text, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.accept_team_invite(text, uuid, text, text, uuid) to service_role;

commit;
