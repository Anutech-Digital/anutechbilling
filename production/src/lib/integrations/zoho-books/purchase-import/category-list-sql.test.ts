/**
 * R-2502c — the SQL whitelist (_r2502_category_allowed, save_zoho_account_categories) and the
 * route's CATEGORY_CHOICES must be the SAME list: an owner calling the RPC directly can map a Zoho
 * account to exactly what the screen offers, nothing else (no special category, no free COGS-*).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { CATEGORY_CHOICES } from "./plan";

const dir = path.resolve(__dirname, "../../../../../supabase/migrations");

/** The newest migration that (re)defines _r2502_category_allowed, and the list inside it. */
function sqlList(): string[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => fs.readFileSync(path.join(dir, f), "utf8").includes("function public._r2502_category_allowed")).pop();
  if (!latest) throw new Error("no migration defines _r2502_category_allowed");
  const body = fs.readFileSync(path.join(dir, latest), "utf8");
  const m = /p_category = any \(array\[([\s\S]*?)\]\)/.exec(body);
  if (!m) throw new Error("whitelist array not found");
  return [...m[1].matchAll(/'((?:[^']|'')*)'/g)].map((x) => x[1].replace(/''/g, "'"));
}

describe("R-2502c category whitelist — SQL = screen", () => {
  it("the same categories, in the same spelling", () => {
    expect([...sqlList()].sort()).toEqual([...CATEGORY_CHOICES].sort());
  });
  it("never Salaries, never a free COGS-*", () => {
    expect(sqlList()).not.toContain("Salaries");
    expect(sqlList().filter((c) => c.startsWith("COGS-"))).toEqual(["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"]);
  });
});
