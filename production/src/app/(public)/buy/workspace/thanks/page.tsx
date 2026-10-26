/**
 * /buy/workspace/thanks?order=Q-XXX&t=<public_token>[&sim=1]
 *
 * Post-purchase confirmation page. The Buy-now dialog redirects here on
 * successful payment (live Razorpay capture OR simulation). The page reads
 * the quote by ID via the admin client and renders a clear "what happens
 * next" timeline + a support strip (contact from src/site/lib/config).
 *
 * Security posture
 *   Quote IDs (Q-2025-26-NNNN) are sequential and guessable, so the number alone
 *   shows nothing. Order details render ONLY when:
 *     • `t` matches the quote's secret `public_token` (S11, 29 Sep 2026 — until
 *       then anybody could read any paid order's name, seats and amount by
 *       counting quote numbers), compared the same way the accept and pay pages do
 *     • the quote belongs to BUY_PAGE_TENANT_ID (ANUTECH's tenant)
 *     • payment_status is 'received' (paid) or 'partial'
 *   Anything else → the same friendly fallback page with no data, so a wrong
 *   token and a wrong number look identical.
 */
import type { Metadata } from "next";
import { ThanksClient } from "./thanks-client";
import { fetchOrder } from "./fetch-order";
import { SLA } from "@/site/lib/config";
import { fetchBuyBrand } from "../_parts/fetch-brand";
import { websitePixelId } from "@/lib/meta/pixel-id.server";

/* R-1975: the title names the website tenant (its own row), like the buy page — never typed. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBuyBrand();
  return {
    title: { absolute: brand ? `Order confirmed · ${brand.name}` : "Order confirmed" },
    description: `Your Google Workspace order is confirmed. Our team will call or WhatsApp you ${SLA.firstReply} to verify your domain.`,
    /* One buyer's order page — never in search results (R-1479: a per-visitor link says noindex). */
    robots: { index: false, follow: false },
  };
}

// Don't cache — different visitor = different order
export const dynamic = "force-dynamic";

export default async function ThanksPage(
  props: {
    searchParams: Promise<{ order?: string; t?: string; sim?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const quoteId = (searchParams.order ?? "").trim();
  const [order, brand, metaPixelId] = await Promise.all([
    quoteId ? fetchOrder(quoteId, searchParams.t?.trim()) : Promise.resolve(null),
    fetchBuyBrand(),
    websitePixelId(),
  ]);
  const isSim   = searchParams.sim === "1";

  /* R-1625: with no paid order yet (the webhook not in), the client confirms the Razorpay
     payment the buy page kept for this order number — the number is only a lookup key into the
     buyer's own sessionStorage; nothing is shown from it until our server confirms. */
  return <ThanksClient order={order} isSimulation={isSim} orderRef={quoteId || undefined} brand={brand} metaPixelId={metaPixelId} />;
}
