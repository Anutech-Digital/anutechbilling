-- ═══════════════════════════════════════════════════════════════════════════
--  INVITE A TESTER INTO THE SANDBOX TENANT
--  Run after create-test-tenant.sql. 21 Aug 2026.
-- ═══════════════════════════════════════════════════════════════════════════
--
--  ─── WHY THE TESTER CANNOT BE AN EXISTING TEAMMATE ────────────────────────
--  The ask was to invite pratik@anutech.in. Measured first, and it would not have
--  worked: Pratik has had a public.users row in the LIVE tenant since 12 Aug and an
--  accepted invite to it. The OAuth callback's very first branch is
--
--      if (existing) return redirect(next)
--
--  so for anyone who already has a users row the invite branch is never reached.
--  A second branch re-links a pre-existing profile to a new auth UID, so even
--  deleting his auth user would pull him back to the live tenant. An invite on his
--  address would have been a no-op that looked like a fix — the worst kind.
--
--  One email therefore means one tenant. A tester who must stay out of the live
--  books needs an address that has never signed in. testing@anutech.in is unused in
--  public.users, in auth.users and in team_invites (all measured 21 Aug 2026).
--
--  ─── WHY AN INVITE AND NOT A SHARED PASSWORD ──────────────────────────────
--  anutech.in is a VERIFIED DOMAIN on the live tenant, so without an invite any
--  @anutech.in signup is routed at the live tenant (parked in join_requests for the
--  owner to approve). The invite is what overrides that, and it does so by design:
--  decideOnboarding() checks the invite BEFORE the domain, because "an invite is a
--  decision someone already made" (src/lib/auth/domain.ts:129). So this row is
--  precisely what keeps a tester's sign-in out of the real books.
--
--  Also: /api/auth/signup creates the auth user with email_confirm = true, so the
--  address does not need a working mailbox. Nobody has to share a password, and
--  nobody has to create a Google account.
--
--  ─── ROLE = owner, DELIBERATELY ───────────────────────────────────────────
--  A tester who cannot open the financial screens cannot test them. Inside the
--  sandbox that grants nothing dangerous: every table's RLS is tenant-scoped, so a
--  sandbox owner sees sandbox rows only, and the Owner Private Vault is scoped to
--  auth.uid() rather than to the role, so it is not shared with anyone either.
--
--  Safe to re-run.
begin;

insert into public.team_invites (id, tenant_id, email, role, invited_by, created_at)
values (
  gen_random_uuid(),
  '7e57e57e-0000-4000-8000-000000000001',    -- ZZ TESTING SANDBOX
  'testing@anutech.in',
  'owner',
  '3caa0f07-44d1-42ee-91b3-2123e04853b1',    -- Pardeep, so the audit trail is real
  now()
)
on conflict do nothing;

do $$
declare
  v_sandbox uuid := '7e57e57e-0000-4000-8000-000000000001';
  v_live    uuid := 'fbb976f1-9090-4f10-9726-0901bd144e42';
  n integer;
begin
  -- exactly one invite for this address, and it points at the sandbox
  select count(*) into n from public.team_invites where lower(email) = 'testing@anutech.in';
  if n <> 1 then
    raise exception 'FAIL: % invite(s) for testing@anutech.in — more than one is ambiguous', n;
  end if;
  select count(*) into n from public.team_invites
    where lower(email) = 'testing@anutech.in' and tenant_id = v_sandbox;
  if n <> 1 then raise exception 'FAIL: the invite does not point at the sandbox tenant'; end if;

  -- and the join branch must actually be reachable: no existing profile for it
  select count(*) into n from public.users where lower(email) = 'testing@anutech.in';
  if n <> 0 then
    raise exception 'FAIL: testing@anutech.in already has a users row — the invite would be ignored, exactly as it would have been for pratik@anutech.in';
  end if;

  -- The live tenant's own membership must be untouched. TEN, not eleven: eleven is
  -- the DB-wide user count and one of them belongs to Demo Co. Written
  -- wrong the first time here too, and caught by this same assertion — the global
  -- figure is always the one that comes to mind.
  select count(*) into n from public.users where tenant_id = v_live;
  if n <> 10 then raise exception 'FAIL: live tenant now has % users, expected 10', n; end if;
  select count(*) into n from public.team_invites where tenant_id = v_live;
  if n <> 10 then raise exception 'FAIL: live tenant now has % invites, expected 10', n; end if;
end $$;

select 'INVITE-READY' as add_test_tenant_invite;

commit;
