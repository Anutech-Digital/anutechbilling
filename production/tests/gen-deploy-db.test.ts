import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { parseDeployHeaders, defaultKey, selectFiles, filesInScript, replaceMigs, splitScript, generate, buildMigsBody, ENVS } from "../scripts/ops/gen-deploy-db.mjs";

// R-385 (7 Oct 2026): the MIGS array of the day's staging + live deploy-db scripts is generated
// from `-- deploy-peek:` headers in the migrations instead of hand-edited (6 hand edits on 7 Oct).
const supabaseDir = path.resolve(__dirname, "..", "supabase");
type Gen = { files: string[]; scripts: Record<string, { before: string; after: string }> };

describe("gen-deploy-db headers", () => {
  it("reads key, peek and user from the top comment block", () => {
    const h = parseDeployHeaders("-- deploy-key: oneterm\r\n-- deploy-peek: exists(select 1 from pg_trigger where tgname='t')\r\n-- note\r\ncreate table x();\r\n", "20261007160000_quote_one_billing_term.sql");
    expect(h).toEqual({ file: "20261007160000_quote_one_billing_term.sql", key: "oneterm", user: "resellersos_migration", peek: "exists(select 1 from pg_trigger where tgname='t')" });
    expect(parseDeployHeaders("-- deploy-peek: true\n-- deploy-user: postgres\n", "20261008000000_a_b.sql").user).toBe("postgres");
  });

  it("defaults the key from the file name", () => {
    expect(defaultKey("20261008000000_Quote_one-term.sql")).toBe("quoteoneterm");
    expect(parseDeployHeaders("-- deploy-peek: true\n", "20261008000000_page_test_runs_more.sql").key).toBe("pagetestruns");
  });

  it("fails loudly when deploy-peek is missing — or only appears below the SQL", () => {
    expect(() => parseDeployHeaders("-- R-999 something\ncreate table x();\n", "20261008000000_x.sql")).toThrow(/20261008000000_x\.sql: no "-- deploy-peek:/);
    expect(() => parseDeployHeaders("create table x();\n-- deploy-peek: true\n", "20261008000000_x.sql")).toThrow(/deploy-peek/);
  });

  it("refuses a peek that would break the bash line", () => {
    for (const bad of ["a|b", 'x="1"', "$x", "`x`"]) {
      expect(() => parseDeployHeaders(`-- deploy-peek: ${bad}\n`, "20261008000000_x.sql")).toThrow(/may not contain/);
    }
  });

  it("refuses two migrations with the same key", () => {
    const e = { key: "k", user: "u", peek: "true" };
    expect(() => buildMigsBody([{ ...e, file: "a.sql" }, { ...e, file: "b.sql" }])).toThrow(/used by both a\.sql and b\.sql/);
  });
});

describe("gen-deploy-db file choice + rewrite", () => {
  const files = ["20261006130000_a.sql", "20261007000000_b.sql", "20261007100000_c.sql", "20261005000000_old.sql", "README.md"];

  it("--since takes every migration from that version", () => {
    expect(selectFiles(files, { since: "20261007000000" })).toEqual(["20261007000000_b.sql", "20261007100000_c.sql"]);
  });

  it("no flag: what the script lists + every newer migration (a new file lands by itself)", () => {
    expect(selectFiles(files, { listed: ["20261006130000_a.sql", "20261007000000_b.sql"] })).toEqual(["20261006130000_a.sql", "20261007000000_b.sql", "20261007100000_c.sql"]);
    expect(() => selectFiles(files, { listed: ["20261009000000_gone.sql"] })).toThrow(/do not exist/);
  });

  it("replaces only the MIGS lines, keeping everything else byte-identical", () => {
    const text = "#!/usr/bin/env bash\nx=1\nMIGS=(\n  \"a|f.sql|u|true\"\n)\nfield() { :; }\n# sed -e 's/auth\\.uid()/x/g'\n";
    const out = replaceMigs(text, ['  "b|g.sql|u|false"'], "t");
    expect(out).toBe(text.replace('"a|f.sql|u|true"', '"b|g.sql|u|false"'));
    expect(filesInScript(text, "t")).toEqual(["f.sql"]);
    expect(() => splitScript("no block\n", "t")).toThrow(/no "MIGS=\("/);
  });
});

/* Copy both migration homes: supabase/migrations, and prisma/migrations where the staging
   branch (R-161) keeps applied ones — so these tests pass on either branch. */
function copyMigrations(tmpSupabase: string) {
  fs.cpSync(path.join(supabaseDir, "migrations"), path.join(tmpSupabase, "migrations"), { recursive: true });
  const prisma = path.join(supabaseDir, "..", "prisma", "migrations");
  if (fs.existsSync(prisma)) fs.cpSync(prisma, path.join(tmpSupabase, "..", "prisma", "migrations"), { recursive: true });
}
describe("today's deploy scripts (7 Oct 2026)", () => {
  it("regenerating is a no-op — the headers carry exactly the peeks the scripts had", () => {
    const res: Gen = generate({ supabaseDir, date: "2026-10-07" });
    /* The count grows every time a migration lands — pin "no drift", not a number. */
    expect(res.files.length).toBeGreaterThanOrEqual(17);
    expect(res.files).toEqual(res.files.slice().sort());
    for (const env of ENVS) expect(res.scripts[env].after).toBe(res.scripts[env].before);
    const since: Gen = generate({ supabaseDir, date: "2026-10-07", since: "20261006130000" });
    expect(since.files).toEqual(res.files);
    for (const env of ENVS) expect(since.scripts[env].after).toBe(since.scripts[env].before);
  });

  it("staging keeps its auth.uid() rewrite; live never gets it", () => {
    const res: Gen = generate({ supabaseDir, date: "2026-10-07" });
    expect(res.scripts.staging.after).toContain("s/auth\\.uid()/public.current_user_id()/g");
    expect(res.scripts.live.after).not.toContain("current_user_id()/g");
  });

  it("finds a listed migration the staging branch moved to prisma/migrations (R-161 layout)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-deploy-db-prisma-"));
    try {
      const tmp = path.join(root, "supabase");
      copyMigrations(tmp);
      for (const env of ENVS) {
        fs.mkdirSync(path.join(tmp, "cloudsql", env), { recursive: true });
        fs.copyFileSync(path.join(supabaseDir, "cloudsql", env, "deploy-db-2026-10-07.sh"), path.join(tmp, "cloudsql", env, "deploy-db-2026-10-07.sh"));
      }
      const moved = "20261006130000_feedback_checked";
      if (fs.existsSync(path.join(tmp, "migrations", `${moved}.sql`))) {
        fs.mkdirSync(path.join(root, "prisma", "migrations", moved), { recursive: true });
        fs.renameSync(path.join(tmp, "migrations", `${moved}.sql`), path.join(root, "prisma", "migrations", moved, "migration.sql"));
      }
      const res: Gen = generate({ supabaseDir: tmp, date: "2026-10-07" });
      expect(res.files).toContain(`${moved}.sql`);
      for (const env of ENVS) expect(res.scripts[env].after).toBe(res.scripts[env].before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("a new migration with a header is appended to BOTH scripts; one without fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gen-deploy-db-"));
    const tmp = path.join(root, "supabase");
    try {
      copyMigrations(tmp);
      for (const env of ENVS) {
        fs.mkdirSync(path.join(tmp, "cloudsql", env), { recursive: true });
        fs.copyFileSync(path.join(supabaseDir, "cloudsql", env, "deploy-db-2026-10-07.sh"), path.join(tmp, "cloudsql", env, "deploy-db-2026-10-07.sh"));
      }
      fs.writeFileSync(path.join(tmp, "migrations", "29991231000000_new_thing.sql"), "-- deploy-peek: to_regclass('public.new_thing') is not null\ncreate table public.new_thing();\n");
      const res: Gen = generate({ supabaseDir: tmp, date: "2026-10-07" });
      for (const env of ENVS) {
        const before = res.scripts[env].before.split("\n");
        const added = res.scripts[env].after.split("\n").filter((l) => !before.includes(l));
        expect(added).toEqual([`  "newthing|29991231000000_new_thing.sql|resellersos_migration|to_regclass('public.new_thing') is not null"`]);
      }
      fs.writeFileSync(path.join(tmp, "migrations", "29991231000059_no_header.sql"), "-- forgot\nselect 1;\n");
      expect(() => generate({ supabaseDir: tmp, date: "2026-10-07" })).toThrow(/29991231000059_no_header\.sql: no "-- deploy-peek:/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe("migration versions", () => {
  it("no two migration files share a version (9 Oct: two workers both picked 20261009180000)", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const f of fs.readdirSync(path.join(supabaseDir, "migrations")).filter((x) => /^\d{14}_.*\.sql$/.test(x))) {
      const v = f.slice(0, 14);
      if (seen.has(v)) clashes.push(`${seen.get(v)} + ${f}`); else seen.set(v, f);
    }
    expect(clashes).toEqual([]);
  });
});
