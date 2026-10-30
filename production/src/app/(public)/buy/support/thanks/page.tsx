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
import { isSupportCheckoutPlan, supportPlanHeading } from "@/lib/support/public-checkout";
import { supportDeskUrl } from "@/lib/support/support-customer.server";
import { fetchBuyBrand } from "../../workspace/_parts/fetch-brand";
import { SupportThanks, type SupportThanksOrder } from "./support-thanks";

export const dynamic = "force-dynamic";

/* R-2102: the seller's brand in the tab, like the checkout page — never the app's own name. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBuyBrand();
  return {
    title: { absolute: brand ? `Support plan order · ${brand.name}` : "Support plan order" },
    robots: { index: false, follow: false },
  };
}

async function fetchSupportOrder(quoteId: string, token: string): Promise<SupportThanksOrder | null> {
  if (!/^Q-[A-Z0-9-]{4,40}$/.test(quoteId) || !token) return null;
  const tenantId = buyPageTenantIdOrEmpty();
  if (!tenantId) return null;
  const { data, error } = await createAdminClient()
    .from("quotes")
    .select("id, public_token, plan, amount, payment_status")
    .eq("id", quoteId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (error || !data || !quoteTokenMatches(token, data.public_token) || !isSupportCheckoutPlan(data.plan)) return null;
  return {
    quoteId: data.id,
    /* R-2102: "Enterprise Support plan" — the line name carries the seller's company name. */
    planName: supportPlanHeading(data.plan),
    amount: Number(data.amount ?? 0),
    paid: ["received", "invoiced"].includes(String(data.payment_status)),
  };
}

export default async function SupportThanksPage(props: { searchParams: Promise<{ order?: string; t?: string; sim?: string }> }) {
  const sp = await props.searchParams;
  const quoteId = (sp.order ?? "").trim();
  const order = quoteId ? await fetchSupportOrder(quoteId, (sp.t ?? "").trim()) : null;
  return <SupportThanks order={order} simulated={sp.sim === "1"} deskUrl={supportDeskUrl()} />;
}
