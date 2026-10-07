# Staging train — small staging batches every 2–3 hours (R-386, 7 Oct 2026)

**Why:** staging used to be merged once a day at 17:00 IST. On 7 Oct 40+ commits piled up and
every new push restarted CI, so the big merge kept slipping. Now the manager sends a small batch
to staging every 2–3 hours: whatever is already CI-green.

**Who runs it:** only the manager session (never a worker, never a scheduled routine). It only
ever touches the `staging` branch — never `deploy`, never the live DB.

```
cd production
node scripts/ops/staging-train.mjs              # dry run (default)
node scripts/ops/staging-train.mjs --db-done    # staging DB step for new migrations already done
node scripts/ops/staging-train.mjs --db-done --push   # the real push to staging
```

What it does:

1. `git fetch anutech`, then picks the **newest commit on `anutech/manager-pardeep` whose GitHub
   "CI" run finished green** (same rule as `scripts/ops/staging-gate.mjs`: the newest run on that
   SHA counts). It reports how many newer commits are still running / red / without their own run.
2. Lists migration files added between `anutech/staging` and that commit. If there are any it
   prints **DB STEP NEEDED**, the list, and the PowerShell command
   `& "C:\Program Files\Git\bin\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/deploy-db-<date>.sh"`
   — and stops (exit 3) unless `--db-done` is passed. The DB step needs Pardeep's yes.
3. In a temporary git worktree (not the main checkout; no `node_modules`; removed afterwards):
   checks out `anutech/staging` and runs `git merge --no-ff <sha> -m "Staging train <IST time>: <card ids>"`.
   A conflict is aborted and the files are listed (exit 2).
4. Prints the push command `git push anutech HEAD:staging` and runs it only with `--push`.
   It is a plain push: if staging moved meanwhile git refuses it — rerun the train.
5. Hinglish summary: cards, migrations, next step.

Exit codes: 0 ok / nothing new · 1 refused (no green commit) or error · 2 merge conflict · 3 DB step needed.

**Never force-push staging** (`git push anutech manager-pardeep:staging` or `--force`): staging
carries R-161 commits that `manager-pardeep` does not have; overwriting them breaks staging.
Live deploy (`deploy` branch) stays the 17:00 IST step with Pardeep's yes — see `docs/STAGING.md`.
