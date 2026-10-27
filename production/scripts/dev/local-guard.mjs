/**
 * local-guard.mjs — the refusals shared by the LOCAL tester scripts (R-878).
 *
 *   scripts/dev/local-login-link.mjs   one-time login link for an @example.test user
 *   scripts/dev/seed-e2e-catalog.mjs   products + vendors for "E2E Test Co"
 *
 * Both only ever talk to the local Supabase stack on this laptop (`npx supabase start`). Every
 * check here returns a REASON string when it refuses and null when it is fine, so the scripts
 * can print why and the tests can pin each refusal. Hard-coded on purpose: there is no env var
 * or flag that lets these scripts reach staging or live.
 *
 * Nothing in this file reads or prints a key.
 */
import { spawnSync } from "node:child_process";

/** Hosts a local database / Supabase API may live on (Docker publishes the stack on these). */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/** Hostname of a URL ("postgresql://u:p@127.0.0.1:54322/postgres", "http://127.0.0.1:54321"). */
function urlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Why `url` (a Postgres URL or the Supabase API URL) is NOT the local stack, or null when it is.
 * @param {string | undefined | null} url
 */
export function dbUrlLocalReason(url) {
  if (!url || !String(url).trim()) return "no database URL — start the local stack (npx supabase start)";
  const host = urlHost(String(url).trim());
  if (!host) return "the database URL could not be parsed — refusing rather than guessing";
  if (!LOCAL_DB_HOSTS.has(host)) return `database host "${host}" is not local (localhost / 127.0.0.1 / Docker host only)`;
  return null;
}

/**
 * Why `host` ("localhost:3008", "tester1.localhost:3008") is not a local app host, or null.
 * *.localhost always resolves to this machine and gives each tester its own cookie jar.
 * @param {string | undefined | null} host
 */
export function appHostLocalReason(host) {
  const h = String(host ?? "").trim().toLowerCase();
  if (!h) return "no app host given";
  if (/[/@?#\s]/.test(h)) return `"${h}" is not a bare host[:port]`;
  const m = /^((?:[a-z0-9-]+\.)*localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/.exec(h);
  if (!m) return `app host "${h}" is not local (localhost, 127.0.0.1 or *.localhost only)`;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return `port ${m[2]} is out of range`;
  return null;
}

/**
 * Why `email` is not a test address, or null. Only @example.test: the .test TLD can never be
 * a real person's mailbox, so a link can never be made for a real account.
 * @param {string | undefined | null} email
 */
export function testEmailReason(email) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e) return "no email given";
  if (!/^[a-z0-9._+-]+@example\.test$/.test(e)) return `"${e}" is not an @example.test address — real accounts are refused`;
  return null;
}

/** A path inside the app ("/dashboard"), never another site. */
export function safeNextPath(next) {
  const n = String(next ?? "").trim();
  if (!n.startsWith("/") || n.startsWith("//") || n.includes("\\") || /[\s]/.test(n)) return "/dashboard";
  return n;
}

/**
 * The one-time link the app's local-only route turns into a session.
 * @param {{ host: string, tokenHash: string, email: string, next?: string }} p
 */
export function buildLoginLink({ host, tokenHash, email, next }) {
  const scheme = "http"; // local dev servers are plain http
  const u = new URL(`${scheme}://${host}/api/dev/login-link`);
  u.searchParams.set("token_hash", tokenHash);
  u.searchParams.set("email", email.trim().toLowerCase());
  u.searchParams.set("next", safeNextPath(next));
  return u.toString();
}

/** Parse `<email> [--host h] [--next /path]`. */
export function parseLoginLinkArgs(argv) {
  const out = { email: undefined, host: "localhost:3001", next: "/dashboard" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--host") out.host = argv[++i];
    else if (a === "--next") out.next = argv[++i];
    else if (!a.startsWith("--") && out.email === undefined) out.email = a;
  }
  return out;
}

/** API_URL + SERVICE_ROLE_KEY + DB_URL out of `supabase status -o env` text. */
export function parseSupabaseStatus(text) {
  const get = (k) => new RegExp(`^${k}="?([^"\\r\\n]+)"?`, "m").exec(text ?? "")?.[1];
  return { url: get("API_URL"), service: get("SERVICE_ROLE_KEY"), dbUrl: get("DB_URL") };
}

/**
 * Local Supabase API URL + service key: env (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) when
 * both are set, else `npx supabase status -o env` from `cwd`. Refuses anything not local.
 * The key is returned to the caller for its client only — never printed.
 * @returns {{ url: string, service: string } | { reason: string }}
 */
export function localSupabase(cwd, env = process.env) {
  let url = env.SUPABASE_URL;
  let service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !service) {
    const r = spawnSync("npx supabase status -o env", {
      cwd, encoding: "utf8", shell: process.platform === "win32",
    });
    const s = parseSupabaseStatus(`${r.stdout ?? ""}`);
    url = s.url;
    service = s.service;
    if (!url || !service) return { reason: "local Supabase not found — run `npx supabase start` first (Docker)" };
  }
  const why = dbUrlLocalReason(url);
  if (why) return { reason: why };
  return { url, service };
}

/* ── R-1957: test scenarios (scripts/dev/scenario.mjs) ──────────────────────────────────────── */

/** The local Supabase DB container `npx supabase start` runs ("supabase_db_resellerosv3"). */
const LOCAL_DB_CONTAINER = /^supabase_db_[A-Za-z0-9_-]+$/;

/**
 * Why scenario data must NOT be written, or null when the target is this laptop's docker DB.
 * Refuses: NODE_ENV=production; no / not-a-Supabase-DB container; and any database or Supabase
 * URL in the env (or production/.env.local) that is not local — then the app on localhost:3001
 * would not be reading the docker DB, so loading test data there is pointless at best.
 * Hard-coded: no flag or env var turns a refusal off.
 * @param {{ nodeEnv?: string | null, container?: string | null, urls?: Array<string | null | undefined> }} p
 */
export function scenarioTargetReason({ nodeEnv, container, urls = [] } = {}) {
  if (String(nodeEnv ?? "").trim().toLowerCase() === "production") {
    return "NODE_ENV is production — scenarios are local test data only";
  }
  if (!container || !String(container).trim()) {
    return "no local Supabase DB container (supabase_db_*) is running — start it with `npx supabase start`";
  }
  if (!LOCAL_DB_CONTAINER.test(String(container).trim())) {
    return `container "${container}" is not a local Supabase DB (supabase_db_* only)`;
  }
  for (const u of urls) {
    if (u == null || !String(u).trim()) continue;
    const why = dbUrlLocalReason(u);
    if (why) return `${why} — the app is not on the local DB, refusing`;
  }
  return null;
}
