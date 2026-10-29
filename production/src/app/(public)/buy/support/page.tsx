/**
 * /buy/support — buy a support plan online (R-2083, 29 Oct 2026).
 *
 *   /buy/support?plan=standard|enterprise&term=monthly|yearly&email=…&billing_customer_id=…
 *
 * The support desk (DSP) sends its "Upgrade" button here (its billing_support_checkout_url).
 * The prices on this page are the server's price book — the same figures
 * GET /api/public/catalog?function=support lists and POST /api/public/checkout/support charges;
 * the page only shows them. Payment works like /buy/workspace: live Razorpay on a deployment
 * with keys, simulation on a laptop, and no Pay button where neither is possible.
 */
import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/server";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { bookSupportPrice, codePriceBook } from "@/lib/catalog/catalog-prices";
import { buyPageTenantIdOrEmpty, simulatedPaymentAllowed } from "@/lib/checkout/live-guards";
import { loadCheckoutRazorpayKeys } from "@/lib/checkout/razorpay-keys.server";
import { checkoutPaymentMode, type CheckoutPaymentMode } from "@/lib/checkout/checkout-payment-mode";
import {
  parseSupportBuyParams, supportPriceView, SUPPORT_BUY_PLANS, SUPPORT_BUY_TERMS, type SupportPriceView,
} from "@/lib/support/public-checkout";
import { supportTier } from "@/lib/support/tiers";
import { fetchBuyBrand } from "../workspace/_parts/fetch-brand";
import { SupportCheckout, type SupportPlanCard } from "./support-checkout";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const brand = await fetchBuyBrand();
  return {
    title: { absolute: brand ? `Buy a support plan · ${brand.name}` : "Buy a support plan" },
    description: "Priority support plans — Standard and Enterprise, monthly or yearly, with a GST invoice.",
    /* A checkout reached from the support desk with the customer's email in the link. */
    robots: { index: false, follow: false },
  };
}

async function paymentModeFor(tenantId: string): Promise<CheckoutPaymentMode> {
  try {
    const keys = tenantId ? await loadCheckoutRazorpayKeys(createAdminClient(), tenantId) : null;
    return checkoutPaymentMode({
      razorpayConfigured: !!keys,
      simulationAllowed: simulatedPaymentAllowed({ razorpayKeyId: keys?.keyId ?? "" }),
    });
  } catch {
    return checkoutPaymentMode({ razorpayConfigured: false, simulationAllowed: simulatedPaymentAllowed() });
  }
}

export default async function BuySupportPage(props: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const pick = parseSupportBuyParams(await props.searchParams);
  const tenantId = buyPageTenantIdOrEmpty();
  const [book, mode, brand] = await Promise.all([
    getPriceBook(tenantId || null).catch(() => codePriceBook()),
    paymentModeFor(tenantId),
    fetchBuyBrand(),
  ]);

  const plans: SupportPlanCard[] = SUPPORT_BUY_PLANS.map((id) => {
    const t = supportTier(id);
    const prices = Object.fromEntries(
      SUPPORT_BUY_TERMS.map((term) => [term, supportPriceView(id, term, bookSupportPrice(book, id, term) ?? 0)]),
    ) as Record<(typeof SUPPORT_BUY_TERMS)[number], SupportPriceView>;
    return {
      id,
      label: t.label,
      summary: t.summary,
      slaHours: t.slaHours,
      features: [
        `First response within ${t.slaHours} hour${t.slaHours === 1 ? "" : "s"}`,
        t.channels.whatsapp === "business_hours" ? "WhatsApp in business hours" : t.channels.whatsapp ? "WhatsApp, around the clock" : "Email helpdesk",
        t.channels.meetCallsPerMonth === null ? "Unlimited live calls" : `${t.channels.meetCallsPerMonth} live calls a month`,
        ...(t.accountManager ? ["Named account manager"] : []),
      ],
      prices,
    };
  });

  return (
    <SupportCheckout
      plans={plans}
      initialPlan={pick.plan}
      initialTerm={pick.term}
      initialEmail={pick.email}
      billingCustomerId={pick.billingCustomerId}
      paymentMode={mode}
      sellerName={brand?.name ?? null}
    />
  );
}
