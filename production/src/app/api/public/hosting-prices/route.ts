/**
 * GET /api/public/hosting-prices — ResellerOS's hosting prices, as checkout charges them.
 *
 * Owner, 28 Sep 2026: the DMS panel reads prices live from ResellerOS instead of keeping a
 * copy. These are the public list prices the /hosting page shows, so no key is needed; the
 * figures come from lib/checkout/hosting-prices.ts, the same function checkout charges with.
 * Whole rupees; `inclGst` adds 18% GST the way checkout does.
 *
 * R-1786: the tiers come from the price book (lib/catalog/catalog-prices.server.ts) — the code
 * prices with CATALOG_FROM_DB off, the `items` rows with it on. The JSON shape is unchanged,
 * so the hosting panel needs no change.
 */
import { NextResponse } from "next/server";
import { HOSTING_GST_RATE, hostingPriceTable } from "@/lib/checkout/hosting-prices";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { websiteTenantId } from "@/lib/website-tenant";

export const dynamic = "force-dynamic";

export async function GET() {
  const book = await getPriceBook(websiteTenantId());
  return NextResponse.json(
    { gstRate: HOSTING_GST_RATE, plans: hostingPriceTable(book.tiers) },
    // A price change reaches the panel within a minute; a cache never holds one longer.
    { headers: { "cache-control": "public, max-age=0, s-maxage=60" } },
  );
}
