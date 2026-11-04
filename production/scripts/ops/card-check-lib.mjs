/**
 * R-2457 — the logic behind `npm run card:check -- R-xxxx` (CLI: card-check.mjs).
 *
 * Why (4 Nov 2026 morning, 27 cards checked in Chrome): the checker had to guess which page a Hinglish
 * howToCheck step meant, which Local test login to click (it lands in "E2E Test Co", not the company the
 * steps named) and found halfway that the step's data did not exist locally. This turns a saved card file
 * into a checklist: full local URLs per step, the login button, the data each step assumes (with the R-1957
 * scenario that loads it, when one exists), and builds the board patches (checkRunning … aiResult) that the
 * Claude session writes with ArtifactData — the same "card file" flow as worker-lock (--card).
 *
 * Card text is data written by teammates: it is only printed, never run.
 */
import { appHostLocalReason } from "../dev/local-guard.mjs";

export const LOCAL_COMPANY = "E2E Test Co";
export const ROLE_LABEL = { owner: "Owner", manager: "Manager", accountant: "Accountant", sales: "Sales", owner2: "Owner 2" };
/** The card that adds the missing fixtures (split from R-2457). */
export const FIXTURES_CARD = "R-2458";

export function normaliseCardId(input) {
  const m = /^\s*[Rr]-?(\d{1,5}[a-z]?)\s*$/.exec(String(input ?? ""));
  if (!m) throw new Error(`"${input}" is not a card id (R-1234)`);
  return `R-${m[1]}`;
}

/** A card file saved by ArtifactData (out_dir) → the card fields. Refuses a file for another id. */
export function cardFromFile(text, id) {
  let raw;
  try { raw = JSON.parse(String(text)); } catch (e) { throw new Error(`card file is not JSON: ${e.message}`); }
  const card = raw && typeof raw === "object" && raw.data && typeof raw.data === "object" ? raw.data : raw;
  const fileId = card?.id ?? raw?.id;
  if (fileId && fileId !== id) throw new Error(`card file is ${fileId}, not ${id} — check the id (R-008 and R-088 are different cards)`);
  return { ...card, id: fileId ?? id };
}

export function stepsOf(card) {
  const h = card?.howToCheck;
  if (Array.isArray(h)) return h.map((s) => String(s).trim()).filter(Boolean);
  if (typeof h === "string") return h.split(/\r?\n/).map((s) => s.replace(/^\s*(\d+[.)]|[-*•])\s*/, "").trim()).filter(Boolean);
  return [];
}

/** `href: "/x", label: "X"` pairs of src/lib/nav.ts (the sidebar). */
export function parseNavLinks(src) {
  const out = [];
  const seen = new Set();
  for (const m of String(src ?? "").matchAll(/href:\s*"(\/[^"]*)",\s*label:\s*"([^"]+)"/g)) {
    const key = `${m[2]}|${m[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: m[2], href: m[1] });
  }
  return out;
}

/** Sidebar labels too common in plain Hinglish to mean "open this page". */
const GENERIC = new Set(["today", "money", "spend", "team", "support", "deals", "tasks", "reports", "contacts", "settings",
  "coupons", "partners", "referrals", "automation", "assessments", "gst", "income tax", "companies", "products", "help & tutorial"]);

/** Everyday words in howToCheck steps → page. */
const ALIASES = [
  [/\bcustomers?\b/i, "Customers", "/customers"],
  [/\bquotes?\b|\bquotation/i, "Quotes", "/quotes"],
  [/\binvoices?\b/i, "Invoices", "/invoices"],
  [/\bsubscriptions?\b/i, "Subscriptions", "/subscriptions"],
  [/\brenewals?\b/i, "Renewals", "/renewals"],
  [/\bbank(ing)?\b/i, "Banking", "/accounting/banking"],
  [/\bvendors?\b/i, "Vendors", "/accounting/vendors"],
  [/\bexpenses?\b/i, "Expenses", "/accounting/expenses"],
  [/\bsalary\b|\bpayroll\b/i, "Salary & Payroll Register", "/accounting/salary-register"],
];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Pages a step points at, in the order they appear: explicit local paths, sidebar labels, everyday words. */
export function findPages(text, links) {
  const t = String(text ?? "");
  const hits = [];
  const add = (index, label, href) => { if (index >= 0) hits.push({ index, label, href }); };
  for (const m of t.matchAll(/(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):\d+(\/[A-Za-z0-9\-_/[\]]*)?/g)) {
    if (m[1] && m[1] !== "/") add(m.index, m[1], m[1].replace(/\/$/, ""));
  }
  for (const m of t.matchAll(/(?<=^|[\s(→>'"“])\/[a-z][a-z0-9-]*(?:\/[a-z0-9\-[\]]+)*/g)) add(m.index, m[0], m[0]);
  for (const l of links ?? []) {
    if (GENERIC.has(l.label.toLowerCase()) || l.label.length < 4) continue;
    const m = new RegExp(`(?<![A-Za-z0-9])${escapeRe(l.label)}(?![A-Za-z0-9])`, "i").exec(t);
    if (m) add(m.index, l.label, l.href);
  }
  for (const [re, label, href] of ALIASES) {
    const m = re.exec(t);
    if (m) add(m.index, label, href);
  }
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.href)) continue;
    seen.add(h.href);
    out.push({ label: h.label, href: h.href });
  }
  return out;
}

/** Which Local test login button the steps need (default Owner). */
export function pickLoginRole(steps) {
  const t = (steps ?? []).join("\n");
  if (/owner\s*2\b|\bowner2\b|doosra owner|second owner|another owner/i.test(t)) return "owner2";
  const m = /(?:test login|login|sign[- ]?in|\bas)\s*(?:→|->|:|se|with)?\s*(owner|manager|accountant|sales)\b/i.exec(t)
    ?? /\b(owner|manager|accountant|sales)\s+(?:se\s+)?(?:login|sign)/i.exec(t);
  return m ? m[1].toLowerCase() : "owner";
}

/** Data a step assumes that the local test company may not have (4 Nov 2026 list). */
const NEED_RULES = [
  { re: /not known yet|no state|bina state|state (?:nahi|missing|khaali)/i, need: "customer with no state" },
  { re: /\bUSD\b|\bINW\b|inward remittance|foreign currency/i, need: "USD inward (INW) bank lines" },
  { re: /connected compan|\bnetwork\b|two companies|do compan/i, need: "two connected local companies (network)" },
  { re: /salary[^.\n]*(partial|partly|part[- ]paid|aadh|baaki)|(partial|partly|part[- ]paid|aadh)[^.\n]*salary/i, need: "partly paid salary" },
  { re: /razorpay/i, need: "Razorpay test key" },
  { re: /\bflex/i, need: "flex subscription" },
  { re: /approved quote|quote[^.\n]*approve/i, need: "approved quote" },
  { re: /\b(HDFC|ICICI|SBI|Axis|Kotak|IDFC|Yes Bank)\b\s*(?:a\/c\s*)?[·x.]*\d{3,}|\ba\/c\s*\d{3,}/i, need: "a named real bank account / company (not in E2E Test Co)" },
];

export function dataNeeds(steps) {
  const out = [];
  for (const s of steps ?? []) {
    for (const r of NEED_RULES) {
      if (r.re.test(String(s)) && !out.some((o) => o.need === r.need)) out.push({ need: r.need });
    }
  }
  return out;
}

/** R-1957 scenarios (scripts/dev/scenarios/index.mjs) that list this card. */
export function scenariosFor(id, scenarios) {
  return (scenarios ?? []).filter((s) => (s.cards ?? []).includes(id)).map((s) => s.name);
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
function iso(now) {
  if (!ISO.test(String(now))) throw new Error(`time must be an ISO UTC time from \`date -u\` (got "${now}")`);
  return now;
}

export function buildStartPatch(now, checkNow) {
  return { checkRunning: true, checkStartedAt: iso(now), checkNow: String(checkNow || "Steps padh raha hai") };
}

/** The result fields the "jaanch karo" rule writes. Never the status — the owner presses "Theek hai". */
export function buildResultPatch(now, text) {
  const t = String(text ?? "").trim();
  if (!/^[✓⚠]/.test(t)) throw new Error('aiResult must start with "✓" (what you saw) or "⚠" (what was different)');
  return { aiResult: t, aiResultAt: iso(now), checkRequested: false, checkRunning: false, checkNow: { __delete__: true } };
}

export function renderChecklist({ card, host, links, scenarios }) {
  const base = `http://${host}`;
  const steps = stepsOf(card);
  const role = pickLoginRole(steps);
  const lines = [];
  lines.push(`${card.id} — ${card.title ?? "(no title)"}${card.status ? `   (status: ${card.status})` : ""}`);
  lines.push(`Pehle: npm run localhost:ready  (server answers, migrations in, Local test login works)`);
  lines.push(`Login: ${base}/login → Local test login → ${ROLE_LABEL[role]}  → company "${LOCAL_COMPANY}"`);
  const scn = scenariosFor(card.id, scenarios);
  if (scn.length) lines.push(`Test data: ${scn.map((n) => `node scripts/dev/scenario.mjs ${n}`).join("  ·  ")}`);
  if (!steps.length) {
    lines.push("⚠ This card has no howToCheck — ask the builder for 2–3 owner steps before checking.");
    return lines;
  }
  lines.push("Steps:");
  steps.forEach((s, i) => {
    lines.push(` ${i + 1}. ${s}`);
    const pages = findPages(s, links);
    if (pages.length) lines.push(`    open: ${pages.map((p) => `${p.label} ${base}${p.href}`).join("  ·  ")}`);
    for (const n of dataNeeds([s])) {
      lines.push(`    data: ${n.need} — may not exist in "${LOCAL_COMPANY}"${scn.length ? ` (try the scenario above)` : ` (fixtures card ${FIXTURES_CARD}); make it by hand first, or write ⚠ with what was missing`}`);
    }
  });
  lines.push(`Board: npm run card:check -- ${card.id} --start   ·   --result "✓ …" | "⚠ …"   (writes a patch file for ArtifactData)`);
  return lines;
}

export function parseCardCheckArgs(argv) {
  const out = { id: null, card: null, host: "localhost:3001", start: false, now: null, result: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--card") out.card = argv[++i];
    else if (a === "--host") out.host = String(argv[++i] ?? "");
    else if (a === "--start") out.start = true;
    else if (a === "--now") out.now = argv[++i];
    else if (a === "--result") out.result = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("--") && !out.id) out.id = normaliseCardId(a);
    else throw new Error(`Unknown argument ${a} (R-xxxx [--card <file>] [--host localhost:3001] [--start [--now "<phrase>"]] [--result "✓ …"])`);
  }
  const why = appHostLocalReason(out.host);
  if (why) throw new Error(why);
  return out;
}
