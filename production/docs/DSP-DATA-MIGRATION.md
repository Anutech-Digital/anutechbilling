# DSP → ResellerOS data migration (design)

> Brick 4 of the DSP merge · designed 7 Sep 2026 · status: **PARKED (7 Sep): Pardeep says the
> production DB holds no real data — nothing to migrate. The design stays as the recipe if
> that ever changes; integration now runs against a LOCAL replica from the repo instead.**
> Source: DSP's production MySQL (support.anutech.in — tickets ~1,228, users ~2,166,
> calls ~559 per its AUTO_INCREMENTs). Target: Cloud SQL, ANUTECH tenant
> (`fbb976f1-9090-4f10-9726-0901bd144e42`).
>
> The landing zones were built brick-first ON PURPOSE: notes → brick 1's
> `support_ticket_notes`, time → `support_ticket_time_logs`, verdicts → brick 3's
> `support_ticket_ratings`, thread → `ai_support_conversations`. This document is
> only the pipe between two schemas that already agree.

## 0. What moves, what deliberately does not

| DSP data | Verdict |
|---|---|
| tickets + messages + internal notes + time logs + ticket ratings | **MOVES** — the support history the merge exists for |
| customers (as identity links only) | **LINKS, not rows** — matched to existing ResellerOS customers; unmatched tickets keep name/email inline |
| chats, chat_messages, calls, recordings | **STAYS in DSP** for now — their ResellerOS home does not exist until the Phase-3 chat/calls decision; migrating them into ticket tables would lie about what they were |
| call ratings (`ratings.ref_type='call'`) | STAYS with calls |
| plans, usage counters, invoices, payment_attempts | **NEVER moves** — ResellerOS is already the billing truth; importing a second money-history would create the two-ledgers problem the merge kills |
| users (agents) | NOT as rows — agent names are denormalised into notes/time logs (`author_name`), exactly what brick 1's schema was designed for |

## 1. Identity & idempotency

- Ticket id: `TKT-DSP-<mysql id>` (e.g. `TKT-DSP-1042`) — collision-free against the
  `TKT-…` series, traceable back to DSP forever.
- Everything hangs off the ticket via the composite FK `(tenant_id, ticket_id)`, so
  **rollback is one statement**: `delete from support_tickets where id like 'TKT-DSP-%'`
  cascades notes/time/ratings; the thread rows follow with
  `delete from ai_support_conversations where ticket_id like 'TKT-DSP-%'`.
- The load refuses to start if `select count(*) from support_tickets where id like
  'TKT-DSP-%'` is not 0 (single-shot namespace guard), and runs as ONE transaction —
  all 1,228 or none.

## 2. Customer linkage (the only join that matters)

DSP `customers.billing_customer_id` was written by the Phase-0 connector and equals
ResellerOS `customers.customer_number` (uuid fallback — `v1-mappers.billingCustomerId`).

Resolution order per DSP customer:
1. `billing_customer_id` → `customers.customer_number` (exact)
2. else DSP user's email → `customers.contact_email` (lower-cased exact — the same
   `.eq` rule the OAuth callback learned the hard way; never `ilike`)
3. else **no link**: `customer_id = null`, and the ticket still carries
   `customer_name` + `raised_by_email` from DSP's users row — nothing is lost, it just
   isn't joined.

Report the three counts (matched-by-id / matched-by-email / unlinked) in the dry run
BEFORE loading; a surprising unlinked count means the connector sync should run first.

## 3. Field mappings

### tickets → support_tickets

| DSP | ResellerOS | Rule |
|---|---|---|
| `id` int | `id` text | `'TKT-DSP-'||id` |
| — | `tenant_id` | ANUTECH `fbb976f1-…` (constant) |
| `customer_id` → users join | `customer_id` uuid / null + `customer_name`, `raised_by_email` | §2 |
| `subject` | `subject` | verbatim (≤500 fits) |
| `description` (+ `request_type`, `gw_edition`, `affected_users`, `google_case_id`, `cc_emails` when present) | `body` | description verbatim; the GW-specific extras appended as a labelled tail block — preserved, not dropped, and greppable |
| `status` `open` | `open` | |
| `status` `pending` | `awaiting_customer` | DSP's `pending(_reason)` = waiting on the customer; `pending_reason` appended to body tail |
| `status` `closed` | `closed`, `resolved_at = updated_at` | DSP has no separate resolved; its close time is the last touch |
| `priority` low/normal/high/urgent | same | |
| `priority` `medium` | `normal` | ResellerOS has no medium |
| `request_type` contains billing/invoice/payment/renewal | `category='billing'` | keyword map; everything else `'tech'`; null → `'other'` |
| `created_at`, `first_response_at` | `created_at`, `first_responded_at` | verbatim (timestamps are IST-naive in MySQL → load as `Asia/Kolkata`) |
| `sla_response_due` | `sla_due_at` | verbatim; historic, cosmetic |
| — | `tier` | `'free'` constant — the insert type's documented historic-import path, so the stamp trigger leaves the row alone |
| `merged_into` | body tail note `MERGED INTO TKT-DSP-<n>` + `status='closed'` | ResellerOS has no merge chain; the pointer survives as text |
| `assigned_agent_id` | `assigned_agent = null` | DSP agent ids are not ResellerOS users; the agent's name still appears on every note/time row they wrote |

### ticket_messages → ai_support_conversations

| DSP | ResellerOS |
|---|---|
| `ticket_id` | `'TKT-DSP-'||ticket_id` |
| `sender_id` → users.role customer | `role='user'` |
| `sender_id` → users.role agent/admin | `role='agent'` |
| `message` | `message_content` |
| `via_email=1` | `channel='email'`; else `'portal'` |
| customer's email (via ticket) | `customer_contact` |
| `created_at` | `created_at` |
| — | `intent=null`, confidence null — these were human turns, not agent reads |

### ticket_internal_notes → support_ticket_notes
`agent_id → users.name` becomes `author_name`; `author_id=null`; `note→body`
(truncate at 8000 with a `[truncated]` marker if ever needed); `created_at` verbatim.

### ticket_time_logs → support_ticket_time_logs
`minutes = least(1440, greatest(1, round(seconds/60.0)))` — brick 1's CHECK is 1..1440;
DSP stored seconds. `agent name → user_name`, `user_id=null`, `logged_at → created_at`.

### ratings (`ref_type='ticket'`) → support_ticket_ratings
`score` 1..5 verbatim; `comment` verbatim; `rated_by_email` = the customer user's
email; `created_at` verbatim. DSP's `uq_rating(ref_type, ref_id)` maps 1:1 onto brick
3's `unique(tenant_id, ticket_id)`. `gmb_clicked` does not move (no home, no need).

## 4. Pipeline (3 steps, each verifiable alone)

1. **EXTRACT** — on the DSP VM, read-only, one command per table (Pardeep paste):
   `mysql -N -B dsp -e "select json_object(…) from tickets"` → 6 files of
   line-per-row JSON, plus a counts row per table. No dumps of tables that don't move.
   (The ready script `scripts/dsp-migration/extract.sh` was removed with the parked work on
   19 Oct 2026, R-1605 — restore it from git history if this migration is ever revived.)
2. **TRANSFORM** — `scripts/dsp-migration/transform.mjs` (execution phase): reads the
   JSON, applies §2–§3, emits ONE `load.sql` — `begin; …inserts…; commit;` with the
   namespace guard at the top and per-table counts `select`ed at the bottom.
   Deterministic: same input → byte-identical output.
3. **LOAD** — the established docker-psql pattern on the gateway VM, as postgres
   (service-path via zzz policies; RLS untouched), ending with
   `NOTIFY pgrst, 'reload schema'` is NOT needed (no DDL) — but the ticket counters on
   /support read live, so the result is visible immediately.

## 5. Verification (the run is not done until these say so)

- Row counts: DSP tickets == loaded `TKT-DSP-%` tickets; same for messages/notes/
  time/ratings (ratings only `ref_type='ticket'`).
- Spot checks: 3 tickets compared field-by-field (one open, one pending→awaiting,
  one closed with rating).
- RLS: as the ANUTECH agent, `/support` shows the history; as tenant-B context the
  SQL suite's isolation tests already stand guard.
- The 50-test suite re-run stays green (nothing here touches its fixtures).

## 6. Open items before execution

1. **DSP VM access** — extraction runs where MySQL lives; needs the VM name/project
   (it is NOT supabase-gateway) and Pardeep's paste, same as every DB step so far.
2. **Freeze window — DECIDED (Pardeep, 7 Sep): extract = cutover.** The moment the
   extract runs, new tickets are raised in ResellerOS and DSP's ticket surface is
   history. No delta pass.
3. `pending → awaiting_customer` reading — confirm with Pardeep (one word).
