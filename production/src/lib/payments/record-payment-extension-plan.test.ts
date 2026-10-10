/* R-812 — paying an extension/renewal quote must keep the subscription's own plan.
 *
 * Staging (10 Oct 2026): after the 3-month extension quote was paid, the subscription's plan
 * became "Google Workspace Business Starter (10 seats) · 3-month extension" — record_payment's
 * renewal branch copied the quote LINE name into subscriptions.plan. The roll-forward lives in
 * SQL, so this guards the LATEST migration that defines record_payment (a later migration that
 * copies an older body would bring the bug back). Proven on the local DB in begin…rollback:
 * before → plan "Workspace Plus · 3-month extension"; after → "Workspace Plus".
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const MIG_DIR = path.join(process.cwd(), "supabase/migrations");

function latestRecordPaymentMigration(): { file: string; sql: string } {
  const files = fs.readdirSync(MIG_DIR).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  for (let i = files.length - 1; i >= 0; i--) {
    const sql = fs.readFileSync(path.join(MIG_DIR, files[i]), "utf8");
    if (/create or replace function public\.record_payment\(/i.test(sql)) return { file: files[i], sql };
  }
  throw new Error("no migration defines record_payment");
}

/** The `if v_is_renewal_quote and v_is_fully_paid then … end if;` roll-forward block. */
function renewalBranch(sql: string): string {
  const start = sql.indexOf("if v_is_renewal_quote and v_is_fully_paid then");
  expect(start, "renewal roll-forward branch not found").toBeGreaterThan(-1);
  const end = sql.indexOf("v_renewal_rolled_forward := true;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
}

describe("record_payment renewal/extension branch keeps the subscription plan (R-812)", () => {
  const { file, sql } = latestRecordPaymentMigration();
  const branch = renewalBranch(sql);

  it("the latest record_payment is at or after the R-812 fix", () => {
    expect(file >= "20261010173000").toBe(true);
  });

  it("plan comes from the subscription, not from the quote line name", () => {
    expect(branch).toMatch(/v_plan_name\s*:=\s*coalesce\(nullif\(trim\(v_renewal_sub\.plan\), ''\), v_first_line->>'name'\)/);
    // The old line that renamed the subscription ("<plan> · 3-month extension").
    expect(branch).not.toMatch(/v_plan_name\s*:=\s*coalesce\(v_first_line->>'name'/);
  });

  it("still writes plan from v_plan_name and keeps the R-805 month-extension date rule", () => {
    expect(branch).toMatch(/plan = v_plan_name/);
    expect(branch).toMatch(/v_extension_months % 12 <> 0/);
    expect(branch).toMatch(/when coalesce\(v_quote\.is_extension, false\) then 'pending'/);
  });

  it("deploy header: peek uses to_regprocedure (no ::regclass) and a letters/digits key", () => {
    const head = sql.split("\n").slice(0, 3).join("\n");
    expect(head).toMatch(/^-- deploy-key: [a-z0-9]+$/m);
    expect(head).toMatch(/^-- deploy-peek: .*to_regprocedure\('public\.record_payment\(text,integer,text,text,text\)'\).*R-812/m);
    expect(head).not.toMatch(/::regclass/);
  });
});
