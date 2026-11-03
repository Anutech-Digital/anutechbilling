---
name: goal-spec
description: How we turn a goal into shipped work — owner questions in one batch, a spec in docs/specs, a card graph on the board, workers with tests first, then review. Load when starting a goal (G-…) or any feature bigger than one card, and before splitting work into cards.
---

# goal-spec

Written 3 Nov 2026 (R-2420) after Pardeep asked us to adopt what helps from a spec-driven
workflow (grill → spec → tickets → TDD → code review). Board cards and TDD already existed;
what was missing was a spec teammates' Claude can read and a review before push. Written by us
in this repo — no external skill was downloaded (skill-install rule).

Five stages, in order. Do not skip a stage; a small goal makes each stage short, not absent.

---

## 1. Owner questions — one batch, owner-only

- Read the code and the screens first (localhost, real data). Answer everything you can yourself.
- Ask the owner ONLY what nobody else may decide: **price, a money rule, GST / tax treatment,
  anything irreversible** (deleting data, sending to customers, live / staging data).
- All questions in ONE message, numbered, each with your recommended default.
- Owner says "jo tumhe sahi lage" → take the default, write it in the spec as
  "decided in session, <date>" and keep going. Prices and data repairs stay the owner's.
- A CA point (GST, TDS) is built with the logical default and listed for Hitesh to **check**.

## 2. Spec — `docs/specs/<goal>.md`

Sections, in this order (see `docs/specs/README.md`):

1. **Goal** — what the owner can do when finished + a measure.
2. **Users & flows** — who opens which screen and presses what.
3. **Rules** — money, GST, roles, what must never happen.
4. **Data** — tables, columns, functions read or added.
5. **Constraints** — gateway / law / outside limits.
6. **Owner decisions** — question, answer, who + date; open ones show the default built.
7. **Cards graph** — card ids, arrows for `dependsOn`, waves.

Rules: no customer names, customer amounts, GSTINs, keys or tenant ids (public repo; the push
secret-scan rejects company names) — write "customer A", "the staging company". About 100–150
lines. Research notes may sit in `Anutech-HQ/drafts/`; the spec in the repo is the truth.
The spec lands in git through its own card (or the first card of the goal).

## 3. Cards — board, with a graph

- One card per piece a worker can finish in a day: `title`, `why`, `fix`, `doneWhen`,
  `howToCheck` (owner steps on localhost), `priority`, `goal: "<G-NAME>"`, `category`
  (`paisa` for money).
- `dependsOn: [ids]` for real order only. `files`: exact paths or folders the card touches.
- **Cards in the same wave never share a file** — that is what lets workers run in parallel
  without the push lock or a rebase conflict. Two cards on one file → put them in different waves.
- Put the waves in the spec's Cards graph. Build status stays on the board, not in the spec.

## 4. Workers — `docs/WORKER-STEPS.md`

- Each card is built by a worker that follows WORKER-STEPS exactly: worktree, lock with the
  card's files, **failing test first** from the owner's real path, then the fix, fast gate.
- The worker reads the spec before coding; a rule it finds missing goes back into the spec
  (same commit) and the board, not only into the code.
- A decision the owner makes during the build goes into the spec's **Owner decisions** too.

## 5. Review — three layers

1. **Worker self-review** before push (WORKER-STEPS "Review before push"): Skill `code-review`
   with args `high` on `git diff anutech/manager-pardeep...HEAD`, against the card and the
   spec; money / migration / auth / RLS
   → also Skill `security-review`. Fix real findings; write `review` {at, findings, fixed, left}
   on the card.
2. **Manager independent review** on p0 and `category: paisa` cards: after the push, a
   separate reviewer (not the builder) reads the spec + diff and writes `independentReview` on
   the card; real findings become fix cards (`fixesFor`, not `dependsOn`) before the localhost
   check, and the card's commits wait out the staging train until they are fixed.
3. **Localhost check** like the owner (`<id> jaanch karo`), result in `aiResult`. The owner
   closes the card.

## Done for a goal

All cards `live` / `done`, the spec's open decisions answered or listed as defaults, and the
measure from **Goal** checked once on real data.
