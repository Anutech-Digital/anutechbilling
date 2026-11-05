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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dbUrlLocalReason } from "./local-guard.mjs";

/** A Supabase project ref: 20 lowercase letters/digits. */
const PROJECT_REF = /^[a-z0-9]{20}$/;

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
    if (String(env.CI ?? "").trim() && String(env.CI).toLowerCase() !== "false") {
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
  try {
    const p = join(tmp, "project-ref");
    if (existsSync(p)) { const r = readFileSync(p, "utf8").trim(); if (r) return r; }
    const j = join(tmp, "linked-project.json");
    if (existsSync(j)) { const r = JSON.parse(readFileSync(j, "utf8"))?.ref; if (typeof r === "string" && r.trim()) return r.trim(); }
  } catch { /* unreadable → not linked */ }
  return null;
}

/** Why a remote run on `ref` must not go ahead given the linked ref, or null. */
export function linkedRefReason(ref, linkedRef) {
  if (!linkedRef) return `no linked Supabase project here (supabase/.temp) — refusing --remote ${ref}`;
  if (linkedRef !== ref) return `the linked project is ${linkedRef}, not ${ref} — refusing`;
  return null;
}
