# Cross-company bank links — read-only report (R-2479)

**What it answers:** does any bank line already point at ANOTHER company's record — or any other
company's record point at this company's bank line — on staging or live?

**Why:** R-2472 (4 Nov 2026) proved a gap that dates from R-718: a login could link its own bank
line to another company's payment, expense, project receipt, salary or bank line (through
`reconcile_bank_txn`, or a plain UPDATE of its own line), and the salary trigger then marked the
other company's salary paid. R-2472 blocks new links; this report checks the data written before.

**Script:** `production/scripts/ops/report-cross-tenant-bank-links.sql`
- READ-ONLY: `begin; set transaction read only; … rollback;` — it cannot write, even by mistake.
- Shows only ids, company (tenant) ids, dates, amounts and the match type — no names, no bank
  descriptions, no contacts.
- Works on a database that does NOT have R-2472 yet (e.g. live before the deploy): the match-type →
  table map is written inside the script, and a table the database does not have is skipped.

## Hard rules

- **Pardeep runs it** (DB step). Claude never connects to the staging or live database.
- It only reads. Fixing a row it finds is a separate decision — Pardeep's (data repair = owner).
- Save the output to a file on your laptop; do not paste company ids into chat or the board.

## Run it — Git Bash, from the repo

Same connection as the other DB reports (`scripts/ops/r1823-repair-reports.sql`): `gcloud sql
connect` as the migration login (`resellersos_migration` owns the tables, so row security does
not hide rows). It needs `gcloud` logged in (`gcloud auth login`) and `psql` on the PATH; psql asks
for the `resellersos_migration` password — use the one you already use for DB steps (it is not in
the repo). `gcloud sql connect` lets your IP in for a few minutes; `gcloud beta sql connect …`
(same arguments) goes through the Cloud SQL Auth Proxy instead, if the plain one cannot reach it.

```bash
cd /c/Users/mso50/new-reselleros
# the script from the latest manager-pardeep, without touching your checked-out branch:
git fetch anutech && git show anutech/manager-pardeep:production/scripts/ops/report-cross-tenant-bank-links.sql > /c/Users/mso50/r2479-report.sql

# STAGING
gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
# LIVE
gcloud sql connect resellersos-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
```

Then at the `resellersos=>` prompt (one line at a time):

```
\o r2479-staging.txt
\i C:/Users/mso50/r2479-report.sql
\o
\q
```

(For live write `\o r2479-live.txt`.) The output file lands in `new-reselleros/`.

**Local DB** (test data — proves it runs, nothing to connect):

```bash
docker exec -i supabase_db_resellerosv3 psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < /c/Users/mso50/r2479-report.sql
```

## Reading the output

- **Section 0 — login check.** `tenants_visible` should equal the number of companies and
  `bank_lines_visible` the number of bank lines. If it shows 0 or 1 company, row security is
  hiding rows: reconnect as the table owner and run again — a "0 rows" then would mean nothing.
- **Section 1 — the finds.** `(0 rows)` = clean: nothing to do. Each row has a `section`:
  - `A forward` — the line (`bank_txn_id`, company `line_tenant_id`) is matched to a record
    (`linked_table`, `linked_id`) of another company (`linked_tenant_id`).
  - `B reverse` — another company's record (e.g. `payments.bank_txn_id` for split receipts,
    `project_payments.bank_txn_id`, `expenses.reconciled_txn_id`) points at this line.
  - `C salary` — a salary of another company whose paid status came from this line.
  The same link can show in more than one section (e.g. a salary match shows in A and C).
  `rows_in_section` gives the count per section.
- Any row → write it on R-2479's card (count per section only, no ids in chat) and Pardeep
  decides the repair (a new card). Before R-2472 is deployed on that database, a row may also be a
  link made since — run it again after the deploy for the final word.

## Tests

`production/tests/ops/report-cross-tenant-bank-links.test.ts`: no write keyword outside comments,
read-only wrapper, no name/contact column; on the local DB (skipped where the container does not
run, e.g. CI) a planted cross-company link (payment, salary, reverse project receipt) is found in
sections A/B/C, still found when a mapped table is missing, a same-company link gives 0 rows, and
everything is rolled back.

## Lessons log

- 4 Nov 2026 (R-2479): local DB — 0 rows (41 companies, 2990 bank lines).
