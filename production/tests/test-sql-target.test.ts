/**
 * R-2493 — the SQL test runner (scripts/test-sql.mjs) defaults to the LOCAL DB and refuses a
 * remote one unless it is asked for twice: `--remote <ref>` AND TEST_SQL_REMOTE_OK=<same ref>.
 *
 * 5 Nov 2026: a worker ran `node scripts/test-sql.mjs` without `--local` and it started on the
 * linked Supabase project (staging). These tests never reach a remote DB: the pure resolver is
 * tested directly, and the CLI is only spawned for REFUSALS, from an empty temp folder (no
 * supabase/.temp link, no supabase/tests), so even a refusal that slipped would stop there.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script, no types
import { resolveSqlTestTarget, describeSqlTestTarget, linkedRefReason, readLinkedRef } from "../scripts/dev/sql-test-target.mjs";

const REF = "abcdefghijklmnopqrst"; // 20 chars, the shape of a Supabase project ref
const OTHER = "zyxwvutsrqponmlkjihg";

describe("resolveSqlTestTarget — local is the default", () => {
  it("no flags → local docker DB", () => {
    const r = resolveSqlTestTarget([], {});
    expect(r.reason).toBeNull();
    expect(r.target).toEqual({ kind: "local" });
    expect(r.only).toBeNull();
  });

  it("--local (CI's explicit path, npm run test:sql:local) → local", () => {
    expect(resolveSqlTestTarget(["--local"], { CI: "true" }).target).toEqual({ kind: "local" });
  });

  it("a name filter stays a filter", () => {
    const r = resolveSqlTestTarget(["payment"], {});
    expect(r.target).toEqual({ kind: "local" });
    expect(r.only).toBe("payment");
  });

  it("--db-url on 127.0.0.1 → local psql", () => {
    const r = resolveSqlTestTarget(["--db-url=postgresql://postgres:postgres@127.0.0.1:54322/postgres"], {});
    expect(r.reason).toBeNull();
    expect(r.target.kind).toBe("db-url");
  });

  it("TEST_SQL_REMOTE_OK alone does nothing — still local", () => {
    expect(resolveSqlTestTarget([], { TEST_SQL_REMOTE_OK: REF }).target).toEqual({ kind: "local" });
  });
});

describe("resolveSqlTestTarget — remote only when asked twice", () => {
  it("--remote <ref> + TEST_SQL_REMOTE_OK=<same ref> → remote", () => {
    const r = resolveSqlTestTarget(["--remote", REF], { TEST_SQL_REMOTE_OK: REF });
    expect(r.reason).toBeNull();
    expect(r.target).toEqual({ kind: "remote", ref: REF });
    expect(r.only).toBeNull(); // the ref is NOT taken as a test-name filter
  });

  it("--remote=<ref> form works the same", () => {
    expect(resolveSqlTestTarget([`--remote=${REF}`, "payment"], { TEST_SQL_REMOTE_OK: REF })).toMatchObject({
      reason: null, target: { kind: "remote", ref: REF }, only: "payment",
    });
  });

  it("--remote without the env → refused", () => {
    const r = resolveSqlTestTarget(["--remote", REF], {});
    expect(r.reason).toMatch(/TEST_SQL_REMOTE_OK/);
  });

  it("--remote with a different env ref → refused", () => {
    expect(resolveSqlTestTarget(["--remote", REF], { TEST_SQL_REMOTE_OK: OTHER }).reason).toMatch(/TEST_SQL_REMOTE_OK/);
  });

  it("--remote with no ref / a bad ref → refused", () => {
    expect(resolveSqlTestTarget(["--remote"], { TEST_SQL_REMOTE_OK: "" }).reason).toBeTruthy();
    expect(resolveSqlTestTarget(["--remote", "--local"], {}).reason).toBeTruthy();
    expect(resolveSqlTestTarget(["--remote", "staging"], { TEST_SQL_REMOTE_OK: "staging" }).reason).toMatch(/ref/);
  });

  it("CI never goes remote, even with both", () => {
    expect(resolveSqlTestTarget(["--remote", REF], { TEST_SQL_REMOTE_OK: REF, CI: "true" }).reason).toMatch(/CI/);
  });

  it("--remote mixed with --local or --db-url → refused", () => {
    expect(resolveSqlTestTarget(["--remote", REF, "--local"], { TEST_SQL_REMOTE_OK: REF }).reason).toBeTruthy();
    expect(
      resolveSqlTestTarget(["--remote", REF, "--db-url=postgresql://p@127.0.0.1:54322/postgres"], { TEST_SQL_REMOTE_OK: REF }).reason,
    ).toBeTruthy();
  });
});

describe("resolveSqlTestTarget — everything else is refused", () => {
  it("--db-url on a non-local host → refused", () => {
    expect(resolveSqlTestTarget(["--db-url=postgresql://u:p@db.example.com:5432/postgres"], {}).reason).toMatch(/not local/);
    expect(resolveSqlTestTarget(["--db-url="], {}).reason).toBeTruthy();
  });

  it("unknown flags (--linked, --project-ref, typos) → refused, not ignored", () => {
    for (const a of [["--linked"], ["--project-ref", REF], ["--remot", REF], ["-r"]]) {
      expect(resolveSqlTestTarget(a, {}).reason, a.join(" ")).toMatch(/flag/);
    }
  });

  it("two name filters → refused (a stray ref must never be read as a filter and the rest run remote)", () => {
    expect(resolveSqlTestTarget(["payment", REF], {}).reason).toBeTruthy();
  });
});

describe("describeSqlTestTarget — the first line printed", () => {
  it("names the target", () => {
    expect(describeSqlTestTarget({ kind: "local" })).toMatch(/^target: local/);
    expect(describeSqlTestTarget({ kind: "db-url", url: "postgresql://postgres:secret@127.0.0.1:54322/postgres" }))
      .toMatch(/^target: local .*127\.0\.0\.1:54322/);
    expect(describeSqlTestTarget({ kind: "remote", ref: REF })).toMatch(new RegExp(`^target: REMOTE ${REF}`));
  });

  it("never prints the password of a --db-url", () => {
    expect(describeSqlTestTarget({ kind: "db-url", url: "postgresql://postgres:secret@127.0.0.1:54322/postgres" })).not.toMatch(/secret/);
  });
});

describe("linked project check before a remote run", () => {
  it("refuses when nothing is linked or the link is another project", () => {
    expect(linkedRefReason(REF, null)).toMatch(/link/);
    expect(linkedRefReason(REF, OTHER)).toMatch(OTHER);
    expect(linkedRefReason(REF, REF)).toBeNull();
  });

  it("reads the ref from supabase/.temp (project-ref or linked-project.json)", () => {
    const a = mkdtempSync(join(tmpdir(), "r2493-link-"));
    expect(readLinkedRef(a)).toBeNull();
    mkdirSync(join(a, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(a, "supabase", ".temp", "linked-project.json"), JSON.stringify({ ref: REF, name: "x" }));
    expect(readLinkedRef(a)).toBe(REF);
    writeFileSync(join(a, "supabase", ".temp", "project-ref"), `${OTHER}\n`);
    expect(readLinkedRef(a)).toBe(OTHER);
  });
});

describe("scripts/test-sql.mjs — prints the target first and refuses before connecting", () => {
  const SCRIPT = resolve(__dirname, "../scripts/test-sql.mjs");
  const run = (args: string[], env: Record<string, string> = {}) => {
    const cwd = mkdtempSync(join(tmpdir(), "r2493-cli-"));
    const base = { ...process.env };
    delete base.TEST_SQL_REMOTE_OK;
    delete base.CI;
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };

  it("--remote without TEST_SQL_REMOTE_OK → exit 2, target printed first, nothing run", () => {
    const r = run(["--remote", REF]);
    expect(r.status).toBe(2);
    expect(r.out.trimStart()).toMatch(new RegExp(`^target: REMOTE ${REF}`));
    expect(r.out).toMatch(/RUKA/);
    expect(r.out).not.toMatch(/canary/i);
  });

  it("--remote with both but no linked project here → exit 2 before connecting", () => {
    const r = run(["--remote", REF], { TEST_SQL_REMOTE_OK: REF });
    expect(r.status).toBe(2);
    expect(r.out).toMatch(/link/);
    expect(r.out).not.toMatch(/canary/i);
  });

  it("--linked (the old remote way) → exit 2", () => {
    const r = run(["--linked"]);
    expect(r.status).toBe(2);
    expect(r.out).not.toMatch(/canary/i);
  });

  it("no flags → 'target: local' is the first line", () => {
    const r = run([]);
    expect(r.out.trimStart()).toMatch(/^target: local/);
    expect(r.out).not.toMatch(/REMOTE/);
  });
});
