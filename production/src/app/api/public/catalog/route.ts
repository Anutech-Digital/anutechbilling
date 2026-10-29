/**
 * GET /api/public/catalog?function=hosting|mail|ssl|support — R-1786 (Phase 2 of R-1784).
 *
 * The website's own products and prices for the panels and the site, read-only and anonymous:
 * the same price book the /hosting page and checkout charge with (lib/catalog/catalog-prices*),
 * so a figure here is the figure paid. With CATALOG_FROM_DB off these are today's code prices.
 *
 * Narrow on purpose: `publicCatalog` whitelists the fields (sku, name, function, termMonths,
 * exGst, inclGst, gstRate, hsn, fulfilment, engineRef) — cost/wholesale/margin are never read
 * into the book, and the test proves none leaves. R-2083: the paid support plans (SUP-STANDARD-
 * MO/YR, SUP-ENTERPRISE-MO/YR; Free is not sold) are here too — the prices /buy/support charges.
 * Workspace has /api/public/catalog/workspace; domains are priced live by the registry.
 *
 * Cached: the book is memoised 60 s per server; CDN `s-maxage=60`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { CATALOG_FUNCTIONS, publicCatalog, type CatalogFunction } from "@/lib/catalog/catalog-prices";
import { websiteTenantId } from "@/lib/website-tenant";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const fn = request.nextUrl.searchParams.get("function");
  if (fn !== null && !(CATALOG_FUNCTIONS as readonly string[]).includes(fn)) {
    return NextResponse.json(
      {
        error: `Unknown function "${fn.slice(0, 40)}". This list has ${CATALOG_FUNCTIONS.join(", ")}. ` +
          "Leave it out for all of them; Google Workspace prices are at /api/public/catalog/workspace.",
        functions: CATALOG_FUNCTIONS,
      },
      { status: 400 },
    );
  }
  const book = await getPriceBook(websiteTenantId());
  return NextResponse.json(
    { gstRate: 18, source: book.source, items: publicCatalog(book, (fn as CatalogFunction | null) ?? undefined) },
    { headers: { "cache-control": "public, max-age=0, s-maxage=60" } },
  );
}
