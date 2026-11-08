// R-2614 (8 Nov 2026): R-2604 renamed 3 times, R-2609/R-2613 collided on 20261108133000, R-2611 needed a
// rename — each rename by hand, each a new sha and a new independent review (~2 h of push delay).
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs ops script, no types
import { maskOwnMigrations, ownMigrationVersions, utcStamp, orderProblems, ownLateOnly, planRenames, rewriteMentions, autoRenameLateMigrations, migrationClashes, otherCardsMigrations, checkMigrationClash, addedMigrations, clashMessage } from "../scripts/ops/worker-lock-migts.mjs";

const MIG = "production/supabase/migrations";

function repo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "r2614-"));
  const g = (a: string[], input?: string) => execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", ...a], { cwd: tmp, encoding: "utf8", input, stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"] });
  const put = (f: string, s: string) => { fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), s); };
  const commit = (m: string) => { g(["add", "-A"]); g(["commit", "-qm", m]); return g(["rev-parse", "HEAD"]).trim(); };
  const runCheck = () => {
    const r = spawnSync(process.execPath, ["scripts/migration-order-check.mjs", "--base", "main"], { cwd: path.join(tmp, "production"), encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  };
  g(["init", "-q", "-b", "main"]);
  put("production/scripts/migration-order-check.mjs", fs.readFileSync(path.join(__dirname, "..", "scripts", "migration-order-check.mjs"), "utf8"));
  put(`${MIG}/20261108120000_base.sql`, "-- deploy-peek: true\nselect 1;\n");
  commit("base");
  return { tmp, g, put, commit, runCheck, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

describe("R-2614 pure helpers", () => {
  it("R-2615: the too-wide mask of every 14-digit number is gone", async () => {
    expect((await import("../scripts/ops/worker-lock-migts.mjs") as Record<string, unknown>).maskMigrationStamps).toBeUndefined();
  });

  it("utcStamp is YYYYMMDDHHMMSS in UTC", () => {
    expect(utcStamp(Date.UTC(2026, 10, 8, 17, 5, 9))).toBe("20261108170509");
  });

  it("reads the order check's problem lines", () => {
    expect(orderProblems("base x\n\nMigration check FAILED:\n  out of order: a.sql is not newer than 1\n  b\n")).toEqual(["out of order: a.sql is not newer than 1", "b"]);
    expect(orderProblems("migrations OK")).toEqual([]);
  });

  it("only the card's own late / duplicate migrations count as auto-fixable", () => {
    const own = ["20261108133000_a.sql"];
    expect(ownLateOnly(["out of order: 20261108133000_a.sql is not newer than 20261108140000 (newest on x) — regenerate its timestamp"], own)).toEqual({ ok: true, late: ["20261108133000_a.sql"] });
    expect(ownLateOnly(["duplicate version 20261108133000: 20261108133000_a.sql and 20261108133000_z.sql", "out of order: 20261108133000_a.sql is not newer than 20261108133000 (newest)"], own).ok).toBe(true);
    expect(ownLateOnly(["out of order: 20261108133000_other.sql is not newer than 1"], own).ok).toBe(false);
    expect(ownLateOnly(["edited an existing migration: 20261030131008_a.sql — it has likely run already"], own).ok).toBe(false);
    expect(ownLateOnly(["out of order: 20261108133000_a.sql is not newer than 1", "bad name: x.sql"], own).ok).toBe(false);
    expect(ownLateOnly([], own).ok).toBe(false);
  });

  it("plans fresh UTC names for ALL own migrations, order kept, newer than base, skipping taken versions", () => {
    const now = Date.UTC(2026, 10, 8, 17, 0, 0);
    expect(planRenames(["20261108133000_a.sql", "20261108190000_b.sql"], { newestOnBase: "20261108140000", now, taken: ["20261108170000"] }))
      .toEqual([{ from: "20261108133000_a.sql", to: "20261108170001_a.sql" }, { from: "20261108190000_b.sql", to: "20261108170002_b.sql" }]);
    // base newer than the clock (hand-made future stamps) → just after it
    expect(planRenames(["20261108133000_a.sql"], { newestOnBase: "20261109000000", now })).toEqual([{ from: "20261108133000_a.sql", to: "20261109000001_a.sql" }]);
  });

  it("rewrites the stem and the bare version, not other numbers", () => {
    const r = [{ from: "20261108133000_a.sql", to: "20261108170000_a.sql" }];
    expect(rewriteMentions("readMig('20261108133000_a.sql'); v = '20261108133000'; n = 202611081330001;", r))
      .toBe("readMig('20261108170000_a.sql'); v = '20261108170000'; n = 202611081330001;");
  });

  it("finds two cards holding the same version", () => {
    const c = migrationClashes(["20261108133000_a.sql"], [{ card: "R-2", files: ["20261108133000_b.sql"] }, { card: "R-3", files: ["20261108140000_c.sql"] }]);
    expect(c).toEqual([{ version: "20261108133000", mine: "20261108133000_a.sql", other: "20261108133000_b.sql", card: "R-2" }]);
    expect(clashMessage("r-1", c)).toMatch(/R-1: migration ka timestamp doosre card ke paas bhi hai[\s\S]*R-2 ka 20261108133000_b\.sql/);
    expect(migrationClashes([], [{ card: "R-2", files: ["20261108133000_b.sql"] }])).toEqual([]);
  });
});

describe("R-2614 push renames the card's own late migration itself (real git + the real order check)", () => {
  it("late own migration → renamed to now, mentions updated, deploy-db regen called, one auto commit, check green", () => {
    const r = repo();
    try {
      r.g(["checkout", "-qb", "card"]);
      r.put(`${MIG}/20261108133000_a.sql`, "-- deploy-peek: to_regclass('public.a') is not null\n-- 20261108133000_a\ncreate table a();\n");
      r.put("production/tests/a.test.ts", "const f = '20261108133000_a.sql';\nconst v = '20261108133000';\n");
      r.commit("R-1: add a");
      r.g(["checkout", "-q", "main"]); r.put(`${MIG}/20261108150000_other.sql`, "select 2;\n"); r.commit("R-2: other");
      r.g(["checkout", "-q", "card"]); r.g(["rebase", "-q", "main"]);
      expect(r.runCheck().status).toBe(1);
      let regens = 0;
      const lines: string[] = [];
      const res = autoRenameLateMigrations("r-1", { git: r.g, top: r.tmp, runCheck: r.runCheck, regen: () => { regens++; }, now: Date.UTC(2026, 10, 8, 17, 0, 0), base: "main", print: (l: string) => lines.push(l) });
      expect(res.ok).toBe(true);
      expect(res.renamed).toEqual([{ from: "20261108133000_a.sql", to: "20261108170000_a.sql" }]);
      expect(regens).toBe(1);
      expect(fs.existsSync(path.join(r.tmp, MIG, "20261108133000_a.sql"))).toBe(false);
      expect(fs.readFileSync(path.join(r.tmp, MIG, "20261108170000_a.sql"), "utf8")).toContain("-- 20261108170000_a");
      expect(fs.readFileSync(path.join(r.tmp, "production/tests/a.test.ts"), "utf8")).toBe("const f = '20261108170000_a.sql';\nconst v = '20261108170000';\n");
      expect(r.g(["log", "-1", "--format=%s"]).trim()).toBe("R-1: rename migration (auto) 20261108133000_a.sql -> 20261108170000_a.sql");
      expect(r.g(["status", "--porcelain"]).trim()).toBe("");
      expect(lines.join("\n")).toMatch(/naam khud badla/);
      expect(r.runCheck().status).toBe(0);
    } finally { r.done(); }
  });

  it("green check → nothing renamed; an edited old migration → refused, nothing renamed", () => {
    const r = repo();
    try {
      r.g(["checkout", "-qb", "card"]);
      r.put(`${MIG}/20261108160000_a.sql`, "select 1;\n"); r.commit("R-1: a");
      expect(autoRenameLateMigrations("R-1", { git: r.g, top: r.tmp, runCheck: r.runCheck, base: "main" })).toEqual({ ok: true, renamed: [] });
      r.put(`${MIG}/20261108120000_base.sql`, "-- deploy-peek: true\nselect 1;\n-- edit\n");
      r.put(`${MIG}/20261108110000_late.sql`, "select 3;\n"); r.commit("R-1: edit old + late");
      const res = autoRenameLateMigrations("R-1", { git: r.g, top: r.tmp, runCheck: r.runCheck, base: "main" });
      expect(res.ok).toBe(false);
      expect(res.renamed).toEqual([]);
      expect(fs.existsSync(path.join(r.tmp, MIG, "20261108110000_late.sql"))).toBe(true);
    } finally { r.done(); }
  });
});

describe("R-2614 claim refuses a migration version another card already holds", () => {
  it("another lock's worktree with the same version → clash; different version → fine", () => {
    const a = repo(), b = repo();
    try {
      for (const r of [a, b]) r.g(["branch", "anutech/manager-pardeep"]);
      a.g(["checkout", "-qb", "card"]); a.put(`${MIG}/20261108133000_a.sql`, "select 1;\n"); a.commit("R-1: a");
      b.g(["checkout", "-qb", "card"]); b.put(`${MIG}/20261108133000_b.sql`, "select 1;\n"); // untracked still counts
      const gitFor = (dir: string) => (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      // base ref name: the local branch named like the remote ref
      expect(addedMigrations(gitFor(b.tmp), "anutech/manager-pardeep").added).toEqual(["20261108133000_b.sql"]);
      const locks = [{ card: "R-2", worktree: b.tmp }, { card: "R-1", worktree: a.tmp }];
      expect(otherCardsMigrations("R-1", locks, { git: gitFor(a.tmp), gitFor })).toEqual([{ card: "R-2", files: ["20261108133000_b.sql"] }]);
      const res = checkMigrationClash("R-1", a.tmp, locks, { gitFor });
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/20261108133000: mera 20261108133000_a\.sql\s+↔\s+R-2 ka 20261108133000_b\.sql/);
      fs.renameSync(path.join(b.tmp, MIG, "20261108133000_b.sql"), path.join(b.tmp, MIG, "20261108140000_b.sql"));
      expect(checkMigrationClash("R-1", a.tmp, locks, { gitFor }).ok).toBe(true);
      expect(checkMigrationClash("R-1", path.join(a.tmp, "nope"), locks, { gitFor }).ok).toBe(true);
    } finally { a.done(); b.done(); }
  });
});

/* R-2615 (8 Nov 2026): the review mask touches only the card's own new migrations; an old wip branch of a
   card whose migration was renamed later (and merged) no longer refuses a claim. */
describe("R-2615 mask only the card's own new migration versions", () => {
  const diff = (files: Array<[string, string, boolean]>) => files.map(([f, body, isNew]) => `diff --git a/${f} b/${f}\n${isNew ? "new file mode 100644\n" : ""}index 0000000..1111111\n--- ${isNew ? "/dev/null" : `a/${f}`}\n+++ b/${f}\n@@ -0,0 +1 @@\n+${body}\n`).join("");
  it("finds the versions of migrations the diff ADDS under supabase/migrations/ only", () => {
    const d = diff([[`${MIG}/20261108133000_a.sql`, "x", true], [`${MIG}/20261108120000_old.sql`, "edit", false], ["production/src/x.ts", "20261108140000", true], [`${MIG}/README.md`, "y", true],
      ["production/tests/fixtures/supabase/migrations/20261108150000_fixture.sql", "z", true], [`${MIG}/sub/20261108160000_deep.sql`, "z", true]]);
    expect(ownMigrationVersions(d)).toEqual(["20261108133000"]);
  });
  it("masks own versions in order, leaves every other 14-digit number alone", () => {
    const d = diff([[`${MIG}/20261108190000_b.sql`, "b", true], [`${MIG}/20261108133000_a.sql`, "a", true], ["production/src/x.ts", "n = 20261108140000; v = '20261108133000'; w = 202611081330001", false]]);
    const m = maskOwnMigrations(d);
    expect(m).toContain(`${MIG}/MIGRATION_0_a.sql`);
    expect(m).toContain(`${MIG}/MIGRATION_1_b.sql`);
    expect(m).toContain("n = 20261108140000; v = 'MIGRATION_0'; w = 202611081330001");
    expect(maskOwnMigrations("no migrations 20261108140000")).toBe("no migrations 20261108140000");
  });
});

describe("R-2615 claim: no false clash from my own or an already-renamed card's old wip branch", () => {
  it("wip of the claimer is ignored; wip whose migration that SAME card later renamed on base is ignored; another card's still clashes", () => {
    const a = repo();
    const gitFor = (dir: string) => (args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    try {
      const wip = (card: string, file: string) => {
        a.g(["checkout", "-q", "-b", `src-${card}`, "main"]); a.put(`${MIG}/${file}`, "select 7;\n");
        const sha = a.commit(`${card.toUpperCase()}: ${file}`);
        a.g(["update-ref", `refs/remotes/anutech/wip/${card}`, sha]);
      };
      wip("r-7", "20261108133000_seven.sql");   // R-7 later renamed its migration and merged
      wip("r-8", "20261108133000_eight.sql");   // R-8's wip: base has an 'eight' migration, but added by R-9
      wip("r-1", "20261108133000_one.sql");     // the claimer's own old wip
      a.g(["checkout", "-q", "main"]);
      a.put(`${MIG}/20261108160000_seven.sql`, "select 7;\n"); a.commit("R-7: rename migration (auto) 20261108133000_seven.sql -> 20261108160000_seven.sql");
      a.put(`${MIG}/20261108170000_eight.sql`, "select 9;\n"); a.commit("R-9: eight\n\nsame pattern as R-8"); // a body mention is not R-8's rename
      a.g(["branch", "anutech/manager-pardeep"]);
      a.g(["checkout", "-qb", "card"]); a.put(`${MIG}/20261108133000_one.sql`, "select 1;\n"); a.commit("R-1: one");
      const others = otherCardsMigrations("R-1", [], { git: gitFor(a.tmp), gitFor });
      expect(others.find((o: { card: string }) => o.card === "R-1")).toBeUndefined();
      expect(others.find((o: { card: string }) => o.card === "R-7")?.files ?? []).toEqual([]);
      expect(others.find((o: { card: string }) => o.card === "R-8")?.files).toEqual(["20261108133000_eight.sql"]);
      const res = checkMigrationClash("R-1", a.tmp, [], { gitFor });
      expect(res.ok).toBe(false);
      expect(res.clashes.map((c: { card: string }) => c.card)).toEqual(["R-8"]);
    } finally { a.done(); }
  });
});
