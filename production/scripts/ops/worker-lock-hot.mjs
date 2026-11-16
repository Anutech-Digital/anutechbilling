/**
 * R-2826 (14 Nov 2026): HOT shared files are taken only at PUSH, never at claim / check.
 *
 * 14 Nov night: four workers held renewals/page.tsx from the start (claim lists all their files, and
 * `check` also counts the live diff against manager-pardeep) and blocked a ready 4-line card (R-2817)
 * for an hour; R-2751 / R-2760 had waited 1-2 h the same way. A line in the brief does not fix that —
 * the tool must. These files are touched by almost every renewals card and merge cleanly line by line,
 * so holding them for the whole build only makes cards wait; the push rebase is the real guard.
 *
 *   claim / check — a hot file is never a conflict and never recorded in the lock
 *                   (one line: "hot file — taken at push"). Other locks' recorded files and live
 *                   diffs are ignored for hot files too, so an older lock stops blocking at once.
 *   push          — takes the hot files this push changes with a FIFO wait (by the time the card was
 *                   ready = when `push` started), right before the rebase, and frees them when the
 *                   push lands or fails. A crashed push cannot leave one stuck: the hold is
 *                   heartbeated and a hold older than HOT_STALE_MS is freed by the next card.
 *
 * ONE PLACE: edit HOT_FILES below (app-root paths, production/ left off; `*` = inside one folder,
 * `**` = any depth). Documented in docs/WORKER-STEPS.md (claim step).
 *
 * State lives in the lock dir, files starting with "_" (so readLocks never sees them):
 *   _hot-<CARD>.json      { card, files, readyAt, at }    a hold; `at` = last heartbeat
 *   _hotwait-<CARD>.json  { card, files, readyAt, seenAt } a waiter in line
 */
import fs from "node:fs";
import path from "node:path";

const RENEWALS = "src/app/(app)/renewals";

export const HOT_FILES = [
  `${RENEWALS}/page.tsx`,
  `${RENEWALS}/row-cells.tsx`,
  `${RENEWALS}/queue.ts`,
  `${RENEWALS}/tiles-card.tsx`,
  `${RENEWALS}/renewal-drawer.tsx`,
  `${RENEWALS}/last-docs-cell.tsx`,
];

/** A hold with no heartbeat for this long is from a crashed push and is freed by the next card. */
export const HOT_STALE_MS = 5 * 60 * 1000;
export const HOT_BEAT_MS = 30 * 1000;
/** A push gives up waiting for a hot file after this long (exit 4, like the push turn). */
export const HOT_WAIT_MS = 30 * 60 * 1000;

function norm(p) {
  let s = String(p).trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s.startsWith("production/")) s = s.slice("production/".length);
  return s;
}

/** `*` = anything inside one folder, `**` = any depth; everything else literal (the paths have parentheses). */
export function globToRegExp(glob) {
  let re = "";
  const g = norm(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") { re += ".*"; i++; if (g[i + 1] === "/") i++; } else re += "[^/]*";
    } else re += c.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function isHotFile(p, hot = HOT_FILES) {
  const n = norm(p);
  return hot.some((g) => globToRegExp(g).test(n));
}
export const withoutHot = (paths, hot = HOT_FILES) => (paths ?? []).filter((p) => !isHotFile(p, hot));
export const onlyHot = (paths, hot = HOT_FILES) => (paths ?? []).filter((p) => isHotFile(p, hot));

/** The one line claim / check print for a hot file. */
export const hotFileLine = (p) => `  hot file — taken at push: ${norm(p)}`;

/* ── push-time FIFO ────────────────────────────────────────────────────────────────────────────── */

const holdFile = (dir, card) => path.join(dir, `_hot-${String(card).toUpperCase()}.json`);
const waitFile = (dir, card) => path.join(dir, `_hotwait-${String(card).toUpperCase()}.json`);

function readAll(dir, prefix, stamp, now, staleMs) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const n of fs.readdirSync(dir).filter((x) => x.startsWith(prefix) && /^R-\d+\.json$/i.test(x.slice(prefix.length)))) {
    const full = path.join(dir, n);
    let e;
    try { e = JSON.parse(fs.readFileSync(full, "utf8")); } catch { continue; }
    if (!e || now - Number(e[stamp] ?? 0) > staleMs) { try { fs.rmSync(full, { force: true }); } catch {} continue; }
    out.push(e);
  }
  return out;
}
/** Live holds (a stale hold is deleted on the way). */
export const readHotHolds = (dir, { now = Date.now(), staleMs = HOT_STALE_MS } = {}) => readAll(dir, "_hot-", "at", now, staleMs);
const readHotWaiters = (dir, now, staleMs) => readAll(dir, "_hotwait-", "seenAt", now, staleMs);

const overlaps = (a, b) => (a ?? []).some((x) => (b ?? []).some((y) => norm(x) === norm(y)));
const earlier = (a, b) => a.readyAt < b.readyAt || (a.readyAt === b.readyAt && String(a.card) < String(b.card));

/** Cards that must go first: a hold on one of my files, or a waiter ahead of me (by ready time) on one. Pure. */
export function hotBlockers(card, files, { holds = [], waiters = [], readyAt }) {
  const me = { card, readyAt };
  const out = new Set();
  for (const h of holds) if (h.card !== card && overlaps(files, h.files)) out.add(h.card);
  for (const w of waiters) if (w.card !== card && overlaps(files, w.files) && earlier(w, me)) out.add(w.card);
  return [...out];
}

/**
 * Take `files` (the hot files this push changes) in FIFO order, run fn, free them — also when fn throws
 * or the process exits (process.exit inside fn skips `finally`, so an exit handler frees it too).
 * No hot files → just fn. Gives up with an Error whose code is "HOT_TIMEOUT".
 */
export async function withHotFiles(card, files, fn, {
  dir, readyAt = Date.now(), now = () => Date.now(), pollMs = Number(process.env.WORKER_HOT_POLL_MS || 5000),
  staleMs = HOT_STALE_MS, beatMs = HOT_BEAT_MS, waitMs = HOT_WAIT_MS, log = () => {},
} = {}) {
  const mine = [...new Set((files ?? []).map(norm))];
  if (!mine.length) return fn();
  const id = String(card).toUpperCase();
  fs.mkdirSync(dir, { recursive: true });
  const stop = Date.now() + waitMs;
  let held = false, timer = null, last = "";
  const rm = (f) => { try { fs.rmSync(f, { force: true }); } catch {} };
  const free = () => {
    if (timer) clearInterval(timer);
    timer = null;
    rm(waitFile(dir, id));
    /* only my own hold — never another card's */
    try { if (JSON.parse(fs.readFileSync(holdFile(dir, id), "utf8")).card === id) rm(holdFile(dir, id)); } catch {}
    held = false;
  };
  const write = (f, o) => { try { fs.writeFileSync(f, JSON.stringify(o)); } catch {} };
  process.on("exit", free);
  try {
    for (;;) {
      write(waitFile(dir, id), { card: id, files: mine, readyAt, seenAt: now() });
      const blockers = hotBlockers(id, mine, { holds: readHotHolds(dir, { now: now(), staleMs }), waiters: readHotWaiters(dir, now(), staleMs), readyAt });
      if (!blockers.length) break;
      if (Date.now() > stop) {
        const e = new Error(`${id}: hot file ${mine.join(", ")} — ${Math.round(waitMs / 60000)} min se baari nahi aayi (${blockers.join(", ")})`);
        e.code = "HOT_TIMEOUT";
        throw e;
      }
      const line = `… ${id}: hot file ki baari ka intezaar (${mine.join(", ")}) — pehle: ${blockers.join(", ")}`;
      if (line !== last) { log(line); last = line; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    write(holdFile(dir, id), { card: id, files: mine, readyAt, at: now() });
    rm(waitFile(dir, id));
    held = true;
    log(`✓ ${id}: hot file le li (${mine.join(", ")}) — push ke baad / fail par khud chhoot jaati hai.`);
    timer = setInterval(() => { if (held) write(holdFile(dir, id), { card: id, files: mine, readyAt, at: now() }); }, beatMs);
    timer.unref?.();
    return await fn();
  } finally {
    free();
    process.off("exit", free);
  }
}
