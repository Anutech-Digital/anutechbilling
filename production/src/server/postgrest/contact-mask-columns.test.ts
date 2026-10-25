/**
 * R-1820 (24 Oct 2026, security audit) — ratchet: every column of leads / customers / contacts /
 * customer_groups whose name says phone / email / mobile / whatsapp is covered by the contact
 * masker (contact-mask.ts). The masker listed only the top-level columns, so contacts.emails /
 * contacts.phones (jsonb lists) and customer_groups.contact_email / contact_phone reached a
 * masked role in clear text. A column added later fails here until it is masked or listed in
 * NOT_A_CONTACT with the reason.
 *
 * Columns come from BOTH the generated types (src/lib/supabase/database.generated.ts) and every
 * migration's `add column` / `create table` for these tables — the types can lag a migration.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { maskedColumns, CONTACT_JSON_COLUMNS } from "./contact-mask";

const ROOT = join(__dirname, "..", "..", "..");
const TABLES = ["leads", "customers", "contacts", "customer_groups"] as const;
const CONTACTY = /phone|email|mobile|whatsapp/;

/** Matches the name pattern but holds no phone / email — with the reason. */
const NOT_A_CONTACT: Readonly<Record<string, string>> = {
};

function typeColumns(table: string): string[] {
  const src = readFileSync(join(ROOT, "src/lib/supabase/database.generated.ts"), "utf8").replace(/\r/g, "");
  const start = src.indexOf(`\n      ${table}: {\n        Row: {\n`);
  if (start < 0) return [];
  const from = src.indexOf("Row: {\n", start) + "Row: {\n".length;
  const end = src.indexOf("\n        }", from);
  return [...src.slice(from, end).matchAll(/^ {10}([a-z_0-9]+): /gm)].map((m) => m[1]);
}

let migrations: string[] | null = null;
function migrationSql(): string[] {
  if (!migrations) {
    const dir = join(ROOT, "supabase/migrations");
    migrations = readdirSync(dir).filter((n) => n.endsWith(".sql"))
      .map((f) => readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, ""))
      .filter((sql) => /\b(leads|customers|contacts|customer_groups)\b/.test(sql));
  }
  return migrations;
}

function migrationColumns(table: string): string[] {
  const out = new Set<string>();
  const addCol = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?(?:public\\.)?"?${table}"?\\s+([^;]*?);`, "gi");
  for (const sql of migrationSql()) {
    if (!sql.includes(table)) continue;
    for (const m of sql.matchAll(addCol)) {
      for (const c of m[1].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_0-9]+)"?/gi)) out.add(c[1].toLowerCase());
    }
    const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?"?${table}"?\\s*\\(([^;]*?)\\n\\);`, "gi");
    for (const m of sql.matchAll(create)) {
      for (const line of m[1].split("\n")) {
        const c = line.trim().match(/^"?([a-z_0-9]+)"?\s+[a-z]/i);
        if (c && !/^(constraint|primary|unique|foreign|check|exclude)$/i.test(c[1])) out.add(c[1].toLowerCase());
      }
    }
  }
  return [...out];
}

describe("R-1820: the contact masker covers every phone / email column", () => {
  it("reads the columns (the scan itself works)", () => {
    for (const t of TABLES) expect(typeColumns(t).length, `${t} in database.generated.ts`).toBeGreaterThan(5);
    expect(typeColumns("contacts")).toContain("emails");
    expect(migrationColumns("leads")).toContain("billing_cycle"); // added by 20260930200000
  });

  for (const t of TABLES) {
    it(`${t}: every /phone|email|mobile|whatsapp/ column is masked`, () => {
      const cols = new Set([...typeColumns(t), ...migrationColumns(t)]);
      const missing = [...cols].filter((c) => CONTACTY.test(c) && !maskedColumns(t).includes(c) && !NOT_A_CONTACT[`${t}.${c}`]);
      expect(missing, `mask these in contact-mask.ts (or list them in NOT_A_CONTACT with the reason)`).toEqual([]);
    });
  }

  it("R-1850: a director's email / phone (company_directors) is masked too", () => {
    const sql = readFileSync(join(ROOT, "supabase/migrations/20261024205900_r1850_company_directors.sql"), "utf8");
    const body = sql.match(/create table if not exists public\.company_directors \(([\s\S]*?)\n\);/)?.[1] ?? "";
    const cols = body.split("\n").map((l) => l.trim().match(/^([a-z_0-9]+)\s+[a-z]/)?.[1]).filter((c): c is string => Boolean(c) && c !== "constraint");
    expect(cols).toContain("din");
    const contacty = cols.filter((c) => CONTACTY.test(c));
    expect(contacty).toEqual(["email", "phone"]);
    for (const c of contacty) expect(maskedColumns("company_directors")).toContain(c);
  });

  it("customers.contact_persons (people's emails / phones inside a jsonb list) is masked", () => {
    expect(CONTACT_JSON_COLUMNS.customers).toContain("contact_persons");
    expect(maskedColumns("customers")).toContain("contact_persons");
  });
});
