"use client";

/**
 * Buy Google Workspace — public page (/buy/workspace).
 *
 * R-1970 (26 Oct 2026): Pardeep's design v2 — header, hero + "Your price" card, plan cards
 * (Annual / Monthly), compare, why us, checkout, after-you-pay, FAQ, talk-to-us band, footer.
 * R-1971: checkout is ON the page — three steps + sticky order summary (coupon), the GST
 * invoice preview, Monthly priced on the server, the phone bottom bar. No popups: the old Buy
 * now / Quote / Trial dialogs are gone; their submit logic lives in _parts/submit-order.ts.
 * The sections are in _parts/; this file keeps the page state and the catalogue → tier merge.
 * No website cart on this page (DECISIONS 4) — the site cart stays for domains and hosting.
 */

import * as React from "react";
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { toBuyPlans, planSum, monthlyOffered, annualSavingPct, clampSeats, usersLabel, BUSINESS_MAX_USERS, type Billing, type BuyPlan } from "./_parts/plans";
import { buyContact, type BuyBrand } from "./_parts/brand";
import { goTo } from "./_parts/wordmark";
import { SiteHeader } from "./_parts/site-header";
import { Hero } from "./_parts/hero";
import { PlanCards, CompareTable } from "./_parts/plan-cards";
import { WhyUs, AfterYouPay, Faq, SupportBand, SiteFooter, TestModeBar } from "./_parts/info-sections";
import { Checkout, canPayOnline } from "./_parts/checkout";
import { SamePrice } from "./_parts/same-price";
import { InvoicePreview, PhoneBar } from "./_parts/order-summary";
import { orderTotals } from "./_parts/checkout-form";
import { useCheckout } from "./_parts/use-checkout";
import { rupee } from "@/lib/utils";
import { landingForForm } from "@/site/lib/ad-attribution";
import { MetaPixel, trackMeta } from "@/site/lib/meta-pixel";
import { ConsentBanner } from "@/site/components/chrome/ConsentBanner";
import { contentIdForPlan } from "@/lib/meta/pixel-ids";
/* R-2020: the tiers and the site promo live in _parts/ so the phone flow (_mobile/) shares them. */
import { buildTiers, FALLBACK_TIERS, type Tier, type CatalogItem } from "./_parts/tiers";
import { useActiveSitePromo, computeSitePromoDiscount, SitePromoBanner } from "./_parts/site-promo";
export type { CatalogItem };

// ──────────────────────────────────────────────────────────────────────
// The page. The sections live in _parts/; this body keeps the one state they all read
// (plan, users, billing — and the checkout via useCheckout). No cart here.
// ──────────────────────────────────────────────────────────────────────
type BuyWorkspaceProps = Parameters<typeof BuyWorkspaceBody>[0];

export function BuyWorkspaceClient(props: BuyWorkspaceProps) {
  return <BuyWorkspaceBody {...props} />;
}

function BuyWorkspaceBody({
  catalogItems = [],
  paymentMode = "simulation",
  initialTierId,
  initialSeats,
  initialBilling,
  openBuy = false,
  brand = null,
  initialCoupon,
  metaPixelId = null,
}: {
  /** R-1979: the website tenant's Meta Pixel id — no id, no Meta script or event. */
  metaPixelId?: string | null;
  /** R-1978: ?coupon=CODE on the buy link — filled in and checked on arrival. */
  initialCoupon?: string;
  /** R-120: edition and seats chosen on the home card (lib/checkout/buy-link.ts). */
  initialTierId?: string;
  initialSeats?: number;
  /** R-2020: ?billing=monthly from the phone flow's Continue — absent, the page opens on Annual as before. */
  initialBilling?: Billing;
  /** Arrived from a "Buy now" elsewhere (?buy=1): go straight to checkout. */
  openBuy?: boolean;
  /** Server-fetched, enabled Google Workspace SKUs from the reseller's Item
   *  Catalog. When empty, we fall back to the hardcoded FALLBACK_TIERS. */
  catalogItems?: CatalogItem[];
  /** "live": Razorpay configured, real money taken. "simulation": no Razorpay but a
   *  simulated checkout is allowed (non-prod) — TEST MODE bar. "disabled": production before
   *  Razorpay go-live — no online pay; the checkout sends a GST quote request instead. */
  paymentMode?: "live" | "simulation" | "disabled";
  /** R-1970: the website tenant's name, logo, GSTIN, address, phone (page.tsx). */
  brand?: BuyBrand | null;
} = {}) {
  const isSimulation = paymentMode === "simulation";
  const onlinePay = paymentMode !== "disabled";
  const TIERS = React.useMemo<Tier[]>(
    () => (catalogItems.length > 0 ? buildTiers(catalogItems) : FALLBACK_TIERS),
    [catalogItems],
  );
  const plans = React.useMemo(() => toBuyPlans(TIERS, isPublicPriceHiddenTier), [TIERS]);
  const monthlyOk = monthlyOffered(plans);
  const savePct = annualSavingPct(plans);
  const contact = buyContact(brand);

  const defaultId = plans.find((p) => p.popular && !p.priceHidden)?.id ?? plans[0]?.id ?? "standard";
  const [planId, setPlanId] = React.useState<BuyPlan["id"]>(
    plans.some((p) => p.id === initialTierId) ? (initialTierId as BuyPlan["id"]) : defaultId,
  );
  const [seats, setSeatsRaw] = React.useState<number>(clampSeats(initialSeats ?? 10));
  const setSeats = (n: number) => setSeatsRaw(clampSeats(n));
  const [billing, setBilling] = React.useState<Billing>(initialBilling ?? "annual");
  const [compareOpen, setCompareOpen] = React.useState(false);
  const plan = plans.find((p) => p.id === planId) ?? plans[0];
  const sum = planSum(plan, seats, billing);

  /* Site promo (Online Promos) — the checkout route applies it to annual and monthly alike. */
  const sitePromo = useActiveSitePromo(plan.id, seats);
  const promoOff = sum ? computeSitePromoDiscount(sitePromo, sum.subtotal) : 0;
  const promoLabel = sitePromo ? `${sitePromo.headline} · online sale` : "";
  const heroPromo = sum && promoOff > 0 ? (() => {
    const t = orderTotals(sum.subtotal, promoOff, 0);
    return { label: `${promoLabel} · you save ${rupee(Math.round(promoOff * 1.18))}`, subtotal: t.taxable, gst: t.gst, total: t.total, was: sum.subtotal };
  })() : null;
  const promo = promoOff > 0 ? { label: promoLabel, off: promoOff } : null;

  const co = useCheckout({ planId: plan.id, seats, sum, promoOff, billing, canBuy: canPayOnline(plan, seats, sum, onlinePay) });

  const goCheckout = () => goTo("checkout", { instant: true });
  /* R-1975: every buy button (header Buy now, Continue to checkout, a plan's Choose, the phone
     bar) opens the PAY checkout — a trial started earlier must not keep the buyer in trial mode.
     Only "Start free trial" sets trial; the checkout's "Pay now instead" switches back. */
  const goPay = () => { co.setMode("pay"); window.setTimeout(goCheckout, 30); };
  /* R-1986 (Pardeep): each plan card keeps its OWN users count; the selected plan's card is the
     page's count. "Buy <plan>" takes that card's count into the checkout. */
  const [cardSeats, setCardSeats] = React.useState<Partial<Record<BuyPlan["id"], number>>>({});
  const seatsFor = (id: BuyPlan["id"]) => (id === planId ? seats : cardSeats[id] ?? seats);
  const onCardSeats = (id: BuyPlan["id"], n: number) => {
    if (id === planId) setSeats(n);
    else setCardSeats((m) => ({ ...m, [id]: clampSeats(n) }));
  };
  const choose = (id: BuyPlan["id"]) => {
    if (id !== planId) {
      const n = seatsFor(id);
      /* the plan left behind keeps the count it had */
      setCardSeats((m) => ({ ...m, [planId]: seats, [id]: undefined }));
      setSeats(n);
    }
    setPlanId(id);
    goPay();
  };
  const onNav = (id: string) => {
    if (id === "compare") { setCompareOpen(true); window.setTimeout(() => goTo("compare"), 30); return; }
    goTo(id);
  };
  const startTrial = () => {
    co.setMode("trial");
    if (plan.custom || plan.priceHidden) setPlanId("standard");
    window.setTimeout(goCheckout, 30);
  };

  /* R-1978: remember the ad this visit landed from (first touch, sessionStorage) — every order,
     trial and quote then sends it, whatever the address bar says later. */
  React.useEffect(() => { landingForForm(); }, []);

  /* R-1978: ?coupon=CODE — fill the box and check it once the basket has a price. */
  const couponTried = React.useRef(false);
  React.useEffect(() => {
    if (couponTried.current || !initialCoupon || !sum) return;
    couponTried.current = true;
    co.setCouponInput(initialCoupon);
    void co.applyCoupon(initialCoupon);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the price is known
  }, [initialCoupon, sum]);

  /* R-1979: Meta events (only when the pixel loaded — an id and "Accept all"; trackMeta is a
     no-op otherwise). ViewContent once; InitiateCheckout when step 1 is done; AddPaymentInfo when
     the payment step opens. value = pre-GST, INR; content_ids = the plan. */
  const metaFired = React.useRef<Set<string>>(new Set());
  const metaOnce = (event: "ViewContent" | "InitiateCheckout" | "AddPaymentInfo") => {
    if (metaFired.current.has(event)) return;
    metaFired.current.add(event);
    trackMeta(event, { content_ids: contentIdForPlan(`google-workspace-${plan.id}`), content_type: "product", value: sum?.subtotal ?? 0, currency: "INR", num_items: seats });
  };
  React.useEffect(() => { metaOnce("ViewContent"); /* eslint-disable-next-line react-hooks/exhaustive-deps -- once */ }, []);
  React.useEffect(() => {
    if (co.step >= 2) metaOnce("InitiateCheckout");
    if (co.step === 3 && co.mode === "pay") metaOnce("AddPaymentInfo");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on step / mode changes
  }, [co.step, co.mode]);

  /* Arrived from a "Buy now" elsewhere (?buy=1): straight to checkout, once. */
  const arrived = React.useRef(false);
  React.useEffect(() => {
    if (arrived.current || !openBuy) return;
    arrived.current = true;
    window.setTimeout(goCheckout, 60);
  }, [openBuy]);

  const waMessage = plan.custom
    ? `Hi, I'd like a Google Workspace Enterprise quote for ${usersLabel(seats)}.`
    : `Hi, I'm looking at Google Workspace ${plan.name} for ${usersLabel(seats)}, ${billing}. Can you send a GST quote?`;

  const card = {
    plans, plan, onPick: setPlanId, seats, onSeats: setSeats, billing, onBilling: setBilling,
    monthlyOk, savePct, sum, promo: heroPromo,
    onContinue: goPay,
    onQuote: goPay,
  };
  const quoted = plan.custom || plan.priceHidden || !sum || seats > BUSINESS_MAX_USERS;
  const barTotal = quoted ? (plan.custom || seats > BUSINESS_MAX_USERS ? "Enterprise quote" : "GST quote") : rupee(co.totals?.total ?? 0);

  return (
    <div className="min-h-screen bg-paper text-ink pb-[76px] min-[820px]:pb-0">
      <MetaPixel pixelId={metaPixelId} />
      {/* R-2010: an ad visitor lands HERE first — the same consent banner as the site. */}
      <ConsentBanner />
      {isSimulation && <TestModeBar />}
      <SiteHeader brand={brand} contact={contact} onNav={onNav} onBuy={goPay} />
      {sitePromo && <SitePromoBanner promo={sitePromo} />}
      <main>
        <Hero card={card} onPlans={() => goTo("plans")} onTrial={startTrial} trialOk />
        <PlanCards
          plans={plans} selectedId={plan.id} seats={seats} billing={billing} onBilling={setBilling}
          monthlyOk={monthlyOk} savePct={savePct} onChoose={choose} contact={contact} seatsFor={seatsFor} onCardSeats={onCardSeats}
        />
        <CompareTable open={compareOpen} onToggle={() => setCompareOpen((o) => !o)} />
        <SamePrice plans={plans} plan={plan} billing={billing} brand={brand} />
        <WhyUs brand={brand}>
          <InvoicePreview plan={plan} seats={seats} billing={billing} sum={sum} promo={promo} co={co} brand={brand} />
        </WhyUs>
        <Checkout
          plan={plan} seats={seats} billing={billing} sum={sum} promo={promo} co={co}
          brand={brand} contact={contact} waMessage={waMessage}
          onlinePay={onlinePay} isSimulation={isSimulation}
          onChangePlan={() => goTo("plans")}
          onSeats={setSeats} onBilling={setBilling} monthlyOk={monthlyOk} savePct={savePct}
        />
        <AfterYouPay />
        <Faq brand={brand} />
        <SupportBand brand={brand} contact={contact} waMessage={waMessage} onQuote={goCheckout} />
      </main>
      <SiteFooter brand={brand} />
      <PhoneBar plan={plan} seats={seats} billing={billing} total={barTotal} inclGst={!quoted} onCheckout={goPay} />
    </div>
  );
}
