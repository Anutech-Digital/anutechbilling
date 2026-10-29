/**
 * /buy/support/thanks?order=Q-…&t=<public_token>[&sim=1] — after paying for a support plan
 * (R-2083).
 *
 * The order is shown only when `t` matches the quote's secret public_token, and the quote is
 * the website company's and a support order — a wrong token and a wrong number look the same
 * (nothing shown). If the payment is not recorded yet, the client confirms the Razorpay answer
 * the buy page kept for THIS order (POST /api/public/checkout/verify) and reloads when paid.
 */
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { buyPageTenantIdOrEmpty } from "@/lib/checkout/live-guards";
import { quoteTokenMatches } from "@/lib/quotes/accept-token";
import { isSupportCheckoutPlan } from "@/lib/support/public-checkout";
import { SupportThanks, type SupportThanksOrder } from "./support-thanks";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Support plan — order",
  robots: { index: false, follow: false },
};

async function fetchSupportOrder(quoteId: string, token: string): Promise<SupportThanksOrder | null> {
  if (!/^Q-[A-Z0-9-]{4,40}$/.test(quoteId) || !token) return null;
  const tenantId = buyPageTenantIdOrEmpty();
  if (!tenantId) return null;
  const { data, error } = await createAdminClient()
    .from("quotes")
    .select("id, public_token, plan, amount, payment_status, line_items")
    .eq("id", quoteId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data || !quoteTokenMatches(token, data.public_token) || !isSupportCheckoutPlan(data.plan)) return null;
  const line = Array.isArray(data.line_items) ? (data.line_items[0] as { name?: string } | undefined) : undefined;
  return {
    quoteId: data.id,
    planName: line?.name ?? "Support plan",
    amount: Number(data.amount ?? 0),
    paid: ["received", "invoiced"].includes(String(data.payment_status)),
  };
}

export default async function SupportThanksPage(props: { searchParams: Promise<{ order?: string; t?: string; sim?: string }> }) {
  const sp = await props.searchParams;
  const quoteId = (sp.order ?? "").trim();
  const order = quoteId ? await fetchSupportOrder(quoteId, (sp.t ?? "").trim()) : null;
  const deskUrl = (process.env.DSP_SUPPORT_URL ?? "").trim().replace(/\/+$/, "") || null;
  return <SupportThanks order={order} simulated={sp.sim === "1"} deskUrl={deskUrl} />;
}
