# migrations-archive — the 218 migrations that built production

These are the real history. Every one of them ran against the production database
(`ontpnqjoysjgrlsukecm`) and they are why it looks the way it does. **Nothing here has
been deleted or edited** — they moved out of `supabase/migrations/` on 15 Aug 2026 and
that is all.

**R-1609 (19 Oct 2026):** `0125`–`0130` had been sitting in a stray repo-root
`supabase/migrations/` folder, outside the app, leaving a gap here between `0124` and
`0131`. They were moved in unchanged (`git mv`), so the archive now holds 222 `.sql` files
and the history has no gap. Nothing referenced their old path.

## Why they moved

They cannot build a database from empty. Run in order against a fresh Postgres they stop
at 73 of production's 87 tables, because several tables were created directly in prod and
only captured in git *later*, under a higher number than the migration that uses them:

| table | created in | used in | gap |
|---|---|---|---|
| `tenant_secrets` | `0171` | `0070` | 101 files |
| `reimbursements` | `0224` | `0133` | 91 files |
| `contacts`, `campaigns`, `whatsapp_messages`, `support_plans`, `prepaid_advances`, `po_bill_allocations`, `employee_documents`, `campaign_sends`, `campaign_templates`, `support_sync_outbox` | `0224` | earlier | — |

And `0224` cannot simply be moved earlier: it needs a unique constraint that a
mid-sequence migration adds. The dependency runs both ways, so no reordering fixes it.

`0171`'s own header describes the problem — *"a fresh DB built from these migrations
would be missing the table"* — so it was known. But the fix was numbered `0171`, after
the `0070` that needs it, and production already had the table, so it never failed
anywhere. It only fails on a database that is actually empty, and until 15 Aug nobody
had ever tried one.

`supabase start` runs everything in `supabase/migrations/` before it will hand you a
database. With these files there, local development could not start at all.

## Where a database comes from now

`supabase/baseline.sql` — a snapshot of production, taken 15 Aug 2026 — plus
`supabase/baseline-storage.sql`. Verified object-by-object against production: 87 tables,
133 functions, 286 policies, 48 triggers, 305 indexes, 1335 columns, 234 foreign keys.

```bash
cd production
node scripts/rebuild-db.mjs <project-ref>
node scripts/db-compare.mjs ontpnqjoysjgrlsukecm <project-ref>
```

## Are these still useful?

Yes, for reading. They explain *why* something is the way it is, and several carry long
headers that are the only written record of a decision — `0171` on schema drift, `0239`
on the RLS helper grants, `0243` on the merge guards. Search them before assuming a
column is arbitrary.

They are not useful for building anything.

## New migrations

Go in `supabase/migrations/`, timestamp-named, created with:

```bash
npm run migration:new -- add_some_column
```

Timestamps rather than `0249`, `0250` — with more than one person working, sequential
numbers collide the moment two people start a migration on the same day, and the
collision only shows up after both are merged.
