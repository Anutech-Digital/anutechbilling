/**
 * sql-test-target.mjs — which database `scripts/test-sql.mjs` may run on (R-2493, 5 Nov 2026).
 *
 * 5 Nov night a worker ran `node scripts/test-sql.mjs` without `--local` and it started on the
 * LINKED Supabase project (staging) — the old default. Now:
 *   - no flag / `--local`            → the local docker DB (supabase_db_*). CI uses `--local`
 *                                      (`npm run test:sql:local`, its own throwaway stack).
 *   - `--db-url=<url>`               → psql on that URL, local hosts only (local-guard.mjs).
 *   - `--remote <ref>`               → the linked project, ONLY when TEST_SQL_REMOTE_OK=<same
 *                                      ref> is also set, not in CI, and supabase/.temp links
 *                                      exactly that ref. Workers never pass it (WORKER-STEPS).
 *   - anything else (`--linked`, `--project-ref`, a typo, two filters) → refused.
 * Every refusal happens before any connection. Pure functions; nothing here prints a key.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dbUrlLocalReason } from "./local-guard.mjs";

/** A Supabase project ref: 20 lowercase letters/digits. */
const PROJECT_REF = /^[a-z0-9]{20}$/;
/** --db-url hosts: this machine's loopback only. */
const DB_URL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * @param {string[]} argv  process.argv.slice(2)
 * @param {Record<string, string | undefined>} env
 * @returns {{ target: {kind:"local"} | {kind:"db-url", url:string} | {kind:"remote", ref:string} | null,
 *             only: string | null, reason: string | null }}
 */
export function resolveSqlTestTarget(argv, env = {}) {
  let local = false;
  let dbUrl = null;
  let remote = null; // undefined-able ref; "" when the flag had no value
  const filters = [];
  const out = (target, reason) => ({ target, only: filters[0] ?? null, reason });

  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--local") local = true;
    else if (a.startsWith("--db-url=")) dbUrl = a.slice("--db-url=".length);
    else if (a === "--remote") {
      const next = argv[i + 1];
      remote = next != null && !String(next).startsWith("-") ? String(argv[++i]) : "";
    } else if (a.startsWith("--remote=")) remote = a.slice("--remote=".length);
    else if (a.startsWith("-")) return out(null, `unknown flag "${a}" — only --local, --db-url=<local url> or --remote <ref> (with TEST_SQL_REMOTE_OK)`);
    else filters.push(a);
  }
  if (filters.length > 1) return out(null, `only one test-name filter allowed (got: ${filters.join(", ")})`);

  if (remote !== null) {
    if (local || dbUrl !== null) return out(null, "--remote cannot be mixed with --local / --db-url");
    if (!PROJECT_REF.test(remote)) return out(null, `--remote needs a Supabase project ref (20 lowercase letters/digits), got "${remote}"`);
    const target = { kind: "remote", ref: remote };
    if (!["", "0", "false", "no"].includes(String(env.CI ?? "").trim().toLowerCase())) {
      return out(target, "CI never runs SQL tests on a remote DB — CI uses its own local stack (--local)");
    }
    if (String(env.TEST_SQL_REMOTE_OK ?? "").trim() !== remote) {
      return out(target, `a remote run needs TEST_SQL_REMOTE_OK=${remote} as well (the same ref) — workers never run remote`);
    }
    return out(target, null);
  }

  if (dbUrl !== null) {
    const why = dbUrlLocalReason(dbUrl);
    if (why) return out(null, `--db-url: ${why}`);
    /* Stricter than local-guard: this machine's loopback only (as before R-2493) — never
       host.docker.internal, which inside a container can be another machine's DB. */
    if (!DB_URL_HOSTS.has(new URL(dbUrl.trim()).hostname.toLowerCase())) {
      return out(null, "--db-url: loopback only (localhost / 127.0.0.1 / ::1)");
    }
    return out({ kind: "db-url", url: dbUrl }, null);
  }
  return out({ kind: "local" }, null);
}

/** The first line test-sql.mjs prints — never a password. */
export function describeSqlTestTarget(target) {
  if (!target) return "target: (none — refused)";
  if (target.kind === "remote") return `target: REMOTE ${target.ref} (linked Supabase project)`;
  if (target.kind === "db-url") {
    let where = "?";
    try { const u = new URL(target.url); where = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname}`; } catch { /* keep "?" */ }
    return `target: local psql ${where}`;
  }
  return "target: local docker DB (supabase_db_*)";
}

/** The project ref supabase/.temp links under `dir` (project-ref wins), or null. */
export function readLinkedRef(dir) {
  const tmp = join(dir, "supabase", ".temp");
  try { const r = readFileSync(join(tmp, "project-ref"), "utf8").trim(); if (r) return r; } catch { /* missing → try the json */ }
  try {
    const r = JSON.parse(readFileSync(join(tmp, "linked-project.json"), "utf8"))?.ref;
    if (typeof r === "string" && r.trim()) return r.trim();
  } catch { /* missing / unreadable → not linked */ }
  return null;
}

/** Why a remote run on `ref` must not go ahead given the linked ref, or null. */
export function linkedRefReason(ref, linkedRef) {
  if (!linkedRef) return `no linked Supabase project here (supabase/.temp) — refusing --remote ${ref}`;
  if (linkedRef !== ref) return `the linked project is ${linkedRef}, not ${ref} — refusing`;
  return null;
}
