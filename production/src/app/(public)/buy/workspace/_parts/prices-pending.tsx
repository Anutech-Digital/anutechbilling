"use client";
/**
 * R-2027 (27 Oct 2026): what /buy/workspace (desktop v2) shows instead of plans while it has no
 * catalogue prices — never typed fallback prices.
 *
 *   loading      "Loading prices…": a price skeleton and a locked button whose own label says
 *                why; it unlocks by itself the moment the prices arrive (usually seconds).
 *   unavailable  the price list did not load, or the catalogue has no plans online: what
 *                happened, why there is no price, and what to do — Try again (when another ask
 *                can help) or talk to us for a GST quote (§24, no dead end).
 */
import * as React from "react";

export function PricesPending({ loading, onRetry }: { loading: boolean; onRetry?: () => void }) {
  return (
    <section id="plans" className="max-w-[1200px] mx-auto px-4 sm:px-5 pt-10 pb-14 scroll-mt-20">
      <h1 className="font-serif font-normal text-[clamp(34px,4.4vw,52px)] leading-[1.08] mb-3">Buy Google Workspace</h1>
      {loading ? (
        <div data-prices-loading role="status" aria-live="polite">
          <p className="text-base text-ink-2 mb-6">Loading prices…</p>
          <div aria-hidden className="grid gap-4 grid-cols-1 min-[720px]:grid-cols-2 min-[1100px]:grid-cols-4 mb-6">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="rounded-2xl border border-hairline bg-white p-5 flex flex-col gap-3">
                <span className="block h-4 w-32 rounded bg-paper-2 animate-pulse" />
                <span className="block h-8 w-24 rounded bg-paper-2 animate-pulse" />
                <span className="block h-3 w-40 rounded bg-paper-2 animate-pulse" />
                <span className="block h-10 w-full rounded-lg bg-paper-2 animate-pulse mt-2" />
              </div>
            ))}
          </div>
          <button
            type="button"
            disabled={loading}
            aria-describedby="prices-loading-why"
            className="h-12 px-6 rounded-lg bg-amber text-white text-base font-semibold disabled:opacity-60 disabled:cursor-not-allowed"
          >
            Loading prices…
          </button>
          <p id="prices-loading-why" className="text-sm text-ink-3 mt-2">
            Buy and checkout unlock as soon as the prices arrive — usually in a few seconds.
          </p>
        </div>
      ) : (
        <div role="alert" className="rounded-2xl border border-hairline bg-white p-6 max-w-[720px]">
          <h2 className="text-xl font-semibold mb-2">Online prices are not available right now</h2>
          <p className="text-base text-ink-2 leading-relaxed mb-5">
            Our price list did not load, so we are not showing a price that could be wrong.
            {onRetry ? " Try again in a moment, or talk to us and we'll send a GST quote." : " Talk to us and we'll send a GST quote."}
          </p>
          <div className="flex flex-wrap gap-2.5">
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="h-11 px-5 rounded-lg bg-amber text-white text-sm font-semibold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
              >
                Try again
              </button>
            )}
            <a
              href="#talk-to-us"
              className="inline-flex items-center h-11 px-5 rounded-lg border border-hairline text-ink text-sm font-semibold no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              Talk to us
            </a>
          </div>
        </div>
      )}
    </section>
  );
}
