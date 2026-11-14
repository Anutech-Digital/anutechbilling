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
 * Tested in drawer-money-r2819.test.ts + renewal-drawer-r2819.test.tsx.
 */
import { rupee } from "@/lib/utils";
import { canOpenRoute } from "@/lib/nav";
import { computeMargin } from "@/components/features/margin-pill";
import {
  pickRenewalCatalogItem, renewalCatalogCost, pickDomainCatalogItem, domainRenewalCatalogCost,
  type RenewalCatalogRow,
} from "@/lib/renewals/renewal-catalog-cost";
import type { RenewalCost } from "@/lib/renewals/renewal-cost";
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

export type DrawerMoney =
  /** The catalogue could not be read — never says "missing" for a failed read. */
  | { kind: "unread" }
  /** Still reading. */
  | { kind: "loading" }
  /** No catalogue cost: the link to the catalogue + why. */
  | { kind: "costMissing"; reason: string }
  /** Cost known but the renewal has no amount (a domain sold with hosting) — no margin. */
  | { kind: "noAmount"; cost: string }
  | { kind: "known"; cost: string; margin: string; pct: number; loss: boolean };

/** What the Terms section's cost lines say. `cost` undefined = loading, null = the read failed. */
export function drawerMoney(amount: RenewalAmount, cost: RenewalCost | null | undefined, termMonths: number | null | undefined): DrawerMoney {
  if (cost === undefined) return { kind: "loading" };
  if (cost === null) return { kind: "unread" };
  if (!cost.known || cost.total <= 0) return { kind: "costMissing", reason: cost.reason || "the catalogue has no cost for this plan" };
  const per = termSuffix(termMonths);
  const costText = `${rupee(cost.total)}${per}`;
  if (!(amount.value > 0)) return { kind: "noAmount", cost: costText };
  const m = computeMargin(cost.total, amount.value);
  const loss = m.margin < 0;
  const margin = `${loss ? "−" : ""}${rupee(Math.abs(m.margin))}${per}`;
  return { kind: "known", cost: costText, margin, pct: m.marginPct, loss };
}

/** A foreign-currency row's ₹ figure ("₹99,600/yr in ₹ (books)"); null for a ₹ customer. */
export function booksRupeeLine(amount: RenewalAmount, termMonths: number | null | undefined): string | null {
  return amount.gst === EXPORT_GST ? `${rupee(amount.value)}${termSuffix(termMonths)} in ₹ (books)` : null;
}
