"use client";
/**
 * R-1971: the sticky "Order summary" beside the checkout steps (with the coupon box), the GST
 * invoice preview in "Why us", and the phone bottom bar. All three read the checkout state, and
 * split GST the way the invoice will: CGST+SGST in the seller's state, IGST elsewhere.
 */
import { rupee } from "@/lib/utils";
import { SLA } from "@/site/lib/config";
import { stateName, whatsappHref, type BuyBrand, type BuyContact } from "./brand";
import { gstLines, orderCompany } from "./checkout-form";
import { BUSINESS_MAX_USERS, clampSeats, usersLabel, type Billing, type BuyPlan, type PlanSum } from "./plans";
import { BillingToggle } from "./hero";
import { GOOGLE_TRIAL_MAX_USERS } from "@/lib/trials/start-from-quote";
import type { CheckoutState } from "./use-checkout";

const addDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

interface SummaryProps {
  plan: BuyPlan; seats: number; billing: Billing; sum: PlanSum | null;
  promo: { label: string; off: number } | null;
  co: CheckoutState; brand: BuyBrand | null; contact: BuyContact; waMessage: string;
  onChangePlan: () => void;
  /** R-1983: change users / billing right here — the page's ONE state (hero card, plan cards and
   *  phone bar read the same), so every number moves together. Omitted → read-only summary. */
  onSeats?: (n: number) => void;
  onBilling?: (b: Billing) => void;
  monthlyOk?: boolean;
  savePct?: number;
}

export function summaryLines({ seats, billing, sum, promo, co, brand }: Pick<SummaryProps, "seats" | "billing" | "sum" | "promo" | "co" | "brand">) {
  if (!sum || !co.totals) return null;
  const lines: Array<{ label: string; value: string; tone?: "good" | "muted" }> = [
    { label: `${usersLabel(seats)} × ${billing === "annual" ? "12 months" : "1 month"}`, value: rupee(sum.subtotal) },
  ];
  if (promo && promo.off > 0) lines.push({ label: promo.label, value: `− ${rupee(Math.min(promo.off, sum.subtotal))}`, tone: "good" });
  if (co.coupon && co.totals.coupon > 0) lines.push({ label: `Coupon ${co.coupon.code}`, value: `− ${rupee(co.totals.coupon)}`, tone: "good" });
  for (const g of gstLines(co.totals.gst, co.buyerState, brand?.stateCode ?? null)) lines.push({ label: g.label, value: rupee(g.amount), tone: "muted" });
  return lines;
}

export function OrderSummary(p: SummaryProps) {
  const { co } = p;
  const lines = summaryLines(p);
  const trial = co.mode === "trial";
  const annual = p.billing === "annual";
  const quoted = p.plan.custom || p.plan.priceHidden || !p.sum || p.seats > BUSINESS_MAX_USERS;
  return (
    <aside aria-label="Order summary" className="flex-[1_1_320px] max-w-[420px] min-w-0 lg:sticky lg:top-[84px] bg-white border border-hairline rounded-[14px] p-[22px]">
      <div className="flex justify-between items-baseline mb-3.5">
        <h3 className="font-serif font-normal text-[22px] m-0">Order summary</h3>
        <button type="button" onClick={p.onChangePlan} className="text-[13px] font-semibold text-amber-ink underline-offset-[3px] hover:underline">Change plan</button>
      </div>
      <div className="text-[15px] font-semibold">Google Workspace {p.plan.name}</div>
      <div className="text-[13px] text-ink-3 mt-0.5 mb-4">
        {usersLabel(p.seats)}{quoted ? " · quoted separately" : annual ? " · Annual, billed yearly" : " · Monthly, billed every month"}
      </div>
      {p.onSeats && <SummaryControls {...p} onSeats={p.onSeats} trial={trial} />}
      {quoted || !lines || !co.totals ? (
        <p className="text-sm text-ink-2 m-0">A written GST quote — no online payment for this order.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2 text-sm" data-testid="summary-lines">
            {lines.map((l) => (
              <div key={l.label} className={`flex justify-between gap-3 ${l.tone === "good" ? "text-emerald" : l.tone === "muted" ? "text-ink-2" : ""}`}>
                <span>{l.label}</span><span className="font-mono whitespace-nowrap">{l.value}</span>
              </div>
            ))}
          </div>
          <div className="border-t-2 border-ink mt-3.5 pt-3 flex justify-between items-baseline gap-3">
            <span className="text-[13px] font-semibold text-ink-2">{trial ? "Due today" : "Total incl. GST"}</span>
            <span className="font-serif text-[30px]" data-testid="summary-total">{trial ? rupee(0) : rupee(co.totals.total)}</span>
          </div>
          <p className="text-xs text-ink-3 mt-2 mb-0 leading-normal">
            {trial
              ? `Free trial — nothing to pay today. After it, ${rupee(co.totals.total)} if you choose to buy.`
              : annual ? `Renews ${addDays(365)} for another year.` : `Billed monthly. Next bill ${addDays(30)}.`}
          </p>
          {!trial && (
            <div className="mt-4 pt-4 border-t border-hairline">
              {co.coupon ? (
                <div className="flex justify-between items-center gap-3 text-sm">
                  <span className="text-emerald font-semibold">Coupon {co.coupon.code} applied</span>
                  <button type="button" onClick={co.removeCoupon} className="text-[13px] text-amber-ink underline underline-offset-[3px]">Remove</button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <label htmlFor="buy-coupon" className="sr-only">Coupon code</label>
                  <input
                    id="buy-coupon"
                    value={co.couponInput}
                    onChange={(e) => co.setCouponInput(e.target.value.toUpperCase())}
                    placeholder="Coupon code"
                    autoComplete="off"
                    className="flex-1 min-w-0 h-11 px-3 text-sm font-mono uppercase border border-hairline rounded-[10px] bg-paper focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                  />
                  <button type="button" onClick={co.applyCoupon} aria-busy={co.couponBusy} className="h-11 px-4 rounded-[10px] border border-hairline-strong text-sm font-semibold hover:bg-paper-2 disabled:opacity-50">
                    {co.couponBusy ? "Checking…" : "Apply"}
                  </button>
                </div>
              )}
              {co.couponError && <p role="alert" className="text-[13px] text-rose mt-1.5 mb-0">{co.couponError}</p>}
            </div>
          )}
        </>
      )}
      <div className="border-t border-hairline mt-[18px] pt-4 text-[13px] leading-snug text-ink-2">
        Questions before paying?{" "}
        {p.contact.tel && <><a href={p.contact.tel.href} className="text-amber-ink underline underline-offset-[3px]">Call</a>{p.contact.whatsapp ? ", " : " "}</>}
        {p.contact.whatsapp && <><a href={whatsappHref(p.contact.whatsapp, p.waMessage)} target="_blank" rel="noopener noreferrer" className="text-amber-ink underline underline-offset-[3px]">WhatsApp</a>{" "}</>}
        · {SLA.hours}
      </div>
    </aside>
  );
}

/** "Your GST invoice" — a preview built from the current selection and the buyer's details. */
export function InvoicePreview(p: Pick<SummaryProps, "plan" | "seats" | "billing" | "sum" | "promo" | "co" | "brand">) {
  const lines = summaryLines(p);
  const quoted = p.plan.custom || p.plan.priceHidden || !p.sum;
  const buyerState = stateName(p.co.buyerState);
  const gstin = p.co.buyer.gstin.trim().toUpperCase();
  return (
    <div className="flex-[1_1_380px] min-w-0 max-w-[520px]">
      <h3 className="font-serif font-normal text-[28px] mb-1.5">Your GST invoice</h3>
      <p className="text-[15px] text-ink-3 mb-[18px]">A preview built from your current selection — show it to your accountant.</p>
      <div className="bg-white border border-hairline-strong rounded-md p-[22px] shadow-[0_18px_36px_-22px_rgba(26,24,21,0.3)] text-[13px] text-ink-2" data-testid="invoice-preview">
        <div className="flex justify-between gap-3 items-baseline border-b-2 border-ink pb-2.5 mb-3.5">
          <span className="font-mono text-[13px] font-medium tracking-[0.08em] text-ink">TAX INVOICE</span>
          <span className="font-mono text-[11px] text-ink-3">SAMPLE</span>
        </div>
        <div className="grid grid-cols-2 gap-3.5 mb-4 leading-normal">
          <div>
            <div className="text-[11px] text-ink-3">From</div>
            <div className="text-ink font-semibold">{p.brand?.name ?? "—"}</div>
            {p.brand?.gstin && <div className="font-mono text-[11px] break-all">GSTIN {p.brand.gstin}</div>}
          </div>
          <div>
            <div className="text-[11px] text-ink-3">Billed to</div>
            <div className="text-ink font-semibold break-words">{orderCompany(p.co.buyer) || "Your company"}</div>
            <div className="font-mono text-[11px] break-all">{gstin ? `GSTIN ${gstin}` : buyerState ? `${buyerState} · B2C` : "Your GSTIN"}</div>
          </div>
        </div>
        <div className="py-2.5 border-y border-hairline mb-2.5 text-ink">
          Google Workspace {p.plan.name} · {usersLabel(p.seats)}{quoted ? "" : ` · ${p.billing === "annual" ? "12 months" : "1 month"}`}
        </div>
        {quoted || !lines || !p.co.totals ? (
          <div className="flex justify-between gap-3 text-ink font-semibold"><span>Total</span><span className="font-mono">Quoted</span></div>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              {lines.map((l) => <div key={l.label} className="flex justify-between gap-3"><span>{l.label}</span><span className="font-mono whitespace-nowrap">{l.value}</span></div>)}
            </div>
            <div className="flex justify-between gap-3 border-t border-ink mt-2.5 pt-2.5 text-ink font-semibold"><span>Total</span><span className="font-mono">{rupee(p.co.totals.total)}</span></div>
          </>
        )}
        <p className="mt-3.5 mb-0 text-xs text-emerald">✓ Valid for input tax credit when your GSTIN is added</p>
      </div>
    </div>
  );
}

/** Phone (< 820px): plan, users, billing, the total and the one next step, always in reach. */
export function PhoneBar({ plan, seats, billing, total, inclGst = false, onCheckout }: { plan: BuyPlan; seats: number; billing: Billing; total: string; inclGst?: boolean; onCheckout: () => void }) {
  return (
    <div className="min-[820px]:hidden fixed inset-x-0 bottom-0 z-50 bg-white border-t border-hairline shadow-[0_-8px_24px_rgba(26,24,21,0.08)] px-4 py-2.5 flex items-center gap-3" data-testid="phone-bar">
      <div className="flex-1 min-w-0">
        <div className="text-xs text-ink-3 truncate">{plan.short} · {usersLabel(seats)}{plan.custom ? "" : ` · ${billing}`}</div>
        {/* R-1975: the hero headline is before GST; this total is with it — say so. */}
        <div className="leading-tight whitespace-nowrap">
          <span className="font-serif text-[22px]">{total}</span>
          {inclGst && <span className="text-xs text-ink-3 ml-1.5">incl. GST</span>}
        </div>
      </div>
      <button type="button" onClick={onCheckout} className="h-12 px-5 rounded-[10px] bg-amber text-white text-[15px] font-semibold shrink-0">
        {plan.custom ? "Get quote" : "Checkout"}
      </button>
    </div>
  );
}

/**
 * R-1983: users − [n] + and (when monthly is offered) Annual / Monthly inside the order summary.
 * More than 300 users → the Enterprise message (the checkout turns into the quote panel);
 * on a trial at most Google's 10 users.
 */
function SummaryControls(p: SummaryProps & { onSeats: (n: number) => void; trial: boolean }) {
  const max = p.trial ? GOOGLE_TRIAL_MAX_USERS : undefined;
  const set = (n: number) => p.onSeats(max ? Math.min(clampSeats(n), max) : clampSeats(n));
  const btn = "w-11 h-11 shrink-0 border border-hairline bg-paper rounded-[10px] text-xl text-ink disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";
  return (
    <div className="mb-4 flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <label htmlFor="summary-seats" className="text-[13px] font-semibold text-ink-2 mr-auto">Users<span className="sr-only"> in this order</span></label>
        <button type="button" aria-label="Fewer users" onClick={() => set(p.seats - 1)} className={btn}>−</button>
        <input
          id="summary-seats"
          type="number"
          inputMode="numeric"
          min={1}
          max={max}
          value={p.seats}
          onChange={(e) => set(Number(e.target.value))}
          className="w-[72px] h-11 text-center font-serif text-[20px] border border-hairline rounded-[10px] bg-paper text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        />
        <button type="button" aria-label="More users" onClick={() => set(p.seats + 1)} className={btn}>+</button>
      </div>
      {p.trial && p.seats >= GOOGLE_TRIAL_MAX_USERS && (
        <p role="status" className="text-[13px] text-ink-2 m-0">Google allows at most {GOOGLE_TRIAL_MAX_USERS} users on a trial — add the rest after you buy.</p>
      )}
      {!p.trial && !p.plan.custom && p.seats > BUSINESS_MAX_USERS && (
        <p role="status" className="text-[13px] text-amber-ink bg-amber-soft rounded-lg px-3 py-2 m-0">Over {BUSINESS_MAX_USERS} users is Enterprise — a written quote, no online payment.</p>
      )}
      {p.monthlyOk && p.onBilling && !p.plan.custom && !p.plan.priceHidden && (
        <BillingToggle billing={p.billing} onBilling={p.onBilling} savePct={p.savePct ?? 0} />
      )}
    </div>
  );
}
