import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/* R-2620 (9 Nov 2026): scripts/ops/report-overseas-no-country.sql is run by Pardeep on staging / live
   (docs/playbooks/overseas-no-country.md) to list customers marked Overseas with no country outside
   India — read as India on new invoices (G5). It must only READ, and it must find a planted row.

   Part 1 (always): no write / DDL keyword outside comments and strings; begin + set transaction read
   only … rollback; the rule inlined (works without R-2620's overseas_country_missing).
   Part 2 (only where the local Supabase container runs — skipped in CI): the report body runs on the
   LOCAL DB after a planted fixture in ONE transaction that is rolled back: an Overseas customer with an
   empty country and one with country India are listed with their draft quote; an Overseas customer with
   its country and a domestic customer with an empty country are not. */

const FILE = fileURLToPath(new URL("../../scripts/ops/report-overseas-no-country.sql", import.meta.url));
const SQL = readFileSync(FILE, "utf8");
const CONTAINER = "supabase_db_resellerosv3";

function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith("'") ? "''" : " "));
}

const WRITE_OR_DDL = [
  "insert", "update", "delete", "merge", "upsert", "truncate", "create", "alter", "drop",
  "grant", "revoke", "comment", "copy", "call", "do", "execute", "prepare", "vacuum", "analyze",
  "reindex", "cluster", "refresh", "lock", "listen", "notify", "commit", "savepoint", "reset",
  "security", "into", "nextval", "setval", "dblink", "set_config", "pg_read_file", "pg_write_file",
];

function forbidden(sql: string): string[] {
  const code = codeOnly(sql).toLowerCase();
  const hits = WRITE_OR_DDL.filter((w) => new RegExp(`\\b${w}\\b`).test(code));
  for (const s of code.match(/(^|[^\\\w])set\b[^;]*/g) ?? []) {
    if (!/set\s+transaction\s+read\s+only\s*$/.test(s.trim())) hits.push(`set: ${s.trim().slice(0, 40)}`);
  }
  for (const m of code.match(/\\[a-z!]+/g) ?? []) {
    if (m !== "\\echo" && m !== "\\pset") hits.push(m);
  }
  return hits;
}

describe("R-2620 Overseas-with-no-country report — read-only", () => {
  it("has no write, DDL or side-effect keyword outside comments", () => {
    expect(forbidden(SQL)).toEqual([]);
  });

  it("runs inside begin; set transaction read only; … rollback;", () => {
    const code = codeOnly(SQL).toLowerCase().replace(/\s+/g, " ").trim();
    expect(code.startsWith("begin; set transaction read only;")).toBe(true);
    expect(code.endsWith("rollback;")).toBe(true);
    expect(code.match(/\bbegin\b/g)?.length).toBe(1);
  });

  it("inlines the rule (empty country = India) instead of needing R-2620's function", () => {
    expect(codeOnly(SQL)).not.toMatch(/overseas_country_missing/);
    expect(SQL.match(/coalesce\(nullif\(lower\(btrim\([a-z_.]*country\)\), ''\), 'india'\) in \('india', 'in', 'ind', 'bharat'\)/g)?.length).toBe(3);
  });
});

function dockerUp(): boolean {
  const r = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

const FIXTURE = `
create function pg_temp.fill_supplier() returns trigger language plpgsql as $f$
begin
  new.address := coalesce(nullif(btrim(coalesce(new.address, '')), ''), 'Test street, India');
  if new.gst_registration is distinct from 'unregistered' and nullif(btrim(coalesce(new.gstin, '')), '') is null then
    new.gstin := '07AAACT1643F1Z5';
  end if;
  return new;
end $f$;
create trigger zz_r2620_test_supplier before insert on public.tenants for each row execute function pg_temp.fill_supplier();
insert into public.tenants (id, name, email, state_code, doc_code) values
  ('dddddddd-0000-0000-0000-000000262091','R2620 Report Co','r2620r@example.in','07','R691');
insert into public.customers (id, tenant_id, name, country, customer_type, gst_treatment, domain) values
  ('cccccccc-0000-0000-0000-000000262091','dddddddd-0000-0000-0000-000000262091','R2620 Empty Country Studio','','business','overseas','e2620.example'),
  ('cccccccc-0000-0000-0000-000000262092','dddddddd-0000-0000-0000-000000262091','R2620 India Overseas','India','business','overseas','i2620r.example'),
  ('cccccccc-0000-0000-0000-000000262093','dddddddd-0000-0000-0000-000000262091','R2620 Real Export LLC','United States','business','overseas','u2620r.example'),
  ('cccccccc-0000-0000-0000-000000262094','dddddddd-0000-0000-0000-000000262091','R2620 Delhi Blank','','business','unregistered_business','d2620r.example');
insert into public.quotes (id, tenant_id, customer_id, customer_name, amount, subtotal, tax_rate, status, line_items) values
  ('Q-R2620-RPT', 'dddddddd-0000-0000-0000-000000262091', 'cccccccc-0000-0000-0000-000000262091', 'R2620 Empty Country Studio', 59000, 50000, 18, 'draft', '[]'::jsonb);
`;

describe.skipIf(!dockerUp())("R-2620 report on the local DB (planted, rolled back)", () => {
  it("lists Overseas + empty / India, not Overseas + US nor a domestic blank", () => {
    const body = SQL.replace(/^begin;\s*\nset transaction read only;\s*$/m, "").replace(/^rollback;\s*$/m, "");
    const script = `\\set ON_ERROR_STOP 1\nbegin;\n${FIXTURE}\n${body}\nrollback;\n`;
    const r = spawnSync("docker", ["exec", "-i", CONTAINER, "psql", "-X", "-U", "postgres", "-d", "postgres"],
      { input: script, encoding: "utf8", timeout: 60_000 });
    expect(r.stderr).not.toMatch(/ERROR/);
    const out = r.stdout;
    const sec1 = out.split("=== 1.")[1].split("=== 2.")[0];
    const sec2 = out.split("=== 2.")[1].split("=== 3.")[0];
    expect(sec1).toMatch(/R2620 Report Co\s*\|\s*2\s*\|/);
    expect(sec2).toContain("R2620 Empty Country Studio");
    expect(sec2).toMatch(/R2620 Empty Country Studio\s*\|\s*\(empty\)\s*\|[^\n]*\|\s*0\s*\|\s*1\s*\|/);
    expect(sec2).toMatch(/R2620 India Overseas\s*\|\s*India\s*\|/);
    expect(sec2).not.toContain("R2620 Real Export LLC");
    expect(sec2).not.toContain("R2620 Delhi Blank");
    expect(out.trim().endsWith("ROLLBACK")).toBe(true);
  }, 90_000);
});
