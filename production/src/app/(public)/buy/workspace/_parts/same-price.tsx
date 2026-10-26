"use client";
/**
 * R-1976 (Pardeep, 26 Oct 2026): "Same price · more service" — back from the old page (6a0d73c8,
 * ~1644-1720), under "Compare all features". The website tenant vs Google direct: both columns
 * carry the SAME per-user price, read from the plan the visitor picked and Annual / Monthly.
 * Plus (price hidden, R-328) or Enterprise → Standard's price. The name is the tenant's own
 * (brand.ts); the bullets are the old page's copy, nothing new promised.
 */
import { rupee } from "@/lib/utils";
import { SLA } from "@/site/lib/config";
import type { BuyBrand } from "./brand";
import type { Billing, BuyPlan } from "./plans";

const H2 = "font-serif font-normal text-[clamp(28px,3.4vw,40px)] leading-[1.12]";

/** The per-user monthly price both columns show, or null when no plan has one at this billing. */
export function samePriceRate(plans: ReadonlyArray<BuyPlan>, selected: BuyPlan, billing: Billing): number | null {
  const rateOf = (p: BuyPlan | undefined) => (p && !p.custom && !p.priceHidden ? (billing === "monthly" ? p.monthly : p.annual) : null);
  return rateOf(selected) ?? rateOf(plans.find((p) => p.id === "standard")) ?? null;
}

function Bullet({ good, children }: { good?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2.5 text-[15px] leading-snug">
      <span aria-hidden className={`font-bold shrink-0 ${good ? "text-emerald" : "text-ink-3"}`}>{good ? "✓" : "✕"}</span>
      <span className={good ? "text-ink-2" : "text-ink-3"}>{children}</span>
    </li>
  );
}

export function SamePrice({ plans, plan, billing, brand }: { plans: ReadonlyArray<BuyPlan>; plan: BuyPlan; billing: Billing; brand: BuyBrand | null }) {
  const rate = samePriceRate(plans, plan, billing);
  const price = rate != null ? rupee(rate) : null;
  const us = brand?.name ?? "Us";
  const per = <span className="text-[13px] text-ink-3 font-sans">/user/month</span>;
  return (
    <section id="same-price" aria-labelledby="same-price-h" className="max-w-[1200px] mx-auto px-4 sm:px-5 pb-16">
      <div className="text-xs font-semibold text-amber-ink tracking-[0.08em] mb-2">SAME PRICE · MORE SERVICE</div>
      <h2 id="same-price-h" className={`${H2} mb-2 [text-wrap:balance]`}>
        <span className="sr-only">Same price, more service: </span>
        {price ? <>Both cost {price}. </> : <>Same price. </>}Only one comes with <span className="text-amber">a person who picks up your call.</span>
      </h2>
      <p className="text-base text-ink-2 max-w-[640px] mb-7 leading-relaxed">
        {brand ? brand.name : "We"} and Google direct have the same price. The difference is what&apos;s wrapped around it.
      </p>
      <div data-testid="same-price-grid" className="grid grid-cols-1 md:grid-cols-2 bg-white border border-hairline rounded-[14px] overflow-hidden">
        <div className="p-6 md:p-7 bg-amber-soft/40 border-b md:border-b-0 md:border-r border-hairline">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-[0.08em] text-amber-ink mb-1">RECOMMENDED</div>
              <h3 className="font-serif font-normal text-[22px] m-0 break-words">{us}</h3>
            </div>
            {price && <div className="text-right shrink-0"><div className="font-serif text-[26px] leading-none" data-testid="same-price">{price}</div>{per}</div>}
          </div>
          <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
            <Bullet good>Hand-held migration from M365/Zoho, planned to avoid downtime</Bullet>
            <Bullet good>Hindi + English phone support, {SLA.hours}</Bullet>
            <Bullet good>Dedicated account manager (one human, not a ticket queue)</Bullet>
            <Bullet good>GST invoice with HSN code (CGST + SGST or IGST)</Bullet>
            <Bullet good>Razorpay · UPI · NEFT · card · net-banking</Bullet>
            <Bullet good>Domain verification + DNS setup done by us</Bullet>
            {billing === "annual" && <Bullet good>Annual upfront with single invoice</Bullet>}
          </ul>
        </div>
        <div className="p-6 md:p-7">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div className="min-w-0">
              <div className="text-[11px] font-semibold tracking-[0.08em] text-ink-3 mb-1">SELF-SERVE ONLY</div>
              <h3 className="font-serif font-normal text-[22px] m-0 text-ink-2">Google direct</h3>
            </div>
            {price && <div className="text-right shrink-0 text-ink-2"><div className="font-serif text-[26px] leading-none" data-testid="same-price">{price}</div>{per}</div>}
          </div>
          <ul className="list-none p-0 m-0 flex flex-col gap-2.5">
            <Bullet>You move old mail, contacts and calendars yourself</Bullet>
            <Bullet>You add the DNS and MX records yourself</Bullet>
            <Bullet>Support from Google&apos;s help centre and support channels</Bullet>
            <Bullet>No local person who knows your account</Bullet>
            <Bullet good>Same Google Workspace, same features</Bullet>
          </ul>
        </div>
      </div>
    </section>
  );
}
