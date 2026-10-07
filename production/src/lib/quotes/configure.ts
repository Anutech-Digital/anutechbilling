/**
 * Customer-adjustable quotes — what happens when the buyer moves the seat count or
 * ticks an optional line on the public page.
 *
 * ─── THE PRICE IS DECIDED HERE, NEVER BY THE BROWSER ────────────────────────
 * The public page sends a CONFIGURATION — "line A: 25 seats, line C: included" — and
 * nothing else. It never sends a rate, a total, or a discount. Everything the customer
 * pays is recomputed from the quote's own stored lines plus the catalogue.
 *
 * This is not defensive habit, it is the only correct design: the public page has no
 * session, so anything it posts is attacker-controlled. A total sent by the browser is
 * a total the customer chose.
 *
 * ─── SEATS CAN CROSS A VOLUME BAND, WHICH CHANGES THE MARGIN ────────────────
 * This is the part that makes an "interactive quote" a money feature rather than a UI
 * feature. A customer sliding 10 seats to 60 moves into the 51+ band, every seat
 * re-prices, and the reseller's margin moves with it — possibly below the floor that
 * lib/quotes/approval.ts says needs the owner.
 *
 * So a reconfigured quote is run through the SAME approval matrix as an internal one.
 * If the new shape needs sign-off, the customer's click becomes a CHANGE REQUEST, not
 * an acceptance: the reseller is told, and nobody has agreed to anything yet. A
 * customer must not be able to self-accept into a deal the reseller's own rules would
 * have stopped.
 *
 * ─── WHAT THE CUSTOMER MAY CHANGE IS THE RESELLER'S DECISION ────────────────
 * Only lines the reseller explicitly marked `seats_adjustable` or `optional` can move.
 * Everything else is fixed. An "interactive" quote where the buyer can edit any line is
 * not a quote, it is an order form the seller has not seen.
 */
import type { Item, QuoteLineItem } from "@/lib/supabase/database.types";
import { slabPricing } from "./volume-tiers";
import { lineCostUnknown } from "./line-cost";
import { requiredApproval, type QuoteEconomics, type ApprovalRequirement } from "./approval";

/** What the customer sends back: per line, how many seats and whether it is included. */
export interface LineChoice {
  lineId: string;
  seats?: number;
  included?: boolean;
}

export interface ConfiguredLine {
  line: QuoteLineItem;
  qty: number;
  included: boolean;
  /** ₹/seat/year actually charged for this configuration. */
  rate: number;
  /** ₹/seat/year cost at this configuration. */
  cost: number;
  /** Set when the seat count moved this line into a different volume band. */
  bandLabel: string | null;
  /** True when the rate changed because of the seat count. */
  rePriced: boolean;
}

export interface ConfiguredQuote {
  lines: ConfiguredLine[];
  /** ₹ ex-GST the customer would pay. */
  subtotal: number;
  /** ₹ ex-GST at the quote's original configuration. */
  originalSubtotal: number;
  economics: QuoteEconomics;
  approval: ApprovalRequirement;
  /** True when the customer's shape differs from what the reseller sent. */
  changed: boolean;
  /**
   * True when this configuration may be accepted outright. False means the click
   * becomes a change request — see the header.
   */
  selfAcceptable: boolean;
}

/** Seat bounds a line allows. Absent bounds mean the seat count is fixed. */
export function seatBounds(line: QuoteLineItem): { min: number; max: number } | null {
  if (!line.seats_adjustable) return null;
  /* Defaults chosen so the customer can always grow and can shrink to half, which is
     the shape of a real negotiation. A reseller who wants different limits sets them
     on the line; these only apply when they did not. */
  const min = line.min_seats ?? Math.max(1, Math.floor(line.qty / 2));
  const max = line.max_seats ?? Math.max(line.qty * 3, line.qty + 50);
  return { min: Math.max(1, min), max: Math.max(min, max) };
}

function clampSeats(line: QuoteLineItem, wanted: number | undefined): number {
  const bounds = seatBounds(line);
  if (!bounds) return line.qty;
  const n = Math.trunc(wanted ?? line.qty);
  if (!Number.isFinite(n)) return line.qty;
  return Math.min(bounds.max, Math.max(bounds.min, n));
}

/**
 * Price a customer's configuration.
 *
 * `catalog` is used ONLY to re-price lines that carry an `item_id`. A custom line has
 * no catalogue row, so its rate stays exactly as the reseller typed it and scales with
 * the seat count — guessing a volume discount for a product with no price list would
 * be inventing a price nobody agreed to.
 */
export function configureQuote(
  lines: readonly QuoteLineItem[],
  choices: readonly LineChoice[],
  catalog: readonly Item[],
): ConfiguredQuote {
  const byId = new Map(choices.map((c) => [c.lineId, c]));
  const configured: ConfiguredLine[] = [];

  for (const line of lines) {
    const choice = byId.get(line.id);
    /* A line the reseller did not mark optional is always included, whatever the
       browser sends. */
    const included = line.optional ? (choice?.included ?? line.included_by_default ?? false) : true;
    const qty = clampSeats(line, choice?.seats);

    const item = line.item_id ? catalog.find((c) => c.id === line.item_id) : undefined;
    let rate = line.rate;
    let cost = line.cost;
    let bandLabel: string | null = null;
    let rePriced = false;

    if (item && qty !== line.qty) {
      const priced = slabPricing(item, qty);
      const newRate = Math.round(priced.msrpPerSeatMonth * 12);
      const newCost = Math.round(priced.wholesalePerSeatMonth * 12);
      bandLabel = priced.label;
      /* Only re-price when the line was still on its catalogue price. A negotiated
         rate stays negotiated at the new seat count — the reseller agreed a per-seat
         number, not a position in the price list. */
      const wasOnCatalogueRate = Math.round(slabPricing(item, line.qty).msrpPerSeatMonth * 12) === line.rate;
      if (wasOnCatalogueRate && newRate !== line.rate) {
        rate = newRate;
        cost = newCost;
        rePriced = true;
      } else if (wasOnCatalogueRate) {
        cost = newCost;
      }
    }

    configured.push({ line, qty, included, rate, cost, bandLabel, rePriced });
  }

  const live = configured.filter((c) => c.included);
  const subtotal = live.reduce((s, c) => s + c.qty * c.rate, 0);
  const originalSubtotal = lines
    .filter((l) => !l.optional || l.included_by_default)
    .reduce((s, l) => s + l.qty * l.rate, 0);

  const economics: QuoteEconomics = {
    subtotal,
    listTotal: live.reduce((s, c) => s + c.qty * (c.line.list_rate ?? c.rate), 0),
    totalCost: live.reduce((s, c) => s + c.qty * c.cost, 0),
    /* R-388: shared rule — the support plan at ₹0 is a known cost. */
    costUnknown: live.some((c) => lineCostUnknown({ cost: c.cost, rate: c.rate, item_id: c.line.item_id })),
  };

  const approval = requiredApproval(economics);
  const changed = configured.some((c) => {
    const wasIncluded = !c.line.optional || (c.line.included_by_default ?? false);
    return c.qty !== c.line.qty || c.included !== wasIncluded;
  });

  return {
    lines: configured,
    subtotal,
    originalSubtotal,
    economics,
    approval,
    changed,
    /* Unchanged quotes are always self-acceptable: the reseller already sent them, so
       whatever approval they needed happened before Send. Only a CHANGED shape has to
       clear the matrix again. */
    selfAcceptable: !changed || approval.tier === "none",
  };
}

/** Plain-language summary of what the customer altered, for the reseller's notification. */
export function describeChanges(c: ConfiguredQuote): string[] {
  const out: string[] = [];
  for (const line of c.lines) {
    const wasIncluded = !line.line.optional || (line.line.included_by_default ?? false);
    if (line.included && !wasIncluded) out.push(`Added "${line.line.name}".`);
    else if (!line.included && wasIncluded) out.push(`Removed "${line.line.name}".`);
    if (line.included && line.qty !== line.line.qty) {
      out.push(
        `"${line.line.name}": ${line.line.qty} → ${line.qty} seats` +
        (line.rePriced ? ` (rate moves to ₹${line.rate}/seat/yr${line.bandLabel ? `, ${line.bandLabel} band` : ""}).` : "."),
      );
    }
  }
  return out;
}
