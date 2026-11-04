# G-NETWORK — when my customer or vendor also uses ResellerOS

Spec started 3 Nov 2026 (manager session: code audit of every link between two companies, and web
research — Xero / QuickBooks / Zoho networking, Peppol, Bharat Connect B2B, GST IMS). First card
built from it: R-2433 (N1, connections). Screen: Settings → Network (`/settings?tab=network`).
Code: `supabase/migrations/*_r2433_tenant_connections.sql`, `src/lib/network/*`,
`src/app/(app)/settings/network-tab.tsx`.

## Goal

Two businesses on ResellerOS never type the same document twice and never argue about a balance:
my invoice reaches my customer's app as a draft bill (Accept / Reject / Pending, like GST IMS); their
payment reaches my app as a matched receipt (TDS shown); both see one statement that agrees.
Pilot pair: two sister companies of the owner.

Measure:
- a connected buyer books a seller's invoice with no typing (only Accept);
- the shared statement for a pair shows ₹0 difference after both sides accept;
- no company ever reads another company's data without an accepted connection and that scope.

## Users & flows

- **Owner of company A** opens Settings → Network. "Company B is on ResellerOS — connect?" shows when
  a customer's or vendor's GSTIN equals B's verified GSTIN. Connect fills the GSTIN into
  **Connect by GSTIN**; A ticks what A shares; optional **Group company (same owner)**; Send request.
- **Owner of company B** sees it under **Requests received** — what A will share, ticks what B
  shares, Accept or Decline.
- Both see the pair under **Connected businesses**: what the other side shares, a switch per scope for
  their own side, **Disconnect** (confirm). A sent request shows "Waiting for them to accept" and can
  be withdrawn. Declined / disconnected pairs list under **Earlier**.
- Manager / accountant see the list read-only; sales and other roles see nothing.
- **Distributor** opens Partners: only resellers who share **Partner metrics** with it appear; the
  reseller switches it off in its own Settings → Network.

## Rules

- Identity = **owner-verified GSTIN** on both sides (R-2445): registered with GSTN (`gstin_verified_at`)
  AND proved to be this company's (`gstin_owner_verified_at` for that same GSTIN), when the request is
  made AND when it is accepted, and still the GSTIN the request named. Connect per GSTIN (one per state).
  Registered alone is not enough — anyone can type and "verify" a public GSTIN.
- A connection is always **request → accept by the other company's owner**. Group links (sister
  companies, same owner) too — marked `related_party`, both owners still accept.
- **Never** suggest or connect a personal workspace (`workspace_kind = 'personal'`); never suggest a
  GSTIN that is not owner-verified, and never to a company that has not proved its own.
- Each side chooses its own **scopes**: invoices, payments, statements, pos (purchase orders),
  catalogue, partner_metrics. A scope is what THIS side shares with the other.
- **Revoke** (either owner) stops every future read and sync at once; documents already delivered
  stay as read-only copies.
- Every cross-company read or write is a **SECURITY DEFINER** function that checks: the caller's
  company (`current_tenant_id()` — active user, finished MFA), the role (owner for request / accept /
  scope change / revoke), an **accepted** connection, and the scope. `search_path` set; no grant to
  anon; the table itself has no grant to request roles. Never the old `parent_tenant_id` /
  `linked_tenant_id` alone.
- Admin-client routes (`/api/v1`, webhooks) that ever touch two companies pin BOTH tenant ids.
- The receiver gets a **copy** frozen at issue, never a live link into the other company. Dedupe by
  seller GSTIN + document number + FY. Accepted documents lock; changes only by credit / debit note.
- Receiver keeps its own ITC decision; nothing is filed on the GST portal by our Accept.

## GSTIN ownership (R-2445)

- Our GSTN lookup (Sandbox public search) returns names, address, status — not the registered email /
  mobile — so OTP to the GST contact needs a new paid API (GSP taxpayer OTP). Built instead: the owner
  presses **Prove you own this GSTIN** (Settings → Network, optional note); the platform admin opens
  **Platform → GSTIN ownership checks** (`/platform/gstin-claims`), sees company + GSTIN + GSTN legal /
  trade name + how many companies saved that GSTIN, checks REG-06 or calls the registered contact, and
  approves or rejects with a reason the company sees. Revoke (reason required) undoes a wrong approval.
- One owner per GSTIN (unique index). **Never first come**: the admin approves the real owner even if a
  squatter asked first; approving rejects every other open claim on that GSTIN; a later claim on a held
  GSTIN is refused with the next step (support + REG-06). A squatter is never suggested and cannot
  request, accept, or block the real owner (requests find only the proved owner).
- Any GSTIN change drops the proof at once (trigger); request roles can never write the proof columns.
- Backfill: the two companies of each operator-set parent link were marked owner-verified (`how =
  parent_link`) when their GSTIN was filled in and unique; those links keep working regardless.
- Data: `tenants.gstin_owner_verified_at / _gstin / _how / _by`, table `gstin_ownership_claims`
  (pending → approved / rejected / withdrawn; revoked); functions `network_claim_gstin_ownership`,
  `network_my_gstin_ownership`, internal `network_gstin_owned`, service-role-only
  `platform_gstin_claims`, `platform_decide_gstin_claim`, `platform_revoke_gstin_owner`.

## Data

- `tenant_connections` (N1): `a_tenant_id` (asked) / `b_tenant_id` (was asked), `a_gstin` / `b_gstin`
  (snapshot), `status` requested → accepted / rejected, requested / accepted → revoked, `a_scopes` /
  `b_scopes`, `related_party`, `origin` (`request` / `parent_link`), who / when for each step.
  One open (requested or accepted) row per pair.
- Functions (N1): `network_request_connection`, `network_respond_connection`,
  `network_revoke_connection`, `network_set_my_scopes`, `network_my_connections`,
  `network_suggestions`; internal `network_has_scope(sharer, viewer, scope)` — the one check every
  later cross-company function calls.
- `get_partner_metrics()` lists a child only when the child shares `partner_metrics`.
- Existing parent links were turned into accepted connections (`origin = parent_link`): child shares
  partner_metrics, parent shares catalogue.
- Later: buyer draft bills (N2) reuse `vendor_bills.source_tenant_invoice_id`; GSTR-2B key
  (`lib/gst/gstr2b.ts`) = same match key.

## Constraints

- GST IMS states (Accept / Reject / Pending) and Rule 67B for credit notes — CA to confirm before N2.
- E-invoice IRN: we do not generate IRNs yet; a network bill carries the seller's IRN when present.
- TDS labels: Income-tax Act 2025 section 393 (old 194C / 194J / 194Q in brackets), Form 168.

## Owner decisions

- Suggestions on by default; a connection always needs the other owner's accept — default built
  (owner: "research karke jo sahi lage", 3 Nov 2026).
- Sister companies: group link, both owners accept, marked related party — same date.
- Partner metrics only with the reseller's consent: OFF for new links; existing parent links keep it
  until the reseller turns it off (shown to them) — same date.
- Our Accept mirrors GST IMS but files nothing on the portal — same date.
- Open: should a rejected request be suggested again later? Built: no (the owner can still connect
  by GSTIN).

## Cards graph

| Card | Needs first |
|---|---|
| N0 R-2432 Fix today's invoice → vendor-bill mirror | — |
| N1 R-2433 Connections: request / accept, scopes, revoke, suggestions, group link | — |
| R-2445 GSTIN ownership proof (platform-admin check) before connecting | N1 |
| N2 Invoice → buyer draft bill (Accept / Reject / Pending, dedupe, CN / DN, void, lock) | N0, N1, R-2445 |
| N3 Payment made → seller's matched receipt (TDS shown) | N2 |
| N5 Dispute thread on a shared document | N2 |
| N6 Distributor: reseller PO → distributor quote; catalogue through the connection | N1 |
| N4 Shared statement for the pair ("balance confirmed") | N3 |

Waves: 1 — N0, N1 · 2 — N2 · 3 — N3, N5, N6 · 4 — N4. Board status is the truth for what is built.
