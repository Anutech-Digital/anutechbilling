/**
 * Guards for migration 20261007300000_lead_list_sort.sql (R-420).
 *
 *  1. list_leads() is 20261007190000's body (R-392) VERBATIM except the sort edits listed in
 *     SORT_EDITS — re-derived here, so nothing else (filters, the 'mine' view's auth.uid(),
 *     the select list) can slip in with the sort change.
 *  2. The sorts the SQL accepts are exactly the server sorts the page can send
 *     (lead-sort.ts#serverSortFor over LEAD_SORTS).
 *  3. The stage key's order is the funnel order (stage-meta.ts#LEAD_STAGE_IDS, then lost).
 *  4. Grants: authenticated only; deploy-key / deploy-peek headers for gen-deploy-db.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEAD_SORTS, serverSortFor } from "./lead-sort";
import { LEAD_STAGE_IDS } from "./stage-meta";

const MIG = path.join(__dirname, "..", "..", "..", "supabase", "migrations");
const read = (name: string) => fs.readFileSync(path.join(MIG, name), "utf8").replace(/\r\n/g, "\n");
const OLD = read("20261007190000_lead_source_filter_search.sql");
const NEW = read("20261007300000_lead_list_sort.sql");

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

const NAME_KEY = "lower(coalesce(nullif(btrim(l.contact_name), ''), nullif(btrim(l.company), ''), "
  + "nullif(btrim(l.contact_email), ''), nullif(btrim(l.contact_phone), ''), ''))";

/** The only edits R-420 makes to list_leads. */
const SORT_EDITS: Array<[string, string]> = [
  ["  v_c_key     numeric;\n", "  v_c_key     numeric;\n  v_c_num     numeric;\n  v_c_txt     text;\n"],
  ["  if v_sort not in ('created', 'wait') then\n"
   + "    raise exception 'list_leads: sort must be created or wait (got %)', v_sort using errcode = '22023';\n",
   "  if v_sort not in ('created', 'wait', 'oldest', 'value', 'followup', 'name', 'stage') then\n"
   + "    raise exception 'list_leads: sort must be created, wait, oldest, value, followup, name or stage (got %)', v_sort using errcode = '22023';\n"],
  ["    else\n      v_c_at := nullif(p_cursor->>'created_at', '')::timestamptz;\n",
   "    elsif v_sort <> 'created' then\n"
   + "      v_c_num := nullif(p_cursor->>'sort_num', '')::numeric;\n"
   + "      v_c_txt := coalesce(p_cursor->>'sort_txt', '');\n"
   + "      if v_c_num is null or v_c_id is null then\n"
   + "        raise exception 'list_leads: the cursor needs both sort_num and id — pass back next_cursor exactly as it was returned, or null for the first page'\n"
   + "          using errcode = '22023';\n"
   + "      end if;\n"
   + "    else\n      v_c_at := nullif(p_cursor->>'created_at', '')::timestamptz;\n"],
  ["           end as wait_key\n      from public.leads l\n",
   "           end as wait_key,\n"
   + "           /* R-420: every other order is ONE ascending key — (sort_num, sort_txt, id) — so one\n"
   + "              keyset rule pages them all. Twin: lib/leads/lead-sort.ts#leadSortKey.\n"
   + "              Newer-first inside a tie is folded into sort_num (minus the arrival epoch). */\n"
   + "           case v_sort\n"
   + "             when 'oldest'   then extract(epoch from l.created_at)\n"
   + "             when 'value'    then -coalesce(l.value, 0)::numeric * 10000000000 - extract(epoch from l.created_at)\n"
   + "             when 'followup' then coalesce(extract(epoch from l.follow_up_date::timestamp), 100000000000) * 10000000000\n"
   + "                                  - extract(epoch from l.created_at)\n"
   + "             when 'name'     then case when " + NAME_KEY + " = '' then 1 else 0 end\n"
   + "             when 'stage'    then (case l.stage::text when 'new' then 1 when 'contact' then 2 when 'quote' then 3\n"
   + "                                   when 'demo' then 4 when 'trial' then 5 when 'won' then 6 when 'lost' then 7 else 8 end)\n"
   + "                                  * 10000000000 - extract(epoch from l.created_at)\n"
   + "           end as sort_num,\n"
   + "           case when v_sort = 'name' then " + NAME_KEY + " else '' end as sort_txt\n"
   + "      from public.leads l\n"],
  ["        or (v_sort = 'created' and (c.created_at, c.id) < (v_c_at, v_c_id))\n",
   "        or (v_sort = 'created' and (c.created_at, c.id) < (v_c_at, v_c_id))\n"
   + "        or (v_sort not in ('wait', 'created') and (c.sort_num, c.sort_txt, c.id) > (v_c_num, v_c_txt, v_c_id))\n"],
  ["              case when v_sort = 'created' then c.created_at end desc,\n              c.id desc\n",
   "              case when v_sort = 'created' then c.created_at end desc,\n"
   + "              c.sort_num, c.sort_txt,\n"
   + "              case when v_sort in ('wait', 'created') then c.id end desc,\n"
   + "              c.id\n"],
  ["                      case when v_sort = 'created' then p.created_at end desc,\n                      p.id desc) as rn\n",
   "                      case when v_sort = 'created' then p.created_at end desc,\n"
   + "                      p.sort_num, p.sort_txt,\n"
   + "                      case when v_sort in ('wait', 'created') then p.id end desc,\n"
   + "                      p.id) as rn\n"],
  ["to_jsonb(n) - 'rn' - 'wait_key' order by", "to_jsonb(n) - 'rn' - 'wait_key' - 'sort_num' - 'sort_txt' order by"],
  ["jsonb_build_object('wait_key', n.wait_key::text, 'id', n.id, 'created_at', n.created_at)",
   "jsonb_build_object('wait_key', n.wait_key::text, 'id', n.id, 'created_at', n.created_at,\n"
   + "                                               'sort_num', n.sort_num::text, 'sort_txt', n.sort_txt)"],
  ["                          else jsonb_build_object('created_at', v_rows->v_last->'created_at', 'id', v_rows->v_last->'id')\n",
   "                          when v_sort = 'created'\n"
   + "                          then jsonb_build_object('created_at', v_rows->v_last->'created_at', 'id', v_rows->v_last->'id')\n"
   + "                          else jsonb_build_object('sort_num', v_keys->v_last->'sort_num', 'sort_txt', v_keys->v_last->'sort_txt',\n"
   + "                                                  'id', v_keys->v_last->'id')\n"],
  ["'S37+S40+R-070+R-221+R-392: one keyset page", "'S37+S40+R-070+R-221+R-392+R-420: one keyset page"],
  ["sort created|wait. Returns", "sort created|wait|oldest|value|followup|name|stage. Returns"],
];

const LIST = ["create or replace function public.list_leads(",
  "grant execute on function public.list_leads(jsonb, integer, jsonb) to authenticated;"] as const;

describe("20261007300000_lead_list_sort — only the sort changed", () => {
  it("starts with deploy-key / deploy-peek headers (gen-deploy-db)", () => {
    const [l1, l2] = NEW.split("\n");
    expect(l1).toMatch(/^-- deploy-key: \w+$/);
    expect(l2).toMatch(/^-- deploy-peek: \(?exists\(/);
    expect(l2).not.toMatch(/[|"$]/);
  });

  it("list_leads is 20261007190000's body + the sort edits, nothing else", () => {
    let want = block(OLD, ...LIST);
    for (const [a, b] of SORT_EDITS) want = once(want, a, b);
    expect(block(NEW, ...LIST)).toBe(want);
  });

  it("re-creates list_leads only (lead_counts takes no sort)", () => {
    expect(NEW.match(/create or replace function/g)?.length).toBe(1);
    expect(NEW).toContain("revoke all on function public.list_leads(jsonb, integer, jsonb) from public;");
    expect(NEW).toContain("revoke all on function public.list_leads(jsonb, integer, jsonb) from anon;");
    expect(NEW).not.toMatch(/security definer/i);
  });

  it("accepts exactly the server sorts the page can send", () => {
    const sent = [...new Set(LEAD_SORTS.map(serverSortFor))].sort();
    const m = NEW.match(/if v_sort not in \(([^)]*)\) then/);
    expect(m).not.toBeNull();
    const accepted = [...(m?.[1] ?? "").matchAll(/'([a-z]+)'/g)].map((x) => x[1]).sort();
    expect(accepted).toEqual(sent);
  });

  it("the stage key follows the funnel order, then lost", () => {
    const order = [...NEW.matchAll(/when '([a-z]+)' then (\d)\b/g)].map((x) => [x[1], Number(x[2])] as const);
    expect(order.map(([s]) => s)).toEqual([...LEAD_STAGE_IDS, "lost"]);
    expect(order.map(([, n]) => n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
