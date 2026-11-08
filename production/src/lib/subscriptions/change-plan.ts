/**
 * R-2227 (Zoho Billing audit A3, G-ZOHO) — "Change plan" on a licence subscription in the middle
 * of its term, e.g. Google Workspace Business Starter → Business Standard.
 *
 * Before: the only ways were Correct details (renames the plan, no money) or a quote typed by
 * hand. Zoho's change-plan shows the credit for the unused old plan, the charge for the new plan
 * and the net — and (R-2255) credited money it had never received.
 *
 * The ONE calculation, used by the dialog's preview AND by the server that saves the quote
 * (R-803 rule: preview = quote):
 *
 *   window      = the rest of the term (yearly-paid) or the rest of the CURRENT part (billed in
 *                 parts — later parts are billed at the new rate by the billing run, R-527);
 *   per seat    = annual × days ÷ term days, or the PART's own rate (R-2226 partShareOf);
 *   new charge  = new plan per seat × new seats
 *   unused      = old plan per seat × old seats   (old rate = what THIS customer pays, from mrr)
 *   credit      = splitChangeCredit(unused incl. GST, the part's money) — only from money RECEIVED
 *                 (R-2255); while the part's bill is still unpaid "Now" is refused, because that
 *                 share would need a credit note on the old invoice, not a line on this quote;
 *   net         = new charge − credit  → ONE draft quote line (qty 1, rate = net, ex-GST).
 *
 * The quote reuses R-2073's path: linked through subscriptions.renewal_quote_id, extension_months
 * = 0 (buys no time). Its line carries `plan_change` — record_payment (migration
 * 20261108033040_r2227_plan_change_payment) reads it once the quote is paid in full and moves the
 * subscription to the new plan, seats, MRR and licence cost; the renewal date stays.
 *
 * Refused here (with the next step): a cheaper plan (an annual commitment cannot be reduced
 * mid-term — R-2205/R-2095 rule; takes effect at renewal), fewer seats (Reduce seats, R-2252), a
 * net of ₹0 or less (credit-note path is a follow-up card), a part with no bill yet, an open
 * quote already linked, a support plan (R-2073 has its own Upgrade plan).
 *
 * ⚠ Units: rupees ex-GST for per-seat / charge / net (the quote's columns); the credit split is
 * in PAISE incl. GST (change-credit.ts), converted back once, rounded DOWN (never credit more).
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import { grossAmount } from "@/lib/quotes/amounts";
import { isSupportSkuId } from "@/lib/support/tiers";
import { rupee } from "@/lib/utils";
import { formatPaise, rupeesToPaise, type Paise } from "./proration";
import { splitChangeCredit, type ChangeCreditSplit } from "./change-credit";
import { annualPerSeatFromMrr } from "./seat-increase-charge";
import { seatChargePlan, type SeatWindowSub } from "./seat-charge-window";
import { partShareOf, type SeatPartSegment } from "./seat-part-rate";
import type { CatalogProduct } from "./catalog-options";

export interface ChangePlanSub {
  id: string;
  item_id: string | null;
  plan: string | null;
  vendor?: string | null;
  status: string;
  seats: number;
  mrr: number;
  billing_cycle: SeatWindowSub["billing_cycle"];
  term_months: SeatWindowSub["term_months"];
  start_date: string | null;
  renewal_date: string | null;
  renewal_quote_id: string | null;
  vendor_cost_per_seat_month?: number | null;
}

/** The money of the part (or yearly term) the change falls in — read on the server
 *  (change-plan-money.server.ts). Paise, incl. GST. */
export interface ChangePlanMoney {
  /** False when the part has no bill (invoice / payment request) yet and was not billed elsewhere. */
  billed: boolean;
  openDuePaise: Paise;
  receivedPaise: Paise;
  alreadyCreditedPaise: Paise;
  invoiced: boolean;
  /** Billed and paid outside this app (Zoho import / opening) — counted as received in full. */
  external?: boolean;
}

/** What the paid quote applies — stored on the quote line, read by record_payment. */
export interface PlanChangeMeta {
  subscription_id: string;
  from_item_id: string | null;
  from_plan: string | null;
  to_item_id: string;
  to_plan: string;
  /** Seats after the change. */
  seats: number;
  /** ₹/month the subscription bills after the change (all seats). */
  new_mrr: number;
  /** ₹/seat/month licence cost of the new plan (null = not in the catalogue). */
  cost_per_seat_month: number | null;
  annual_per_seat: number;
  period_from: string;
  period_to: string;
  new_charge: number;
  unused: number;
  credit: number;
  lower_open_paise: Paise;
  credit_paise: Paise;
  not_given_paise: Paise;
}

export type PlanChangeLine = QuoteLineItem & { plan_change: PlanChangeMeta };

export interface PlanChangeCalc {
  from: string;
  to: string;
  chargedDays: number;
  termDays: number;
  /** Billed in parts → the part's own rate (R-2226). */
  parts: readonly SeatPartSegment[] | null;
  oldAnnualPerSeat: number;
  newAnnualPerSeat: number;
  oldPerSeat: number;
  newPerSeat: number;
  oldSeats: number;
  newSeats: number;
  /** Ex-GST, whole rupees. */
  newCharge: number;
  unused: number;
  credit: number;
  net: number;
  tax: number;
  total: number;
  split: ChangeCreditSplit;
  newMrr: number;
}

export interface PlanChangePlan {
  calc: PlanChangeCalc;
  line: PlanChangeLine;
  /** Customer-facing note text (what the quote pays for). */
  noteText: string;
}

export type PlanChangeResult = { ok: true; plan: PlanChangePlan } | { ok: false; reason: string };

const fmt = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

/** ₹/seat/year the catalogue charges for the subscription's commitment (flex → flex tier × 12). */
export function targetAnnualPerSeat(target: CatalogProduct, termMonths: number | null): number | null {
  if ((termMonths ?? 12) <= 1) {
    return target.flexMonthlySellPerSeat != null && target.flexMonthlySellPerSeat > 0
      ? Math.round(target.flexMonthlySellPerSeat * 12) : null;
  }
  return target.annualSellPerSeat > 0 ? Math.round(target.annualSellPerSeat) : null;
}

function targetCostPm(target: CatalogProduct, termMonths: number | null): number | null {
  const c = (termMonths ?? 12) <= 1 ? target.flexMonthlyCostPerSeat : target.annualMonthlyCostPerSeat;
  return c != null && c > 0 ? Math.round(c) : null;
}

/** Plans a subscription may move to: same vendor, a subscription product, not itself, not support. */
export function planChangeTargets(sub: Pick<ChangePlanSub, "item_id" | "vendor">, products: readonly CatalogProduct[]): CatalogProduct[] {
  return products.filter((p) =>
    p.id !== sub.item_id && !isSupportSkuId(p.id) && (!sub.vendor || p.vendor === sub.vendor));
}

/** Is this subscription one "Change plan" serves (an active licence, not a support plan)? */
export function canChangePlan(sub: Pick<ChangePlanSub, "status" | "item_id" | "seats">): boolean {
  return sub.status === "active" && !isSupportSkuId(sub.item_id) && (sub.seats ?? 0) > 0;
}

/** R-2227: is this quote a licence PLAN CHANGE quote (its first line carries `plan_change`)? */
export function isPlanChangeQuote(q: { extension_months?: number | null; line_items?: unknown }): boolean {
  if (q.extension_months !== 0) return false;
  const first = Array.isArray(q.line_items) ? (q.line_items[0] as { plan_change?: unknown } | undefined) : undefined;
  return !!first && typeof first.plan_change === "object" && first.plan_change !== null;
}

export function buildPlanChange(args: {
  sub: ChangePlanSub;
  target: CatalogProduct;
  newSeats: number;
  today: string;
  taxRatePct: number;
  money: ChangePlanMoney | null;
}): PlanChangeResult {
  const { sub, target, today, taxRatePct, money } = args;
  const newSeats = args.newSeats;
  if (sub.status !== "active") return { ok: false, reason: `This subscription is ${sub.status}. Only an active plan can be changed.` };
  if (isSupportSkuId(sub.item_id)) return { ok: false, reason: "A support plan is changed with Upgrade plan." };
  if (sub.renewal_quote_id) {
    return { ok: false, reason: `This subscription already has an open quote (${sub.renewal_quote_id}). Finish or delete it first.` };
  }
  if (target.id === sub.item_id) return { ok: false, reason: "Pick a different plan." };
  if (isSupportSkuId(target.id)) return { ok: false, reason: "A licence cannot be changed into a support plan." };
  if (sub.vendor && target.vendor !== sub.vendor) return { ok: false, reason: "The new plan must be from the same vendor." };
  if (!Number.isSafeInteger(newSeats) || newSeats < 1 || newSeats > 100_000) {
    return { ok: false, reason: "Seats must be a whole number of 1 or more." };
  }
  if (newSeats < sub.seats) {
    return { ok: false, reason: `Seats cannot go below ${sub.seats} here. Lower seats with Manage seats, then change the plan.` };
  }
  const oldAnnual = annualPerSeatFromMrr(sub.mrr, sub.seats);
  if (!(oldAnnual > 0)) return { ok: false, reason: "This subscription has no price (MRR is ₹0). Set it with Correct details first." };
  const newAnnual = targetAnnualPerSeat(target, sub.term_months);
  if (newAnnual == null) {
    return { ok: false, reason: (sub.term_months ?? 12) <= 1
      ? `${target.name} has no Flexible (monthly) price in your catalogue. Add it under Products first.`
      : `${target.name} has no price in your catalogue. Add it under Products first.` };
  }
  if (newAnnual < oldAnnual) {
    return { ok: false, reason: `${target.name} (${fmt(newAnnual)}/seat/yr) costs less than what this customer pays now (${fmt(oldAnnual)}/seat/yr). A move to a cheaper plan takes effect at renewal — change it on the renewal quote.` };
  }

  const window = seatChargePlan(sub, today);
  if (!window || window.current.remainingDays <= 0) {
    return { ok: false, reason: "This term has ended. Renew the subscription first, then change the plan." };
  }
  const cur = window.current;
  const parts = cur.parts && cur.parts.length > 0 ? cur.parts : null;
  const chargedDays = Math.max(0, Math.min(cur.termDays, cur.remainingDays));
  const perSeat = (annual: number) => parts ? partShareOf(annual, parts) : Math.round((annual * chargedDays) / cur.termDays);
  const oldPerSeat = perSeat(oldAnnual);
  const newPerSeat = perSeat(newAnnual);
  const newCharge = newPerSeat * newSeats;
  const unused = oldPerSeat * sub.seats;

  if (!money || !money.billed) {
    return { ok: false, reason: "This part of the term has no bill yet, so there is no paid amount to credit. Raise its bill first (Billing schedule), or change the plan at renewal." };
  }
  const unusedGross: Paise = rupeesToPaise(grossAmount(unused, taxRatePct));
  const split = splitChangeCredit({
    unusedPaise: unusedGross,
    openDuePaise: money.external ? 0 : money.openDuePaise,
    receivedPaise: money.external ? unusedGross : money.receivedPaise,
    alreadyCreditedPaise: money.external ? 0 : money.alreadyCreditedPaise,
    invoiced: money.invoiced,
  });
  /* R-2255: the unused value would first LOWER what the part's bill still asks for — that needs a
     credit note on that invoice (CGST s.34), which this quote cannot be. Netting it here would leave
     the old invoice asking for its full amount while the customer is already credited against it.
     So "Now" waits until the bill is paid (or the change goes on the renewal quote). */
  if (split.lowerOpenPaise > 0) {
    return { ok: false, reason: `This term's bill still has ${formatPaise(money.openDuePaise)} unpaid. Record that payment first, then change the plan — or change it at renewal.` };
  }
  const allowedGross = split.creditPaise;
  /* Back to ex-GST rupees once, rounded DOWN so the credit never exceeds what the rule allows. */
  const credit = allowedGross === unusedGross ? unused : Math.min(unused, Math.floor(allowedGross / (100 + taxRatePct)));
  const net = newCharge - credit;
  if (net <= 0) {
    return { ok: false, reason: "The new plan costs no more than the unused part of the current one, so there is nothing to charge. Change it at renewal." };
  }
  const total = grossAmount(net, taxRatePct);
  const newMrr = Math.round((newAnnual * newSeats) / 12);
  const lastDay = cur.chargeTo;
  const commitment = (sub.term_months ?? 12) <= 1 ? "monthly" as const : "annual_yearly" as const;

  const oldName = sub.plan?.trim() || "current plan";
  const noteText = [
    `Plan change: ${oldName} → ${target.name}, ${newSeats} seat${newSeats === 1 ? "" : "s"}, for ${cur.from} to ${lastDay}${parts ? " (this billing part)" : ""}.`,
    `${target.name} ${newSeats} × ${fmt(newPerSeat)} = ${fmt(newCharge)}`,
    `Less unused ${oldName} ${sub.seats} × ${fmt(oldPerSeat)} = ${fmt(unused)}${credit < unused ? ` — credited ${fmt(credit)} (only up to what was paid for this term)` : ""}`,
    `To pay before GST: ${fmt(net)}. The renewal date stays the same; the plan changes when this quote is paid.`,
  ].join("\n");

  const line: PlanChangeLine = {
    id: "plan-change-1",
    item_id: target.id,
    name: `${target.name} · change from ${oldName} (pro-rata from ${cur.from} to ${lastDay})`,
    qty: 1,
    rate: net,
    cost: 0,
    commitment,
    plan_change: {
      subscription_id: sub.id,
      from_item_id: sub.item_id,
      from_plan: sub.plan,
      to_item_id: target.id,
      to_plan: target.name,
      seats: newSeats,
      new_mrr: newMrr,
      cost_per_seat_month: targetCostPm(target, sub.term_months),
      annual_per_seat: newAnnual,
      period_from: cur.from,
      period_to: lastDay,
      new_charge: newCharge,
      unused,
      credit,
      lower_open_paise: split.lowerOpenPaise,
      credit_paise: split.creditPaise,
      not_given_paise: split.notGivenPaise,
    },
  };

  return {
    ok: true,
    plan: {
      calc: {
        from: cur.from, to: lastDay, chargedDays, termDays: cur.termDays, parts,
        oldAnnualPerSeat: oldAnnual, newAnnualPerSeat: newAnnual, oldPerSeat, newPerSeat,
        oldSeats: sub.seats, newSeats, newCharge, unused, credit, net, tax: total - net, total, split, newMrr,
      },
      line,
      noteText,
    },
  };
}
