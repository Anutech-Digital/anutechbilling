/**
 * R-2105 (29 Oct 2026) — a queue for worker slots, and heartbeats so a stopped worker never blocks.
 *
 * Before: a refused claim (exit 3) meant "wait 5 minutes and retry up to 6 times, then stop" — every
 * waiting worker polled on its own, no order, and after 30 min it gave up. A lock from a stopped worker
 * stayed until someone ran `release` by hand. Now:
 *
 *   claim --wait [--priority p0|p1|p2]   — joins the queue (lock folder `_queue-<CARD>.json`) and blocks
 *       until it is this card's turn: slots go by priority (p0 > p1 > p2; default the card file's
 *       `priority`, else p2), then first come first served. A waiter whose files clash with a live lock
 *       does not hold up the ones behind it. A waiter that stops refreshing its entry (15 s) for
 *       QUEUE_STALE_MS drops out of the queue by itself.
 *   beat <CARD>                          — "still working" (claim, check, push, ci and tsc beat too).
 *   stale locks                          — a lock with no sign of life for STALE_MS (working) /
 *       STALE_CI_MS (ci-wait / ci-red) is released by whoever reads the locks next, with a line in
 *       `_stale-release.log`. Sign of life = the newest of: beatAt, claimedAt, ciWaitSince, ciRedAt, the
 *       lock file's mtime, the worktree's git index mtime (every git add / commit counts).
 *
 * Pure helpers here; worker-lock.mjs does the files and the waiting.
 */
import fs from "node:fs";
import path from "node:path";

export const PRIORITIES = ["p0", "p1", "p2"];
export const DEFAULT_PRIORITY = "p2";
/** A working lock with no sign of life for 60 min is from a stopped worker. */
export const STALE_MS = 60 * 60 * 1000;
/** ci-wait / ci-red: CI alone takes 45–60 min, and a green CI already frees the lock (settleCiWaitLocks). */
export const STALE_CI_MS = 120 * 60 * 1000;
/** A queue entry the waiting process has not refreshed for this long = that process is gone. */
export const QUEUE_STALE_MS = 2 * 60 * 1000;
export const QUEUE_POLL_MS = Number(process.env.WORKER_QUEUE_POLL_MS || 15 * 1000);

/** "P0" / "p1" → "p0"/"p1"; anything else → null. */
export function normPriority(p) {
  const s = String(p ?? "").trim().toLowerCase();
  return PRIORITIES.includes(s) ? s : null;
}
export const priorityRank = (p) => PRIORITIES.indexOf(normPriority(p) ?? DEFAULT_PRIORITY);

/** Queue entries in turn order: priority, then who joined first, then card id (stable). */
export function queueOrder(entries) {
  return [...entries].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)
    || Number(a.joinedAt ?? 0) - Number(b.joinedAt ?? 0)
    || String(a.card).localeCompare(String(b.card)));
}

/** Entries still alive (refreshed within QUEUE_STALE_MS). */
export function liveQueue(entries, now) {
  return entries.filter((e) => now - Number(e.seenAt ?? e.joinedAt ?? 0) <= QUEUE_STALE_MS);
}

/**
 * Is it `card`'s turn for a slot? Only live waiters ahead of it that are waiting for a SLOT (not for
 * files held by another lock) hold it back. Returns { turn, ahead: [cards] }.
 */
export function queueTurn(card, entries, now) {
  const order = queueOrder(liveQueue(entries, now));
  const ahead = [];
  for (const e of order) {
    if (e.card === card) break;
    if (e.waitingFor !== "files") ahead.push(e.card);
  }
  return { turn: ahead.length === 0, ahead };
}

/** Newest sign of life of a lock, ms. `extra` = mtimes the caller read (lock file, worktree index). */
export function lockActivityAt(lock, extra = []) {
  const ts = [lock?.beatAt, lock?.claimedAt, lock?.ciWaitSince, lock?.ciRedAt]
    .map((t) => (t ? Date.parse(t) : NaN)).concat(extra.map(Number)).filter(Number.isFinite);
  return ts.length ? Math.max(...ts) : 0;
}

/** Is this lock from a stopped worker? */
export function isStaleLock(lock, now, activityAt) {
  const ci = lock?.state === "ci-wait" || lock?.state === "ci-red";
  return now - activityAt > (ci ? STALE_CI_MS : STALE_MS);
}

/** The lock with a fresh heartbeat. */
export function lockBeat(lock, at) {
  return { ...lock, beatAt: at };
}

/** mtime (ms) of a worktree's git index — every git add / commit / checkout there touches it. null if unknown. */
export function worktreeIndexMtime(worktree) {
  try {
    const dotGit = path.join(worktree, ".git");
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"));
      if (!m) return null;
      gitDir = path.resolve(worktree, m[1].trim());
    }
    return fs.statSync(path.join(gitDir, "index")).mtimeMs;
  } catch { return null; }
}

/** readLocks' stale rule for one lock file: true = released (file removed, logged in _stale-release.log). */
export function releaseIfStale(l, full, dir, now) {
  let mtime = null; try { mtime = fs.statSync(full).mtimeMs; } catch {}
  const activity = lockActivityAt(l, [mtime, worktreeIndexMtime(l.worktree)].filter((x) => x != null));
  if (!isStaleLock(l, now, activity)) return false;
  fs.rmSync(full, { force: true });
  const mins = Math.round((now - activity) / 60000);
  const state = l.state ?? "working";
  try { fs.appendFileSync(path.join(dir, "_stale-release.log"), JSON.stringify({ at: new Date(now).toISOString(), card: l.card, state, quietMin: mins, worktree: l.worktree }) + "\n"); } catch {}
  console.log(`(${l.card} ka lock hata — ${mins} min se koi heartbeat/commit nahi (${state}); _stale-release.log me likha. Wapas aaye to claim dobara.)`);
  return true;
}

/**
 * claim --wait: poll look() every QUEUE_POLL_MS, keep this card's queue entry fresh, grant() when the slot
 * is free, it is this card's turn and no file clashes. Exit 2/3 after waitMin. The entry is removed on exit.
 */
export function waitInQueue({ card, priority, worktree, waitMin, dir, look, grant, countsTowardCap }) {
  const deadline = Date.now() + waitMin * 60_000;
  const joinedAt = Date.now();
  const bye = () => leaveQueue(dir, card);
  process.on("exit", bye);
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { bye(); process.exit(130); });
  return (async () => {
    let lastLine = "";
    for (;;) {
      const s1 = look();
      const waitingFor = s1.conflicts.length ? "files" : "slot";
      if (s1.slot.ok && s1.q.turn && !s1.conflicts.length) return grant(s1);
      joinQueue(dir, { card, priority, joinedAt, seenAt: Date.now(), waitingFor, worktree });
      const line = waitingFor === "files"
        ? `… ${card} (${priority}): files ${[...new Set(s1.conflicts.map((c) => c.card))].join(", ")} ke paas hain — unke khatam hone ka intezaar`
        : `… ${card} (${priority}): slot ka intezaar${s1.q.ahead.length ? ` — aage queue me: ${s1.q.ahead.join(", ")}` : ` — chal rahe: ${s1.locks.filter((l) => l.card !== card && countsTowardCap(l)).map((l) => l.card).join(", ")}`}`;
      if (line !== lastLine) { console.log(line); lastLine = line; }
      if (Date.now() > deadline) { bye(); console.error(`✗ ${card}: ${waitMin} min me baari nahi aayi. Owner ko batao.`); process.exit(s1.conflicts.length ? 2 : 3); }
      await new Promise((r) => setTimeout(r, QUEUE_POLL_MS));
    }
  })();
}

/* Queue entries: one file per waiting card in the lock folder. */
const queueFile = (dir, card) => path.join(dir, `_queue-${String(card).toUpperCase()}.json`);
export function readQueue(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir).filter((x) => /^_queue-R-\d+\.json$/.test(x))) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))); } catch {}
  }
  return out;
}
export function joinQueue(dir, entry) { try { fs.writeFileSync(queueFile(dir, entry.card), JSON.stringify(entry)); } catch {} }
export function leaveQueue(dir, card) { try { fs.rmSync(queueFile(dir, card), { force: true }); } catch {} }

/** --wait, --priority p0, --wait-min 240 out of the args. */
export function parseQueueFlags(args) {
  const rest = []; const o = { wait: false, priority: null, waitMin: 240 };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--wait") o.wait = true;
    else if (a === "--priority") o.priority = args[++i] ?? null;
    else if (a.startsWith("--priority=")) o.priority = a.slice(11);
    else if (a === "--wait-min") o.waitMin = Number(args[++i]);
    else if (a.startsWith("--wait-min=")) o.waitMin = Number(a.slice(11));
    else rest.push(a);
  }
  if (!Number.isFinite(o.waitMin) || o.waitMin <= 0) o.waitMin = 240;
  return { rest, ...o };
}

