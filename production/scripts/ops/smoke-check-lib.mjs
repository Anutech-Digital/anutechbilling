/**
 * Smoke check — the pure parts (R-1722, 24 Oct 2026). smoke-check.mjs drives the browser;
 * everything that decides "red or green" lives here so tests/ops/smoke-check.test.ts can
 * drive it without a browser. Read-only by design: nothing here clicks, submits or writes.
 */

/**
 * The real pages, in the order an owner walks them. A `from` page is a DETAIL page: the
 * script opens the list page and follows the first link whose path matches `link`, so it
 * never needs a hardcoded id (ids differ between localhost, staging and live).
 */
export const SMOKE_PAGES = [
  { name: "Dashboard", path: "/dashboard" },
  { name: "Leads", path: "/leads" },
  { name: "Customers", path: "/customers" },
  { name: "A customer", from: "/customers", link: /^\/customers\/[0-9a-f-]{36}$/i },
  { name: "Quotes", path: "/quotes" },
  { name: "A quote", from: "/quotes", link: /^\/quotes\/[0-9a-f-]{36}$/i },
  { name: "Invoices", path: "/invoices" },
  { name: "An invoice", from: "/invoices", link: /^\/invoices\/[0-9a-f-]{36}$/i },
  { name: "Payments", path: "/payments" },
  { name: "Subscriptions", path: "/subscriptions" },
  { name: "Renewals", path: "/renewals" },
  { name: "Collections", path: "/collections" },
  { name: "Online orders", path: "/online-orders" },
  { name: "Accounting", path: "/accounting" },
  { name: "P&L", path: "/accounting/pnl" },
  { name: "Banking", path: "/accounting/banking" },
  { name: "Settings", path: "/settings" },
];

/** Text that means the page showed an error boundary or a "didn't load" state. */
export const ERROR_STATE_PATTERNS = [
  /We hit a snag loading this page/i,
  /Application error: a (client|server)-side exception/i,
  /\bdid(?:n['’]t| not) load\b/i,
  /\bcould(?:n['’]t| not) (?:load|be loaded)\b/i,
  /Something went wrong/i,
];

/** The first error-state text found on the page, or null. */
export function findErrorState(text) {
  for (const re of ERROR_STATE_PATTERNS) {
    const m = String(text ?? "").match(re);
    if (m) return m[0];
  }
  return null;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalBase(base) {
  try { return LOCAL_HOSTS.has(new URL(base).hostname); } catch { return false; }
}

/** "/customers" stays; Git Bash turns a bare "/customers" into "C:/Program Files/Git/customers". */
function appPath(flag, v) {
  if (!v.startsWith("/")) throw new Error(`${flag} needs an app path like /customers (got ${v}; in Git Bash prefix the command with MSYS_NO_PATHCONV=1)`);
  return v;
}

/** argv (without node + script) → options. Throws on a bad argument. */
export function parseArgs(argv) {
  const out = { base: null, mock500: [], extra: [], only: null, json: false, help: false, headed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); return v; };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--json") out.json = true;
    else if (a === "--headed") out.headed = true;
    else if (a === "--mock-500") out.mock500.push(appPath(a, next()));
    else if (a === "--extra") out.extra.push(appPath(a, next()));
    else if (a === "--only") out.only = next().split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    else if (a.startsWith("--")) throw new Error(`Unknown argument ${a}`);
    else if (!out.base) out.base = a.replace(/\/+$/, "");
    else throw new Error(`Only one base URL (got ${out.base} and ${a})`);
  }
  if (!out.help && !out.base) throw new Error("Base URL missing, e.g. node scripts/ops/smoke-check.mjs http://localhost:3001");
  if (out.base && !/^https?:\/\//.test(out.base)) throw new Error(`Base URL must start with http:// or https:// (got ${out.base})`);
  return out;
}

/**
 * Which login to use. SMOKE_EMAIL + SMOKE_PASSWORD always win. Only on localhost may it fall
 * back to the E2E seed owner (E2E_OWNER_EMAIL / E2E_OWNER_PASSWORD, .env.test) — the seed
 * user exists only in the local DB, and a staging run must name its own test login.
 * Returns { email, password, source } or { missing: [names] }. Never values in messages.
 */
export function resolveCreds(env, base) {
  if (env.SMOKE_EMAIL && env.SMOKE_PASSWORD) return { email: env.SMOKE_EMAIL.trim(), password: env.SMOKE_PASSWORD, source: "SMOKE_EMAIL" };
  if (isLocalBase(base) && env.E2E_OWNER_PASSWORD) {
    return { email: (env.E2E_OWNER_EMAIL || "e2e-owner@example.test").trim().toLowerCase(), password: env.E2E_OWNER_PASSWORD, source: "E2E_OWNER (local seed)" };
  }
  const missing = [];
  if (!env.SMOKE_EMAIL) missing.push("SMOKE_EMAIL");
  if (!env.SMOKE_PASSWORD) missing.push("SMOKE_PASSWORD");
  return { missing };
}

/** Requests that count: same origin as the base, minus dev-server plumbing. */
export function isCountedRequest(url, base) {
  let u, b;
  try { u = new URL(url); b = new URL(base); } catch { return false; }
  if (u.origin !== b.origin) return false;
  if (/^\/_next\/webpack-hmr|^\/__nextjs|^\/_next\/static\/webpack\//.test(u.pathname)) return false;
  return true;
}

/** net::ERR_ABORTED = the browser cancelled it (navigation away, prefetch) — not a server fault. */
export function isRealFailure(errorText) {
  return !/ERR_ABORTED|NS_BINDING_ABORTED|cancelled/i.test(String(errorText ?? ""));
}

/** Console noise from the dev toolchain, not the app. */
export function isNoiseConsole(text) {
  return /Download the React DevTools|\[HMR\]|\[Fast Refresh\]/i.test(String(text ?? ""));
}

/**
 * A page row → red reasons ([] = green).
 * row: { status, finalPath, consoleErrors: [], badRequests: [{status, method, path}], errorState, note }
 */
export function redReasons(row) {
  const r = [];
  if (row.skipped) return r; // a detail page with no record to open (empty list): shown as "–", not red
  if (row.note) r.push(row.note);
  if (row.status == null) r.push("no response");
  else if (row.status >= 400) r.push(`HTTP ${row.status}`);
  if (row.finalPath && /^\/login\b/.test(row.finalPath) && row.path !== "/login") r.push("sent to /login (session lost)");
  if (row.errorState) r.push(`error state: "${row.errorState}"`);
  if (row.badRequests?.length) r.push(`${row.badRequests.length} bad request(s)`);
  if (row.consoleErrors?.length) r.push(`${row.consoleErrors.length} console error(s)`);
  return r;
}

const pad = (s, n) => { s = String(s); return s.length >= n ? s : s + " ".repeat(n - s.length); };

/** Plain-text table + the red details under it. */
export function formatReport(rows, { sha, base } = {}) {
  const lines = [];
  lines.push(`Smoke check: ${base ?? ""}  version ${sha ?? "?"}`);
  lines.push("");
  lines.push(`${pad("", 3)}${pad("Page", 15)}${pad("HTTP", 6)}${pad("Console", 9)}${pad("Bad req", 9)}${pad("Error state", 13)}Path`);
  for (const row of rows) {
    const red = redReasons(row).length > 0;
    if (row.skipped) { lines.push(`${pad("–", 3)}${pad(row.name, 15)}${pad("skip", 6)}${row.skipped}`); continue; }
    lines.push(`${pad(red ? "✗" : "✓", 3)}${pad(row.name, 15)}${pad(row.status ?? "—", 6)}${pad(row.consoleErrors?.length ?? 0, 9)}${pad(row.badRequests?.length ?? 0, 9)}${pad(row.errorState ? "yes" : "no", 13)}${row.path ?? "—"}`);
  }
  const reds = rows.filter((r) => redReasons(r).length);
  const checked = rows.filter((r) => !r.skipped).length;
  lines.push("");
  if (!reds.length) lines.push(`✓ Sab ${checked} page hare.`);
  else {
    lines.push(`✗ ${reds.length} of ${checked} page laal:`);
    for (const row of reds) {
      lines.push(`  ${row.name} (${row.path ?? "—"}): ${redReasons(row).join("; ")}`);
      for (const b of row.badRequests ?? []) lines.push(`    ${b.status ?? "FAILED"} ${b.method} ${b.path}${b.error ? ` (${b.error})` : ""}`);
      for (const c of (row.consoleErrors ?? []).slice(0, 5)) lines.push(`    console: ${String(c).slice(0, 200).replace(/\s+/g, " ")}`);
    }
  }
  return lines.join("\n");
}
