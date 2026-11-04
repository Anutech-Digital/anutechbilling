#!/usr/bin/env node
/**
 * R-2351 — seal the OAuth / provider tokens still stored as PLAINTEXT (see -lib.mjs for the rules).
 *
 * DRY RUN (default — counts only, writes nothing):
 *   node scripts/ops/reseal-oauth-tokens.mjs --db-url-env=DATABASE_URL
 * APPLY (a data repair — only with Pardeep's OK, dry run first):
 *   node scripts/ops/reseal-oauth-tokens.mjs --db-url-env=DATABASE_URL --apply --confirm=RESEAL [--batch=100]
 *
 * The connection string is read from the env variable named by --db-url-env (default
 * DATABASE_URL) and never printed; SECRETS_MASTER_KEY must be the key the app runs with.
 * Exit: 0 ok · 1 error · 2 refused · 3 wrong key (nothing written in 2/3).
 */
import pg from "pg";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { TARGETS, run, parseArgs, ResealRefused } from "./reseal-oauth-tokens-lib.mjs";

/** Identifiers only from the fixed TARGETS list — never from input. */
const ALLOWED = new Map(TARGETS.map((t) => [t.table, new Set([t.key, ...t.columns])]));
function ident(table, col) {
  if (!ALLOWED.get(table)?.has(col)) throw new Error(`not an allowed column: ${table}.${col}`);
  return `public."${table}"`;
}
const q = (c) => `"${c}"`;

export function pgAdapter(client) {
  return {
    async hasColumn(table, col) {
      const r = await client.query(
        "select 1 from information_schema.columns where table_schema = 'public' and table_name = $1 and column_name = $2",
        [table, col]);
      return r.rowCount > 0;
    },
    async counts(table, col) {
      const r = await client.query(
        `select count(*) filter (where ${q(col)} <> '')::int as total,
                count(*) filter (where ${q(col)} like 'rosv1:%')::int as sealed
           from ${ident(table, col)}`);
      return { total: r.rows[0].total, sealed: r.rows[0].sealed };
    },
    async sampleSealed(table, col, n) {
      const r = await client.query(`select ${q(col)} as v from ${ident(table, col)} where ${q(col)} like 'rosv1:%' limit $1`, [n]);
      return r.rows.map((x) => x.v);
    },
    async plainBatch(table, key, col, limit) {
      ident(table, key);
      const r = await client.query(
        `select ${q(key)}::text as id, ${q(col)} as value from ${ident(table, col)}
          where ${q(col)} <> '' and ${q(col)} not like 'rosv1:%' order by 1 limit $1`, [limit]);
      return r.rows;
    },
    async updateIf(table, key, col, id, old, next) {
      ident(table, key);
      const r = await client.query(
        `update ${ident(table, col)} set ${q(col)} = $1 where ${q(key)}::text = $2 and ${q(col)} = $3`, [next, String(id), old]);
      return r.rowCount === 1;
    },
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = process.env[a.dbUrlEnv];
  if (!url) { console.error(`${a.dbUrlEnv} is not set — nothing was read or written.`); return 2; }
  let where = "?";
  try { const u = new URL(url); where = `${u.hostname}/${u.pathname.slice(1)}`; } catch { /* unix socket form */ }
  console.log(`Database: ${where} (from ${a.dbUrlEnv})`);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run({ argv: process.argv.slice(2), env: process.env, db: pgAdapter(client), log: (s) => console.log(s) });
  } catch (e) {
    if (e instanceof ResealRefused) { console.error(e.message); return e.exitCode; }
    console.error(`Stopped: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`Stopped: ${e?.message ?? e}`); process.exit(1); });
}
