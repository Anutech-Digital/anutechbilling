import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

// R-2357 (2 Nov 2026): the staging train's DB step (commit 11dc3606e) stopped SILENTLY at
// step 2 "What staging has now". peek() imports one SQL file that RAISEs 'PEEK …' and greps the
// PEEK line out of the operation. That day the import failed with a different error — R-2017's
// peek named storage.objects as text, and resellersos_migration has no USAGE on schema storage:
// "ERROR: permission denied for schema storage". No PEEK line → grep exit 1 → with
// `set -euo pipefail` the script died inside $(peek …) before its own "Could not read staging"
// line. Only the backup had run.
//
// 1. peek() + step 2, cut from each real deploy script and run with a fake gcloud: an import
//    error must reach the screen with "Could not read <env> — nothing changed" (red on the old
//    peek(), which exits 1 with an empty screen).
// 2. no deploy-peek may name a storage-schema object as text (to_regclass('storage.x'),
//    has_table_privilege(…, 'storage.x', …)) — look it up by OID through pg_class/pg_namespace.
// 3. the SQL test's PEEK_NEW line is the migration's own header (so the SQL proof is about the
//    peek that ships).

const APP = path.resolve(__dirname, "..");
const script = (env: string) => path.join(APP, "supabase", "cloudsql", env, "deploy-db-2026-10-07.sh");

const BASH =
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\Git\\usr\\bin\\bash.exe"].find((p) => fs.existsSync(p)) ?? null
    : spawnSync("bash", ["--version"]).status === 0
      ? "bash"
      : null;

/** peek(), is_true() and the step-2 lines, exactly as the script has them. */
function stepTwo(env: string): string {
  const src = fs.readFileSync(script(env), "utf8").replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith("peek() {"));
  const end = lines.findIndex((l, i) => i > start && l === "}");
  expect(start, `${env}: peek() not found`).toBeGreaterThan(-1);
  const isTrue = lines.find((l) => l.startsWith("is_true() {"));
  const s2 = lines.findIndex((l) => l.startsWith('BEFORE="$(peek '));
  expect(isTrue && s2 > -1, `${env}: step 2 not found`).toBeTruthy();
  return [...lines.slice(start, end + 1), isTrue!, ...lines.slice(s2, s2 + 3)].join("\n");
}

function run(env: string, operationsJson: string) {
  const fake = [
    "set -euo pipefail",
    'P=proj; I=inst; DB=db; B=gs://bucket; TMP=/nonexistent',
    // fake gcloud: cp + import succeed quietly (the import "fails" on purpose in real life), operations prints $OPS
    'gcloud() { case "$1 $2" in "sql operations") printf "%s\\n" "$OPS";; *) return 0;; esac; }',
    stepTwo(env),
    'echo "REACHED-AFTER-STEP-2"',
  ].join("\n");
  const r = spawnSync(BASH!, ["-s"], { input: fake, encoding: "utf8", env: { ...process.env, OPS: operationsJson } });
  return { status: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const PERMISSION_ERROR = JSON.stringify(
  [{ operationType: "IMPORT", status: "DONE", error: { errors: [{ code: "ERROR_OTHER", message: "ERROR: permission denied for schema storage" }] } }],
  null,
  2,
);
const PEEK_OK = JSON.stringify(
  [{ operationType: "IMPORT", status: "DONE", error: { errors: [{ code: "ERROR_OTHER", message: "ERROR: PEEK a=true cuid=true\nCONTEXT: PL/pgSQL function inline_code_block" }] } }],
  null,
  2,
);

describe.skipIf(!BASH)("R-2357 deploy-db peek(): an import error is shown, never a silent exit", () => {
  for (const env of ["staging", "live"]) {
    it(`${env}: no PEEK line → the import's error + "Could not read ${env} — nothing changed"`, () => {
      const r = run(env, PERMISSION_ERROR);
      expect(r.status).toBe(1);
      expect(r.out).toContain(`Could not read ${env} — nothing changed`);
      expect(r.err).toContain("permission denied for schema storage");
      expect(r.out).not.toContain("REACHED-AFTER-STEP-2");
    });
    it(`${env}: a PEEK line is printed and the script goes on`, () => {
      const r = run(env, PEEK_OK);
      expect(r.status, r.err).toBe(0);
      expect(r.out).toContain("PEEK a=true cuid=true");
      expect(r.out).toContain("REACHED-AFTER-STEP-2");
    });
  }
});

describe("R-2357 deploy-peeks never need USAGE on schema storage", () => {
  const peeks = fs.readFileSync(path.join(APP, "src", "server", "migrations-health", "peeks.generated.ts"), "utf8");
  it("no peek names a storage.* object as text (resellersos_migration has no USAGE there)", () => {
    const bad = peeks.split("\n").filter((l) => /'storage\.[a-z_]/i.test(l));
    expect(bad).toEqual([]);
  });
  it("the SQL test proves the peek that ships (PEEK_NEW = the migration's header)", () => {
    const mig = fs.readFileSync(path.join(APP, "supabase", "migrations", "20261101211500_r2017_storage_anon_grants.sql"), "utf8");
    const header = /^-- deploy-peek: (.+)$/m.exec(mig)![1].trim();
    const test = fs.readFileSync(path.join(APP, "supabase", "tests", "r2357_storage_peek_no_usage.test.sql"), "utf8").replace(/\r\n/g, "\n");
    const lines = test.split("\n");
    const i = lines.indexOf("-- PEEK_NEW");
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1].trim()).toBe(header);
    expect(peeks).toContain(JSON.stringify(header));
  });
});
