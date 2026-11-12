/**
 * Board auto-free — when is a running card "quiet"? R-2719 (12 Nov 2026).
 *
 * The board page (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n) sends a `doing` card back to the
 * list after 60 quiet minutes. Its `quietMin` read only liveLog OBJECTS that have `at` (and claimedAt),
 * so on 12 Nov cards were freed 3–4 times while their workers were busy: those workers wrote liveLog as
 * plain strings, or only changed nowDoing, and were timed from claimedAt.
 *
 * Rule now: quiet time counts from the NEWEST of
 *   - claimedAt,
 *   - every liveLog entry — an object's `at`, or a time inside a string line
 *     ("2026-11-12T15:11:21Z …" or the board style "12 Nov 20:41 IST …"),
 *   - the nowDoing update: `nowDoingAt` (write it with every nowDoing change) or the card's `updatedAt`.
 * A time more than 10 minutes in the future (typo, wrong clock) is ignored, so a card cannot stay
 * claimed for ever.
 *
 * The page keeps its own copy: `lastLifeMs` below is self-contained on purpose (no imports, no outer
 * names) — paste its source into the page and make the page's quietMin call it
 * (tests/ops/board-quiet.test.ts proves the pasted source gives the same answer).
 *
 *   node scripts/ops/board-quiet.mjs <card.json> […]     quiet minutes of saved card files
 *                                                         (ArtifactData get, out_dir → <out_dir>/cards/R-XXX.json)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STALE_MIN = 30;
export const AUTO_FREE_MIN = 60;

/** Newest sign of life on a card, in ms since epoch; 0 when the card carries no usable time. */
export function lastLifeMs(c, nowMs = Date.now()) {
  if (!c || typeof c !== "object") return 0;
  const AHEAD_OK = 10 * 60000;
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/;
  const IST = /\b(\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}):(\d{2}) IST\b/i;
  const fromText = (s) => {
    const iso = ISO.exec(s);
    if (iso) return Date.parse(iso[0]);
    const m = IST.exec(s);
    if (!m) return NaN;
    const d = Number(m[1]), mon = MON[m[2].toLowerCase()], hh = Number(m[3]), mm = Number(m[4]);
    if (d < 1 || d > 31 || hh > 23 || mm > 59) return NaN;
    /* The line has no year: take now's IST year; a date that would then be ahead of now is last year's. */
    const year = new Date(nowMs + 330 * 60000).getUTCFullYear();
    const at = (y) => Date.UTC(y, mon, d, hh, mm) - 330 * 60000;
    return at(year) > nowMs + AHEAD_OK ? at(year - 1) : at(year);
  };
  const times = [c.claimedAt, c.nowDoingAt, c.updatedAt].map((v) => (typeof v === "string" ? Date.parse(v) : NaN));
  for (const x of Array.isArray(c.liveLog) ? c.liveLog : []) {
    if (typeof x === "string") times.push(fromText(x));
    else if (x && typeof x === "object") times.push(typeof x.at === "string" ? Date.parse(x.at) : NaN, typeof x.text === "string" && !x.at ? fromText(x.text) : NaN);
  }
  let best = 0;
  for (const t of times) if (!Number.isNaN(t) && t <= nowMs + AHEAD_OK && t > best) best = t;
  return best;
}

/** Whole minutes since the newest sign of life; 0 when there is none (the page never frees such a card). */
export function quietMin(c, nowMs = Date.now()) {
  const t = lastLifeMs(c, nowMs);
  return t ? Math.max(0, Math.floor((nowMs - t) / 60000)) : 0;
}

/** The page's auto-free test: a `doing` card, not a goal card, quiet for 60 min or more. */
export function shouldAutoFree(c, nowMs = Date.now()) {
  return !!c && c.status === "doing" && c.kind !== "goal" && quietMin(c, nowMs) >= AUTO_FREE_MIN;
}

function main(argv) {
  if (!argv.length || argv.includes("--help") || argv.includes("-h")) {
    console.log("node scripts/ops/board-quiet.mjs <card.json> […]   — quiet minutes of saved board cards (auto-free at 60)");
    return 0;
  }
  let bad = 0;
  for (const p of argv) {
    let c;
    try {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      c = raw && raw.data && typeof raw.data === "object" && !("title" in raw) ? { id: raw.id, ...raw.data } : raw;
    } catch (e) { console.error(`✗ ${p}: ${e.message}`); bad = 1; continue; }
    const m = quietMin(c);
    const last = lastLifeMs(c);
    const state = c.status !== "doing" ? `status ${c.status} — auto-free sirf doing par` : shouldAutoFree(c) ? `board ise chhod dega (${AUTO_FREE_MIN} min)` : m >= STALE_MIN ? `liveLog likho — ${AUTO_FREE_MIN - m} min me board chhod dega` : "theek";
    console.log(`${c.id ?? path.basename(p)}: ${m} min se koi kadam nahi (aakhri: ${last ? new Date(last).toISOString() : "koi samay nahi"}) — ${state}`);
  }
  return bad;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
