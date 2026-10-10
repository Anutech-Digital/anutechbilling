/**
 * GET /api/public/catalog/workspace — the customer-facing Google Workspace price list.
 *
 * Built for the company website (website/): its licence calculator and quote estimate show
 * these figures LIVE, so a price Pardeep edits in Operations → Catalog reaches the website
 * without anyone redeploying it. Same security model as the buy page: admin client, but
 * reads ONLY the buy-page tenant's rows, so there is no cross-tenant surface — and the
 * response is shaped by `publicWorkspaceCatalog`, whose test proves `wholesale` and
 * `margin_pct` never leave (lib/catalog/public-workspace.ts explains why that is a
 * function, not a select list).
 *
 * Anonymous, cache "no-store" on our side; the website caches it briefly on ITS side
 * (revalidate), which is the right place — a stale price on the website for ten minutes is
 * fine, a price this route caches past a catalogue edit defeats the buy page's own
 * "edits reflect within seconds" rule.
 */
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
/* R-076: Microsoft 365 and Zoho rows come through too (suiteRows keeps only the suites). */
import { publicWorkspaceCatalog, suiteRows } from "@/lib/catalog/public-workspace";
import { READ_BUDGET_MS, TIMED_OUT, recall, remember, withBudget } from "./last-good";

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const dynamic = "force-dynamic";

type Shaped = ReturnType<typeof publicWorkspaceCatalog>;

/** One read of the price list, shaped for the public. Throws on a database error. */
async function readCatalog(): Promise<Shaped> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("items")
    .select("name, msrp, prices, vendor")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .in("vendor", ["google", "microsoft", "zoho"])
    .eq("kind", "main")
    .eq("is_active", true)
    .order("msrp", { ascending: true });
  if (error) throw Object.assign(new Error(error.message), { code: error.code, details: error.details });
  const items = publicWorkspaceCatalog(suiteRows(data ?? []));
  remember(items); // R-703: every good read refreshes the remembered list
  return items;
}

export async function GET() {
  /* R-703: a database that does not answer used to cost 40 s and end in 503 (847 times on
     9–10 Oct). The read now gets a budget; past it, or on an error, the last good list is
     served with `stale: true` — see last-good.ts for why that is safe and when it stops. */
  const read = readCatalog();
  read.catch(() => {}); // a late failure after we answered from memory is already logged below
  let failure: unknown = null;
  try {
    const items = await withBudget(read, READ_BUDGET_MS);
    if (items !== TIMED_OUT) {
      return NextResponse.json({ items }, { headers: { "Cache-Control": "no-store" } });
    }
    failure = new Error(`no answer in ${READ_BUDGET_MS} ms`);
  } catch (e) {
    failure = e;
  }

  const kept = recall<Shaped>();
  if (kept) {
    console.warn(
      `[public-catalog] database unavailable (${failure instanceof Error ? failure.message : String(failure)}) — serving the list read ${Math.round((Date.now() - kept.at) / 60000)} min ago`,
    );
    return NextResponse.json(
      { items: kept.value, stale: true, asOf: new Date(kept.at).toISOString() },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  console.error("[public-catalog] fetch failed:", failure);
  /* 503, not an empty 200: the website treats a failure as "use the fallback prices",
     and an empty 200 would read as "the catalogue is genuinely empty" — a different
     statement, and the wrong one. */
  return NextResponse.json({ error: "catalog unavailable" }, { status: 503 });
}
