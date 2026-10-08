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

export const metadata: Metadata = {
  title: { absolute: "Order confirmed · Anutech Digital" },
  description: `Your Google Workspace order is confirmed. Our team will call or WhatsApp you ${SLA.firstReply} to verify your domain.`,
};

// Don't cache — different visitor = different order
export const dynamic = "force-dynamic";

export default async function ThanksPage(
  props: {
    searchParams: Promise<{ order?: string; t?: string; sim?: string }>;
  }
) {
  const searchParams = await props.searchParams;
  const quoteId = (searchParams.order ?? "").trim();
  const order   = quoteId ? await fetchOrder(quoteId, searchParams.t?.trim()) : null;
  const isSim   = searchParams.sim === "1";

  return <ThanksClient order={order} isSimulation={isSim} />;
}
