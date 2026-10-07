/**
 * Guards for migration 20261007190000_lead_source_filter_search.sql (R-392).
 *
 *  1. list_leads() and lead_counts() are 20261007000000's bodies VERBATIM except the
 *     sources filter, the 8-argument search call and lead_counts' by_source — re-derived
 *     here, so nothing else (e.g. the 'mine' view's auth.uid()) can slip in.
 *  2. public.lead_source_key / lead_source_label carry exactly LEAD_SOURCES (lead-sources.ts).
 *  3. The new lead_search_hit keeps the same phone rule constants as lead-search.ts.
 *  4. Grants: authenticated only; the file starts with a deploy-peek header.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PHONE_LIKE, PHONE_MIN_DIGITS } from "./lead-search";
import { LEAD_SOURCES } from "./lead-sources";

const MIG = path.join(__dirname, "..", "..", "..", "supabase", "migrations");
const read = (name: string) => fs.readFileSync(path.join(MIG, name), "utf8").replace(/\r\n/g, "\n");
const OLD = read("20261007000000_lead_search_tokens.sql");
const NEW = read("20261007190000_lead_source_filter_search.sql");

function block(sql: string, start: string, end: string): string {
  const a = sql.indexOf(start);
  const b = sql.indexOf(end, a);
  expect(a, `${start} missing`).toBeGreaterThan(-1);
  expect(b, `${end} missing`).toBeGreaterThan(a);
  return sql.slice(a, b + end.length);
}

function once(s: string, a: string, b: string): string {
  expect(s.split(a).length - 1, `expected exactly one: ${a}`).toBe(1);
  return s.replace(a, () => b);
}

const OWNERS_PARSE = "    select array_agg(x) into v_owners from jsonb_array_elements_text(v_f->'owners') x;\n  end if;\n";

/** The only edits R-392 makes to a function body. */
function rederive(body: string, a: "l" | "f"): string {
  let s = once(body, "  v_owners    text[];\n", "  v_owners    text[];\n  v_sources   text[];\n");
  s = once(s, OWNERS_PARSE, OWNERS_PARSE
    + "  if jsonb_typeof(v_f->'sources') = 'array' and jsonb_array_length(v_f->'sources') > 0 then\n"
    + "    select array_agg(x) into v_sources from jsonb_array_elements_text(v_f->'sources') x;\n  end if;\n");
  s = once(s,
    `            or public.lead_search_hit(v_search, ${a}.company, ${a}.contact_name, ${a}.contact_email, ${a}.contact_phone, ${a}.plan))`,
    `            or public.lead_search_hit(v_search, ${a}.company, ${a}.contact_name, ${a}.contact_email, ${a}.contact_phone, ${a}.plan,\n`
    + `                                      ${a}.source, (select u.full_name from public.users u where u.id = ${a}.owner_id)))`);
  s = once(s, `            or ${a}.owner_id::text = any (v_owners))\n`,
    `            or ${a}.owner_id::text = any (v_owners))\n`
    + "       -- Source (R-392)\n"
    + `       and (v_sources is null or public.lead_source_key(${a}.source) = any (v_sources))\n`);
  return s;
}

const LIST = ["create or replace function public.list_leads(",
  "grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;"] as const;
const CNT = ["create or replace function public.lead_counts(",
  "grant execute on function public.lead_counts(jsonb) to authenticated;"] as const;

describe("20261007190000_lead_source_filter_search — only search + sources changed", () => {
  it("starts with deploy-key / deploy-peek headers (gen-deploy-db)", () => {
    const [l1, l2] = NEW.split("\n");
    expect(l1).toMatch(/^-- deploy-key: \w+$/);
    expect(l2).toMatch(/^-- deploy-peek: \(exists\(/);
    expect(l2).not.toMatch(/[|"$]/);
  });

  it("list_leads is 20261007000000's body + sources + the 8-arg search", () => {
    const want = rederive(block(OLD, ...LIST), "l")
      .replace("'S37+S40+R-070+R-221: one keyset page", "'S37+S40+R-070+R-221+R-392: one keyset page");
    expect(block(NEW, ...LIST)).toBe(want);
  });

  it("lead_counts is 20261007000000's body + sources + the 8-arg search + pool.by_source", () => {
    let want = rederive(block(OLD, ...CNT), "f");
    want = once(want, "           l.requires_human_attention\n      from public.leads l\n",
      "           l.requires_human_attention, l.source\n      from public.leads l\n");
    want = once(want,
      "                                            where owner_id is not null group by owner_id) o), '{}'::jsonb))\n",
      "                                            where owner_id is not null group by owner_id) o), '{}'::jsonb),\n"
      + "        'by_source',     coalesce((select jsonb_object_agg(o.k, o.n)\n"
      + "                                     from (select public.lead_source_key(source) as k, count(*) as n from pool\n"
      + "                                            where public.lead_source_key(source) <> '' group by 1) o), '{}'::jsonb))\n");
    want = want.replace("'S40+R-070+R-221: every count", "'S40+R-070+R-221+R-392: every count");
    expect(block(NEW, ...CNT)).toBe(want);
  });

  it("the 'mine' view still reads auth.uid() (staging deploy rewrites it)", () => {
    expect(block(NEW, ...LIST)).toContain("l.owner_id = auth.uid()");
    expect(block(NEW, ...CNT)).toContain("v_me        uuid    := auth.uid();");
  });

  it("nothing calls the old 6-argument lead_search_hit any more", () => {
    expect(NEW).not.toMatch(/lead_search_hit\(v_search, [lf]\.company, [lf]\.contact_name, [lf]\.contact_email, [lf]\.contact_phone, [lf]\.plan\)\)/);
  });
});

describe("lead_source_key / lead_source_label ↔ LEAD_SOURCES", () => {
  const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const keyFn = block(NEW, "create or replace function public.lead_source_key(", "$fn$;");
  const labelFn = block(NEW, "create or replace function public.lead_source_label(", "$fn$;");

  it("maps every key and lowercased label to the key", () => {
    for (const s of LEAD_SOURCES) {
      /* Searched CASE: Postgres has no `when 'a', 'b'` list form (that is MySQL) — the first
         version used it and failed on apply (caught 7 Oct applying on local). */
      expect(keyFn).toContain(`    when lower(btrim(coalesce(p_source, ''))) in (${sq(s.value)}, ${sq(s.label.toLowerCase())}) then ${sq(s.value)}`);
    }
    expect(keyFn.match(/^ {4}when /gm)?.length).toBe(LEAD_SOURCES.length);
  });

  it("labels every key", () => {
    for (const s of LEAD_SOURCES) expect(labelFn).toContain(`    when ${sq(s.value)} then ${sq(s.label)}`);
    expect(labelFn.match(/^ {4}when /gm)?.length).toBe(LEAD_SOURCES.length);
  });

  it("both are immutable with an empty search_path", () => {
    for (const fn of [keyFn, labelFn]) {
      expect(fn).toMatch(/\bimmutable\b/);
      expect(fn).toContain("set search_path = ''");
    }
  });
});

describe("8-argument lead_search_hit ↔ lead-search.ts", () => {
  const fn = block(NEW, "create or replace function public.lead_search_hit(", "$fn$;");

  it("uses the same phone-like pattern and minimum digits", () => {
    expect(fn).toContain(`v_q ~ '${PHONE_LIKE.source}'`);
    expect(fn).toContain(`length(v_digits) >= ${PHONE_MIN_DIGITS}`);
  });

  it("searches the source text and the assigned person's name", () => {
    expect(fn).toContain("p_source text,");
    expect(fn).toContain("p_owner_name text");
    expect(fn).toContain("replace(v_raw, '-', ' ')");
    expect(fn).toContain("public.lead_source_label(public.lead_source_key(v_raw))");
    expect(fn).toContain("strpos(v_src, v_word) > 0");
    expect(fn).toContain("strpos(v_owner, v_word) > 0");
  });

  it("is immutable, has an empty search_path, and reads no table", () => {
    expect(fn).toMatch(/\bimmutable\b/);
    expect(fn).toContain("set search_path = ''");
    expect(fn).not.toMatch(/\bfrom\s+public\./i);
  });

  it("every new function is granted to authenticated only", () => {
    for (const sig of [
      "public.lead_search_hit(text, text, text, text, text, text, text, text)",
      "public.lead_source_key(text)",
      "public.lead_source_label(text)",
    ]) {
      expect(NEW).toContain(`revoke all on function ${sig} from public;`);
      expect(NEW).toContain(`revoke all on function ${sig} from anon;`);
      expect(NEW).toContain(`grant execute on function ${sig} to authenticated;`);
    }
  });
});
