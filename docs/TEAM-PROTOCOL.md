# Team protocol — the team, their Claude sessions, one repo

*27 Sep 2026. For every Claude Code session (and any other agent) working in this repo.
Read it at the start of a session; it is short on purpose.*

The humans decide **what** and **whether**. The agents do the **how**, report back, and keep
each other informed through one shared place — the board — instead of through the humans.

## The board is the shared memory

**URL:** https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n (org-shared; each person needs
"can edit"). An agent reads and writes it with the `ArtifactData` tool against that URL.
Collections:

| collection | one doc = | key fields |
|---|---|---|
| `tasks` | one piece of work, id `R-nnn` (someone asked another area) or `Snn` (roadmap) | `plain` (one Hinglish line, max 90 chars: what the work achieves, no jargon — the card headline) · `kind` request/roadmap · `owner` pardeep/abhishek/pawan/hitesh/sab · `from` · `priority` p0–p3 · `bucket` · `title` · `why` · `fix` · `where` · `doneWhen` · `status` · `commits[]` · `dependsOn[]` · `outcome` · `statusNote` · `nextStep` · `waitingOn` · `humanStep` (the ONE thing only the owner can do — a login, a key, a yes; the board shows it instead of status buttons) · `humanStepDoneAt` (set by the owner pressing “✔ Maine kar diya”; the next Claude session picks the card up from there) · `updatedAt` |
| `changes` | one thing others must know (a migration, a changed RPC signature, a new env var, a data note) | `at` · `owner` (who changed it) · `title` · `body_html` · `affects[]` (owners) · `migrations[]` · `commit` · `acked{}` |
| `messages` | a chat message | `ch` general/requests/roadmap/deploy/accounting/billing/customer/qa · `text` · `by` · `at` |

**Statuses:** `open` → `doing` → `review` → `done` (or `blocked`, `declined`). An agent may move
a task to `doing` and to `review`. **Only a human moves it to `done`** (or `declined`), after
checking the `doneWhen` line.
*Exception (Pardeep, 29 Sep 2026):* a human may give their OWN Claude sessions standing
permission to set `done` on that human's cards once every part of `doneWhen` is verified. Pardeep
has. The session then writes `statusNote: "<date>: Claude ne Done kiya — <what was checked>"`.
It never covers another owner's card, anything waiting on deploy / a prod migration / another
person, or a fix on a page Hitesh reported (his retest still decides).

Ownership of code is in [`OWNERS.json`](../OWNERS.json) (repo root). `node production/scripts/areas.mjs`
tells you whose area a branch touched.

## Team model — an AI custom-software company, 1 Oct 2026

Pardeep (manager): "hum AI se custom software banate hain — 4 logon ka role sirf wo ho jo AI na kar sake, baaki sab AI kare." Four people writing code in parallel made the work slow and confusing, so code is written in **one place per project** by Pardeep's AI, and people do only what needs a human. `OWNERS.json` is the truth for this repo.

### What the AI does vs. what only a person does
| AI does (not a person) | Only a person (AI can't) |
|---|---|
| Requirement doc, screen sketches, estimate draft — from the client's call notes | Meeting / calling the client, trust, getting "yes, this is what we want" |
| Code, database, tests, bug fixes, docs | Deciding what to build and in what order; client's yes when scope changes |
| Daily progress note, board updates, release notes | Price, payment terms, sending invoices, GST / CA |
| Testing on localhost / test site with AITEST data | Real logins (server, domain, payment gateway, the client's accounts) |
| Running the deploy steps, post-deploy checklist | Saying "yes, go live"; handover and training for the client |
| First draft of a support reply, the bug card | An unhappy client, refund / discount decisions |

### Four people, four roles (same on every project)
| Person | Role | When in a project | Does |
|---|---|---|---|
| **Pardeep** | Manager + product owner + builder | Start to end | Turns what the client wants into clear work for the AI, fixes scope and priority, builds with his AI on the project's one branch, looks at every piece on localhost for 5 minutes |
| **Pawan** | Client & Sales | Start + demos | Brings clients, first meeting, listens (AI writes the notes), demos at every milestone, gets the client's sign-off; the company website and leads (website code with his own AI, website paths only) |
| **Hitesh** | Money & Compliance | Quote, every milestone, end | Final price and milestones, advance / milestone invoices, payment follow-up, GST / TDS with the CA; checks every money number inside the software |
| **Abhishek** | Delivery & Support | Every release + after go-live | Logins to the client's server / domain / accounts, weekly deploy (**every Thursday 4 pm IST** for ResellerOS: backup → migrations in order → app → version check), live check, handover + training, support tickets, AMC; repo `cloudbuild.yaml`, `.github/` |

### One client project, seven steps
1. **Lead → meeting (Pawan).** Pawan pastes the raw notes into `docs/meeting-notes/` (or the board form); the AI turns them into `REQUIREMENTS.md`, screen sketches and an `ESTIMATE.md` draft (`docs/project-template/`).
2. **Scope + price (Pardeep + Hitesh).** Pardeep fixes scope, Hitesh the price and milestones; the AI writes the quote → Pawan gets it signed (`docs/signoff/M0-…`) + advance (Hitesh invoices).
3. **Build (Pardeep + AI).** Code + tests on the project's one branch; the AI writes a daily progress note (also for the client). Pardeep checks on localhost daily.
4. **Demo (Pawan).** At each milestone (`DEMO-M#.md`); the client's written yes goes into `docs/signoff/` and the AI opens the invoice card for Hitesh; new asks become rows in `CHANGES.md` (Pardeep scope + Hitesh price + client yes before building).
5. **Go live (Abhishek).** Deploy day: login + "yes"; the AI runs the steps; Abhishek checks live.
6. **Handover (Abhishek + Hitesh).** Training, logins to the client (`HANDOVER.md`); final invoice + payment.
7. **Support / AMC (Abhishek).** Tickets; the AI drafts the reply in `docs/support/T-nnn.md` and the bug card; Abhishek sends; Pardeep's AI fixes; AMC tickets beyond the agreed number → Hitesh prices them.

### Board — only this (all projects on one board)
- Every card names its **project** ("ResellerOS", "Client X ERP"); a project filter at the top.
- Each person sees one list, **"🔎 Aapka kadam"** — only what they must do themselves (meeting, decision, invoice, login / yes).
- One line **"🤖 AI kar raha hai"**, one line **"⏳ Deploy din"**.
- The form on top: **"🐞 Bug / idea / client ki baat"** — one line; the AI turns it into a card.

### How we build ResellerOS — one queue (trial 1–8 Oct 2026)

ResellerOS is too big for one builder, and splitting it by area (30 Sep) made people wait on each other. So for one week we split the work by **card**, not by area:

1. **One list, "📋 Agla kaam".** Pardeep (owner) orders it every morning (`rank` on the card: 1 = next).
2. **One card at a time per person.** Your AI takes the top unclaimed card (sets `claimedBy` = you, `status` = doing, `claimedAt`), and you build it **end to end** — any file it needs, Leads or Invoices or Website. Nobody asks anyone for code.
3. **Cards are small — one day or less.** A bigger card is first split by the AI into small cards (same `rank` range).
4. **Merged the same day.** Work on a short branch `<name>/<card>` from `origin/manager-pardeep`; when the gate is green, rebase on `origin/manager-pardeep`, run the gate again, merge into `manager-pardeep` and push (retry the rebase if someone pushed first). No branch lives past one day.
5. **No two cards on the same files at once.** Each card lists the folders it will touch (`files`); the AI does not take a card whose `files` overlap a card someone else is doing — it takes the next one.
6. **Done = verified.** Tests + gate green, and you opened it on localhost and checked it like the business owner. Then `status` = review with what you checked; Pardeep looks for 5 minutes and closes it.

**Screen and data-entry rules (Pardeep, 21 Oct 2026).** Every card that touches a screen runs the 9-rule checklist in `.claude/skills/label-and-logic-check/SKILL.md` §4 before building and again before aiResult: one fact one place; statuses never contradict; the primary button is the right next step; English UI only; tables fit 1280px with the action column visible; one task one way; ask only what the task needs; fewest steps with smart defaults; the owner's 2–3 examples on the card are the first test. The aiResult says the checklist was run. The 21 Oct review found most of these mistakes only after the build — the checklist moves the catch to before it.

What stays with people (not the queue): Pardeep — owner decisions (price, discount, bank / payments, spending, contracts, priority); Pawan — clients, demos, sales; Hitesh — books, GST / TDS filing, CA (after Pardeep's yes on money); Abhishek — deploy every Thursday 4 pm IST, server, support.

Measured for the trial (end of week): hours from claim to merge per card, merge conflicts, times someone waited on someone.

### Picking up a stopped card — any member, any machine (25 Oct 2026, R-1898)

Pardeep: "kisi bhi team member ke Claude Code se kisi bhi team member ka ruka kaam aage badhe" — and the other way round. Before this, worktrees, WIP commits, worker locks and the handoff notes lived only on Pardeep's laptop, so a stopped card could only be continued there. The method:

1. **The board card is the truth.** While a card is `doing` it carries `claimedBy`, a liveLog whose every line says what is done and what is next, and a `branch` field (`wip/<card lowercase>`, e.g. `wip/r-1898`) once WIP has been pushed. Nothing a resumer needs may live only in a session temp folder or on one laptop.
2. **Half-done work is on GitHub.** At each green step the worker commits (`WIP <CARD>: …` is fine) and runs `node scripts/ops/worker-lock.mjs wip <CARD>` from the worktree's `production/`. It pushes HEAD to `anutech` `wip/<card>` — creating it, or moving it with `--force-with-lease` on that one branch only. It refuses any other branch name and never touches `manager-pardeep`, `main`, `deploy`, `staging` or another card's branch; it prints the `branch` value to set on the card (the script cannot write the board).
3. **Stopping:** `wip` push, then a last liveLog line "STOPPED at <step>; done …; next: <exact next command>; branch wip/<card>; lock released", and release the laptop lock. The 60-min auto-free may then put the card back in `list` — the `branch` field and liveLog stay.
4. **Resuming (anyone):** read the card; from the main clone's `production/` run `node scripts/ops/worker-lock.mjs resume <CARD> <new worktree path>` — it fetches `anutech/wip/<card>`, creates the worktree on branch `w-<card>` from it and prints the next steps. Re-claim the card in your own person's name (`status: doing`, `claimedBy`, `claimedAt` from `date -u`), add liveLog "picked up from <person> — …", and continue from the last "next". Never resume over a card someone else has in `doing` with a fresh liveLog — ask them first.
5. **Finishing** is unchanged: gate, then `worker-lock.mjs push <CARD>` (rebase on `anutech/manager-pardeep`, tsc, guard tests, secret scan, push). The wip branch is never merged by hand; clear `branch` on the card when it goes to `review`.

**Locks across machines.** The laptop lock (`~/.claude/worker-locks`) only stops two workers on the same machine from touching the same files. Across machines the lock is the board: claim on the card before any code, and do not take a card whose `files` overlap a card someone else has in `doing`.

**Push guard.** `worker-lock.mjs guard-push` checks the refs a push sends (git pre-push stdin): a `wip/*` ref only from the `wip` command and only that card's own branch; `manager-pardeep` only from `push`. To make a plain `git push` obey it on your laptop, add a `pre-push` hook running `node production/scripts/ops/worker-lock.mjs guard-push` — optional, per laptop.

Full worker steps: [`docs/WORKER-STEPS.md`](WORKER-STEPS.md).

## Testing — 30 Sep 2026

Testing is automatic first: see [`docs/QA-SYSTEM.md`](QA-SYSTEM.md) (CI on every push, E2E, daily AI QA on the
online **test** environment — never production — and the daily live-error routine).

- A bug is an `R-nnn` request: `owner` = the area owner of that page, title `Bug: …`, with URL, steps,
  expected, actual. (Cards from the AI QA routine carry `from: "hitesh"` and a `qaKey` for history.)
- The owner fixes it **with a test** and sets `review`. The AI QA routine retests automatically and posts
  `R-nnn retest pass` / `retest fail: …` in `#qa`; cards without a `qaKey` are retested by the person who
  reported them. **A reported bug is not `done` before its retest passes.**

## Session start (every time, before any code)

1. Know who you work for: the branch → owner in `OWNERS.json` (`manager-pardeep` → pardeep, …).
2. `ArtifactData query tasks where owner in [me, "sab"] and status in [open, doing, review, blocked]`
   — list them to the human, P0 first, with any `review` ones they still need to check.
3. `ArtifactData query changes` for docs whose `affects` contains me and `acked` lacks me —
   summarise them in one line each. **These are other people's changes to things you use;
   read them before touching the same code.** Mark each read by merging `acked.<me>: <iso date>`.
4. Skim the last ~20 `messages` in `#general`, `#deploy` and your area channel.
5. `git fetch` and note whether the other two branches moved (`git log --oneline HEAD..origin/<branch> | wc -l`).

Say all of that to the human in ≤10 lines, then ask nothing — continue with what they asked,
or, if they asked "what next", propose the top unblocked task.

## While working

- **Claim** before you start: update the task to `status: "doing"` (pin `if_version`).
- Stay in your area. Need a change in someone else's area? **Do not make it.** Create a task:
  next free `R-nnn` (query the highest), `kind: "request"`, `owner` = the area owner, with
  `why`, `where` (file:line / RPC), `fix`, `doneWhen`. Then carry on with your own work.
- Shared files (`OWNERS.json` → `shared`: migrations, types, nav, layout, middleware…): change the
  smallest thing that works; it will need a `changes` entry.
- A migration is always a `changes` entry, with `affects` = every owner whose tables it touches.

## Session end (before the human leaves, or when a task is finished)

1. Gate: `npx tsc --noEmit`, `npx vitest run`, the SQL tests you touched. Report failures honestly.
2. `node scripts/areas.mjs` — if it names another person's area, stop and either cite the
   `R-nnn` that asked for it in the commit message or back the change out into a request.
3. Commit with the task id in the message (`S13: …`, `R-018: …`), push **to your own branch only**.
4. Board, in one `ArtifactData batch`:
   - the task → `status: "review"`, `commits: [sha…]`, `outcome` (what you did, what you did NOT
     do and why — the same honesty as the existing R-001…R-008 outcomes);
   - `nextStep`: one plain line, what happens next ("Deploy ke baad renewals cron 540s se kam")
     and `waitingOn`: who holds it now — a person key, `"deploy"`, or a task id (`"R-029"`).
     The board shows both on every card as **Agla kadam / Kiske paas** and sorts My work by them
     (karna hai / check karke Done / intezaar). Left out, the board guesses from status and note.
   - one `changes` doc if anything others must know;
   - one `messages` line in your area channel: `S13 → review (abc1234): RLS wrap on 212 policies`.

## What an agent never does on its own

Deploy · apply migrations to production · touch Cloud billing, secrets or OAuth clients ·
push to or merge another person's branch · mark a task `done` · delete board data.
These stay with the humans, however obvious they look.

## Every person's own morning digest (set up once, then nobody has to chase anyone)

Each of us runs a scheduled Claude task on our own machine that reads the board every
morning and tells **us** what is waiting — so no one has to message anyone to say "your card
is open". Set it up once in the Claude app: **Scheduled → New task**, schedule weekdays
09:30, folder = your checkout of this repo, and paste this prompt (change `<me>` to
`abhishek`, `pawan` or `hitesh`):

```
Morning digest for <me> on ResellerOS. READ AND REPORT ONLY: no code edits, no commits,
no pushes, no status changes, no messages. Reply in Hinglish.
Board: https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n (use the ArtifactData tool).
1. tasks where owner in [<me>, "sab"] and status in [open, doing, blocked, review]:
   list by priority (P0 first) with id, title and days since createdAt/statusAt.
2. tasks where from = <me> and status = review: these wait for MY check ("Done jab").
3. changes whose affects contains <me> and acked has no <me>: one line each.
4. messages from the last 24h in #general, #deploy and my area channel, and any @<Name>.
5. git fetch; how many commits manager-pardeep has that my branch does not
   (git log --oneline HEAD..origin/manager-pardeep | wc -l) — if > 0, say "merge karo".
Then suggest the one task I should pick first today. At most 15 lines.
```

Pardeep's own digest also prepares a short ready-to-send message for each person when
something of theirs is stuck, so a reminder costs one copy-paste, not a written message.

## Autonomy levels (what the human can hand over)

| level | the agent may | example |
|---|---|---|
| **A — report** | read the board + repo, summarise, propose | the daily digest |
| **B — draft** | work a task on its own branch, run the gate, push, set `review` | "S21 kar do" |
| **C — pick** | choose the next unblocked task of its owner by priority and do B | "roadmap se agla uthao" |

Level C is only for tasks with a testable `doneWhen` and no `dependsOn` still open, and only in
the owner's own area. Anything touching money calculations, GST, migrations or auth still ends
at `review`; a human reads it.

## Why it is built like this

Before 27 Sep, requests travelled as text a human pasted from one chat into another, and the
board's content lived inside its HTML — so the other two agents never saw it, and every edit
republished the whole page over whatever someone else had just changed. Tasks and changes are
now **data**: any session can query "what is mine" and "what changed that touches me", and
writes are per document, so three agents cannot overwrite each other.
