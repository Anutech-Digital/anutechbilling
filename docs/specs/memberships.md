# Memberships — one login in many companies (R-2471)

Card R-2471 (decision 4 Nov 2026: multi-company membership; "Remove" = end that membership, never
delete the login). Slices: **1 = R-2471** (this spec: table + current-company selection + RLS
helpers + backfill, no UI) · 2 = R-2476 company switcher · 3 = R-2477 Invite / Claim / Remove on
memberships · 4 = R-2478 backfill repair report.

> Slice 1 changes `current_tenant_id()`, which every RLS policy and SECURITY DEFINER guard uses.
> It MUST get an independent review (a separate reviewer, not the builder) before any staging train.

## 1. Today (measured on the local DB, 4 Nov 2026)

- One login = one `public.users` row (`id` = auth uid) = one company (`users.tenant_id`, NOT NULL).
- `current_tenant_id()` returns `users.tenant_id` when the row is active, not past
  `access_ends_on` (R-1896) and the session passed MFA if enrolled (R-731). Four branches by
  `session_user`: `app_runtime` (Cloud SQL data gateway, `app.user_id` + optional `app.tenant_id`),
  `app_jobs` (`app.tenant_id`, optional `app.user_id`), `app_service`/`app_anon` (NULL), and the
  Supabase data plane (`auth.uid()` from the JWT).
- `current_user_has_role(...)` and `current_user_is_owner()` read `users.role` / `is_active`.
- **The JWT carries no tenant or role claim** (no custom access-token hook; grep 4 Nov). The app
  reads `users` on every request (`src/lib/auth/session-user.ts`, middleware R-722). So there are
  no stale tenant claims to worry about — the database row is the only truth.
- 111 FKs point at `users(id)` (27 CASCADE, 6 NO ACTION, 78 SET NULL) — deleting or remapping
  the users row is not an option (card's `rejected` field).

## 2. Design

### 2.1 `public.tenant_memberships` — who may work in which company

| column | meaning |
|---|---|
| `id` uuid pk | |
| `user_id` → `users(id)` ON DELETE CASCADE | the login |
| `tenant_id` → `tenants(id)` ON DELETE CASCADE | the company |
| `role` `user_role` | role IN THIS company |
| `is_active` bool | owner switched the member off in this company (reversible) |
| `access_ends_on` date | last IST day in this company (R-1896) |
| `employee_id`, `manager_id`, `can_view_deals`, `gets_new_leads` | the per-company facts that today sit on `users` |
| `created_at`, `created_by` | |
| `ended_at`, `ended_by`, `end_reason` | membership ended (Remove / moved); an ended membership never grants access again unless a new invite re-opens it (slice 3) |
| `updated_at` | |

`unique (user_id, tenant_id)` — one membership per login per company, re-used on re-invite.

RLS on. `authenticated` may only SELECT: its own memberships (`user_id = current_user_id()`, for
the switcher) and the memberships of its current company (`tenant_id = current_tenant_id()`).
No INSERT/UPDATE/DELETE grant to `authenticated`/`anon`: rows change only through triggers and
SECURITY DEFINER functions. `service_role` has its own policy (Cloud SQL has no BYPASSRLS, R-450).
Audit: `log_row_change()` on every insert/update/delete (activity_log).

### 2.2 The selected ("current") company = `users.tenant_id`

**Chosen:** keep `users.tenant_id` as "the company this login is working in now", and make the
membership the authority. Rejected: a per-session JWT claim (needs a custom access-token hook,
a token refresh on every switch, and the gateway would need to carry it — a stale claim would
then be a real risk), and a new `users.current_tenant_id` column (every policy, definer
function and app query reads `users.tenant_id` today; a second column would be a second truth).

Consequences:
- Every existing RLS policy (`tenant_id = current_tenant_id()`), every definer guard and every
  app read of `users.tenant_id` keeps working unchanged.
- Switching is per LOGIN, not per browser tab: both tabs follow the switch on their next
  request. Accepted (Tally/Zoho-style "one company open at a time").
- The per-company columns on `users` (`role`, `is_active`, `access_ends_on`, `employee_id`,
  `manager_id`, `can_view_deals`, `gets_new_leads`) become a MIRROR of the selected company's
  membership, kept in sync by triggers both ways (2.4), so app code that reads them directly
  stays right.

### 2.3 `current_tenant_id()` / `current_user_has_role()` / `current_user_is_owner()`

Each now joins `tenant_memberships m on m.user_id = u.id and m.tenant_id = u.tenant_id` and
requires `m.is_active and m.ended_at is null and (m.access_ends_on is null or m.access_ends_on >=
ist_today())` — **in addition to** the old `users.is_active` / `access_ends_on` / MFA checks
(defence in depth: if the mirror and the membership ever disagree, the answer is NULL/false).
Role comes from `m.role`. No membership → NULL / false (fail closed).

- `app_runtime`: as before, plus the membership; `app.tenant_id`, when set, must equal the
  selected company.
- `app_jobs` with a user: the user's ACTIVE membership in `app.tenant_id` (a job enqueued for
  company A still runs for A after the user switched to B; it never runs for a company where the
  membership is off or ended). Without a user: `app.tenant_id` as before.
- `app_service` / `app_anon`: NULL, unchanged.
- Supabase branch: `public.current_user_id()` (= `auth.uid()` there). Written with
  `current_user_id()`, so staging's `apply()` rewrite of `auth.uid()` (R-161) has nothing to change.

### 2.4 Sync triggers

- `users` AFTER INSERT → membership for (`id`, `tenant_id`) with the row's values (upsert).
  Every existing path that creates a login (signup, invite accept, join request, tests that
  insert `users` directly) therefore gets its membership with no code change.
- `users` AFTER UPDATE of a mirrored column or `tenant_id`:
  - same company → copy the changed values into that membership (the Team page still writes
    `users`; R-722 deactivate / R-1896 exit keep working).
  - company changed to one where the login ALREADY has an active membership with exactly these
    values → a **switch**: nothing else changes.
  - company changed to one without such a membership → a **move** (today's only kind:
    claim-merge `merge_stranded_user_into_tenant`, OAuth re-link, scripts): upsert the new
    membership with the row's values and END the old one (`ended_at`, `end_reason = 'moved'`).
    This keeps today's one-company behaviour for every existing path.
- `tenant_memberships` AFTER INSERT/UPDATE → when it is the user's selected company and a value
  differs, copy it onto `users` (for slice 3's Remove / role change). Both directions compare
  with `is distinct from`, so the pair stops after one round.

### 2.5 `switch_company(p_tenant_id uuid)` — the server-side selection (no UI yet)

SECURITY DEFINER, granted to `authenticated` (and so `app_runtime`, a member of it). Refuses
(42501) without a signed-in user, without MFA when enrolled (`session_mfa_ok()`), and when the
caller has no ACTIVE, not-ended, not-expired membership in that company — "You are not a member
of that company." On success it sets `users.tenant_id` and the mirrored columns from the
membership in one UPDATE. `guard_privileged_user_columns()` gets one new early branch: a login
may change its OWN `tenant_id` (and mirrored columns) only when the new values equal an active
membership's values exactly — so even a direct PATCH (which `users_self_update`'s WITH CHECK
already refuses) can only land on a real membership with its real role.

### 2.6 Backfill

One membership per existing `users` row, same tenant / role / is_active / access_ends_on /
employee_id / manager_id / can_view_deals / gets_new_leads; `created_at` = the user's
`created_at`. `on conflict do nothing` (idempotent). Slice 4 (R-2478) adds the repair report
that proves 0 mismatches on staging.

## 3. Threats and answers

| threat | answer (slice 1) | test |
|---|---|---|
| Switch into a company you are not a member of | `switch_company` refuses 42501; guard refuses a self PATCH of `tenant_id` without a matching active membership; RLS WITH CHECK refuses it too | case 4, 5 |
| A member of A and B sees B's rows while A is selected | `current_tenant_id()` = selected company only; every policy is `tenant_id = current_tenant_id()` | case 1–3 |
| Stale JWT claims | none exist (no tenant/role claim; the DB row is read per statement). A switch takes effect on the next statement | n/a (documented) |
| Deactivated member (this company) | membership `is_active = false` → NULL; the mirror keeps R-722 sign-out working | case 6 |
| Ended membership | `ended_at is not null` → NULL, and `switch_company` refuses | case 7 |
| Expired (`access_ends_on` passed) in one company | that company → NULL; the other company still works | case 8 |
| Mirror and membership disagree (bug / manual SQL) | both checked → NULL (fail closed) | case 9 |
| Escalate role by switching | role always comes from the target membership; guard rejects any other value | case 5 |
| Last owner | not reachable in slice 1 (no Remove yet). Slice 3: Remove refuses the last active owner and yourself | slice 3 |
| MFA step per company | MFA is per LOGIN (`auth.mfa_factors`), checked on every call AND in `switch_company`; no per-company MFA policy exists today | case 10 |
| Platform admin | server-side email list acting through the service client (e.g. R-2445); no DB role → unaffected | n/a |
| `service_role`, `app_service`, `app_anon` | NULL tenant as before; service_role policy on the new table only | existing r1615 / r722 tests |
| `app_jobs` running for a user | needs the user's active membership in `app.tenant_id` | case 11 |
| Staging `apply()` rewriting `auth.uid()` (R-161) | new code uses `public.current_user_id()`; nothing to rewrite | — |
| Existing tests / policies | all keep using `current_tenant_id()`; inserting `users` creates the membership by trigger | r722, r731, r1896, r1615, r1618, r715 green |

## 4. Not in slice 1 (later slices)

- Team list of a company shows only logins whose SELECTED company it is (`users_tenant_read`).
  Slice 3 lists members from `tenant_memberships`.
- Team chat #general follows `users.tenant_id` (R-2296 `chat_general_sync_user`); per-company
  chat membership comes with slice 3.
- Invite of a login that already has a company still refuses (R-2469); slice 3 adds a second
  membership instead.
