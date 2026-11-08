---
name: status-update
description: How to answer "kya update hai" / "status?" / "kitne worker chal rahe hain" — a fresh check of the board, git, CI and locks, the source and time named, the worker count computed the way the board computes it, in short Hinglish. Load before any status answer, worker count, or train count you give Pardeep or a teammate. Never answer status from memory or from your own spawn list.
---

# status-update

Written 8 Nov 2026 (R-2585). Rule: [`docs/CLAUDE-TEAM-PLAYBOOK.md`](../../../docs/CLAUDE-TEAM-PLAYBOOK.md)
section (a) "Status always from a fresh check" and (d) "Board = truth for counts". Memory and old
worker reports are hints, not answers. If a check fails, say so — don't fill the gap.

## 1. Fresh checks (run them in parallel)

- [ ] **Board:** ArtifactData `query`, url https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n,
      collection `cards`, `where` `[["status","in",["doing","review"]]]` (and `live` for the train count).
- [ ] **Git:** `git fetch anutech` then
      `git log --oneline -15 anutech/manager-pardeep` (what landed) and
      `git log --oneline anutech/staging..anutech/manager-pardeep | wc -l` (not on staging yet).
- [ ] **CI:** `gh run list -R Anutech-Digital/anutechbilling -b manager-pardeep -L 5`.
- [ ] **Locks / CI per card** (from `production/` of a worktree on the latest manager-pardeep):
      `node scripts/ops/worker-lock.mjs list` and `node scripts/ops/worker-lock.mjs ci-all`
      → write each card's final `ciCheck` on the board.
- [ ] Staging asked about → `/api/version` on staging, or `node scripts/ops/staging-smoke.mjs`
      (read-only).
- [ ] `date -u` — the time of your check.

## 2. Count workers the way the board does

**Before telling a worker count, compute it the way the board does:**
- every card with `status: doing` — always running, **even with a human `step` on it** (board v108);
- plus every `review` card with `checkRunning: true` (checkers / reviewers).

Never count from your own spawn list. (8 Nov: the board showed 4 while 5 were doing, because a card
with a CA `step` showed as "ruka".) A running worker that is not on the board → fix the board
first (mark it `doing` / `checkRunning`), then tell the count. The count you say = the board's count.

## 3. Fix stale cards while you look

- [ ] `doing` card with no liveLog for 60+ min → ask its worker, or free it (back to `list`,
      clear `claimedBy`/`claimedAt`/`nowDoing`, liveLog "Apne aap wapas list mein — N min se koi kadam nahi").
- [ ] A worker said "done" but its sha is not in `git log anutech/manager-pardeep` → not done;
      send it back to push.
- [ ] `needsDecision` on a card that is not really blocked → move it to `followUps`.

## 4. The answer (short Hinglish, ≤10 lines)

```
Abhi dekha (board + git + CI, <HH:MM> UTC):
- Chal rahe: <n> (board) — R-…, R-… (ek line: kya kar raha hai)
- Review mein: <n>; CI: <green/red/pending>
- Train: <ready>/20 ready
- Aapke liye: <owner-only items, haan/na with recommendation> (or "kuch nahi")
Agla: <1 line>
```

- Name the source and time in the first line ("abhi git se dekha", "board se, 03:42 UTC").
- Owner-only items only as yes/no with your recommendation; nothing else asked.
- Add at most 1–2 process speed-up ideas (playbook a, "Coach him").
