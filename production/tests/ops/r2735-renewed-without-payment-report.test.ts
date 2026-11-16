import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* R-2735 (13 Nov 2026): the renewed-without-payment report only READS (the manager runs it on staging;
   repairs stay Pardeep's call). */

const FILE = fileURLToPath(new URL("../../scripts/ops/r2735-renewed-without-payment-report.sql", import.meta.url));

function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}
const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop", "grant", "revoke",
  "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze", "reindex", "cluster", "refresh",
  "lock", "listen", "notify", "commit", "savepoint", "reset", "security", "into", "nextval", "setval",
  "set_config", "pg_read_file", "pg_write_file",
];

describe("R-2735 renewed-without-payment report — read-only", () => {
  const sql = readFileSync(FILE, "utf8");
  it("runs inside begin; set transaction read only; … rollback; with no write or DDL", () => {
    const code = codeOnly(sql).toLowerCase();
    expect(code).toMatch(/^\s*begin;\s*set transaction read only;/m);
    expect(code.trim().endsWith("rollback;")).toBe(true);
    expect(WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code))).toEqual([]);
    /* R-2761: \gset + \if / \else / \endif only set and test a psql variable (section 3 skip) — no write. */
    for (const m of code.match(/\\[a-z!]+/g) ?? []) expect(["\\echo", "\\pset", "\\gset", "\\if", "\\else", "\\endif"]).toContain(m);
  });
  it("selects no contact field", () => {
    expect(codeOnly(sql).toLowerCase()).not.toMatch(/\b(email|phone|contact_email|contact_phone)\b/);
  });
});

/* R-2749 (14 Nov 2026): the review of R-2735 found the report skipped monthly flex (1-month term billed
   monthly) and could list an anniversary-shaped sub whose next term is billed ahead but correctly NOT renewed.
   Proved on the local DB with planted rows (rolled back): before, A (anniversary) listed + B (flex) missing;
   after, only B. These pin the three SQL changes and the moves section. */
describe("R-2749 report fixes", () => {
  const code = codeOnly(readFileSync(FILE, "utf8")).toLowerCase().replace(/\s+/g, " ");
  it("keeps monthly flex (cycle = term) — not only cycle < term", () => {
    expect(code).toContain("sp.cycle_months <= sp.term_months");
    expect(code).not.toContain("sp.cycle_months < sp.term_months");
  });
  it("current term starts strictly before renewal_date (anniversary date = next term, billed ahead)", () => {
    expect(code).toContain("b.term_start < sp.renewal_date");
    expect(code).not.toContain("b.term_start <= sp.renewal_date");
  });
  it("never lists a first part that renews FROM the current renewal_date (waiting for its payment)", () => {
    expect(code).toContain("f.renews_from is distinct from f.renewal_date");
  });
  it("lists every forward / back move of renewal_date (subscription_renewal_moves)", () => {
    expect(code).toMatch(/from public\.subscription_renewal_moves m/);
    expect(code).toMatch(/m\.direction, m\.from_date, m\.to_date/);
  });
});

/* R-2761 (rev-r2749 LOW 4): section 3 errored on a database without the R-2749 table; it now skips there,
   and shows each hold's kind / resolved time without needing the R-2761 columns. */
describe("R-2761 report section 3", () => {
  const raw = readFileSync(FILE, "utf8");
  it("skips section 3 when subscription_renewal_moves is missing (psql \\if on to_regclass)", () => {
    expect(raw).toMatch(/to_regclass\('public\.subscription_renewal_moves'\) is not null as r2761_has_moves \\gset/);
    expect(raw).toMatch(/\\if :r2761_has_moves[\s\S]*from public\.subscription_renewal_moves m[\s\S]*\\else[\s\S]*\\endif/);
  });
  it("reads hold_kind / resolved_at through to_jsonb (runs before R-2761 too)", () => {
    expect(raw).toContain("to_jsonb(m)->>'hold_kind'");
    expect(raw).toContain("to_jsonb(m)->>'resolved_at'");
  });
});
