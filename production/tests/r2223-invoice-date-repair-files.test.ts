// R-2223: the SQL test proves the invoice-date repair by running COPIES of its two SQL files
// (a supabase/tests file cannot include another file). This keeps those copies exact, and keeps
// the repair out of every automatic deploy step — it is the owner's own DB step (run.sh).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const PROD = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = join(PROD, "supabase/cloudsql/live/r2223-invoice-dates");
const TEST = join(PROD, "supabase/tests/r2223_invoice_date_repair.test.sql");
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function between(src: string, name: string): string {
  const start = src.indexOf(`-- >>> ${name}\n`);
  const end = src.indexOf(`-- <<< ${name}\n`);
  expect(start, `marker ">>> ${name}" in the SQL test`).toBeGreaterThan(-1);
  expect(end, `marker "<<< ${name}" in the SQL test`).toBeGreaterThan(start);
  return src.slice(start + `-- >>> ${name}\n`.length, end);
}

describe("R-2223 invoice-date repair files", () => {
  const test = read(TEST);

  it("the SQL test runs exactly rows.sql and apply-body.sql", () => {
    expect(between(test, "rows.sql")).toBe(read(join(DIR, "rows.sql")));
    expect(between(test, "apply-body.sql")).toBe(read(join(DIR, "apply-body.sql")));
  });

  it("the SQL test ends in rollback (CI's SQL runner refuses anything else)", () => {
    expect(test.trimEnd().endsWith("rollback;")).toBe(true);
  });

  it("run.sh needs the database named (no default) and asks before writing", () => {
    const run = read(join(DIR, "run.sh"));
    expect(run).toMatch(/staging\) I=resellersos-staging-db/);
    expect(run).toMatch(/live\)\s+I=resellersos-db/);
    expect(run).toMatch(/\*\) echo "Usage: run\.sh staging\|live/);
    expect(run).toMatch(/\[ "\$OK" = "haan" \]/);
  });

  it("is not wired into any deploy-db script", () => {
    for (const env of ["staging", "live"]) {
      const dir = join(PROD, "supabase/cloudsql", env);
      for (const f of readdirSync(dir).filter((n) => n.startsWith("deploy-db-"))) {
        expect(read(join(dir, f)), `${env}/${f}`).not.toMatch(/r2223/i);
      }
    }
  });
});
