# Localhost check of built cards (Chrome) — playbook

For: the "`<card id>` jaanch karo" run (CLAUDE.md) and any checker that follows a card's `howToCheck`
on http://localhost:3001 in Chrome. Built by R-2457 (4 Nov 2026); fixtures: R-2458.

## Hinglish summary (Pardeep ke liye)

- Check se pehle ek hi command: `npm run localhost:ready` (reselleros-deploy/production se). Ye code +
  migrations latest karta hai, server se jawab maangta hai, server atka ho to SIRF apna `next dev` band
  karke dobara chalata hai, Local test login jaanchta hai, pages garam karta hai, aur ek line deta hai:
  `READY …` ya `NOT READY — <kyun>`.
- Har card ke liye: `npm run card:check -- R-xxxx` — kaunsa login button dabana hai, har step ka pura
  localhost link, aur kaunsa data local company me shayad nahi hai.
- Local test login hamesha **"E2E Test Co"** me le jaata hai — aapki asli company ka data (bank account,
  customers) wahan nahi hota. Jo step asli naam maangta hai, uska data pehle banana padta hai (R-2458).
- Localhost par "Sign in with Google" band hai (local setup me Google hota hi nahi) — aur local DB me
  aapka asli account / asli company hai hi nahi (hona bhi nahi chahiye). Doosri local company me jaane ke
  liye: `node scripts/dev/local-login-link.mjs excel-owner@example.test --next /dashboard` → jo link chhape
  use Chrome me kholo. Password nahi lagta.
- Result board par: `--start` aur `--result "✓ …"` patch file banate hain; Claude use card par likhta hai.

## What went wrong on 4 Nov 2026 (27 cards checked) — and the cause

| # | Seen | Root cause | Now |
|---|---|---|---|
| 1 | :3001 was LISTENING but gave no answer for 4+ min; killed by hand; first compile then took ~2 min | A dev server can hang (stuck compile / worker); nothing checked it; restarting by hand risked killing the wrong process | `localhost:ready` probes `/api/version` (public, no DB). Listening + 3 probes of 60 s (3 min — a compile after an update can take ~2 min) with no answer = hung → kills ONLY the process tree of THIS checkout's `next dev` / `dev-local.mjs` (the listener must be node running next dev and its tree must name the checkout folder — a worker's or another project's server is refused) and starts `dev:local` again, then warms pages |
| 2 | Chrome not signed in; Local test login opened a company that is not the one the steps named | Local test login (R-281) signs in the seeded `e2e-*@example.test` users, all in **E2E Test Co**; the local DB also holds other test companies, so steps naming a real company's bank or customer point at data that is not there | `localhost:ready` checks the test login works (POST `/api/dev/test-login`, the app holds the password); `card:check` prints which button to click and says "company E2E Test Co" |
| 3 | Local DB missed merged migrations | Workers sometimes applied single migrations by hand; nobody ran `localhost:update` before checking | `localhost:ready` runs `localhost:update` first (code + every pending migration, superseded ones skipped — R-2106) |
| 4 | The Chrome extension's first screenshot failed while the page was redirecting | Screenshot taken during the `/login` → page redirect | Method below: after navigate, wait for the final URL / a page heading, then screenshot; one retry |
| 6 | "Sign in with Google" on localhost:3001 / 127.0.0.1:3001 says "Google sign-in isn't turned on here" — the owner normally signs in with Google, so he had no easy way into a company | The LOCAL Supabase stack (`production/supabase/config.toml`) has no `[auth.external.google]` block, so local GoTrue reports Google off and the login page's button (R-098) stops with that message. That is by design, and turning it on would not help: the local DB holds **no real accounts and no real company** (checked 4 Nov: all 16 local users are test addresses — example.test / demo.test / …; real live data must never be copied to a laptop). A Google login would create a new empty user and land on /welcome. Enabling it would also need a Google OAuth client for `http://127.0.0.1:54321/auth/v1/callback`, its secret in the shell env and a local stack restart | Use the existing local-only one-time link (R-878, no password): `node scripts/dev/local-login-link.mjs <owner>@example.test --next /dashboard` → open the printed link in Chrome. It refuses any non-`@example.test` address, a non-local host and a non-local Supabase. On Pardeep's laptop the seed company (id `11111111-…`) owner is `excel-owner@example.test`; E2E Test Co's owner is the Owner button. `localhost:ready` prints this hint. A login-page button for "seed company owner" would be a new auth path → its own card with a security review, not done here |
| 5 | `howToCheck` steps assumed data that does not exist locally (USD inward lines, a customer with no state, two connected companies, a partly paid salary, a Razorpay test key) | No rule said the steps must name data that exists in the local test company; no fixtures for these | Rule in `docs/WORKER-STEPS.md` (howToCheck names pages + data in E2E Test Co, or the scenario that makes it); `card:check` flags such steps; R-2458 adds the missing scenarios to the existing loader (`scripts/dev/scenario.mjs`, R-1957) |

## Audit notes (what exists, so nobody rebuilds it)

- `npm run localhost:update` (R-2106, `production/scripts/ops/localhost-update.mjs`) — moves the detached
  reselleros-deploy checkout to `anutech/manager-pardeep`, keeps the local `dev-local.mjs` edit, applies
  pending migrations on the local docker DB. Never restarts the server; prints when a restart is needed.
  Refuses a checkout on a branch (so it never moves a worker worktree).
- `npm run dev:local` (`production/scripts/dev-local.mjs`) — blanks every `.env.local` key except a small
  allowlist, points Supabase + Prisma at the LOCAL stack (refuses a non-local `supabase status`), sets
  `NEXT_PUBLIC_APP_ENV=local`, `CRON_SECRET=local-dev-cron-secret`. Turbopack by default.
- Local test login (R-281) — login page buttons Owner / Manager / Accountant / Sales / Owner 2, only with
  `NEXT_PUBLIC_APP_ENV=local`, not production, on localhost / 127.0.0.1. The server reads the test password
  from env or the gitignored `production/.env.test` (E2E_* lines only). Seed: `E2E_ALLOW_SEED=1 node
  e2e/fixtures/seed-e2e-tenant.mjs` (local only). One-time link instead of a button:
  `node scripts/dev/local-login-link.mjs e2e-owner@example.test --next /quotes`.
- The "+ Demo data" button next to the LOCAL badge fills E2E Test Co with rows tagged "DEMO · …".
- Test scenarios (R-1957, `node scripts/dev/scenario.mjs <name>`) — fixed-id, idempotent data for named
  money/reconcile cards in E2E Test Co, with a hard local guard (`scenarioTargetReason`). New fixtures go
  here, not into a new seed system (R-2458).
- R-2458 scenarios (4 Nov 2026) — `node scripts/dev/scenario.mjs` lists them; `all` loads every one; loading twice
  gives the same rows; `--clear` takes one away (E2E Test Co only, plus the second company it makes):
  | Scenario | Data | Cards |
  |---|---|---|
  | customer-no-state | SCN Pathak Fabrication (State "Not known yet") + draft quote Q-SCN-NS-1 | R-2363, R-2442, R-2448 |
  | usd-inw-lines | 3 "INW … USD…@rate" lines on SCN HDFC Current ··7788 (new sale, one paying USD invoice INV-SCN-USD-1 at another rate, one short) | R-2425, R-2427, R-2440 |
  | lut-per-fy | LUT ARN for last FY + this FY (needs migration R-2444; skipped before it) | R-2444, R-2440 |
  | zero-ref-credits | two ₹5,000 credits with reference 000000000000000 + invoices ZR-1..3 for two customers | R-2430, R-2424, R-2441 |
  | small-leftover | ₹354 unpaid bill, ₹5,900 bill with ₹55 left, two late customers (Payment Follow-up) | R-2421, R-2413 |
  | salary-part-paid | SCN Ravi Kumar salary partly paid (₹25,000 of ₹30,000) + SCN Sunita Rao FULL N FINAL line and a later salary line | R-2428 |
  | nbfc-interest | SCN Bajaj Finance (NBFC) ₹13,000 interest this FY, SCN HDFC Bank ₹8,000, an EMI money-out line | R-2376 |
  | approved-quote | Q-SCN-AP-1 approved by the manager (10% off, ₹1,000 cost) + two accepted quotes for Combine | R-2447, R-2441 |
  | connected-companies | second company SCN Network Partner Pvt Ltd, accepted connection, both GSTINs proved, 2 Pending invoices in Purchase Inbox → From network | R-2433, R-2445, R-2449, R-2434, R-2450 |
  Flex subscriptions (R-2422, R-2431): `ads-month` (Gamma monthly flex). Not in fixtures (card:check says
  "No ready-made data"): a Razorpay test key, a Zoho connection, a login for the second company, a one-owner
  company, renewal part quotes — R-2464.
- Local guard helpers: `production/scripts/dev/local-guard.mjs` (`dbUrlLocalReason`,
  `scenarioTargetReason`, `appHostLocalReason`) — `localhost:ready` and `card:check` reuse them.

## Method (each check run)

1. **Once per session:** from `C:/Users/mso50/reselleros-deploy/production`: `npm run localhost:ready`.
   Go on only on a `READY` line. `NOT READY` says why (local guard, migration failed, 5xx Build Error, test
   login not seeded, port still taken). `-- --dry-run` shows what it would do and changes nothing.
2. **Per card:** save the card (ArtifactData get, out_dir `<home>/Anutech-HQ/cardfile`), then
   `npm run card:check -- R-xxxx`. Check the id it prints (R-008 is not R-088).
3. `npm run card:check -- R-xxxx --start --now "Login kar raha hai"` → apply the patch file to the card
   (ArtifactData update, file_path, if_version). Update `checkNow` at each step.
4. In Chrome: open `http://localhost:3001/login` → Local test login → the button card:check named.
   For a "logged out" step use a new tab at `http://127.0.0.1:3001/…` (no localhost cookie) — never sign out.
5. For each step: navigate → **wait for the final URL and a page heading** (redirects finish first) →
   screenshot → read the numbers/text the step names. If the first screenshot fails, wait 2 s and retry once.
6. A step whose data is missing (card:check's `data:` line): load the scenario it names; if none exists,
   create the minimum by hand in E2E Test Co, or write `⚠` saying exactly what was missing — never "passed".
7. `npm run card:check -- R-xxxx --result "✓ …"` (or `"⚠ …"`) → apply the patch. Never change `status`.

## Hard rules

- Local only. `localhost:ready` refuses when NODE_ENV is production, no `supabase_db_*` container runs, or a
  Supabase/database URL (shell env or `supabase status`) is not local. No flag turns that off.
- Never staging or live data. Never print or type a password, key or cookie — the test login route holds
  the password; scripts only send the role.
- Kill only our own dev server: the listener on the dev port must be node running `next dev` /
  `dev-local.mjs`; its parents are walked only while they are the same dev server's node/cmd processes.
  If the process list cannot be read, only the server localhost:ready itself started (its pid file) is killed.
  Never `localhost:ready` while someone else is mid-check without telling them — use `--no-restart` to
  only look.
- A 5xx (Build Error) is not fixed by a restart — read the server log; `npm ci` in the shared node_modules
  is the coordinator's call (R-2385).

## Plan / status

- [x] (a) `npm run localhost:ready` — R-2457
- [x] (c) `npm run card:check -- R-xxxx` + board patches — R-2457
- [x] (d) howToCheck rule in `docs/WORKER-STEPS.md` — R-2457
- [x] (b) fixtures for the 4 Nov data gaps as R-1957 scenarios — R-2458 (9 scenarios; card:check names them)
- [ ] (e) second-company login, one-owner company, renewal part quotes — R-2464

## Lessons log

- 4 Nov 2026 (R-2458): the old `project-receipts` reset stopped (FK) once a tester had quoted / taken a payment
  on SCN Acme — a scenario customer must take everything hanging off it with it (`scn_drop_customer_docs` in
  `_common.sql`). Run `node scripts/dev/scenario.mjs --self-test` after adding a scenario: it proves load →
  app steps → reset → reload → clear on the real local DB, rolled back.

- 4 Nov 2026 (R-2457): on the loaded laptop PowerShell itself (even `powershell -Command 1`, so also
  `Get-CimInstance Win32_Process`) gave no answer in 60–90 s from a worker shell. So: the process list is read
  only when a kill is needed (45 s limit), and when it cannot be read, localhost:ready kills only a server it
  started itself (pid file in the temp folder, same port + checkout, still node.exe — checked with
  `tasklist`). A server started by hand cannot be proven ours then → refused. **Let localhost:ready start
  the :3001 server** (stop a hand-started one once with Ctrl+C in its window), so later hangs are fixed
  without a hand.
