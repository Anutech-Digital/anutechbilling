/**
 * R-2711 — scan: no client query may filter or order on a JSON path (`col->key` / `col->>key`).
 *
 * `/api/sb/rest/v1` is the app's own data gateway (src/server/postgrest), not real PostgREST.
 * Its query parser takes plain column names only (parse.ts: `IDENT` on every filter key), so
 * `.eq("payer->>customer_id", id)` answers 400 PGRST100 wherever DATA_GATEWAY is on (staging,
 * and live once it uses the gateway) — while plain Supabase on localhost accepts it, so local
 * testing never shows it. R-2025's "Known payers" card did exactly that on every customer page.
 *
 * The gateway parser is NOT widened for JSON paths (security decision on the card): a read
 * that needs a JSON field goes through a small SQL function (e.g. `customer_payer_lines`,
 * migration r2711) or a real column. This scan keeps new JSON-path keys out of the client code.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache
import { listSourceFiles } from "@/lib/testing/walk-source";
import { parseQuery } from "@/server/postgrest/parse";

/** Builder methods whose FIRST argument is a column name the gateway parses as a filter/order key. */
const KEY_METHODS = [
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "likeAllOf", "likeAnyOf", "ilikeAllOf", "ilikeAnyOf",
  "is", "in", "contains", "containedBy", "rangeGt", "rangeGte", "rangeLt", "rangeLte", "rangeAdjacent",
  "overlaps", "textSearch", "match", "not", "filter", "order",
];
const KEY_CALL = new RegExp(String.raw`\.(${KEY_METHODS.join("|")})\(\s*(["'\`])((?:(?!\2)[^\\]|\\.)*?)\2`, "g");
/** `.or("a->>b.eq.1,…")` / `.and(…)`: the whole filter string is parsed by the gateway too. */
const LOGIC_CALL = /\.(or|and)\(\s*(["'`])((?:(?!\2)[^\\]|\\.)*?)\2/g;

/** Comments stripped: prose about the old query must not trip the scan. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function jsonPathKeys(src: string): string[] {
  const code = strip(src);
  const hits: string[] = [];
  for (const m of code.matchAll(KEY_CALL)) if (m[3].includes("->")) hits.push(`.${m[1]}("${m[3]}")`);
  for (const m of code.matchAll(LOGIC_CALL)) if (m[3].includes("->")) hits.push(`.${m[1]}("${m[3]}")`);
  return hits;
}

const isCode = (n: string) => /\.(ts|tsx)$/.test(n) && !/\.(test|spec)\.(ts|tsx)$/.test(n) && !n.endsWith(".d.ts");

describe("R-2711: client queries never filter on a JSON path (the data gateway refuses it)", () => {
  it("the gateway parser really refuses a JSON-path filter key (why this scan exists)", () => {
    expect(() => parseQuery(new URLSearchParams({ "payer->>customer_id": "eq.x" }))).toThrow(/bad filter key/);
    expect(() => parseQuery(new URLSearchParams({ customer_id: "eq.x" }))).not.toThrow();
  });

  it("the scan catches the old Known payers query (red on the R-2025 code)", () => {
    const old = `const { data, error } = await db().from("bank_transactions")
        .select("id, bank_account_id, txn_date, credit, payer")
        .eq("payer->>customer_id", customerId as string)
        .not("matched_to_type", "is", null)
        .order("txn_date", { ascending: false });`;
    expect(jsonPathKeys(old)).toEqual(['.eq("payer->>customer_id")']);
    expect(jsonPathKeys(`q.order('meta->date').filter("data->x", "eq", 1).or("payer->>key.eq.a,id.eq.b")`)).toEqual([
      '.order("meta->date")', '.filter("data->x")', '.or("payer->>key.eq.a,id.eq.b")',
    ]);
    expect(jsonPathKeys(`q.eq("customer_id", id).order("txn_date");\n  // old: .eq("payer->>customer_id", id)\n  /* .order("meta->date") */`)).toEqual([]);
  });

  it("no .eq/.filter/.in/.order/… key under src/ contains -> or ->>", () => {
    const files = listSourceFiles("src", isCode).filter((f) => !f.split(path.sep).join("/").startsWith("src/server/postgrest/"));
    expect(files.length).toBeGreaterThan(500);
    const found = files.flatMap((f) => jsonPathKeys(readSource(f)).map((h) => `${f.split(path.sep).join("/")}: ${h}`));
    expect(found, "JSON-path filter keys go through a SQL function or a real column, not the gateway (R-2711)").toEqual([]);
  });
});
