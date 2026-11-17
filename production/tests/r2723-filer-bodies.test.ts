/**
 * R-2723 — the three subscription filers are re-defined ONLY to name the quote line they file.
 *
 * record_payment, activate_quote_on_credit and file_invoiced_quote_subscriptions are 300–1,000
 * line money functions. The R-2723 migration re-creates them from their newest definitions with
 * exactly two added lines each (set `app.r2723_quote_line` at the top of the line loop, clear it
 * after the loop). This test proves that: the new body minus the lines marked R-2723 is the older
 * newest body, byte for byte — so nothing another card added (R-2848, R-2230, R-2097 …) is lost.
 *
 * If a later card re-defines one of these filers from a body without the two lines, the trigger
 * falls back to counting (R-2712) — tests/…/r2723_quote_line_pick.test.sql then goes red.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { readSource } from "@/lib/testing/source-cache";
import path from "node:path";

const MIGRATIONS = path.resolve(__dirname, "../supabase/migrations");
const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
const mine = files.find((f) => /_r2723_quote_line_hint\.sql$/.test(f));

/** The text of `create or replace function public.<name>(` … closing dollar tag, or null. */
function functionBody(file: string, name: string): string[] | null {
  const lines = readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/\r\n/g, "\n").split("\n");
  const start = new RegExp(`^create or replace function public\\.${name}\\(`, "i");
  const at = lines.findIndex((l) => start.test(l));
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^\$(function)?\$\s*;?\s*$/.test(l));
  if (end < 0) return null;
  return lines.slice(at, end + 1);
}

const OLDER: Record<string, string> = {
  record_payment: "20261115134526_r2848_renewal_together_payment.sql",
  activate_quote_on_credit: "20261101184900_r2230_part_due_dates.sql",
  file_invoiced_quote_subscriptions: "20261029045403_r2097_opening_sub_fractional_tier.sql",
};

describe("R-2723 — the filers name their quote line, nothing else changes", () => {
  it("the migration exists", () => {
    expect(mine).toBeTruthy();
  });

  for (const [name, older] of Object.entries(OLDER)) {
    it(`${name}: the older file is still the newest definition before R-2723`, () => {
      const start = new RegExp(`^create or replace function public\\.${name}\\(`, "im");
      const definers = files.filter((f) => f < mine! && start.test(readSource(path.join(MIGRATIONS, f))));
      expect(definers[definers.length - 1]).toBe(older);
    });

    it(`${name}: new body = newest older body + the two R-2723 lines`, () => {
      const was = functionBody(older, name)!;
      const now = functionBody(mine!, name)!;
      expect(was).toBeTruthy();
      expect(now).toBeTruthy();
      const added = now.filter((l) => l.includes("R-2723"));
      expect(added.map((l) => l.trim())).toEqual([
        "perform set_config('app.r2723_quote_line', p_quote_id || '|' || v_line_idx, true);  -- R-2723: this row's quote line, for subscription_term_follows_line",
        "perform set_config('app.r2723_quote_line', '', true);  -- R-2723",
      ]);
      const strip = (ls: string[]) => ls.join("\n").replace(/\s*;?\s*$/, "");
      expect(strip(now.filter((l) => !l.includes("R-2723")))).toBe(strip(was));

      // The set sits right after the loop reads its line; the clear right after that loop ends.
      const setAt = now.findIndex((l) => l.includes("p_quote_id || '|' || v_line_idx"));
      expect(now[setAt - 1].trim()).toBe("v_first_line := v_quote.line_items -> v_line_idx;");
      expect(now[setAt - 2].trim()).toBe("for v_line_idx in 0 .. jsonb_array_length(v_quote.line_items) - 1 loop");
      const loopIndent = /^\s*/.exec(now[setAt - 2])![0];
      const clearAt = now.findIndex((l) => l.includes("'app.r2723_quote_line', '', true"));
      expect(now[clearAt - 1]).toBe(`${loopIndent}end loop;`);
      const firstLoopEnd = now.findIndex((l, i) => i > setAt && l === `${loopIndent}end loop;`);
      expect(clearAt - 1).toBe(firstLoopEnd);
    });
  }

  it("the trigger reads the setting and keeps the R-2712 pick as the fallback", () => {
    const body = functionBody(mine!, "subscription_term_follows_line")!.join("\n");
    expect(body).toContain("current_setting('app.r2723_quote_line', true)");
    expect(body).toContain("if not v_hinted then");
    const was = functionBody("20261113004902_r2712_bulk_line_years.sql", "subscription_term_follows_line")!;
    // Every line of the R-2712 body is still there, in order (R-2723 only adds).
    const nowLines = functionBody(mine!, "subscription_term_follows_line")!;
    let i = 0;
    for (const l of nowLines) if (i < was.length && l === was[i]) i++;
    expect(i).toBe(was.length);
  });
});
