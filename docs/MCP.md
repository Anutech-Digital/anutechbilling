# ResellerOS in Claude chat (MCP connector)

Add ResellerOS as a **custom connector** in claude.ai and ask about the business in plain words —
"aaj ki queue dikhao", "overdue invoices batao". Claude reads (and, if you allow it, makes small
changes) **as you**: it sees exactly what your login sees in the app, nothing more.

Built on branch `session/mcp-server` (20 Nov 2026). **Off by default** — nothing is reachable until
`MCP_ENABLED=true` is set on a server.

---

## 1. What was built

| Part | Where |
|---|---|
| MCP server (official TypeScript SDK 1.32.2, Streamable HTTP, stateless — a new server per request) | `production/src/app/api/mcp/route.ts` → `production/src/lib/mcp/` |
| OAuth 2.1 sign-in for Claude (PKCE, dynamic client registration, refresh, revoke) | `production/src/lib/mcp/oauth/`, `production/src/app/api/mcp/oauth/*`, `production/src/app/.well-known/*` |
| Consent screen ("Connect Claude to ResellerOS?") | `/mcp/authorize` — `production/src/app/(auth)/mcp/authorize/page.tsx` |
| Your connections (list / disconnect) | `GET` / `POST /api/mcp/connections` |
| 23 read tools, 7 write tools | `production/src/lib/mcp/tools/` |
| Audit log, write previews, connections (new tables, RLS) | migration `production/supabase/migrations/20261120151905_mcp_connector.sql`, test `production/supabase/tests/mcp_connector_rls.test.sql` |
| Staging NOINDEX | `production/src/lib/security/noindex.ts`, used by `middleware.ts` and `app/robots.ts` |

### How a request is checked (every call, nothing cached)

1. Bearer access token → signature + 1-hour expiry (`lib/mcp/oauth/grants.ts`).
2. Your `users` row is read **as you** → active? same company as when you connected? not a personal
   account? Role comes from this row, never from the token — a role change applies on the next call.
3. The connection row (`mcp_oauth_grants`) must still be `active` → a disconnect stops Claude at once.
4. Per-person rate limit (60 tool calls / minute).
5. The tool's role check: you must be able to open its page in the app (`lib/nav.ts`), plus the
   brief's extra limits (P&L: owner / accountant; salary: owner / manager; support notes: the
   `support.update` roles). Phone numbers and emails are masked for roles without
   `can_view_contact_details` — same rule as the app.
6. The tool runs. Every database call uses a short-lived JWT minted **for you** (the same
   10-minute token the app mints for an Auth.js login), so Postgres RLS (`current_tenant_id()`)
   decides what is visible. **No service-role client exists in MCP code** — `lib/mcp/guard.test.ts`
   fails the build if one appears.
7. One row in `mcp_audit_log`: tool, input, status (ok / preview / denied / error / rate_limited …),
   and before/after values for changes.

Money is whole rupees, printed `₹1,23,456`. **GST (18%) is always a separate figure** — taxable
value, GST (CGST + SGST or IGST via `lib/gst/tax-split`) and total. Dates are IST.

---

## 2. Environment variables

| Variable | Default | What it does |
|---|---|---|
| `MCP_ENABLED` | off | `true` turns on `/api/mcp`, the OAuth endpoints and the consent page. Off → all 404. |
| `MCP_WRITE_ENABLED` | off | `true` lets a connection ask for changes (write tools). Needs `MCP_ENABLED`. |
| `MCP_OAUTH_SECRET` | — | **Required when on.** 32+ random characters; signs client ids, codes and tokens. Server-only (Secret Manager). Changing it logs every Claude connection out. |
| `SUPABASE_JWT_SECRET` | already set | Used to mint the per-user DB token (same as Auth.js). Must be present. |
| `NEXT_PUBLIC_APP_URL` | already set | The public address; issuer and resource URLs are built from it. |
| `NOINDEX` | off | `true` on **staging only**: `X-Robots-Tag: noindex, nofollow` on every response and robots.txt `Disallow: /`. |

Generate a secret: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`

---

## 3. Staging deploy steps (Cloud Build / Cloud Run)

Do these as the normal deploy step (Abhishek / Pardeep). Nothing here touches production.

1. **Merge** `session/mcp-server` into `manager-pardeep` the usual way (worker-lock push), so the next
   staging train carries it.
2. **Database** — apply the migration on staging with the usual deploy-db step. It is additive
   (three new tables, one trigger). Then check: `select to_regclass('public.mcp_audit_log'),
   to_regclass('public.mcp_oauth_grants'), to_regclass('public.mcp_write_previews');` → three names.
3. **Secret** — create it once:
   ```bash
   node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" | gcloud secrets create mcp-oauth-secret --data-file=- --project=resellsubsos-prod
   ```
4. **Env vars** — on the staging service only, and with `--update-*`, never `--set-env-vars`
   (that replaces all eleven existing ones):
   ```bash
   gcloud run services update resellersos-staging --region=asia-southeast1 \
     --update-env-vars=MCP_ENABLED=true,NOINDEX=true \
     --update-secrets=MCP_OAUTH_SECRET=mcp-oauth-secret:latest
   ```
   Leave `MCP_WRITE_ENABLED` off for the first week; add `MCP_WRITE_ENABLED=true` once reads look right.
5. **Smoke check** (no login needed):
   ```bash
   curl -s https://resellersos-staging-njvk4nxhdq-as.a.run.app/.well-known/oauth-authorization-server
   curl -si https://resellersos-staging-njvk4nxhdq-as.a.run.app/api/mcp -X POST | head -5   # expect 401 + WWW-Authenticate
   curl -si https://resellersos-staging-njvk4nxhdq-as.a.run.app/robots.txt                # expect Disallow: /
   ```

To switch it off again: `--update-env-vars=MCP_ENABLED=false` (everything answers 404 at once).

---

## 4. Testing with MCP Inspector

1. Run the app locally with `MCP_ENABLED=true` and `MCP_OAUTH_SECRET=<32+ chars>` in `.env.local`.
   Apply the migration to your local database first.
2. `npx @modelcontextprotocol/inspector` → Transport **Streamable HTTP**, URL `http://localhost:3001/api/mcp`.
3. Click **Connect** → Inspector registers itself, opens `/mcp/authorize` → sign in → **Allow**.
4. **List Tools**, then try `get_today_queue` and `list_invoices` with `{"status":"overdue"}`.
5. For a change (with `MCP_WRITE_ENABLED=true` and "Also allow changes" ticked): call `add_lead_note`
   with an `idempotency_key` → you get a `preview_id`; call it again with the same fields plus
   `confirm: true` and the `preview_id`.

---

## 5. Adding the connector in claude.ai

1. claude.ai → **Settings → Connectors → Add custom connector**.
2. Name: `ResellerOS`. URL: `https://<your server>/api/mcp` (staging:
   `https://resellersos-staging-njvk4nxhdq-as.a.run.app/api/mcp`).
3. Click **Connect**. A ResellerOS page opens: sign in (email + password or Google) if asked, read
   "Connect Claude to ResellerOS?" — it shows your name, role and company — and press **Allow**.
   Tick "Also allow changes" only if you want Claude to add leads / tasks / notes.
4. In a chat, turn the connector on and ask.

---

## 6. Tools, with example prompts

### Read (always available when `MCP_ENABLED=true`, subject to your role)

| Tool | What it gives | Try saying |
|---|---|---|
| `get_today_queue` | Ranked "what needs me today" (tasks, enquiries, support, renewals, overdue invoices, failed payments, deals) | "aaj ki queue dikhao" |
| `get_dashboard_summary` | New leads, open deals, invoiced (with GST), received, overdue, renewals, my overdue tasks, open tickets — today / week / month / FY | "is mahine ka business kaisa raha?" |
| `list_leads` / `get_lead` | Leads by stage, search, follow-up due; one lead with activity and open tasks | "aaj kis lead ka follow-up hai?" |
| `list_enquiries` | The Enquiries inbox | "nayi enquiries dikhao" |
| `list_deals` | Open / won / lost deals, closing within N days | "is hafte close hone wali deals" |
| `list_tasks` | My (or everyone's) tasks: overdue / today / week | "mere overdue tasks" |
| `list_customers` / `get_customer` | Customers; one customer with subscriptions, recent invoices, dues | "Acme ka kitna baaki hai?" |
| `list_quotes` / `get_quote` | Quotes with ex-GST, GST and total | "sent quotes jo abhi accept nahi hue" |
| `list_invoices` / `get_invoice` | `unpaid`, `overdue`, `paid`, date range, customer; GST split, balance due | "overdue invoices batao" |
| `list_payments` | Money received in a date range | "kal kitna payment aaya?" |
| `list_renewals` | Active subscriptions renewing within N days (default 30), by product | "is hafte ki renewals", "Workspace renewals agle 15 din" |
| `list_subscriptions` | Subscriptions by status / vendor / customer | "Microsoft ke active subscriptions" |
| `list_unmatched_bank_entries` | Bank lines not matched yet | "bank ki unmatched entries" |
| `get_pnl_summary` | Headline P&L (GST basis): revenue, output GST, COGS, expenses, profit before depreciation — **owner / accountant only** | "pichhle mahine ka P&L" |
| `list_staff` | People and roles | "team list dikhao" |
| `get_attendance_summary` | Today's check-ins, or days present in a month | "aaj kaun aaya hai?" |
| `get_salary_summary` | A month's salaries, deductions, paid / to pay — **owner / manager only** | "October ki salary summary" |
| `list_support_tickets` | Open tickets, mine, by priority | "high priority tickets" |
| `search` | Leads, customers, quotes, invoices, tickets in one go | "Sharma Traders dhundo" |

Every list has `limit` (max 50) and `offset`; the answer carries `next_offset` for the next page.

### Write (only with `MCP_WRITE_ENABLED=true` AND "Also allow changes" ticked) — Phase A

| Tool | What it does | Try saying |
|---|---|---|
| `add_lead` | New lead, stage New, owned by you; preview lists possible duplicates | "naya lead add karo: Gupta Exports, 20 users Workspace" |
| `update_lead_status` | Move a lead to new / contact / demo / trial / quote / lost (lost needs a reason). Not "won" — that comes from an accepted quote. | "L-ABC123 ko demo stage me daalo" |
| `add_lead_note` | Note on the lead's timeline | "is lead pe note likho: kal demo" |
| `create_task` | Task for yourself on a date / time (IST) | "kal 11 baje proposal bhejne ka task banao" |
| `complete_task` | Mark a task done | "ye task done kar do" |
| `set_followup_reminder` | Follow-up task + reminder on a lead (sets its follow-up date) | "Acme ka follow-up parso 10:30 pe" |
| `add_support_ticket_note` | **Internal** note on a ticket (customer doesn't see it, nothing is emailed) | "ticket pe note: MX records check kiye" |

**How writes work — always two steps.** First call → a **preview** ("Move Acme from contact → demo"),
nothing saved. Claude shows it to you. Only after you say yes does Claude call again with
`confirm=true` and the `preview_id`. The confirm must carry exactly the same fields (checked by hash),
within 15 minutes, and the record must not have changed since the preview. Each change has an
`idempotency_key`: if Claude retries, the change is not made twice. Before/after values go to
`mcp_audit_log`.

**Never built:** deleting anything, sending email or WhatsApp, refunds, GST settings, user roles or
passwords, editing finalized invoices, the vault, telecalling — and no writes in Billing & Subscriptions.

---

## 7. How to revoke access

- **One connection:** claude.ai → Settings → Connectors → ResellerOS → Disconnect. Claude calls our
  revocation endpoint; the connection is marked `revoked` and stops working on the next call.
- **From ResellerOS (all your connections):** while signed in, `POST /api/mcp/connections` with
  `{"all": true}` (or `{"id": "<connection id>"}`; `GET /api/mcp/connections` lists them). A revoked
  connection can never be switched back on (database trigger).
- **Someone else's access:** deactivate their login (Team page) — every MCP call checks the user is
  active, so all their connections stop at once.
- **Everyone at once:** change `MCP_OAUTH_SECRET` (all tokens become invalid) or set `MCP_ENABLED=false`.

Owner / manager can read the whole company's audit log: `select * from mcp_audit_log order by created_at desc`.

---

## 8. Decisions & assumptions

1. **OAuth server: built a minimal one in Next.js, not Supabase's.** Production auth is a self-hosted
   GoTrue `v2.151.0` (no OAuth-server feature) and staging already runs Auth.js (`AUTH_PROVIDER=authjs`),
   so there is no Supabase OAuth server to use. The authorization server sits on top of whichever login
   the app has (email + password, Google): `/mcp/authorize` uses the normal session, and `/login?next=`
   brings a signed-out person back.
2. **The caller's JWT is minted, not borrowed.** The brief says every DB call must use a client created
   with the user's JWT. Each call mints the same 10-minute HS256 token the app already mints for Auth.js
   sessions (`server/auth/supabase-jwt.ts`), for the user named in a verified access token whose
   connection row is still active. RLS sees an ordinary signed-in user. The MFA level (`aal`) is the one
   the person had when they pressed Allow, carried inside the signed token.
3. **Stateless tokens + one DB row per connection.** Client ids, codes and tokens are HMAC-signed
   (`MCP_OAUTH_SECRET`); no shared memory is needed between Cloud Run instances. The row makes codes
   one-use, refresh tokens rotate (a reused one is refused), and revocation immediate. Codes and refresh
   secrets are stored only as sha256. Access tokens: 1 hour; refresh: 30 days since last use.
4. **Public clients only** (PKCE S256, no client secret) — what claude.ai and MCP Inspector use.
   Redirect URIs must be https (or http on localhost) and match exactly.
5. **Rate limits are per server instance** (in memory, same design as `lib/security/rate-limit.ts`):
   60 tool calls / minute / person; 30 OAuth calls / minute / IP. The shared Postgres limiter needs the
   service role, which MCP code must not use.
6. **Role gating reuses the app's own matrix**: a tool is offered only if your role can open its page
   (`lib/nav.ts`), plus the brief's narrower lists. Personal (free) accounts get no tools.
7. **P&L tool shows headline figures on the GST (as-invoiced) basis** from `report_pnl`. Depreciation,
   project-labour allocation and director-payroll moves are not included and the answer says so — the
   full P&L is a client-side assembly that cannot run on the server without copying it.
8. **"Dues" on a customer = unpaid invoice balance** using the app's own `invoiceBalance` rule. Credit
   notes / advances on account are on the customer page; the answer points there.
9. **Today queue** = `today_inbox()` + deal rows, ranked with the page's own code. GST/TDS deadline rows
   (built from the compliance log on the client) are not repeated; the answer says so.
10. **`update_lead_status` cannot set "won"** — a won lead comes from an accepted quote (billing flow).
11. **Tasks are created for yourself only** (no assigning to others from Claude).
12. **Dashboard totals read at most 1,000 rows per figure** and say so; open `/dashboard` for full numbers.
13. **Dependency:** only `@modelcontextprotocol/sdk` (pinned 1.32.2) was added. npm moved one transitive
    package (`side-channel` 1.1.0 → 1.1.1) because the SDK's express/qs requires it; no direct
    dependency (next, @sentry/nextjs, …) changed.
14. **Audit failures don't hide the answer** — a failed audit insert is logged as
    `[mcp] audit insert failed` (an incident to look at), and the tool's result is still returned.
15. **Consent page uses the auth layout** (centred card). It is a single, small server-rendered form;
    the full design-audit trio (design-critique, accessibility-review, layout-audit) has not been run on it.

---

## 9. Needs billing owner approval (Phase B — NOT built)

These touch the Billing & Subscriptions section, which is hands-off (AGENTS.md §13). Proposed only;
each would use the same preview → confirm, idempotency key, role check (`money.record` roles) and audit.

| Proposed tool | What it would do | Would call |
|---|---|---|
| `create_quote_draft` | Draft quote for a lead/customer from catalog items (never sent) | the Quotes screen's create path |
| `convert_quote_to_invoice` | Issue the tax invoice for an accepted quote | `generate_invoice(p_quote_id)` |
| `record_payment` | Record money received against an invoice | `record_payment` RPC (L9: check its guards first) |
| `match_bank_entry` | Match a bank line to an invoice / payment | `reconcile_bank_txn` |
| `mark_renewal_contacted` | Log that a renewal customer was contacted | renewals contact log |

---

## 10. Test status

- Vitest: `src/lib/mcp/*.test.ts` + `src/lib/security/noindex.test.ts` — every tool for success,
  permission denied, cross-tenant blocked and flag-off; OAuth (PKCE, one-use codes, refresh rotation,
  revocation, per-call user/tenant/role re-check); DB wrapper (tenant filter, column allowlist, secret
  columns); routes (404 when off, 401 challenge, CSRF); guard (no service role, no billing imports).
- SQL: `supabase/tests/mcp_connector_rls.test.sql` (own rows only, cross-tenant blocked, audit append-only,
  revoked is final). Run 20 Nov 2026 on the local Supabase (migration + test in one rolled-back
  transaction): **passes**; a mutated assertion turns it red, and the rollback leaves nothing behind.
- Playwright: `e2e/mcp-auth.spec.ts` — metadata, 401 challenge, client registration, signed-out
  authorize → login with `next=`, fake code refused, unregistered redirect never followed. Skips itself
  when `MCP_ENABLED` is off. **3/3 pass** on localhost (20 Nov 2026). Not covered yet: the signed-in
  Allow → token → tool call path in a browser (it needs the migration applied to the local database).
- Gate on this branch (20 Nov 2026): typecheck exit 0, lint exit 0, lint ratchet ok (no rule above
  baseline). Full vitest: every MCP test passes; the one remaining red file,
  `renewals/row-facts-r2876.test.ts`, fails only because this Windows checkout has CRLF line endings
  (`core.autocrlf=true`) and the test matches `\n` — it does not touch MCP code.
