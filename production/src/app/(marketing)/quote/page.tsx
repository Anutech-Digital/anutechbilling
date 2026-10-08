import type { Metadata } from "next";
import { Suspense } from "react";
import { SLA } from "@/site/lib/config";
import { QuoteBuilder } from "@/site/components/quote/QuoteBuilder";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";

export const metadata: Metadata = { title: "Get a quote" };

export const revalidate = 600;

/**
 * The form's products are the same live-merged editions the calculator shows, so the two
 * pages can never disagree about what is sellable — and the calculator's "Get this as a
 * quote" hands its whole selection over in the URL (?edition&seats&term).
 *
 * Suspense because QuoteBuilder reads useSearchParams — Next requires the boundary to keep
 * the rest of the page statically renderable.
 */
export default async function QuotePage() {
  const editions = mergeEditions(await fetchLiveWorkspace());
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
          <QuoteBuilder editions={editions} />
        </Suspense>
      </div>
    </section>
  );
}
