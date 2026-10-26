"use client";
/**
 * R-1970: where "Buy now" lands on /buy/workspace — the order for the chosen plan, users and
 * billing, and the one next step. Annual opens the existing Buy now payment dialog (server-
 * priced). Until the inline checkout (R-1971) pays monthly online, Monthly, Plus and
 * Enterprise get a written GST quote on the same plan and users — never a dead end.
 */
import { rupee } from "@/lib/utils";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";
import { SLA } from "@/site/lib/config";
import { BUSINESS_MAX_USERS, usersLabel, type Billing, type BuyPlan, type PlanSum } from "./plans";

export type CheckoutNext = "pay" | "quote-monthly" | "quote-plan" | "quote-enterprise" | "quote-offline";

/** The one next step for this order. */
export function checkoutNext(plan: BuyPlan, seats: number, billing: Billing, onlinePay: boolean): CheckoutNext {
  if (plan.custom) return "quote-enterprise";
  if (seats > BUSINESS_MAX_USERS) return "quote-enterprise";
  if (plan.priceHidden || plan.annual == null) return "quote-plan";
  if (!onlinePay) return "quote-offline";
  if (billing === "monthly") return "quote-monthly";
  return "pay";
}

const NOTE: Record<Exclude<CheckoutNext, "pay">, string> = {
  "quote-monthly": "Monthly billing is paid online with our new checkout, coming next. Today we send you a written monthly GST quote instead.",
  "quote-plan": `This plan is priced for your team. We send a written GST quote ${SLA.quote}.`,
  "quote-enterprise": `Enterprise (and more than ${BUSINESS_MAX_USERS} users) is quoted, not checked out. We send a written GST quote ${SLA.quote}.`,
  "quote-offline": `Online payment opens soon. We send a written GST quote ${SLA.quote}.`,
};

export function CheckoutSection({
  plan, seats, billing, sum, promo, next, onPay, onQuote, onTrial, trialOk,
}: {
  plan: BuyPlan;
  seats: number;
  billing: Billing;
  sum: PlanSum | null;
  promo: { label: string; subtotal: number; gst: number; total: number } | null;
  next: CheckoutNext;
  onPay: () => void;
  onQuote: () => void;
  onTrial: () => void;
  trialOk: boolean;
}) {
  const annual = billing === "annual";
  const shown = promo ?? sum;
  const priced = !!sum && next !== "quote-enterprise" && next !== "quote-plan";
  return (
    <section id="checkout" className="bg-paper-2 border-y border-hairline scroll-mt-16">
      <div className="max-w-[1200px] mx-auto px-4 sm:px-5 py-16">
        <h2 className="font-serif font-normal text-[clamp(30px,3.6vw,42px)] leading-[1.1] mb-2">Checkout</h2>
        <p className="text-base text-ink-2 mb-8">No account needed — we set up your admin login with you after payment.</p>
        <div className="max-w-[560px] bg-white border border-hairline rounded-[14px] p-[22px]">
          <div className="text-[15px] font-semibold">Google Workspace {plan.name}</div>
          <div className="text-[13px] text-ink-3 mt-0.5 mb-4">
            {usersLabel(seats)}{plan.custom ? " · quoted separately" : annual ? " · Annual, billed yearly" : " · Monthly, billed every month"}
          </div>
          {priced && sum && shown && (
            <div className="flex flex-col gap-2 text-sm" data-testid="checkout-lines">
              <div className="flex justify-between gap-3"><span>{usersLabel(seats)} × {annual ? "12 months" : "1 month"}</span><span className="font-mono whitespace-nowrap">{rupee(sum.subtotal)}</span></div>
              {promo && <div className="flex justify-between gap-3 text-emerald"><span>{promo.label}</span><span className="font-mono whitespace-nowrap">− {rupee(sum.subtotal - promo.subtotal)}</span></div>}
              <div className="flex justify-between gap-3 text-ink-2"><span>GST 18%</span><span className="font-mono whitespace-nowrap">{rupee(shown.gst)}</span></div>
              <div className="border-t-2 border-ink mt-2 pt-3 flex justify-between items-baseline gap-3">
                <span className="text-[13px] font-semibold text-ink-2">Total incl. GST</span>
                <span className="font-serif text-[30px]" data-testid="checkout-total">{rupee(shown.total)}</span>
              </div>
            </div>
          )}
          {next === "pay" ? (
            <button type="button" onClick={onPay} className="mt-5 w-full h-14 rounded-xl bg-amber text-white text-[17px] font-bold hover:bg-amber-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">
              Continue to payment
            </button>
          ) : (
            <>
              <p className="mt-4 mb-0 text-sm text-ink-2 leading-normal bg-paper rounded-[10px] px-4 py-3.5">{NOTE[next]}</p>
              <button type="button" onClick={onQuote} className="mt-4 w-full h-14 rounded-xl bg-ink text-paper text-[17px] font-bold hover:bg-ink-2">
                {next === "quote-enterprise" ? "Request an Enterprise quote" : next === "quote-monthly" ? "Get a monthly GST quote" : "Get a GST quote"}
              </button>
            </>
          )}
          {trialOk && !plan.custom && (
            <div className="flex justify-center mt-3">
              <button type="button" onClick={onTrial} className="min-h-11 text-sm text-amber-ink underline underline-offset-[3px]">
                Not ready? Start a {WORKSPACE_TRIAL_DAYS}-day free trial instead
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
