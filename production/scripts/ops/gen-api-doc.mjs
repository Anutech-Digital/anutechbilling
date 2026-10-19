/**
 * gen-api-doc — writes docs/API.md: every API route in src/app, its URL, its HTTP methods and a
 * short hint of how a caller is let in (R-1665, 19 Oct 2026).
 *
 * Why: a new session should find "which routes exist and who may call them" without opening
 * 250+ route files. The doc is generated, so it cannot drift: tests/ops/gen-api-doc.test.ts
 * fails when a route is added, removed or changes its methods without re-running this.
 *
 *   node scripts/ops/gen-api-doc.mjs           # rewrite ../docs/API.md
 *   node scripts/ops/gen-api-doc.mjs --check   # write nothing; exit 1 if docs/API.md is stale
 *
 * Run from production/. Output is deterministic (sorted, no dates), so a re-run with no route
 * change gives a byte-identical file.
 *
 * The "Who may call" column is a HEURISTIC read of the route's own source (comments removed),
 * plus the file a route re-exports from. It is a hint for a reader, not a security check —
 * the real guards are the ratchets in src/app/api/admin-client-ratchet.test.ts and
 * role-gate-ratchet.test.ts. When nothing recognisable is found it says "?".
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PRODUCTION = path.resolve(HERE, "..", "..");
export const APP_DIR = path.join(PRODUCTION, "src", "app");
export const DOC_FILE = path.resolve(PRODUCTION, "..", "docs", "API.md");

const ROUTE_FILE = /^route\.(ts|js|tsx|jsx|mjs)$/;
const HTTP = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** All route files under `dir`, as paths relative to it with forward slashes, sorted. */
export function findRouteFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        walk(full);
      } else if (ROUTE_FILE.test(e.name)) {
        out.push(path.relative(dir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * "api/cron/[job]/route.ts" → "/api/cron/:job". Route groups "(app)" and parallel slots "@x"
 * are dropped; "[...path]" → ":path*", "[[...path]]" → ":path*?".
 */
export function urlPathOf(relFile) {
  const segs = relFile.split("/").slice(0, -1);
  const parts = [];
  for (const s of segs) {
    if (/^\(.*\)$/.test(s) || s.startsWith("@")) continue;
    let m;
    if ((m = /^\[\[\.\.\.(.+)\]\]$/.exec(s))) parts.push(`:${m[1]}*?`);
    else if ((m = /^\[\.\.\.(.+)\]$/.exec(s))) parts.push(`:${m[1]}*`);
    else if ((m = /^\[(.+)\]$/.exec(s))) parts.push(`:${m[1]}`);
    else parts.push(s);
  }
  return "/" + parts.join("/");
}

/** Top-level group for the table: "/api/cron/x" → "api/cron", "/auth/sign-out" → "auth". */
export function groupOf(url) {
  const p = url.split("/").filter(Boolean);
  if (p.length === 0) return "/";
  if (p[0] === "api") return p.length > 1 ? `api/${p[1].replace(/\*?\??$/, "")}` : "api";
  return p[0].startsWith(":") ? "/" : p[0];
}

/** Source with comments removed, so a route that only TALKS about a guard is not credited with it. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

/** HTTP methods a route module exports (function, const, or `export { a as GET }` forms). */
export function methodsOf(src) {
  const code = stripComments(src);
  const found = new Set();
  for (const m of code.matchAll(/export\s+(?:async\s+)?function\s+([A-Z]+)\b/g)) found.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+([A-Z]+)\b/g)) found.add(m[1]);
  for (const m of code.matchAll(/export\s+(?:const|let|var)\s+\{([^}]*)\}\s*=/g)) {
    for (const n of m[1].split(",")) found.add(n.split(":").pop().trim());
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().split(/\s+as\s+/).pop().trim();
      found.add(name);
    }
  }
  return HTTP.filter((h) => found.has(h));
}

/** Relative files a route re-exports from (`export { POST } from "./webhook.server"`). */
export function reExportSources(src) {
  return [...stripComments(src).matchAll(/export\s*(?:\{[^}]*\}|\*)\s*from\s*["'](\.[^"']+)["']/g)].map((m) => m[1]);
}

// Each rule: [label, regex over the comment-free source]. Order = order shown.
const CALLER_RULES = [
  ["cron secret", /\bCRON_SECRET\b|\bcronAuthFailure\s*\(|\bgatedCron\b/],
  ["webhook signature", /\bverifyMetaSignature\b|\bverifyRetellSignature\b|\bverifySharedSecretHeader\b|\bcreateHmac\b|\bWEBHOOK_SECRET\b|validateWebhookSignature|x-razorpay-signature|x-hub-signature/i],
  ["inbound secret", /\bINBOUND_EMAIL_SECRET\b|\bx-ingest-key\b/],
  ["agent token", /\bAGENT_QUEUE_TOKEN\b/],
  ["API key", /\bauthenticateApiKey\s*\(/],
  ["DMS panel key", /\bcheckPanelKey\s*\(|\bDMS_PANEL_API_KEY\b/],
  ["signed token", /\bverifyPdfToken\b|\bquoteTokenMatches\b|\bverifyClaimToken\b|\bverifyUnsubscribe\b|\bverifyTrialToken\b/],
  ["platform admin", /\bisPlatformAdmin\s*\(/],
  ["JWT (data gateway)", /\bidentityFromHeaders\s*\(/],
];
const SESSION = /\bwithRoute\s*(<[^>]*>)?\s*\(|\.auth\.getUser\s*\(|\bgetSessionUser\s*\(|\brequireUser\s*\(|\bgetCaller\s*\(|\bgetSession\s*\(|\bauth\(\s*\)/;
const ROLE = /\bwithRoute\s*(<[^>]*>)?\s*\(\s*\{[^}]*\b(roles|permission|pages)\s*:|\.\.\.OWNER_ONLY\b|\bOWNER_ONLY\b|\bACTION_ROLES\b|\bmayDo\s*\(|\bcan\s*\(|\bvaultGate\s*\(|\bmayOpenPage\s*\(|\brequireRole\s*\(|\bassertRole\s*\(|\brole\s*(===|!==)\s*["'](owner|manager|accountant|billing)["']/;

/**
 * Short, conservative "who may call" hint from a route's source. Returns e.g. "cron secret",
 * "session + role", "API key", "public", or "?" when nothing recognisable is found.
 */
export function authHint(src, url) {
  const code = stripComments(src);
  const hints = CALLER_RULES.filter(([, re]) => re.test(code)).map(([label]) => label);
  if (SESSION.test(code)) hints.push(ROLE.test(code) ? "session + role" : "session");
  if (hints.length > 0) return hints.join(", ");
  if (/^\/api\/public\//.test(url)) return "public";
  if (/^\/api\/auth\/|^\/auth\/|^\/callback$/.test(url)) return "sign-in flow";
  if (/^\/api\/dev\//.test(url)) return "dev only";
  return "?";
}

/** One row per route file: { file, url, group, methods, auth }. */
export function collectRoutes(appDir = APP_DIR) {
  return findRouteFiles(appDir).map((file) => {
    const full = path.join(appDir, file);
    let src = fs.readFileSync(full, "utf8");
    // A thin route that re-exports its handler: read the real file too (one level).
    for (const spec of reExportSources(src)) {
      const base = path.resolve(path.dirname(full), spec);
      const hit = ["", ".ts", ".tsx", ".js", ".mjs"].map((x) => base + x).find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
      if (hit) src += "\n" + fs.readFileSync(hit, "utf8");
    }
    const url = urlPathOf(file);
    return { file, url, group: groupOf(url), methods: methodsOf(src), auth: authHint(src, url) };
  });
}

const cell = (s) => String(s).replace(/\|/g, "\\|");

/** The whole docs/API.md text. Pure: same routes in, same bytes out. */
export function renderApiDoc(routes) {
  const sorted = [...routes].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : a.file < b.file ? -1 : 1));
  const groups = new Map();
  for (const r of sorted) {
    if (!groups.has(r.group)) groups.set(r.group, []);
    groups.get(r.group).push(r);
  }
  const names = [...groups.keys()].sort();
  const counts = {};
  for (const r of sorted) for (const h of r.auth.split(", ")) counts[h] = (counts[h] ?? 0) + 1;

  const L = [];
  L.push("# API routes");
  L.push("");
  L.push("<!-- GENERATED by production/scripts/ops/gen-api-doc.mjs — do not edit by hand. -->");
  L.push("<!-- After adding, removing or changing a route: cd production && node scripts/ops/gen-api-doc.mjs -->");
  L.push("");
  L.push(`**${sorted.length} route files** under \`production/src/app\` (Next.js route handlers), in ${names.length} groups.`);
  L.push("Paths: `[id]` is shown as `:id`, `[...path]` as `:path*`; route groups like `(auth)` are dropped.");
  L.push("");
  L.push("**Who may call** is a hint read from each route's own code, not a guarantee:");
  L.push("");
  L.push("- `session` — a signed-in user (`withRoute()` or `auth.getUser()`); `session + role` — also checks the user's role or permission.");
  L.push("- `cron secret` — `Authorization: Bearer <CRON_SECRET>` (Cloud Scheduler); see `src/app/api/cron/_lib/cron-auth.ts`.");
  L.push("- `webhook signature` — an HMAC / provider signature check; `inbound secret` — a shared ingest secret.");
  L.push("- `API key` — a tenant API key (`/api/v1`, `src/lib/api-keys`); `DMS panel key` — called by the DMS app.");
  L.push("- `signed token` — a one-time or signed link token; `agent token` — the internal AI agent queue token.");
  L.push("- `platform admin` — the platform operator only; `JWT (data gateway)` — the `/api/sb` gateway reads the caller from its JWT.");
  L.push("- `public` — under `/api/public`, no check found (anonymous by design); `sign-in flow` — a sign-in/auth route with no other check found;");
  L.push("  `dev only` — under `/api/dev` (local and test only).");
  L.push("- `?` — nothing recognisable found; read the route before trusting it.");
  L.push("");
  L.push("The real guards are the ratchet tests `src/app/api/admin-client-ratchet.test.ts` (service-role routes) and");
  L.push("`src/app/api/role-gate-ratchet.test.ts` (mutating routes need a role gate).");
  L.push("");
  L.push("| Hint | Routes |");
  L.push("|---|---|");
  for (const k of Object.keys(counts).sort()) L.push(`| ${cell(k)} | ${counts[k]} |`);
  L.push("");
  L.push("## Groups");
  L.push("");
  L.push(names.map((n) => `[${n}](#${n.replace(/[^a-z0-9-]/gi, "").toLowerCase()}) (${groups.get(n).length})`).join(" · "));
  for (const n of names) {
    L.push("");
    L.push(`## ${n}`);
    L.push("");
    L.push("| Path | Methods | Who may call | File |");
    L.push("|---|---|---|---|");
    for (const r of groups.get(n)) {
      L.push(`| \`${cell(r.url)}\` | ${r.methods.join(", ") || "?"} | ${cell(r.auth)} | [${cell(r.file)}](../production/src/app/${encodeURI(r.file)}) |`);
    }
  }
  L.push("");
  return L.join("\n");
}

/** CLI. Returns the exit code. */
export function main(argv = process.argv.slice(2), { appDir = APP_DIR, docFile = DOC_FILE, log = console.log } = {}) {
  const check = argv.includes("--check");
  const text = renderApiDoc(collectRoutes(appDir));
  const current = fs.existsSync(docFile) ? fs.readFileSync(docFile, "utf8").replace(/\r\n/g, "\n") : null;
  if (check) {
    if (current === text) {
      log("docs/API.md is up to date.");
      return 0;
    }
    log("docs/API.md is stale — run: cd production && node scripts/ops/gen-api-doc.mjs");
    return 1;
  }
  if (current === text) {
    log("docs/API.md unchanged.");
    return 0;
  }
  fs.writeFileSync(docFile, text);
  log(`docs/API.md written (${text.split("\n").length} lines).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
