/**
 * R-1412 — pure helpers for scripts/ops/queue-watch.mjs (tested in tests/ops/queue-watch.test.ts).
 *
 * classify(item) — one word per queue item, first match wins:
 *   urgent    item.urgent === true (someone pressed "urgent"; R-397)
 *   p0        reported_severity "critical", or severity_score >= 80 (0–100 triage score)
 *   security  type / inferred_type "security", or a security word in title / summary / directive
 *   money     type / inferred_type "billing"/"payment", or a money word in the same text
 *   normal    everything else
 * Keyword lists are short on purpose — a missed word only means "normal", never a lost item.
 */

export const POLL_MS = 90_000;
export const ERROR_EVERY_MS = 30 * 60_000;

const SECURITY_WORDS = /\b(security|secure|leak(ed|s)?|xss|csrf|injection|password|token|secret|unauthori[sz]ed|permission|privacy|exposed|hack(ed)?)\b/i;
const MONEY_WORDS = /\b(payments?|paid|money|refunds?|razorpay|billing|overcharged|charged)\b|₹/i;

export function classify(item) {
  if (!item || typeof item !== "object") return "normal";
  if (item.urgent === true) return "urgent";
  const sev = String(item.reported_severity ?? "").toLowerCase();
  const score = Number(item.severity_score);
  if (sev === "critical" || (Number.isFinite(score) && score >= 80)) return "p0";
  const types = [item.reported_type, item.inferred_type].map((t) => String(t ?? "").toLowerCase());
  const text = [item.title, item.problem_summary, item.directive].filter((t) => typeof t === "string").join(" ");
  if (types.includes("security") || SECURITY_WORDS.test(text)) return "security";
  if (types.some((t) => t === "billing" || t === "payment" || t === "money") || MONEY_WORDS.test(text)) return "money";
  return "normal";
}

/** Items whose id is not in `seen` (a Set of "<env>:<id>"). Returns { fresh, seen } — seen is a new Set. */
export function newItems(env, items, seen) {
  const next = new Set(seen);
  const fresh = [];
  for (const it of Array.isArray(items) ? items : []) {
    const id = it && (typeof it.id === "string" || typeof it.id === "number") ? String(it.id) : null;
    if (!id) continue;
    const key = `${env}:${id}`;
    if (next.has(key)) continue;
    next.add(key);
    fresh.push(it);
  }
  return { fresh, seen: next };
}

/** One output line per new item. */
export function newLine(env, item) {
  return `NEW ${env} ${item.id} ${classify(item)}`;
}

/**
 * Rate limit for "QUEUE <env> HTTP <code>": at most once per ERROR_EVERY_MS per env.
 * lastAt is a plain object { [env]: ms }. Returns { print, lastAt } (lastAt is a new object).
 */
export function shouldReportError(env, lastAt, now, everyMs = ERROR_EVERY_MS) {
  const prev = lastAt?.[env];
  if (typeof prev === "number" && now - prev < everyMs) return { print: false, lastAt: { ...lastAt } };
  return { print: true, lastAt: { ...lastAt, [env]: now } };
}

/** "QUEUE <env> HTTP <code>" — code is the status, or "down" for a network error. */
export function errorLine(env, code) {
  return `QUEUE ${env} HTTP ${code}`;
}

/** State file <-> memory. Unknown / broken JSON = empty state (first run prints the current queue). */
export function parseState(text) {
  try {
    const s = JSON.parse(text);
    return {
      seen: new Set(Array.isArray(s?.seen) ? s.seen.filter((x) => typeof x === "string") : []),
      lastErrorAt: s?.lastErrorAt && typeof s.lastErrorAt === "object" ? s.lastErrorAt : {},
    };
  } catch {
    return { seen: new Set(), lastErrorAt: {} };
  }
}

/** Keeps the newest 5000 ids so the file cannot grow forever. */
export function serializeState(state) {
  const seen = [...state.seen].slice(-5000);
  return JSON.stringify({ seen, lastErrorAt: state.lastErrorAt ?? {} });
}

/** KEY=value lines (# comments, optional quotes) → object. Never logs anything. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}
