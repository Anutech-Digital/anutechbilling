# R-2223 — invoice dates raised before R-2095 (owner's DB step, not a deploy step)

Pardeep runs it from PowerShell, staging first (`haan` to confirm; one transaction; checks itself):

```powershell
& "C:\Program Files\Git\bin\bash.exe" "C:/Users/mso50/new-reselleros/production/supabase/cloudsql/live/r2223-invoice-dates/run.sh" staging
```

`live` instead of `staging` for live (takes a backup first); add `undo` to put the old dates back.
Files: `rows.sql` (the rule, a pure SELECT — the dry-run report), `apply-body.sql` (the repair),
`peek-body.sql` (read-only count), `undo.sql`. Proof: `supabase/tests/r2223_invoice_date_repair.test.sql`.
