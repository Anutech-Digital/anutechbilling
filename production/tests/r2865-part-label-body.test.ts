import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { readSource } from "@/lib/testing/source-cache"; // shared read cache for whole-folder walks (R-2564)

/* R-2865 (16 Nov 2026) — a money RPC was redefined only to change a label ("Advance payment for …" →
   "Payment for …"). This proves the new bodies of bill_subscription_instalment and bill_parts_together are
   the LATEST earlier bodies, line for line, except the label literal and the R-2865 comment lines — so no
   amount, GST, period, link, lock or guard line changed, and no newer rule was dropped. */

const MIG = path.resolve(__dirname, "..", "supabase", "migrations");
const NEW = "20261116140831_r2865_part_label_payment.sql";

function body(file: string, fn: string): string[] {
  const t = fs.readFileSync(path.join(MIG, file), "utf8").replace(/\r\n/g, "\n");
  const s = t.indexOf(`create or replace function public.${fn}(`);
  expect(s, `${fn} in ${file}`).toBeGreaterThan(-1);
  const e = t.indexOf("\n$$;\n", s);
  expect(e).toBeGreaterThan(s);
  return t.slice(s, e + 4).split("\n");
}

/** The newest migration (by file name) before NEW that defines the function. */
function latestBefore(fn: string): string {
  const files = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f < NEW).sort();
  const hits = files.filter((f) => readSource(path.join(MIG, f)).toLowerCase().includes(`create or replace function public.${fn}(`));
  return hits[hits.length - 1];
}

const OLD_LABEL = "v_label := 'Advance payment for '";
const NEW_LABEL = "v_label := 'Payment for '";

describe("R-2865: only the label text of the part-proforma RPCs changed", () => {
  it.each([
    ["bill_subscription_instalment", "20261106120956_r2527_review_followups.sql"],
    ["bill_parts_together", "20261114165044_r2810_bill_parts_together.sql"],
  ])("%s is the body of %s with one string changed", (fn, expectedBase) => {
    // copied from the LATEST definition, not an older one
    expect(latestBefore(fn)).toBe(expectedBase);

    const oldLines = body(expectedBase, fn);
    const newLines = body(NEW, fn);

    // the old body: its one label line, and (Bill next part) its one comment line quoting the old text
    expect(oldLines.filter((l) => l.includes(OLD_LABEL))).toHaveLength(1);
    const oldKept = oldLines
      .filter((l) => !/^\s*\/\* "Advance payment for Q2 · 28 Jan–27 Apr 2027" — period_end is exclusive \(schedule\.ts\)\. \*\/$/.test(l))
      .map((l) => (l.includes(OLD_LABEL) ? l.replace(OLD_LABEL, NEW_LABEL) : l));

    // the new body: exactly one R-2865 comment line added, the label line changed
    const marks = newLines.filter((l) => l.includes("R-2865"));
    expect(marks).toHaveLength(1);
    expect(marks[0].trim().startsWith("/* R-2865:")).toBe(true);
    expect(marks[0].trim().endsWith("*/")).toBe(true);
    expect(marks[0].slice(marks[0].indexOf("/*") + 2, marks[0].lastIndexOf("*/"))).not.toContain("*/");
    expect(newLines.filter((l) => l.includes(NEW_LABEL))).toHaveLength(1);
    expect(newLines.some((l) => l.includes("'Advance payment"))).toBe(false);

    expect(newLines.filter((l) => !l.includes("R-2865"))).toEqual(oldKept);
  });

  it("no migration after it writes the old label again", () => {
    const later = fs.readdirSync(MIG).filter((f) => f.endsWith(".sql") && f > NEW);
    for (const f of later) {
      expect(readSource(path.join(MIG, f)).includes("'Advance payment for '"), f).toBe(false);
    }
  });

  it("the migration restates the grants and touches nothing else", () => {
    const t = fs.readFileSync(path.join(MIG, NEW), "utf8");
    expect(t.match(/create or replace function/g)).toHaveLength(2);
    expect(t).toContain("grant execute on function public.bill_subscription_instalment(uuid, boolean) to authenticated, service_role;");
    expect(t).toContain("grant execute on function public.bill_parts_together(uuid[]) to authenticated, service_role;");
    expect(/\b(update|delete from|insert into)\s+public\.quotes\b[^;]*;\s*$/m.test(t.slice(t.lastIndexOf("$$;")))).toBe(false);
    expect(/^\s*(alter|drop|create (table|trigger|index|policy))/im.test(t)).toBe(false);
  });
});
