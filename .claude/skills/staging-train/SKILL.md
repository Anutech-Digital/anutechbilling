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

## 0. Abhishek's staging pushes first (Pardeep, 17 Nov 2026, R-2910)

Abhishek puts his own work on `anutech/staging` himself. Before ANY train — before you pick a sha — look at what is on staging that `manager-pardeep` does not have. `staging-train.mjs` does it in every dry run and every `--push` (exit 8 = found), so run the dry run first:

```bash
git fetch anutech
node scripts/ops/staging-train.mjs --sha <commit> --dry-run     # from production/ of a fresh manager-pardeep worktree
```

- [ ] **Exit 8** — it printed the commits (sha, date, author, subject, migrations) from `anutech/staging` after the last train merge and from `anutech/Abhishek`. STOP the train and tell Pardeep in one line ("Abhishek ne staging par N commit daale hain — pehle manager-pardeep me la raha hoon"). Then, in this order:
  1. **Card** (like R-2904) via `new-card.mjs`, claim, own worktree off `anutech/manager-pardeep`, worker-lock.
  2. **Read-only review first**: `git log -p anutech/manager-pardeep..<his sha>`; his migrations (timestamp order, `deploy-peek` header, RLS on new tables, grants incl. `service_role`, peeks); anything touching money / auth.
  3. **Merge** his commits into the card branch (`git merge <his sha>` or cherry-pick the range). A conflict in his code → show Pardeep, never pick a side. Regenerate deploy-db + peeks (`node scripts/ops/gen-deploy-db.mjs --date <YYYY-MM-DD>`; `worker-lock push` does it too).
  4. **Never re-run or edit a migration staging already has** — its peek must already be true on the staging DB (the dry run drops migrations already in `prisma/migrations`). Only a NEW migration goes through the DB step (section 3). A peek he relied on that is false → stop, show Pardeep.
  5. **Independent check** (skill `independent-check`, a separate reviewer on the wip sha) for money / p0 / security parts; then `node scripts/ops/worker-lock.mjs push <CARD> --card <file>` — never a plain `git push`.
  6. **CI + SQL tests green** on the pushed sha (`gh run list -R Anutech-Digital/anutechbilling --commit <sha>`), then the localhost check (`npm run localhost:update`, open his pages).
  7. Only then train at the NEW manager-pardeep sha — his commits are in it now, so this check stays quiet.
- [ ] **Exit 0, no list** — nothing direct on staging; go on with section 1.
- [ ] Pardeep says go ahead anyway (emergency): `--allow-staging-ahead "<reason>"` — printed and logged to `~/.claude/staging-train-override.log`; write the reason on the board too. Never use it on your own.

Every team member's Claude follows this step (`docs/TEAM-PROTOCOL.md` → Staging, and the playbook Lessons log).

## 1. Is a train due?

- [ ] Count ready cards from the board (pushed to manager-pardeep, CI green, money/customer cards
      checked on localhost). **< 20 → no train** unless Pardeep himself asked. Say the count
      ("train: 12/20"); never propose a small or "special" train.
- [ ] Work merged from another person (Abhishek etc.) ran on localhost first.
- [ ] While the train runs (DB step → push → smoke): **at most 2 building workers, no new spawns**;
      refill to 4–6 right after smoke (playbook d, R-2581).

## 2. Review + pick the sha

- [ ] Every p0 / `category: paisa` / security card in the train has an `independentReview`
      verdict (skill `independent-check`). BLOCK → its commits stay out until the fix card is pushed.
- [ ] Pick the commit: `git fetch anutech`; its "CI" AND "SQL tests" runs are green
      (`gh run list -R Anutech-Digital/anutechbilling --commit <sha>`).
- [ ] `node scripts/ops/staging-train.mjs --sha <commit> --dry-run` — read the card list, the new
      migrations and the DB step it prints. A merge conflict → stop.

## 3. Staging DB step (Claude runs it — Pardeep, 5 Nov)

- [ ] Temp worktree pinned to that commit:
      `git worktree add <home>/reselleros-train-<sha7> --detach <commit>`.
- [ ] `node scripts/ops/staging-train.mjs --db-wait` (R-2719) — waits (30 s a line, max 30 min) while it is
      09:25–10:05 IST (daily Cloud SQL backup) or an operation is running. Exit 0 → go on; exit 7 → still
      busy, do NOT run the DB script yet, run `--db-wait` again later.
- [ ] `bash <that worktree>/production/supabase/cloudsql/staging/deploy-db-<date>.sh`
      (gcloud auth, no password typed; if the login expired, re-login the browser way — playbook b).
- [ ] **Every peek prints `=true`, including the new migrations' keys.** Any false, or the script
      stops → STOP, show Pardeep the output, change nothing.
      HTTP 409 = Cloud SQL backup/operation running → `node scripts/ops/staging-train.mjs --db-wait`, then re-run (safe).
- [ ] Remove the temp worktree with `git worktree remove <path>` (never `git worktree prune`).

## 4. Merge + push

- [ ] `node scripts/ops/staging-train.mjs --sha <commit> --db-done --push`
      (merge `--no-ff` in a temp worktree from `anutech/staging`, `git push anutech HEAD:staging`,
      never forced).
- [ ] Cloud Build: `gcloud builds list --project=resellsubsos-prod --limit=3` until the staging
      build is SUCCESS.
      **Build red** → the DB is already updated: make a fix card, push it, then train again at the
      fix sha with `--sha <fix sha> --db-done --push` (no new migrations → no DB step again).

## 5. Smoke

- [ ] `node scripts/ops/staging-smoke.mjs --expect-sha <the staging MERGE commit>` — the sha `--push` prints as
      `Staging merge commit: <sha>` (staging runs that merge, never the pinned manager-pardeep sha; the smoke
      that `--push` runs by itself already uses it). Last line must be `SMOKE GREEN`.
      `SMOKE RED: …` → fix card first; tell Pardeep in one line.

## 6. After the train

- [ ] Board: on each card in the train write `stagingAt` (`date -u`) and `stagingCommit` (the sha);
      write the train note and the next train count.
- [ ] Staging **"Read from Zoho again"** — Claude presses it itself (Pardeep, 8 Nov). Only one Zoho
      reader at a time (HTTP 429).
- [ ] Optional repair check: R-1823 report on staging should say 0.
- [ ] Staging crons (R-2616): staging has its OWN scheduler jobs, named `resellersos-staging-*`. Check the plan
      `bash production/scripts/setup-cloud-scheduler.sh --env staging --dry-run`, then run it without
      `--dry-run` (gcloud login; secret read off the staging service). Default = zoho-fy-read only; more
      with `ONLY=a,b`. Never `SERVICE_NAME=resellersos-staging` in live mode — that makes live names.
- [ ] One short Hinglish message to Pardeep: sha, cards count, smoke result, and the
      **post-train owner steps** only (reconnects, approvals, data repairs) — each with your recommendation.
- [ ] Refill workers to 4–6.

## Do not

- Train past an exit 8 (step 0) or use `--allow-staging-ahead` without Pardeep's word.
- Pass the pinned manager-pardeep sha to `--expect-sha` (the build runs the staging merge commit).
- Run `staging-train.mjs --push` without `--sha` (the newest-green rule can pick a different commit).
- Run the DB step from an older folder (left new code on an old DB, 5 Nov).
- Touch staging company data in bulk — Anutech staging holds the owner's real entries.
