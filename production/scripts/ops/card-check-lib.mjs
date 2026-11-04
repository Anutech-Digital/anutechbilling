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

/** The fixtures that need more than rows (a login, a one-owner company, a billing run) — split from R-2458. */
export const NEXT_FIXTURES_CARD = "R-2464";

/**
 * Data a step assumes that the local test company may not have (4 Nov 2026 list).
 * R-2458: each need names the R-1957 scenario that loads it into E2E Test Co (scripts/dev/scenarios/index.mjs),
 * or — when no fixture can hold it — `noFixture`, the plain reason and what to do instead.
 */
const NEED_RULES = [
  // a LEAD with no state is made by the steps themselves (R-2456) — the customer scenario does not hold it
  { re: /not known yet|no state|bina state|state (?:nahi|missing|khaali)/i, unless: /\blead\b/i, need: "customer with no state", scenario: "customer-no-state" },
  { re: /\bUSD\b|\bINW\b|inward remittance|foreign currency/i, need: "USD inward (INW) bank lines", scenario: "usd-inw-lines" },
  { re: /connected (?:compan|business|customer)|\bnetwork\b|two companies|do compan|distributor[^.\n]*reseller|\bverified GSTIN|prove you own/i,
    need: "two connected local companies (network)", scenario: "connected-companies" },
  { re: /salary[^.\n]*(partial|partly|part[- ]paid|aadh|baaki)|(partial|partly|part[- ]paid|aadh)[^.\n]*salary/i, need: "partly paid salary", scenario: "salary-part-paid" },
  { re: /full\s*(?:n|and|&)\s*final|\bF&F\b|\bFNF\b/i, need: "FULL N FINAL salary line", scenario: "salary-part-paid" },
  { re: /\b0{12,}\b|placeholder ref|zero[- ]ref/i, need: "placeholder-reference (000…) bank lines and invoices", scenario: "zero-ref-credits" },
  { re: /small leftover|chhota bill|₹\s?(?:55|354)(?![\d,])|write off/i, need: "part-paid invoice with a small leftover", scenario: "small-leftover" },
  { re: /\bNBFC\b|non-bank|not a bank|Bajaj|Tata Capital|\b194A\b|loan interest/i, need: "non-bank lender with interest over ₹10,000", scenario: "nbfc-interest" },
  { re: /\bLUT\b/, need: "LUT for each financial year", scenario: "lut-per-fy" },
  { re: /approved quote|quote[^.\n]*approve|approve[^.\n]*quote|below[- ]cost/i, need: "approved quote", scenario: "approved-quote" },
  { re: /\bflex/i, need: "flex subscription", scenario: "ads-month" },
  { re: /razorpay/i, need: "Razorpay test key",
    noFixture: "keys are never in a fixture — the owner saves a rzp_test_… key in Settings → Integrations first" },
  { re: /\bzoho\b/i, need: "a Zoho Books connection",
    noFixture: "Reconcile / Find in Zoho needs a connected Zoho Books org — not in local fixtures; check the non-Zoho steps and write ⚠ for these" },
  { re: /sirf (?:EK|ek) owner|only (?:one|ONE) owner|sole owner|single owner/i, need: "a company with one owner",
    noFixture: `E2E Test Co has Owner + Owner 2 — a one-owner company is ${NEXT_FIXTURES_CARD}` },
  { re: /\b(HDFC|ICICI|SBI|Axis|Kotak|IDFC|Yes Bank)\b\s*(?:a\/c\s*)?[·x.]*\d{3,}|\ba\/c\s*\d{3,}/i, need: "a named real bank account / company (not in E2E Test Co)",
    noFixture: "use the scenarios' own account SCN HDFC Current ··7788 instead of a real company's account" },
];

/**
 * Cards whose steps need data no scenario holds yet (4 Nov 2026 review list) — the reason is printed
 * as "No ready-made data" so the checker does not hunt for it.
 */
export const CARD_NO_FIXTURE = {
  "R-2415": "a Razorpay TEST key (Settings → Integrations, saved by the owner) and a Razorpay test payment",
  "R-2439": "a Razorpay TEST key (Settings → Integrations, saved by the owner) and a Razorpay test payment",
  "R-2426": `a company with ONE owner — E2E Test Co has Owner + Owner 2 (${NEXT_FIXTURES_CARD})`,
  "R-2371": `a money-in line carrying our own company name — use any money-in line on SCN HDFC Current ··7788 and type the name, or ${NEXT_FIXTURES_CARD}`,
  "R-2423": `renewal part quotes (Part 1 of 12) come from the subscription billing run (${NEXT_FIXTURES_CARD})`,
  "R-2456": "none needed — the steps make the new lead themselves",
};

export function dataNeeds(steps) {
  const out = [];
  for (const s of steps ?? []) {
    for (const r of NEED_RULES) {
      if (!r.re.test(String(s)) || (r.unless && r.unless.test(String(s))) || out.some((o) => o.need === r.need)) continue;
      out.push(r.scenario ? { need: r.need, scenario: r.scenario } : { need: r.need, noFixture: r.noFixture });
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
  const known = new Set((scenarios ?? []).map((s) => s.name));
  // R-2458: the scenarios that list the card, then the ones its steps' data needs point at
  const scn = [...new Set([...scenariosFor(card.id, scenarios),
    ...dataNeeds(steps).map((n) => n.scenario).filter((n) => n && known.has(n))])];
  if (scn.length) lines.push(`Test data: ${scn.map((n) => `node scripts/dev/scenario.mjs ${n}`).join("  ·  ")}   (E2E Test Co, local DB; load twice = same rows)`);
  if (CARD_NO_FIXTURE[card.id]) lines.push(`No ready-made data for: ${CARD_NO_FIXTURE[card.id]}`);
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
      if (n.scenario && known.has(n.scenario)) lines.push(`    data: ${n.need} → node scripts/dev/scenario.mjs ${n.scenario}`);
      else if (n.noFixture) lines.push(`    data: ${n.need} — No ready-made data: ${n.noFixture}`);
      else lines.push(`    data: ${n.need} — may not exist in "${LOCAL_COMPANY}"; make it by hand first, or write ⚠ with what was missing`);
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
