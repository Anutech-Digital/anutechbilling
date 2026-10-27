import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs ops script, no types
import { runRelatedSql, notProvenHelp } from "../scripts/ops/worker-lock-sql.mjs";

/**
 * R-1955 (26 Oct 2026): worker-lock's related-SQL gate tells "this push broke the test" from "the
 * local DB was already broken" by running the test WITHOUT the card's migrations. When the card's
 * migration is already on the local DB (deploy-peek true — R-1952's case) that compare cannot be
 * made, so the gate must never claim it: such a red is "not proven" — it blocks with the way out,
 * and is logged. A fake psql plays the local DB: `applied` = migration files whose peek is true,
 * `red(script)` decides whether a test script fails.
 */
type Mig = { file: string; src: string };
const A: Mig = { file: "20261026100000_r1952_a.sql", src: "-- deploy-peek: exists(select 1 from pg_proc where proname = 'book_expense')\nbegin;\ncreate or replace function public.book_expense(p uuid) returns void language plpgsql as $$ begin null; end $$;\ncommit;\n" };
const B: Mig = { file: "20261026100100_r1952_b.sql", src: "-- deploy-peek: to_regclass('public.vendor_notes') is not null\ncreate table if not exists public.vendor_notes (id uuid);\n" };
const NO_PEEK: Mig = { file: "20261026100200_r1952_c.sql", src: "create or replace function public.book_expense(p uuid) returns void language sql as $$ select $$;\n" };
const T = (file: string, body: string) => ({ file, src: `begin;\n${body}\nrollback;\n` });
const TEST = T("book_expense.test.sql", "select public.book_expense(null); select * from vendor_notes;");

function fakeDb(applied: string[], red: (script: string) => boolean) {
  const scripts: string[] = [];
  const psql = (sql: string) => {
    if (sql.includes("PEEK_APPLIED")) {
      const on = (applied.includes(A.file) && sql.includes("book_expense")) || (applied.includes(B.file) && sql.includes("vendor_notes"));
      return { status: 0, out: on ? "PEEK_APPLIED\n" : "PEEK_PENDING\n" };
    }
    scripts.push(sql);
    return red(sql) ? { status: 3, out: 'ERROR:  duplicate key value violates unique constraint "tenants_pkey"' } : { status: 0, out: "" };
  };
  return { psql, scripts };
}

describe("R-1955: related SQL gate never claims a before/after proof it did not make", () => {
  it("R-1952's case: migration already on the local DB + red test → NOT PROVEN, blocks, says the way out", () => {
    const db = fakeDb([A.file], () => true);
    const r = runRelatedSql({ changed: [A], tests: [TEST], psql: db.psql });
    expect(r.ok).toBe(false);
    expect(r.notProven).toEqual(["book_expense.test.sql"]);
    expect(r.applied).toEqual([A.file]);
    expect(r.ran[0]).toMatchObject({ ok: false, notProven: true });
    /* never called old local breakage — that would be a proof we never made */
    expect(r.message).not.toContain("is push ki nahi");
    expect(r.message).toContain("? book_expense.test.sql: laal — PROOF NAHI BANA");
    expect(r.message).toContain("npx supabase db reset");
    expect(r.message).toContain("--skip-related-sql");
    /* the test ran once, on top of the applied migration, which is not run again */
    expect(db.scripts).toHaveLength(1);
    expect(db.scripts[0]).not.toContain("create or replace function");
  });

  it("migration applied + test green → passes, but says the test ran on the applied migration (not silent)", () => {
    const r = runRelatedSql({ changed: [A], tests: [TEST], psql: fakeDb([A.file], () => false).psql });
    expect(r.ok).toBe(true);
    expect(r.notProven).toEqual([]);
    expect(r.message).toMatch(/^✓ .*1\/1 hare; 1 migration local DB par pehle se lagi \(20261026100000_r1952_a\.sql\)/);
    expect(r.message).toContain('"migration ke bina" compare nahi');
  });

  it("one applied, one pending; red with AND without the pending one → NOT PROVEN (the applied one may be the cause)", () => {
    const r = runRelatedSql({ changed: [A, B], tests: [TEST], psql: fakeDb([A.file], () => true).psql });
    expect(r.ok).toBe(false);
    expect(r.notProven).toEqual(["book_expense.test.sql"]);
    expect(r.message).not.toContain("is push ki nahi");
  });

  it("one applied, one pending; green once the pending one is left out → a PROVEN red of this push", () => {
    const db = fakeDb([A.file], (s) => s.includes("create table if not exists public.vendor_notes"));
    const r = runRelatedSql({ changed: [A, B], tests: [TEST], psql: db.psql });
    expect(r.ok).toBe(false);
    expect(r.notProven).toEqual([]);
    expect(r.ran[0]).toMatchObject({ ok: false });
    expect(r.ran[0].notProven).toBeUndefined();
    expect(r.message).toContain("✗ book_expense.test.sql: ERROR:");
    expect(r.message).not.toContain("PROOF NAHI BANA");
    expect(db.scripts[0]).toContain("create table if not exists public.vendor_notes");
    expect(db.scripts[0]).not.toContain("create or replace function public.book_expense"); // A is applied, not re-run
  });

  it("nothing applied, red with AND without → old local breakage, warn only (R-1936 behaviour kept)", () => {
    const r = runRelatedSql({ changed: [A, B], tests: [TEST], psql: fakeDb([], () => true).psql });
    expect(r.ok).toBe(true);
    expect(r.ran[0]).toMatchObject({ ok: true, localRed: true });
    expect(r.message).toContain("⚠ book_expense.test.sql: migration ke bina bhi local DB par laal");
  });

  it("a migration with no deploy-peek is run again inside the transaction, so the compare stays a real one", () => {
    const db = fakeDb([], () => true);
    const r = runRelatedSql({ changed: [NO_PEEK], tests: [TEST], psql: db.psql });
    expect(r.ok).toBe(true);
    expect(r.ran[0]).toMatchObject({ localRed: true });
    expect(db.scripts[0]).toContain("create or replace function public.book_expense");
    expect(db.scripts[1]).not.toContain("create or replace function public.book_expense");
  });

  it("the help names the applied migration and both ways on", () => {
    const h = notProvenHelp("x.sql");
    expect(h).toContain("migration (x.sql) local DB par pehle se lagi hai");
    expect(h).toContain("anutech/manager-pardeep");
    expect(h).toContain("Pardeep");
  });
});

describe("R-1955: worker-lock logs every not-proven red and blocks with exit 5", () => {
  it("logNotProven writes one line to _ci-gate.log; a proven result writes nothing", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "r1955-"));
    const prev = process.env.WORKER_LOCK_DIR;
    process.env.WORKER_LOCK_DIR = dir;
    try {
      // @ts-expect-error — plain .mjs ops script, no types
      const wl = await import("../scripts/ops/worker-lock.mjs?r1955");
      wl.logNotProven("R-2000", { notProven: [], applied: [] });
      expect(existsSync(path.join(dir, "_ci-gate.log"))).toBe(false);
      wl.logNotProven("R-2000", { notProven: ["book_expense.test.sql"], applied: [A.file] });
      const line = JSON.parse(readFileSync(path.join(dir, "_ci-gate.log"), "utf8").trim());
      expect(line).toMatchObject({ card: "R-2000", how: "related-sql-not-proven", tests: ["book_expense.test.sql"], applied: [A.file] });
    } finally {
      if (prev === undefined) delete process.env.WORKER_LOCK_DIR; else process.env.WORKER_LOCK_DIR = prev;
    }
  });

  it("the push gate and sql-related log it before refusing", () => {
    const src = readFileSync(path.join(__dirname, "..", "scripts", "ops", "worker-lock.mjs"), "utf8");
    const gate = src.slice(src.indexOf("function relatedSqlGate"), src.indexOf("function logNotProven"));
    expect(gate.indexOf("logNotProven(card, r)")).toBeGreaterThan(0);
    expect(gate.indexOf("logNotProven(card, r)")).toBeLessThan(gate.indexOf("process.exit(5)"));
    const cli = src.slice(src.indexOf('cmd === "sql-related"'));
    expect(cli.indexOf("logNotProven(card, r)")).toBeGreaterThan(0);
    expect(cli.indexOf("logNotProven(card, r)")).toBeLessThan(cli.indexOf("process.exit(5)"));
  });
});
