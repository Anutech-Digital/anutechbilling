/**
 * R-2819 (renewals 12-question audit, 14 Nov 2026 — "the operator can't see what a renewal costs us";
 * the renewal quote page says "Margin Unknown") — the drawer's Customer pays / Our cost / Margin.
 *
 * ONE formula, not a second one:
 *   Customer pays = the row's own amount (queue.ts renewalAmount — R-2751's one basis: the term amount
 *                   BEFORE GST, in ₹ for the books).
 *   Our cost      = what the renewal quote itself would carry (lib/renewals/renewal-catalog-cost.ts,
 *                   R-2736): the catalogue row by item_id / exact name / the one confident match,
 *                   its tier for the term × months × seats; a domain = its extension's row per year × years.
 *   Margin        = computeMargin (components/features/margin-pill — the quote page's Est. margin).
 * Nothing found or no ₹ wholesale → "Cost missing — add in catalogue", never a 100% margin.
 *
 * Cost is internal: only a role that may open the catalogue (/items — the one screen that shows
 * wholesale; nav.ts says owner + manager) sees these lines, and the catalogue is not even read for
 * anyone else. A foreign-currency customer: Customer pays shows their currency AND the ₹ books figure;
 * cost and margin are ₹ only — a $ price is never subtracted from a ₹ cost on screen.
 * No low-margin flag: no margin threshold exists in Settings (only code constants).
 * R-2835: the cost and margin price the seats the NEXT quote bills — a seat cut scheduled for this renewal
 * (the renewal quote's own renewalSeatCut) is priced at the cut seats, with the customer's amount scaled to
 * match so the margin is for the same seats; a term outside 1–60 months shows "Cost unknown — check term"
 * instead of a 12-month number. Display only: no quote, price or money rule changes.
 * Tested in drawer-money-r2819.test.ts + drawer-money-r2835.test.ts + renewal-drawer-r2819/r2835.test.tsx.
 */
import { rupee } from "@/lib/utils";
import { canOpenRoute } from "@/lib/nav";
import { computeMargin } from "@/components/features/margin-pill";
import {
  pickRenewalCatalogItem, renewalCatalogCost, pickDomainCatalogItem, domainRenewalCatalogCost,
  type RenewalCatalogRow,
} from "@/lib/renewals/renewal-catalog-cost";
import type { RenewalCost } from "@/lib/renewals/renewal-cost";
import { renewalSeatCut, type ScheduledSeatCutRow } from "@/lib/renewals/scheduled-seat-cut";
import { EXPORT_GST, termSuffix, type RenewalAmount } from "./queue";

/** The catalogue — where a missing cost is added. */
export const CATALOGUE_HREF = "/items";

/** May this role see what a renewal costs us? The roles that may open the catalogue (nav.ts — one rule). */
export function mayShowRenewalCost(role: string | null | undefined): boolean {
  return !!role && canOpenRoute(role, CATALOGUE_HREF);
}

export interface CostSub {
  plan: string | null;
  seats: number | null;
  vendor: string | null;
  item_id?: string | null;
  term_months?: number | null;
  domain?: string | null;
}

/** The term's months the way the renewal quote reads them (renewalTerm: 1–60, else 12). */
function termMonthsOf(sub: CostSub): number {
  const m = sub.term_months;
  return m != null && m >= 1 && m <= 60 ? Math.round(m) : 12;
}

/** "example.co.in" → "co.in" (a domain subscription holds the registered name). */
function tldOf(domain: string | null | undefined): string {
  const d = (domain ?? "").trim().toLowerCase();
  const i = d.indexOf(".");
  return i > 0 ? d.slice(i + 1) : "";
}

/** Our cost for this renewal's term from the catalogue rows — the renewal quote's own pick + arithmetic. */
export function renewalCostForSub(rows: readonly RenewalCatalogRow[], sub: CostSub): RenewalCost {
  const months = termMonthsOf(sub);
  if (sub.vendor === "domain") {
    const pick = pickDomainCatalogItem(rows, { itemId: sub.item_id ?? null, tld: tldOf(sub.domain) });
    return domainRenewalCatalogCost(pick?.row ?? null, Math.max(1, Math.round(months / 12)));
  }
  const pick = pickRenewalCatalogItem(rows, { itemId: sub.item_id ?? null, plan: sub.plan, vendor: sub.vendor });
  return renewalCatalogCost(pick?.row ?? null, { termMonths: months, seats: sub.seats ?? 0 });
}

/** Is this term one the renewal quote can price (renewalTerm: 1–60; empty = the 12-month default)? */
export function termPriceable(termMonths: number | null | undefined): boolean {
  return termMonths == null || (termMonths >= 1 && termMonths <= 60);
}

/** Which seats the cost is for: the current seats, or the seats a scheduled cut leaves (R-2835). */
export interface DrawerSeatPlan {
  /** The seats to price (null = the subscription has none). */
  seats: number | null;
  /** The customer's amount × scale = the amount for those seats (1 without a cut). */
  scale: number;
  /** One line under Our cost, when the seats are not simply the current ones. */
  note?: string;
}

/** `cuts`: the subscription's scheduled cuts; null = the read failed. Same rule as the renewal quote. */
export function drawerSeatPlan(
  sub: { seats: number | null; renewal_date?: string | null },
  cuts: readonly ScheduledSeatCutRow[] | null,
): DrawerSeatPlan {
  const now = sub.seats ?? 0;
  if (now <= 0) return { seats: sub.seats, scale: 1 };
  if (cuts === null) return { seats: now, scale: 1, note: `Scheduled seat cuts could not be read, so this is on ${now} seats.` };
  const cut = renewalSeatCut(cuts, { seats: now, renewalDate: sub.renewal_date ?? "" });
  if (cut.kind === "apply") {
    return { seats: cut.seats, scale: cut.seats / now, note: `on ${now} seats, cut to ${cut.seats} scheduled` };
  }
  if (cut.kind === "seats_changed") {
    return { seats: now, scale: 1, note: `A seat cut is scheduled for this renewal but does not match the ${now} seats now, so this is on ${now} seats.` };
  }
  return { seats: now, scale: 1 };
}

export type DrawerMoney =
  /** The catalogue could not be read — never says "missing" for a failed read. */
  | { kind: "unread" }
  /** Still reading. */
  | { kind: "loading" }
  /** No catalogue cost: the link to the catalogue + why. */
  | { kind: "costMissing"; reason: string }
  /** Cost known but the renewal has no amount (a domain sold with hosting) — no margin. */
  | { kind: "noAmount"; cost: string; seatNote?: string }
  /** The term is outside 1–60 months — the quote refuses it, so no cost is shown (R-2835). */
  | { kind: "termUnknown" }
  | { kind: "known"; cost: string; margin: string; pct: number; loss: boolean; seatNote?: string };

/** What the Terms section's cost lines say. `cost` undefined = loading, null = the read failed. */
export function drawerMoney(
  amount: RenewalAmount, cost: RenewalCost | null | undefined, termMonths: number | null | undefined, seats?: DrawerSeatPlan,
): DrawerMoney {
  if (!termPriceable(termMonths)) return { kind: "termUnknown" };
  if (cost === undefined) return { kind: "loading" };
  if (cost === null) return { kind: "unread" };
  if (!cost.known || cost.total <= 0) return { kind: "costMissing", reason: cost.reason || "the catalogue has no cost for this plan" };
  const per = termSuffix(termMonths);
  const costText = `${rupee(cost.total)}${per}`;
  const seatNote = seats?.note ? { seatNote: seats.note } : {};
  if (!(amount.value > 0)) return { kind: "noAmount", cost: costText, ...seatNote };
  const m = computeMargin(cost.total, Math.round(amount.value * (seats?.scale ?? 1)));
  const loss = m.margin < 0;
  const margin = `${loss ? "−" : ""}${rupee(Math.abs(m.margin))}${per}`;
  return { kind: "known", cost: costText, margin, pct: m.marginPct, loss, ...seatNote };
}

/** A foreign-currency row's ₹ figure ("₹99,600/yr in ₹ (books)"); null for a ₹ customer. */
export function booksRupeeLine(amount: RenewalAmount, termMonths: number | null | undefined): string | null {
  return amount.gst === EXPORT_GST ? `${rupee(amount.value)}${termSuffix(termMonths)} in ₹ (books)` : null;
}
