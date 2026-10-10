import { describe, it, expect } from "vitest";
import {
  parseArgs,
  extractCardIds,
  parseAddedMigrations,
  dropAlreadyInPrisma,
  groupRunsBySha,
  pickGreen,
  decide,
  istStamp,
  mergeMessage,
  dbCommand,
  summaryLines,
  PUSH_ARGS,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/staging-train.mjs";

/* R-386 (7 Oct 2026): staging was merged once a day; 40+ commits piled up and every push
   restarted CI. The staging train merges the newest CI-green commit every 2–3 hours. */

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const run = (status: string, conclusion: string) => ({ status, conclusion });

describe("staging train — args", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ dbDone: false, push: false, help: false });
  });
  it("takes --db-done and --push", () => {
    expect(parseArgs(["--push", "--db-done"])).toEqual({ dbDone: true, push: true, help: false });
  });
  it("rejects anything else (no --force, no branch names)", () => {
    expect(() => parseArgs(["--force"])).toThrow(/--force/);
    expect(() => parseArgs(["staging"])).toThrow(/staging/);
  });
});

describe("staging train — card ids from commit subjects", () => {
  it("collects unique ids sorted by number", () => {
    expect(
      extractCardIds([
        "R-384: menu rename",
        "R-348: deploy-db scripts add quote_one_billing_term (R-381) — 17 migrations",
        "R-381: one quote = one billing term",
        "R-065, R-104: fixes",
      ]),
    ).toEqual(["R-065", "R-104", "R-348", "R-381", "R-384"]);
  });
  it("keeps suffixed ids and ignores look-alikes", () => {
    expect(extractCardIds(["R-381b: follow-up", "XR-12 is not a card", "PR-55 merge", "R-7 too short"])).toEqual(["R-381b"]);
  });
  it("empty when no ids", () => {
    expect(extractCardIds(["Merge branch", ""])).toEqual([]);
    expect(mergeMessage("07 Oct 14:30 IST", [])).toBe("Staging train 07 Oct 14:30 IST: no card ids");
  });
});

describe("staging train — migration diff parsing", () => {
  it("keeps only added .sql files under production/supabase/migrations, sorted", () => {
    const out = [
      "production/supabase/migrations/20261007120000_b.sql",
      "production/supabase/migrations/20261007110000_a.sql",
      "production/supabase/migrations/README.md",
      "production/supabase/tests/x.test.sql",
      "",
    ].join("\r\n");
    expect(parseAddedMigrations(out)).toEqual([
      "production/supabase/migrations/20261007110000_a.sql",
      "production/supabase/migrations/20261007120000_b.sql",
    ]);
  });
  it("empty diff → no migrations", () => {
    expect(parseAddedMigrations("")).toEqual([]);
    expect(parseAddedMigrations(undefined)).toEqual([]);
  });
});

describe("staging train — picking the newest green commit", () => {
  const runs = groupRunsBySha(
    JSON.stringify([
      { headSha: A, status: "in_progress", conclusion: "" },
      { headSha: B, status: "completed", conclusion: "failure" },
      { headSha: D, status: "completed", conclusion: "success" },
      { headSha: D, status: "completed", conclusion: "failure" }, // older run on D — newest wins
    ]),
  );

  it("skips running, red and run-less commits and counts them", () => {
    expect(pickGreen([A, B, C, D], runs)).toEqual({ pick: D, newer: { running: 1, red: 1, noRun: 1 } });
  });
  it("a red re-run beats an old green (staging-gate rule)", () => {
    const r = groupRunsBySha(
      JSON.stringify([
        { headSha: A, status: "completed", conclusion: "failure" },
        { headSha: A, status: "completed", conclusion: "success" },
      ]),
    );
    expect(pickGreen([A], r).pick).toBeNull();
  });
  it("no green commit → pick null", () => {
    expect(pickGreen([A, B], runs)).toEqual({ pick: null, newer: { running: 1, red: 1, noRun: 0 } });
    expect(groupRunsBySha("")).toEqual(new Map());
    expect(() => groupRunsBySha("{}")).toThrow(/array/);
  });
  it("groups newest run first per sha", () => {
    expect(runs.get(D)).toEqual([run("completed", "success"), run("completed", "failure")]);
  });
});

describe("staging train — decision table", () => {
  const base = { pick: D, alreadyInStaging: false, migrations: [] as string[], dbDone: false, push: false };
  const mig = ["production/supabase/migrations/20261007110000_a.sql"];

  it("CI red / no green commit → refuse", () => {
    expect(decide({ ...base, pick: null, push: true, dbDone: true })).toMatchObject({ action: "refuse", exitCode: 1 });
  });
  it("staging already up to date → nothing", () => {
    expect(decide({ ...base, pick: null, alreadyInStaging: true })).toMatchObject({ action: "nothing", exitCode: 0 });
  });
  it("migrations without --db-done → stop with DB STEP NEEDED, even with --push", () => {
    const d = decide({ ...base, migrations: mig, push: true });
    expect(d).toMatchObject({ action: "db-step", exitCode: 3 });
    expect(d.message).toMatch(/DB STEP NEEDED/);
  });
  it("migrations with --db-done → merge", () => {
    expect(decide({ ...base, migrations: mig, dbDone: true }).action).toBe("merge-dry");
  });
  it("no --push → dry run; --push → push", () => {
    expect(decide(base).action).toBe("merge-dry");
    expect(decide({ ...base, push: true }).action).toBe("merge-push");
  });
});

describe("staging train — safety + text", () => {
  it("push is a plain push to staging — never forced, never deploy", () => {
    expect(PUSH_ARGS).toEqual(["push", "anutech", "HEAD:staging"]);
    expect(PUSH_ARGS.join(" ")).not.toMatch(/--force|-f\b|\+|deploy/);
  });
  it("IST stamp and the deploy-db command use the IST date", () => {
    const s = istStamp(new Date("2026-10-07T20:00:00Z")); // 01:30 IST next day
    expect(s).toEqual({ label: "08 Oct 01:30 IST", day: "2026-10-08" });
    expect(dbCommand(s.day)).toBe(
      '& "C:\\Program Files\\Git\\bin\\bash.exe" "/c/Users/mso50/new-reselleros/production/supabase/cloudsql/staging/deploy-db-2026-10-08.sh"',
    );
  });
  it("summary says the next step", () => {
    const dry = summaryLines({ pick: D, cards: ["R-386"], migrations: [], decision: { action: "merge-dry" }, merged: true, pushed: false });
    expect(dry.join("\n")).toMatch(/Cards: R-386[\s\S]*Migrations: koi nahi[\s\S]*--push/);
    const conflict = summaryLines({ pick: D, cards: [], migrations: [], decision: { action: "merge-dry" }, merged: false });
    expect(conflict.join("\n")).toMatch(/CONFLICT/);
  });
});

describe("R-540: migrations staging already has under prisma/migrations", () => {
  it("drops an added supabase migration whose name is a staging prisma folder", () => {
    const added = [
      "production/supabase/migrations/20261006130000_feedback_checked.sql",
      "production/supabase/migrations/20261010050000_attendance_change_log.sql",
    ];
    const tree = "production/prisma/migrations/0_init\nproduction/prisma/migrations/20261006130000_feedback_checked\nproduction/prisma/migrations/migration_lock.toml\n";
    expect(dropAlreadyInPrisma(added, tree)).toEqual(["production/supabase/migrations/20261010050000_attendance_change_log.sql"]);
    expect(dropAlreadyInPrisma(added, "")).toEqual(added);
  });
});
