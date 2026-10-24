import type { Metadata } from "next";
import { Suspense } from "react";
import { SLA } from "@/site/lib/config";
import { QuoteBuilder } from "@/site/components/quote/QuoteBuilder";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { websiteTenantId } from "@/lib/website-tenant";

export const metadata: Metadata = {
  title: "Get a quote",
  description: `Pick the edition, the commitment and the headcount — the estimate builds itself, and the formal GST quotation follows by email ${SLA.quote}.`,
};

/* R-1797: 60 s like /hosting and /ssl — the hosting and SSL estimate come from the price book.
   Live Workspace prices keep their own 10-minute cache (lib/live-catalog.ts). */
export const revalidate = 60;

/**
 * The form's products are the same live-merged editions the calculator shows, so the two
 * pages can never disagree about what is sellable — and the calculator's "Get this as a
 * quote" hands its whole selection over in the URL (?edition&seats&term).
 *
 * Suspense because QuoteBuilder reads useSearchParams — Next requires the boundary to keep
 * the rest of the page statically renderable.
 */
export default async function QuotePage() {
  const [workspace, book] = await Promise.all([fetchLiveWorkspace(), getPriceBook(websiteTenantId())]);
  const editions = mergeEditions(workspace);
  const prices = { tiers: book.tiers, ssl: book.ssl };
  return (
    <section className="section rise">
      <div className="wrap">
        <div style={{ maxWidth: 640, marginBottom: 30 }}>
          <h1 className="h1-page" style={{ marginBottom: 16 }}>A priced answer {SLA.quote}.</h1>
          <p className="body-lg" style={{ margin: 0 }}>
            Pick the exact edition, the commitment and the headcount — the estimate builds itself.
            Generate sends the requirement to our sales system; the formal GST quotation follows by email.
          </p>
        </div>
        <Suspense fallback={null}>
          <QuoteBuilder editions={editions} prices={prices} />
        </Suspense>
      </div>
    </section>
  );
}
