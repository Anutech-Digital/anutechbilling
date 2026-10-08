/**
 * Guards for migration 20261007000000_lead_search_tokens.sql (R-221).
 *
 *  1. list_leads() and lead_counts() are 20260930200000's bodies VERBATIM except the search
 *     lines — re-derived here from that migration, so nothing else can slip in.
 *  2. public.lead_search_hit() uses the same phone rule constants as lead-search.ts.
 *  3. Grants: authenticated only, for the new helper.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PHONE_LIKE, PHONE_MIN_DIGITS } from "./lead-search";

const MIG = path.join(__dirname, "..", "..", "..", "supabase", "migrations");
const read = (name: string) => fs.readFileSync(path.join(MIG, name), "utf8").replace(/\r\n/g, "\n");
const OLD = read("20260930200000_deal_totals_billing_cycle_dup_check.sql");
const NEW = read("20261007000000_lead_search_tokens.sql");

function block(sql: string, start: string, end: string): string {
  const a = sql.indexOf(start);
  const b = sql.indexOf(end, a);
  expect(a, `${start} missing`).toBeGreaterThan(-1);
  expect(b, `${end} missing`).toBeGreaterThan(a);
  return sql.slice(a, b + end.length);
}

/** The only edits R-221 makes to a function body: the search variable and its WHERE lines. */
function rederive(body: string, alias: "l" | "f", counts: boolean): string {
  const out: string[] = [];
  const src = body.split("\n");
  for (let i = 0; i < src.length; i++) {
    const ln = src[i];
    if (ln === "  v_pattern   text;") { if (counts) out.push("  v_search    text;"); continue; }
    if (ln.startsWith("    v_search  := lower(v_f->>'search');")) { out.push("    v_search  := v_f->>'search';"); continue; }
    if (ln.startsWith("    v_pattern := ")) { if (counts) out.push("    v_search := v_f->>'search';"); continue; }
    if (ln.trim() === "and (v_pattern is null") {
      out.push("       and (v_search is null",
        `            or public.lead_search_hit(v_search, ${alias}.company, ${alias}.contact_name, ${alias}.contact_email, ${alias}.contact_phone, ${alias}.plan))`);
      i += 5;
      continue;
    }
    out.push(ln);
  }
  return out.join("\n")
    .replace("'S37+S40+R-070: one keyset page", "'S37+S40+R-070+R-221: one keyset page")
    .replace("'S40+R-070: every count", "'S40+R-070+R-221: every count");
}

describe("20261007000000_lead_search_tokens — only the search changed", () => {
  it("list_leads is 20260930200000's body with the new search", () => {
    const s = "create or replace function public.list_leads(";
    const e = "grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;";
    expect(block(NEW, s, e)).toBe(rederive(block(OLD, s, e), "l", false));
  });

  it("lead_counts is 20260930200000's body with the new search", () => {
    const s = "create or replace function public.lead_counts(";
    const e = "grant execute on function public.lead_counts(jsonb) to authenticated;";
    expect(block(NEW, s, e)).toBe(rederive(block(OLD, s, e), "f", true));
  });

  it("no LIKE pattern is left in either function", () => {
    expect(NEW).not.toMatch(/v_pattern/);
  });
});

describe("lead_search_hit ↔ lead-search.ts", () => {
  const fn = block(NEW, "create or replace function public.lead_search_hit(", "$fn$;");

  it("uses the same phone-like pattern and minimum digits", () => {
    expect(fn).toContain(`v_q ~ '${PHONE_LIKE.source}'`);
    expect(fn).toContain(`length(v_digits) >= ${PHONE_MIN_DIGITS}`);
  });

  it("is immutable, has an empty search_path, and reads no table", () => {
    expect(fn).toMatch(/\bimmutable\b/);
    expect(fn).toContain("set search_path = ''");
    expect(fn).not.toMatch(/\bfrom\s+public\./i);
  });

  it("is granted to authenticated only", () => {
    const sig = "public.lead_search_hit(text, text, text, text, text, text)";
    expect(NEW).toContain(`revoke all on function ${sig} from public;`);
    expect(NEW).toContain(`revoke all on function ${sig} from anon;`);
    expect(NEW).toContain(`grant execute on function ${sig} to authenticated;`);
  });
});
