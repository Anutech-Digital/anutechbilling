/**
 * R-1130: billing opens Banking read-only (R-254), but Category Rules let it add, re-file and
 * delete the rules that categorise every imported bank line — and the database allowed it
 * (txn_category_rules policies were tenant-only; R-719 skipped the table).
 *
 * Page: every write control sits behind canWriteMoney, billing sees the rules + a view-only note.
 * DB:   insert / update / delete need owner / manager / accountant (MONEY_WRITE_ROLES); reads stay.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const page = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const migDir = path.join(__dirname, "../../../../../../supabase/migrations");
const migName = fs.readdirSync(migDir).find((f) => /_r1130_txn_rule_write_roles\.sql$/.test(f));
const mig = migName ? fs.readFileSync(path.join(migDir, migName), "utf8") : "";

describe("R-1130: Category Rules page — billing reads, money roles write", () => {
  it("reads the role and gates with canWriteMoney (same rule as Banking)", () => {
    expect(page).toContain('import { canWriteMoney } from "@/lib/nav"');
    expect(page).toMatch(/const canWrite = canWriteMoney\(useCurrentUser\(\)\.data\?\.role\)/);
  });

  it("shows billing the view-only note instead of the add form", () => {
    expect(page).toMatch(/!canWrite && <div[^>]*><ViewOnlyNote what="[^"]+" \/><\/div>/);
    expect(page).toMatch(/\{canWrite && \(\s*<Card[^>]*>\s*<form onSubmit=\{onAdd\}/);
  });

  it("table: category / side are plain text and Delete is hidden without canWrite", () => {
    expect(page).toMatch(/canWrite \? \(\s*<select\s+value=\{r\.category\}/);
    expect(page).toMatch(/canWrite \? \(\s*<select\s+value=\{r\.direction\}/);
    expect(page).toMatch(/\{canWrite && \(\s*<button[\s\S]{0,80}aria-label=\{`Delete rule/);
  });

  it("onAdd refuses without canWrite (no write fires even if the form were reached)", () => {
    expect(page).toMatch(/if \(!canWrite \|\| !pattern\.trim\(\) \|\| !category\) return;/);
  });
});

describe("R-1130: txn_category_rules writes need a money role in the database", () => {
  it("a migration exists with deploy headers and no ::regclass in the peek", () => {
    expect(migName, "supabase/migrations/*_r1130_txn_rule_write_roles.sql").toBeTruthy();
    const [l1, l2] = mig.split(/\r?\n/);
    expect(l1).toMatch(/^-- deploy-peek: /);
    expect(l1).not.toContain("::regclass");
    expect(l2).toMatch(/^-- deploy-key: [a-z0-9]+$/);
  });

  it("drops the tenant-only write policies", () => {
    for (const p of ["txn_category_rules_tenant_write", "txn_category_rules_tenant_update", "txn_category_rules_tenant_delete"]) {
      expect(mig).toMatch(new RegExp(`drop policy if exists ${p}\\s+on public\\.txn_category_rules;`));
      expect(mig).not.toMatch(new RegExp(`create policy ${p}\\b`));
    }
  });

  it("insert / update / delete check tenant AND owner / manager / accountant", () => {
    const roles = "public.current_user_has_role('owner', 'manager', 'accountant')";
    for (const op of ["insert", "update", "delete"]) {
      const m = mig.match(new RegExp(`create policy txn_category_rules_${op}_money_roles on public\\.txn_category_rules for ${op} to authenticated([\\s\\S]*?);`));
      expect(m, op).toBeTruthy();
      expect(m![1]).toContain("tenant_id = public.current_tenant_id()");
      expect(m![1]).toContain(roles);
      expect(m![1]).not.toContain("'billing'");
    }
  });

  it("reads are untouched", () => {
    expect(mig).not.toMatch(/drop policy if exists txn_category_rules_tenant_read/);
  });
});
