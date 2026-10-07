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

const BUY_PAGE_TENANT_ID =
  process.env.BUY_PAGE_TENANT_ID?.trim() || "fbb976f1-9090-4f10-9726-0901bd144e42";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("items")
    .select("name, msrp, prices, vendor")
    .eq("tenant_id", BUY_PAGE_TENANT_ID)
    .in("vendor", ["google", "microsoft", "zoho"])
    .eq("kind", "main")
    .eq("is_active", true)
    .order("msrp", { ascending: true });

  if (error) {
    console.error("[public-catalog] fetch failed:", error);
    /* 503, not an empty 200: the website treats a failure as "use the fallback prices",
       and an empty 200 would read as "the catalogue is genuinely empty" — a different
       statement, and the wrong one. */
    return NextResponse.json({ error: "catalog unavailable" }, { status: 503 });
  }

  return NextResponse.json(
    { items: publicWorkspaceCatalog(suiteRows(data ?? [])) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
