# R-1434 — Custom roles (design, launch ke BAAD banana hai)

Status: design only — koi app code nahi badla. Faisla: Pardeep "haan" (16 Oct 2026) = launch ke baad.
Idea: Abhishek (staging AI Help, 12 Oct). Build card: see "Build card" at the bottom.

## Seedhi baat (Pardeep ke liye)

- **Kya chahiye:** owner apne roles khud bana sake (jaise "Test User"), har role me
  checkbox se chune ki wo kya dekh / kar sakta hai, aur team member ko wo role de sake.
- **Abhi kyun nahi:** aaj ki saari suraksha (database rules, menu, page guard, API) role ke
  **naam** par bani hai — "owner", "billing" jaise naam ~300 jagah likhe hain. Custom role
  ka naam in liston me hoga hi nahi, to har jagah badalna padega. Ek bhi jagah chhoot gayi
  to ya to kisi ko zyada dikhega (leak) ya kaam band. Launch se pehle ye risk nahi lena.
- **Plan:** pehle "permission" ki ek list banao (jaise `invoices.view`, `money.record`),
  aaj ke 9 roles ko us list me badlo (bina behaviour badle), phir dheere-dheere har
  role-naam check ko permission check se badlo, aur aakhir me owner ke liye role banane ki
  screen. 4 phase, har phase alag deploy, har phase ke baad security re-test.
- **Abhi zaroorat ho to:** ek built-in "tester" role (sirf dekh sakta, kuch badal nahi
  sakta) — chhota kaam, par wo bhi ~20 files chhoota hai (neeche "Chhota option").

## Aaj ka system (current state, counts 17 Oct 2026, branch manager-pardeep @ bac5fe90)

Roles fixed hain — 9 built-ins, ek DB enum:

| Layer | Kahan | Kya karta hai |
|---|---|---|
| Role list | `production/src/lib/auth/roles.ts:43` `USER_ROLES` | owner, manager, sales_senior, sales, billing, delivery, accountant, support, partner_agent |
| DB column | `prisma/schema.prisma:4967` enum `user_role`; `public.users.role` (`schema.prisma:4396`), `team_invites.role` (`:4030`) | enum = DB khud galat naam rokta hai (koi check constraint nahi, enum hi constraint hai) |
| Permission matrix | `roles.ts:165` `PERMISSIONS` (7 flags: export, contact details, vault reveal, financials, manage team, secrets, contact customers); `can()` `roles.ts:232` | sirf 3 jagah (non-test) `can()` call hota hai |
| Money lists | `roles.ts:269-283` `MONEY_RECORD_ROLES`, `MONEY_DELETE_ROLES`; `nav.ts:336-384` `SALARY_ROLES`, `MONEY_WRITE_ROLES`, `SALES_READ_ONLY_ROLES`, `PAYROLL_ROLES` | role-naam listen |
| API actions | `production/src/lib/auth/action-roles.ts:14` `ACTION_ROLES` (8 actions), `mayDo()` `:50` | 17 files `mayDo` use karti hain |
| Menu | `production/src/lib/nav.ts:415` `APP_NAV` — 111 `roles:` entries; `filterNavForRole` `:166` | menu row = role-naam list |
| Page guard | `nav.ts:269` `ROUTE_DENY`, `isRouteAllowed` `:291`, `canOpenRoute` `:373`; `production/src/middleware.ts:28` `PROTECTED_PREFIXES` (54 prefixes), check at `middleware.ts:378` | route allowed = menu se nikla (prefix) minus deny list |
| API guard | `production/src/lib/api/with-route.ts:73-76` (`roles` / `permission`, R-732), check `:127-131` | 30 route files `withRoute`; 2 use `permission:` |
| API ad-hoc | 110 TS files compare the role literally (`role === "owner"`, `.includes(role)`); 53 files use some `*_ROLES` const | sab role-naam |
| SQL helper | `supabase/migrations/20260930175000_role_hardening.sql:52` `current_user_has_role(variadic text[])` — active user + role in list | 218 calls in 36 migration files |
| SQL others | `current_user_is_owner()` 23 calls; 21 migration files read `u.role` / `role in (…)` directly (30 `role in (` / `= any(`) | role-naam lists inside RLS policies and SECURITY DEFINER guards (R-718, R-885, R-1001, R-1003…) |
| Ratchets | `src/app/api/role-gate-ratchet.test.ts` (R-732, ungated mutating routes baseline 30), `src/lib/security/service-role-policies.test.ts` — both on push-guard list | |

Matlab: role ka matlab teen jagah alag-alag likha hai (TS matrix, nav lists, SQL lists).
Wo aaj bhi drift karte hain (R-138, R-1127: billing ko page dikha par RLS ne data chhupaya
→ Rs 0). Custom roles se pehle inhe **ek** jagah laana hi asli kaam hai.

## Goal

1. Owner (sirf `can_manage_team`) apni company ke liye role bana sake: naam + permissions ke checkbox.
2. Role team member ko assign ho; asar menu, page, API aur database — chaaron par ek jaisa.
3. 9 built-in roles bilkul waise hi chalte rahein (kisi existing user ka access na badle).
4. Ek company ka custom role doosri company me kabhi na dikhe / na lage.
5. Fail closed: permission na mile / role mita diya / unknown → kuch nahi milta.

## Proposed model

**1. Permissions catalogue (code me, ek file)** — `src/lib/auth/permissions-catalogue.ts`
(naam baad me). Har permission ek string key + label + group + "kis cheez ko kholta hai":
- aaj ke 7 `PERMISSIONS` flags → `data.export`, `contacts.view_full`, `vault.reveal`,
  `finance.view`, `team.manage`, `secrets.manage`, `customers.contact`;
- aaj ke 8 `ACTION_ROLES` → `seats.change`, `campaign.send`, `contacts.import`,
  `integration.company`, `money.record`, `quote.accept`, `vault.upload`, `support.update`;
- money lists → `money.delete`, `money.write`, `salary.view`, `payroll.view`, `sales.write`;
- menu areas → `<area>.view` per nav group (leads, deals, quotes, invoices, payments,
  subscriptions, renewals, accounting, compliance, marketing, support, whatsapp, partners…),
  roughly 40–60 keys. `<area>.edit` only where a role today sees but may not write.
Catalogue code me rahega (DB me nahi) — permission naya tabhi banta hai jab code use karta
hai; DB sirf "kis role ke paas kaunsi key" rakhega. Ek SQL seed catalogue ki copy rakhta hai
aur ek test dono ko barabar rakhta hai.

**2. `roles` table (per tenant)** — `public.tenant_roles (id uuid, tenant_id uuid null,
key text, name text, permissions text[], is_builtin bool, created_by, created_at)`.
- Built-in 9 roles = rows with `tenant_id null, is_builtin true` — **read-only templates**
  (RLS: select for all authenticated, no insert/update/delete except migration).
- Custom roles = `tenant_id = current_tenant_id()`, owner/manager with `team.manage` write
  karte hain. "Copy from Billing" = template ki permissions copy karke naya role.
- `permissions` me sirf catalogue ki keys (check trigger: `permissions <@ catalogue keys`).

**3. users** — `users.role` (enum) **rehta hai** built-in ke liye (aaj ka saara code chalta
rahe). Naya `users.custom_role_id uuid null references tenant_roles(id)`; set ho to wahi
permissions lagti hain, aur `users.role` us user ke liye "base" (menu home, ROLE_HOME) bane.
Trigger: custom role ka `tenant_id` = user ka `tenant_id` (cross-tenant assign impossible).

**4. Ek SQL function** — `public.has_permission(p text) returns boolean` (stable, security
definer, `search_path = public`, `grant execute … to authenticated, service_role`, not anon):
active user → custom_role_id ho to us row ki `permissions`, warna built-in template ki →
`p = any(...)`. Unknown user / inactive / null tenant → `false` (fail closed §17c).
Policies aur definers `current_user_has_role('owner','manager')` ki jagah
`has_permission('money.record')` likhenge. Per-request cache: `set_config('app.perms', …,
true)` jaisa R-1468 ka `app.aal` pattern (transaction-local).

**5. App side — sab ek hi source se**
- `can(user, key)` naya signature; `mayDo` / `withRoute({ permission })` / `canWriteMoney`
  sab andar se `can()` bulayenge. `withRoute({ roles })` dheere-dheere `permission` me.
- Nav: `NavItem.roles` → `NavItem.perm` (ek key). `filterNavForRole` → `filterNavForPerms`.
  `ROUTE_DENY` khatam — deny ab bas "perm nahi hai" (jaise billing ke paas `payroll.view` nahi).
- Middleware: session me role ki jagah permission list (JWT claim ya short cache), `isRouteAllowed`
  usi se. Role badle to purana session 5 min me refresh (aaj ka R-1003 jaisa).

## Migration plan (phases)

**P1 — catalogue + `has_permission`, behaviour bilkul same (~3–4 din)**
Catalogue file; `tenant_roles` with 9 built-in templates whose permission sets EXACTLY
reproduce today's lists (generated from `PERMISSIONS`, `ACTION_ROLES`, nav `roles:`, SQL
lists); `has_permission()`; `users.custom_role_id` (null for everyone). Equivalence test:
for every built-in role × every key, `can(role,key)` == old answer and
`has_permission` == old SQL list. Koi policy abhi nahi badli. Deploy = no visible change.

**P2 — role-naam checks ko permission se badlo, file by file (~2–3 hafte, sabse bada)**
Slices: SQL (36 files / 218 `current_user_has_role` + 21 direct `role in` files — naye
migration me policy/definer `create or replace`, puraane migration nahi chhoote), API (110
literal + 53 const files), nav (111 rows), middleware. Har slice ke saath **ratchet test**:
"`current_user_has_role(` / `role === "` ki ginti sirf kam ho sakti hai" (role-gate-ratchet
jaisa, baseline har slice me neeche). Aakhir me baseline 0, aur `current_user_has_role`
sirf `has_permission` ke andar. Billing/Customer areas (Abhishek, Pawan) ke files unke
owners ke saath — CROSS-TEAM-REQUESTS me slice list.

**P3 — UI: role banao + assign (~1 hafta)**
Settings → Team → Roles: list (built-in = lock icon, "Copy"), New role (naam + grouped
checkboxes with plain labels), Edit, Delete (sirf jab koi user assigned nahi). Team page par
role dropdown me custom roles bhi. Audit log: kisne kaunsa role kab badla. Owner apna khud
ka role kabhi nahi kho sakta (last owner guard, aaj jaisa).

**P4 — "Test User" read-only template (~1–2 din)**
Built-in template `viewer`: saare `*.view`, koi write/export/reveal/contact nahi. Owner
copy karke "Test User" bana sakta hai. Abhishek ka asli use-case yahi hai.

Total rough: **4–6 hafte** ek developer, P2 ke saath security re-test.

## Security re-test plan

1. **Equivalence (P1, P2 har slice):** built-in roles ka har (role, key) aur har (role, route)
   ka jawab pehle == baad — table-driven test, generated from the old lists before deleting them.
2. **Cross-tenant:** company A ka custom role company B ke user ko assign nahi ho sakta
   (trigger), B ki screen par dikhta nahi (RLS), A ka owner B ke role edit nahi kar sakta.
   Real-Postgres test (service-role-policies.test.ts jaisa).
3. **Fail closed (§17c):** `has_permission` null tenant / inactive user / deleted role /
   unknown key → false; har naya definer §17c pattern + R-401 grant guard.
4. **Escalation:** `team.manage` wala user apne aap ko ya kisi ko woh permission nahi de
   sakta jo uske paas khud nahi (no grant-up); sirf owner `secrets.manage` / `team.manage` de.
5. **Ratchets:** role-gate-ratchet (API), naya role-name ratchet (SQL + TS), service-role
   policies — sab push-guard list par.
6. **Manual staging pass:** har built-in role se login karke menu + 10 key pages + 5 writes;
   phir ek custom "Test User" se same — kuch likh na paye, export na ho, contact masked.

## Risks

- **Silent widening:** ek policy galat key se badli → billing ko salary dikh gayi. Bachav:
  equivalence test old lists se generate, puraani list tabhi delete jab test green.
- **Drift wapas:** koi naya page `roles: [...]` likhe. Bachav: ratchet baseline 0 + lint rule.
- **Performance:** `has_permission` har row par. Stable + transaction-local cache; P1 me
  EXPLAIN on 5 biggest tables.
- **Session staleness:** role badla par purana JWT. Bachav: perms server par har request
  me DB/cache se, JWT me sirf hint.
- **Doosre owners ka code:** P2 ka bada hissa Billing/Customer areas me hai — un owners ka
  time chahiye, warna wo slices ruk jaayenge.
- **Enum lock-in:** `user_role` enum se value hatana mushkil — isliye enum rehta hai,
  custom role alag column me.

## Chhota option (abhi chahiye to): built-in read-only `tester` role

Kya chhoota hai (har jagah ek naya naam):
- `ALTER TYPE public.user_role ADD VALUE 'tester'` (naya migration) + `prisma/schema.prisma` enum.
- `roles.ts`: `USER_ROLES`, `ROLE_LABEL`, `PERMISSIONS` (= NONE), `GATEWAY_LIMITED_BY_ROLE`
  (type check sab dikha dega). `INVITABLE_ROLES` me aa jaayega.
- `nav.ts`: 111 `roles:` rows me se jo "dekhne" wale hain unme `tester` jodna (ya
  `filterNavForRole` me tester ko "manager ka menu" map karna, jaise sales_senior→sales),
  `ROLE_HOME.tester`, `ROUTE_DENY.tester` me saare `/new` aur settings.
- SQL: read policies jo `current_user_has_role(...)` se select rokti hain (36 files ka
  subset) me `'tester'` jodna; **write** policies me nahi — default deny se write band.
  Agar policies "same tenant = read" hain to kuch nahi karna.
- API: koi change nahi chahiye agar har mutating route gated hai — par role-gate-ratchet
  baseline aaj 30 hai, yani 30 write routes kisi bhi signed-in user ke liye khule hain →
  tester bhi likh paayega. Isliye tester se pehle R-732 baseline 0 hona chahiye.
Effort ~3–5 din + re-test. Lekin P2 me ye kaam phir se karna padega; isliye seedha P4
(viewer template) behtar hai jab tak bahut zaroori na ho.

## Build card

Board par naya card (post-launch, status list, p3): "Custom roles — build (post-launch,
design: docs/design/R-1434-custom-roles.md)". Done when: P1–P4 deployed, equivalence +
cross-tenant + fail-closed tests green, role-name ratchet baseline 0, owner ne staging par
"Test User" bana kar ek login se check kiya.
