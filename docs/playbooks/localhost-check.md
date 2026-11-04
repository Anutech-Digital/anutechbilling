# Localhost check of built cards (Chrome) — playbook

For: the "`<card id>` jaanch karo" run (CLAUDE.md) and any checker that follows a card's `howToCheck`
on http://localhost:3001 in Chrome. Built by R-2457 (4 Nov 2026); fixtures follow in R-2458.

## Hinglish summary (Pardeep ke liye)

- Check se pehle ek hi command: `npm run localhost:ready` (reselleros-deploy/production se). Ye code +
  migrations latest karta hai, server se jawab maangta hai, server atka ho to SIRF apna `next dev` band
  karke dobara chalata hai, Local test login jaanchta hai, pages garam karta hai, aur ek line deta hai:
  `READY …` ya `NOT READY — <kyun>`.
- Har card ke liye: `npm run card:check -- R-xxxx` — kaunsa login button dabana hai, har step ka pura
  localhost link, aur kaunsa data local company me shayad nahi hai.
- Local test login hamesha **"E2E Test Co"** me le jaata hai — aapki asli company ka data (bank account,
  customers) wahan nahi hota. Jo step asli naam maangta hai, uska data pehle banana padta hai (R-2458).
- Result board par: `--start` aur `--result "✓ …"` patch file banate hain; Claude use card par likhta hai.

## What went wrong on 4 Nov 2026 (27 cards checked) — and the cause

| # | Seen | Root cause | Now |
|---|---|---|---|
| 1 | :3001 was LISTENING but gave no answer for 4+ min; killed by hand; first compile then took ~2 min | A dev server can hang (stuck compile / worker); nothing checked it; restarting by hand risked killing the wrong process | `localhost:ready` probes `/api/version` (public, no DB). Listening + 3 probes of 30 s with no answer = hung → kills ONLY the process tree of our own `next dev` / `dev-local.mjs` (the listener must be node running next dev — anything else is refused) and starts `dev:local` again, then warms pages |
| 2 | Chrome not signed in; Local test login opened a company that is not the one the steps named | Local test login (R-281) signs in the seeded `e2e-*@example.test` users, all in **E2E Test Co**; the local DB also holds other test companies, so steps naming a real company's bank or customer point at data that is not there | `localhost:ready` checks the test login works (POST `/api/dev/test-login`, the app holds the password); `card:check` prints which button to click and says "company E2E Test Co" |
| 3 | Local DB missed merged migrations | Workers sometimes applied single migrations by hand; nobody ran `localhost:update` before checking | `localhost:ready` runs `localhost:update` first (code + every pending migration, superseded ones skipped — R-2106) |
| 4 | The Chrome extension's first screenshot failed while the page was redirecting | Screenshot taken during the `/login` → page redirect | Method below: after navigate, wait for the final URL / a page heading, then screenshot; one retry |
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
- [ ] (b) fixtures for the 4 Nov data gaps as R-1957 scenarios — R-2458

## Lessons log

- 4 Nov 2026 (R-2457): on the loaded laptop PowerShell itself (even `powershell -Command 1`, so also
  `Get-CimInstance Win32_Process`) gave no answer in 60–90 s from a worker shell. So: the process list is read
  only when a kill is needed (45 s limit), and when it cannot be read, localhost:ready kills only a server it
  started itself (pid file in the temp folder, same port + checkout, still node.exe — checked with
  `tasklist`). A server started by hand cannot be proven ours then → refused. **Let localhost:ready start
  the :3001 server** (stop a hand-started one once with Ctrl+C in its window), so later hangs are fixed
  without a hand.
