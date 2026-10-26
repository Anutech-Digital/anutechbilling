// R-1957: scripts/dev/scenario.mjs writes test data ONLY into this laptop's docker DB.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
// @ts-expect-error — plain .mjs dev script, no types
import { scenarioTargetReason } from "../scripts/dev/local-guard.mjs";
// @ts-expect-error — plain .mjs dev script, no types
import { SCENARIOS, pageUrl, sqlTextArray } from "../scripts/dev/scenarios/index.mjs";

const PROD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL = "supabase_db_resellerosv3";

describe("scenario guard: local docker DB only", () => {
  it("accepts the local container with local URLs (or none)", () => {
    expect(scenarioTargetReason({ nodeEnv: "development", container: LOCAL, urls: [] })).toBeNull();
    expect(scenarioTargetReason({
      nodeEnv: undefined,
      container: LOCAL,
      urls: ["http://127.0.0.1:54321", "postgresql://postgres:x@localhost:54322/postgres", undefined, ""],
    })).toBeNull();
  });

  it("refuses NODE_ENV=production even on the local container", () => {
    for (const nodeEnv of ["production", "PRODUCTION", " production "]) {
      expect(scenarioTargetReason({ nodeEnv, container: LOCAL, urls: [] })).toMatch(/NODE_ENV is production/);
    }
  });

  it("refuses a non-local Supabase / database URL", () => {
    for (const u of [
      "https://ontpnqjoysjgrlsukecm.supabase.co",
      "https://api.anutech.in",
      "postgresql://postgres:x@10.20.0.3:5432/resellersos",
      "http://localhost.evil.com:54321",
      "not a url",
    ]) {
      expect(scenarioTargetReason({ nodeEnv: "development", container: LOCAL, urls: ["http://127.0.0.1:54321", u] }))
        .toMatch(/not local|could not be parsed/);
    }
  });

  it("refuses when no local Supabase DB container runs, or the name is something else", () => {
    for (const container of [null, undefined, "", "postgres", "resellersos-db", "supabase_db_x; rm -rf /"]) {
      expect(scenarioTargetReason({ nodeEnv: "development", container, urls: [] })).toMatch(/container/);
    }
  });

  it("the script itself exits 1 under NODE_ENV=production before touching any DB", () => {
    const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "vendor-sharma"], {
      cwd: PROD, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_ENV: "production" },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/NODE_ENV is production/);
  });

  it("the script refuses a non-local app host for its URLs", () => {
    const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", "vendor-sharma", "--host", "reselleros.anutech.in"], {
      cwd: PROD, encoding: "utf8", timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not local/);
  });
});

describe("scenario registry", () => {
  it("each scenario has its SQL file, SCN- bill numbers and ids that the SQL really inserts", () => {
    for (const s of SCENARIOS) {
      const sql = readFileSync(join(PROD, "scripts/dev/scenarios", `${s.name}.sql`), "utf8");
      for (const id of [...s.scope.vendors, ...s.scope.txns, ...s.scope.docs]) expect(sql).toContain(`'${id}'`);
      for (const m of sql.matchAll(/'(SCN-[A-Z0-9-]+)'/g)) expect(m[1]).toMatch(/^SCN-/);
      expect(s.cards.length).toBeGreaterThan(0);
      expect(sql).not.toMatch(/\b(drop|truncate)\b/i);
    }
  });

  it("covers the money cards", () => {
    const cards = new Set(SCENARIOS.flatMap((s: { cards: string[] }) => s.cards));
    for (const c of ["R-1911", "R-1912", "R-1913", "R-1915", "R-1917", "R-1918", "R-1919", "R-1952"]) expect(cards.has(c)).toBe(true);
  });

  it("prints local URLs and quotes only safe values into SQL", () => {
    expect(pageUrl("localhost:3001", "banking")).toMatch(/^http:\/\/localhost:3001\/accounting\/banking\/c1957000-/);
    expect(pageUrl("localhost:3001", "expenses", new Date(2026, 9, 26))).toBe(
      "http://localhost:3001/accounting/expenses?from=2026-07-28&to=2026-11-30&q=SCN",
    );
    expect(() => sqlTextArray(["x'); drop table vendors; --"])).toThrow(/unsafe/);
  });
});
