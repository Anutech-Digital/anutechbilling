# Overseas customers with no country — read-only report (R-2620)

**What it answers:** which customers are marked **Overseas** but have no country outside India (empty,
or "India"), per company — and what was already quoted / invoiced to them, with what tax.

**Why:** an empty country reads as India everywhere (money-rules G5). Such a customer (they came over
from the Zoho import — staging Excel, 6 Nov) got a NEW quote / invoice taxed as an Indian sale: 18% GST
on what may be a 0% export under the LUT. Since R-2620 the app refuses a sent quote or a new invoice for
them with "… is marked Overseas but has no country on record … Open the customer, pick its country"
(a draft is still allowed; Zoho / opening imports are not refused). This report lists the rows to fix.

**Script:** `production/scripts/ops/report-overseas-no-country.sql`
- READ-ONLY: `begin; set transaction read only; … rollback;` — it cannot write, even by mistake.
- Works on a database WITHOUT R-2620 (the rule is written inside the script).
- Shows company and customer NAMES (you need them to fix the country) — save the output to a file on
  your laptop; on the board / in chat write counts only.

## Hard rules

- **Pardeep runs it** on staging / live (DB step). Claude runs it only on the LOCAL DB.
- It only reads. Setting a customer's real country (e.g. from its Zoho billing address) is a data
  repair — Pardeep's haan/na first, a separate card. An issued invoice never changes by itself (G8);
  section 3 lists the ones a repair would have to look at (credit note / re-issue is his call).

## Run it — Git Bash, from the repo

Same connection as the other DB reports (`docs/playbooks/cross-tenant-bank-links.md`): `gcloud sql
connect` as the migration login (`resellersos_migration` owns the tables, so row security does not hide
rows). It needs `gcloud` logged in and `psql` on the PATH; psql asks for the `resellersos_migration`
password — use the one you already use for DB steps (it is not in the repo).

```bash
cd /c/Users/mso50/new-reselleros
git fetch anutech && git show anutech/manager-pardeep:production/scripts/ops/report-overseas-no-country.sql > /c/Users/mso50/r2620-report.sql

# STAGING
gcloud sql connect resellersos-staging-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
# LIVE
gcloud sql connect resellersos-db --user=resellersos_migration --database=resellersos --project=resellsubsos-prod
```

Then at the `resellersos=>` prompt (one line at a time):

```
\o r2620-staging.txt
\i C:/Users/mso50/r2620-report.sql
\o
\q
```

(For live write `\o r2620-live.txt`.) The output file lands in `new-reselleros/`.

**Local DB** (test data — proves it runs):

```bash
docker exec -i supabase_db_resellerosv3 psql -X -U postgres -d postgres -v ON_ERROR_STOP=1 < production/scripts/ops/report-overseas-no-country.sql
```

## Reading the output

- **0 — login check.** `companies_visible` should equal the number of companies. 0 or 1 → row security
  is hiding rows: reconnect as the table owner; a "0 rows" would mean nothing.
- **1 — per company.** `(0 rows)` = clean. Else: how many such customers, how many Tax Invoices were
  issued to them, how many charged GST and the GST total (rupees).
- **2 — per customer.** The country / state / GSTIN as stored, open quotes (sent, not yet invoiced),
  drafts, active subscriptions, invoices (with GST / at 0% / from the Zoho import as filed), last invoice
  date. Fix list: pick each customer's real country (Customers → the customer → Edit → Customer region).
  A customer whose invoices are all "from the Zoho import" was filed as Zoho filed it — only the country
  on the customer needs fixing.
- **3 — issued invoices.** Every non-void Tax Invoice whose frozen buyer facts are Overseas + no
  country (also for a customer fixed since). GST charged on one of them may need a credit note — Pardeep
  decides.
- Write the counts on R-2620's card (no names); the repair is a new card after Pardeep's haan.

## Tests

`production/tests/ops/report-overseas-no-country.test.ts`: no write keyword outside comments, read-only
wrapper, the rule inlined; on the local DB (skipped where the container does not run, e.g. CI) planted
Overseas + empty and Overseas + India customers are listed with their draft quote, Overseas + US and a
domestic customer with an empty country are not, everything rolled back. The refusal itself:
`production/supabase/tests/r2620_overseas_needs_country.test.sql`.

## Lessons log

- 9 Nov 2026 (R-2620): local DB — 35 companies, 7 Overseas customers, 0 rows in 1–3, ~1 s.
- 9 Nov 2026 (R-2620): an Overseas customer with no country AND no state was already refused by
  generate_invoice — but as "has no state on record, add the state", which leads the user to make it an
  Indian customer. The silent 18% case is one with a state (or GSTIN) on file.
