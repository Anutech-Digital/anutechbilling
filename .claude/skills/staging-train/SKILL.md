---
name: staging-train
description: The ordered checklist for a staging train (manager-pardeep → staging) — the 20-card rule, independent review, a CI+SQL-green pinned sha, dry-run, the staging DB step from a temp worktree, --db-done --push, Cloud Build, smoke, board update, Zoho re-read. Load when Pardeep asks for a train, when the ready-card count reaches 20, or before running scripts/ops/staging-train.mjs or a staging deploy-db script. Coordinator only — a card worker never runs a train. Never live.
---

# staging-train

Written 8 Nov 2026 (R-2585) because every train was re-typed by hand. This is the checklist;
the rules and the why live in [`docs/CLAUDE-TEAM-PLAYBOOK.md`](../../../docs/CLAUDE-TEAM-PLAYBOOK.md)
section (c) and [`docs/WORKER-STEPS.md`](../../../docs/WORKER-STEPS.md) ("Staging train pinned to one
commit"). Commands run from a worktree's `production/` on a fresh `anutech/manager-pardeep`
(never the main clone on another branch).

**Never live** — live DB, live deploy and live secrets are Pardeep's steps.

## 0. Is a train due?

- [ ] Count ready cards from the board (pushed to manager-pardeep, CI green, money/customer cards
      checked on localhost). **< 20 → no train** unless Pardeep himself asked. Say the count
      ("train: 12/20"); never propose a small or "special" train.
- [ ] Work merged from another person (Abhishek etc.) ran on localhost first.
- [ ] While the train runs (DB step → push → smoke): **at most 2 building workers, no new spawns**;
      refill to 4–6 right after smoke (playbook d, R-2581).

## 1. Review + pick the sha

- [ ] Every p0 / `category: paisa` / security card in the train has an `independentReview`
      verdict (skill `independent-check`). BLOCK → its commits stay out until the fix card is pushed.
- [ ] Pick the commit: `git fetch anutech`; its "CI" AND "SQL tests" runs are green
      (`gh run list -R Anutech-Digital/anutechbilling --commit <sha>`).
- [ ] `node scripts/ops/staging-train.mjs --sha <commit> --dry-run` — read the card list, the new
      migrations and the DB step it prints. A merge conflict → stop.

## 2. Staging DB step (Claude runs it — Pardeep, 5 Nov)

- [ ] Temp worktree pinned to that commit:
      `git worktree add <home>/reselleros-train-<sha7> --detach <commit>`.
- [ ] `bash <that worktree>/production/supabase/cloudsql/staging/deploy-db-<date>.sh`
      (gcloud auth, no password typed; if the login expired, re-login the browser way — playbook b).
- [ ] **Every peek prints `=true`, including the new migrations' keys.** Any false, or the script
      stops → STOP, show Pardeep the output, change nothing.
      HTTP 409 = Cloud SQL backup running → wait for `gcloud sql operations list` DONE, re-run (safe).
- [ ] Remove the temp worktree with `git worktree remove <path>` (never `git worktree prune`).

## 3. Merge + push

- [ ] `node scripts/ops/staging-train.mjs --sha <commit> --db-done --push`
      (merge `--no-ff` in a temp worktree from `anutech/staging`, `git push anutech HEAD:staging`,
      never forced).
- [ ] Cloud Build: `gcloud builds list --project=resellsubsos-prod --limit=3` until the staging
      build is SUCCESS.
      **Build red** → the DB is already updated: make a fix card, push it, then train again at the
      fix sha with `--sha <fix sha> --db-done --push` (no new migrations → no DB step again).

## 4. Smoke

- [ ] `node scripts/ops/staging-smoke.mjs --expect-sha <commit>` → last line must be `SMOKE GREEN`.
      `SMOKE RED: …` → fix card first; tell Pardeep in one line.

## 5. After the train

- [ ] Board: on each card in the train write `stagingAt` (`date -u`) and `stagingCommit` (the sha);
      write the train note and the next train count.
- [ ] Staging **"Read from Zoho again"** — Claude presses it itself (Pardeep, 8 Nov). Only one Zoho
      reader at a time (HTTP 429).
- [ ] Optional repair check: R-1823 report on staging should say 0.
- [ ] One short Hinglish message to Pardeep: sha, cards count, smoke result, and the
      **post-train owner steps** only (reconnects, approvals, data repairs) — each with your recommendation.
- [ ] Refill workers to 4–6.

## Do not

- Run `staging-train.mjs --push` without `--sha` (the newest-green rule can pick a different commit).
- Run the DB step from an older folder (left new code on an old DB, 5 Nov).
- Touch staging company data in bulk — Anutech staging holds the owner's real entries.
