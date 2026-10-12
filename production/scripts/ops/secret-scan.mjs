/**
 * Secret / client-data scan (R-1430, 12 Oct 2026). The repo is PUBLIC: one pasted key, tenant id
 * or client record leaks the moment it is pushed. This runs in the worker push guard
 * (worker-lock.mjs push, diff mode) and in CI (`checks` job).
 *
 *   node scripts/ops/secret-scan.mjs --diff <base>   only lines ADDED since merge-base(<base>, HEAD)
 *   node scripts/ops/secret-scan.mjs --full          every tracked file (git ls-files)
 *   node scripts/ops/secret-scan.mjs --paths a b     just these files (handy for a quick check)
 *   add --fingerprints to print each hit's fingerprint (for an allowlist entry; local use only)
 *
 * Output is `file:line  rule` ONLY — the matched value is never printed, not even in part.
 * Exit 1 on any hit, 0 when clean, 2 on a usage/git error.
 *
 * False positive? Add an entry to scripts/ops/secret-scan.allow.json — {path?, rule?, fingerprint?,
 * reason}. Every given field must match; `reason` is required. Prefer a fingerprint over a path.
 *
 * Client-specific terms (customer names, real tenant ids) are NOT written in this public repo.
 * They come from SECRET_SCAN_DENY_TERMS (comma/newline separated; a CI secret) and/or the file in
 * SECRET_SCAN_DENY_FILE (default ~/.secret-scan-deny.txt, one term per line, # comments). Matched
 * case-insensitively; reported as `deny-term`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Literal fragments are split / quantified so this file never matches its own rules.
const DASH5 = "-{5}";

/** Content rules. `check(match)` → false drops the match (placeholder, words, not random). */
export const RULES = [
  { id: "private-key", re: new RegExp(`${DASH5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY${DASH5}`, "g") },
  { id: "gcp-service-account", re: /"private_key"\s*:\s*"-{5}BEGIN/g },
  { id: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: "oauth-client-secret", re: /\bGOCSPX-[0-9A-Za-z_-]{20,}/g, check: (v) => looksRandom(v.slice(7), 3.0) },
  { id: "github-token", re: /\b(?:gh[pousr]_[0-9A-Za-z]{36,}|github_pat_[0-9A-Za-z_]{40,})/g, check: (v) => looksRandom(v.replace(/^\w+?_/, ""), 3.0) },
  { id: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, check: (v) => !/(.)\1{7}/.test(v) && !/EXAMPLE$/.test(v) },
  { id: "razorpay-live-key", re: /\brzp_live_[0-9A-Za-z]{10,}/g, check: (v) => looksRandom(v.slice(9), 2.5) },
  { id: "resend-key", re: /\bre_[0-9A-Za-z]{8}_[0-9A-Za-z]{20,}\b/g, check: (v) => looksRandom(v.slice(3), 3.0) },
  { id: "sk-key", re: /\bsk(?:-proj|-ant-[a-z0-9]+|_live|-live)?[-_][0-9A-Za-z_-]{24,}/g, check: (v) => looksRandom(v.replace(/^sk[-_](?:proj|ant-[a-z0-9]+|live)?[-_]?/, ""), 3.5) },
  { id: "jwt", re: /\beyJ[0-9A-Za-z_-]{8,}\.eyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/g },
  { id: "db-url-password", re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/'"`]+:([^\s@/'"`]+)@/g, value: 1, check: (v) => !isPlaceholder(v) && v.length >= 8 },
  {
    id: "generic-secret",
    // NAME = "value" / NAME: 'value' — NAME contains SECRET/TOKEN/PASSWORD/API_KEY. Only the value is judged.
    re: /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["'`]([A-Za-z0-9+/_\-=.~]{16,})["'`]/gi,
    value: 1,
    check: (v) => !isPlaceholder(v) && looksRandom(v, 3.5) && /\d/.test(v) && /[A-Za-z]/.test(v),
  },
  { id: "personal-email", re: /\b[A-Za-z0-9._%+-]+@(?:gmail|googlemail|yahoo|ymail|hotmail|outlook|live|icloud|me|rediffmail|protonmail|proton|aol|zoho)\.(?:com|co\.in|in|me)\b/gi, pii: true, check: (v) => !isFakeEmail(v) },
  { id: "phone", re: /(?<![\d.\w])(?:\+91[\s-]?|91[\s-]|0)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])/g, pii: true, check: (v) => !isFakePhone(v) },
];

/** Paths whose PII rules are off (fixtures and tests are meant to hold fake people). */
export const FIXTURE_PATH = /(^|\/)(tests?|__tests__|e2e|fixtures?|__fixtures__|__mocks__|seed|seeds|mocks?)(\/|$)|\.(test|spec|stories)\.[a-z]+$|(^|\/)seed[^/]*\.(sql|ts|mjs|js)$/i;

/** Never content-scanned: generated / vendored / lock files. */
const SKIP_PATH = /(^|\/)(node_modules|\.next|dist|build|coverage|playwright-report|test-results|\.git)\/|(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|next-env\.d\.ts)$|\.min\.(js|css)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|br|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|webm|wav|ogg|exe|dll|so|dylib|wasm|jar|class|bin|db|sqlite|psd|ai|xlsx?|docx?|pptx?)$/i;
const MAX_BYTES = 1_500_000;

/** Committed secret FILES: .env*, keys, keystores. Templates (.env.example etc.) are fine. */
export function fileNameRule(p) {
  const base = String(p).split("/").pop() ?? "";
  if (/^\.env(\..+)?$/i.test(base) && !/\.(example|sample|template|dist|defaults?)$/i.test(base) && !/^\.env\.(example|sample|template)\b/i.test(base)) return "env-file";
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(base) || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(base)) return "key-file";
  if (/service[-_]?account.*\.json$/i.test(base) || /^credentials\.json$/i.test(base)) return "credentials-file";
  return null;
}

export function entropy(s) {
  const m = new Map();
  for (const c of s) m.set(c, (m.get(c) ?? 0) + 1);
  let e = 0;
  for (const n of m.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

/** Random-looking: enough entropy, not plain words like live-auth-secret, not a repeated char. */
export function looksRandom(v, minEntropy = 3.5) {
  if (!v || v.length < 8) return false;
  if (/^[a-z]+([-_.][a-z]+)*$/.test(v) || /^[A-Z]+([-_.][A-Z]+)*$/.test(v)) return false; // words / ENV_NAMES
  if (/(.)\1{5,}/.test(v)) return false; // xxxxxx, 000000 placeholders
  return entropy(v) >= minEntropy;
}

export function isPlaceholder(v) {
  return /^(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|<[^>]*>|\{\{.*\}\}|\*+|x+|X+|\.+|password|postgres|pass|secret|changeme|change[-_]?me|example|test|testing|dev|local|admin|root)$/i.test(v)
    || /(placeholder|your[-_]|example|dummy|redacted|changeme|xxxx)/i.test(v);
}

export function isFakeEmail(v) {
  return /(^|[._-])(test|example|demo|dummy|fake|sample|noreply|no-reply|someone|user|name|abc|xyz|you|your|yourname|mailer-daemon|postmaster)[0-9]*([._+-]|@)/i.test(v);
}

export function isFakePhone(v) {
  const d = v.replace(/\D/g, "").slice(-10);
  if (/(\d)\1{5,}/.test(d)) return true; // 9999999999, 9800000000
  if (/0123456789|1234567890|9876543210|987654321|123456789/.test(d)) return true;
  if (/^(\d\d)\1{4}$/.test(d) || /^(\d{5})\1$/.test(d)) return true; // 9898989898, 9876598765
  return false;
}

/** Short, non-reversible id for one hit, used by allowlist entries. Value itself is never stored. */
export function fingerprint(rule, value) {
  return crypto.createHash("sha256").update(`${rule}\u0000${value}`).digest("hex").slice(0, 16);
}

/** Deny terms: env SECRET_SCAN_DENY_TERMS + file SECRET_SCAN_DENY_FILE (default ~/.secret-scan-deny.txt). */
export function loadDenyTerms(env = process.env) {
  const out = [];
  if (env.SECRET_SCAN_DENY_TERMS) out.push(...env.SECRET_SCAN_DENY_TERMS.split(/[,\n]/));
  const f = env.SECRET_SCAN_DENY_FILE || path.join(os.homedir(), ".secret-scan-deny.txt");
  try { out.push(...fs.readFileSync(f, "utf8").split(/\r?\n/).filter((l) => !l.trim().startsWith("#"))); } catch { /* optional */ }
  return [...new Set(out.map((t) => t.trim().toLowerCase()).filter((t) => t.length >= 4))];
}

/**
 * Hits in one file's lines. `lines` = [{ n, text }] (diff mode passes only added lines).
 * Returns [{ path, line, rule, fp }] — never the value.
 */
export function scanLines(p, lines, { denyTerms = [] } = {}) {
  const hits = [];
  const fixture = FIXTURE_PATH.test(p);
  for (const { n, text } of lines) {
    if (text.length > 5000) continue; // minified / data blobs
    for (const r of RULES) {
      if (r.pii && fixture) continue;
      r.re.lastIndex = 0;
      for (const m of text.matchAll(r.re)) {
        const v = r.value ? m[r.value] : m[0];
        if (r.check && !r.check(v)) continue;
        hits.push({ path: p, line: n, rule: r.id, fp: fingerprint(r.id, v) });
      }
    }
    if (denyTerms.length) {
      const low = text.toLowerCase();
      for (const t of denyTerms) if (low.includes(t)) hits.push({ path: p, line: n, rule: "deny-term", fp: fingerprint("deny-term", t) });
    }
  }
  return hits;
}

export function scanText(p, text, opts) {
  return scanLines(p, String(text).split(/\r?\n/).map((t, i) => ({ n: i + 1, text: t })), opts);
}

function globToRe(g) {
  const s = String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\/?/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
  return new RegExp(`^${s}$`);
}

/** Allowlist entries: {path?, rule?, fingerprint?, reason}. Throws on an entry without a reason. */
export function loadAllowlist(file) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return []; throw e; }
  const entries = Array.isArray(raw) ? raw : raw.entries ?? [];
  return entries.map((e, i) => {
    if (!e || typeof e.reason !== "string" || e.reason.trim().length < 5) throw new Error(`secret-scan.allow.json entry ${i}: "reason" is required`);
    if (!e.path && !e.fingerprint) throw new Error(`secret-scan.allow.json entry ${i}: needs "path" or "fingerprint"`);
    return { ...e, _re: e.path ? globToRe(e.path) : null };
  });
}

export function isAllowed(hit, allow) {
  return allow.some((e) => (!e._re || e._re.test(hit.path)) && (!e.rule || e.rule === hit.rule) && (!e.fingerprint || e.fingerprint === hit.fp));
}

/** `git diff -U0` text → { path: [{n, text}] } of ADDED lines (new-file numbering). */
export function parseDiff(diff) {
  const out = {};
  let cur = null, n = 0;
  for (const l of String(diff).split("\n")) {
    if (l.startsWith("+++ ")) { const p = l.slice(4).replace(/^b\//, "").replace(/\t.*$/, ""); cur = p === "/dev/null" ? null : p; if (cur) out[cur] ??= []; continue; }
    if (l.startsWith("@@")) { const m = l.match(/\+(\d+)/); n = m ? Number(m[1]) : 0; continue; }
    if (!cur || l.startsWith("--- ") || l.startsWith("diff ") || l.startsWith("index ")) continue;
    if (l.startsWith("+")) { out[cur].push({ n, text: l.slice(1).replace(/\r$/, "") }); n++; }
    else if (l.startsWith(" ")) n++;
  }
  return out;
}

export function formatHits(hits, { fingerprints = false } = {}) {
  return hits.map((h) => `${h.path}:${h.line}  ${h.rule}${fingerprints ? `  fp=${h.fp}` : ""}`);
}

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

function readable(abs, p) {
  if (SKIP_PATH.test(p) || BINARY_EXT.test(p)) return null;
  let st; try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8000).includes(0)) return null;
  return buf.toString("utf8");
}

export function run(argv, { cwd = process.cwd(), env = process.env, log = console.log, err = console.error } = {}) {
  const fps = argv.includes("--fingerprints");
  const args = argv.filter((a) => a !== "--fingerprints");
  const mode = args[0];
  let root;
  try { root = git(["rev-parse", "--show-toplevel"], cwd).trim(); } catch { root = cwd; }
  const allowFile = env.SECRET_SCAN_ALLOW || path.join(root, "production/scripts/ops/secret-scan.allow.json");
  let allow;
  try { allow = loadAllowlist(allowFile); } catch (e) { err(`secret-scan: ${e.message}`); return 2; }
  const full = mode === "--full" || (mode === "--diff" && (!args[1] || /^0+$/.test(args[1])));
  /* Deny terms judge NEW lines (diff / paths). Older docs in the tree still name clients; a full scan
     applies the terms only with SECRET_SCAN_DENY_FULL=1 (a cleanup audit), so new branches stay green. */
  const opts = { denyTerms: full && env.SECRET_SCAN_DENY_FULL !== "1" ? [] : loadDenyTerms(env) };
  const hits = [];
  const nameHit = (p) => { const r = fileNameRule(p); if (r) hits.push({ path: p, line: 0, rule: r, fp: fingerprint(r, p) }); };

  if (full) {
    if (mode === "--diff") log("secret-scan: no base (new branch) — scanning the full tree");
    const files = git(["ls-files", "-z"], root).split("\0").filter(Boolean);
    for (const p of files) { nameHit(p); const t = readable(path.join(root, p), p); if (t != null) hits.push(...scanText(p, t, opts)); }
  } else if (mode === "--diff") {
    let base = args[1], diff;
    try { base = git(["merge-base", base, "HEAD"], root).trim(); } catch { /* not an ancestor (force push) — diff against it directly */ }
    try { diff = git(["diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=ACMR", base, "HEAD"], root); }
    catch { log(`secret-scan: base ${args[1]} not found — scanning the full tree`); return run(["--full", ...(fps ? ["--fingerprints"] : [])], { cwd, env, log, err }); }
    for (const [p, lines] of Object.entries(parseDiff(diff))) {
      nameHit(p);
      if (SKIP_PATH.test(p) || BINARY_EXT.test(p)) continue;
      hits.push(...scanLines(p, lines, opts));
    }
  } else if (mode === "--paths" && args.length > 1) {
    for (const p of args.slice(1)) {
      const abs = path.resolve(cwd, p);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      nameHit(rel);
      const t = readable(abs, rel);
      if (t != null) hits.push(...scanText(rel, t, opts));
    }
  } else {
    err("usage: secret-scan.mjs --diff <base> | --full | --paths <file>... [--fingerprints]");
    return 2;
  }

  const bad = hits.filter((h) => !isAllowed(h, allow));
  if (!bad.length) { log(`✓ secret-scan: clean (${hits.length - bad.length} allowlisted)`); return 0; }
  for (const line of formatHits(bad, { fingerprints: fps })) err(line);
  const counts = {};
  for (const h of bad) counts[h.rule] = (counts[h.rule] ?? 0) + 1;
  err(`✗ secret-scan: ${bad.length} hit(s) — ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  err("  Remove the value (use an env var / secret manager). If it is a real secret that was ever pushed: ROTATE it.");
  err("  False positive: add {fingerprint|path, rule, reason} to production/scripts/ops/secret-scan.allow.json (get fp with --fingerprints, locally).");
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(run(process.argv.slice(2)));
}
