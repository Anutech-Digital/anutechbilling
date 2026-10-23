/**
 * Turning an inbound enquiry into a draft quote — the decision, separated from the writing.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Traced on 23 Aug 2026, asked as "50 Business Starter ka quote maangu to email par aa
 * jayega?". The answer was no, and the break was not where it looked: `/buy/workspace`
 * already auto-creates a draft quote from a form submission, but the inbound-email webhook
 * only ever inserted a lead. Nothing on the email path has ever produced a quote.
 *
 * The webhook is a 700-line route that has already been the source of two shipped bugs
 * (a lead created from our own forwarded mail; a reply spam-filtered off its own thread).
 * Putting money arithmetic inline there would make it a third. So the ARITHMETIC and the
 * REFUSALS live here, where they can be tested against a table of inputs, and the route
 * keeps only the writing.
 *
 * ─── IT MOSTLY REFUSES, AND SAYS WHY ────────────────────────────────────────
 * Four of the five outcomes are refusals. That is the point: a quote nobody asked for, or
 * one built on a seat count nobody read correctly, is worse than no quote — it is a
 * five-figure GST document with a wrong number on it, and it consumes an irreversible
 * number from the gapless Rule 46 series to do so. Every refusal carries a reason the
 * operator can act on, per CLAUDE.md §24; none of them is a silent null.
 *
 * ─── THE TERM IS ANNUAL, AND THAT IS A CHOICE ───────────────────────────────
 * An email says "50 Business Starter". It does not say monthly or annual, and there is no
 * honest way to read one out of the other. Annual is used because:
 *   - `buildWorkspaceLines` (the form path) already commits to `annual_yearly`, and two
 *     paths quoting the same product on different terms would be worse than either choice;
 *   - the output is a DRAFT. A human opens it before a customer ever sees it, and the term
 *     is the first thing on the line.
 * The choice is stated on the quote's own notes field by the caller, so whoever opens the
 * draft reads "annual, assumed" rather than discovering it from the arithmetic.
 *
 * If auto-SENDING is ever wired to this, that reasoning stops holding — an assumed term
 * that no human checked would reach the customer. Revisit here first.
 */

import { slabFor, discountedRate } from "@/lib/pricing/volume-slabs";
import type { ItemPrices } from "@/lib/supabase/database.types";

/** ₹ per seat per MONTH, as the `items` table stores them (whole rupees — AGENTS.md). */
export interface CatalogueItemPrice {
  id: string;
  name: string;
  /**
   * The ANNUAL tier's ₹/seat/month. `item-form.tsx` copies the headline tier — annual when
   * set, else monthly — into this legacy column, so for a normally-priced product this is the
   * annual rate and `× 12` is the annual line.
   */
  msrp: number | null;
  wholesale: number | null;
  /**
   * The full price matrix. Needed because the MONTHLY-flex tier is its own number and is not
   * `msrp`.
   *
   * ─── THE BUG THIS FIELD EXISTS TO FIX, 26 Aug 2026 ──────────────────────────
   * Before it, a monthly quote was built as `rate: monthlyMsrp` — the ANNUAL tier's rate on a
   * monthly-flex line. Live figures: annual ₹270/seat/month, monthly ₹325. So every monthly
   * quote the AI path produced was about 17% under, and `commitment-rate.ts`'s own header says
   * why that direction is wrong on purpose:
   *
   *   "the monthly tier usually costs MORE per month than a twelfth of the annual rate"
   *
   * Confirmed as ₹325 by Pardeep before this changed. Nothing here guesses a monthly price.
   */
  prices?: ItemPrices | null;
}

/** One quote line, shaped exactly as `buildWorkspaceLines` shapes it. */
export interface EnquiryQuoteLine {
  id: string;
  name: string;
  qty: number;
  /** ₹ per seat per YEAR — msrp × 12, because the commitment is annual. */
  rate: number;
  cost: number;
  commitment: "annual_yearly" | "monthly";
}

export type EnquiryQuotePlan =
  | { ok: false; reason: string }
  | {
      ok: true;
      items: EnquiryQuoteLine[];
      /** ex-GST and BEFORE the volume discount, whole rupees. */
      subtotal: number;
      /** incl-GST at 18%, AFTER the volume discount, whole rupees. */
      amount: number;
      /**
       * Whole percent off, from the volume rate card — goes onto `quotes.discount_pct`.
       *
       * ─── WHY THE DISCOUNT IS HERE AND NOT IN THE LINE RATE ────────────────
       * `discount_pct` is applied to the SUBTOTAL by every screen that renders a quote
       * (quotes/[id]:404, quotes:1138, invoices:1202 — all `subtotal − round(subtotal × pct)`).
       * Baking the discount into `rate` as well would hand the customer the same discount
       * twice, and the second one would be invisible on the document.
       *
       * Keeping it at quote level also means the document reads the way a real quote reads —
       * a list rate, a named discount line, a total — instead of a mystery per-seat number the
       * customer cannot check. The existing UI already renders "Discount (3%) −₹X"; nothing
       * new had to be drawn.
       */
      discountPct: number;
      /** Set when the rate card's discount was refused — the cost floor. Null when it applied. */
      discountNote: string | null;
      /** For the draft's notes, so the assumption is readable and not inferred. */
      assumption: string;
      /** False when the mail named the term. The auto-send gate reads THIS, not the text. */
      termAssumed: boolean;
    };

export interface PlanQuoteInput {
  item: CatalogueItemPrice | null;
  seats: number | null;
  /** From extractEntities().term — null means the sender never said. */
  term?: "monthly" | "annual" | null;
  /** Injected so the plan is deterministic under test — the route passes crypto. */
  newLineId?: () => string;
  /** R-1532: 0 for a business that issues a Bill of Supply (quoteStartTaxRate); else 18. */
  taxRatePct?: 0 | 18;
}

export function planQuoteFromEnquiry(input: PlanQuoteInput): EnquiryQuotePlan {
  const { item, seats } = input;

  if (!item) {
    return {
      ok: false,
      reason:
        "the mail did not name a product from this tenant's catalogue — the lead is saved, " +
        "build the quote from it once the product is confirmed",
    };
  }

  if (seats == null) {
    /* The commonest refusal by far, and deliberately not guessed at. A quote for the wrong
       number of seats is not a smaller error than no quote; it is a bigger one, because it
       looks finished. */
    return {
      ok: false,
      reason:
        `no seat count could be read from the mail, so "${item.name}" has no quantity — ` +
        "the lead is saved with the product, add the seats and the quote builder is one tap",
    };
  }

  if (!Number.isInteger(seats) || seats <= 0 || seats > 9999) {
    return { ok: false, reason: `seat count ${seats} is not a quantity anyone orders — no quote built` };
  }

  const monthlyMsrp = item.msrp ?? 0;
  if (!Number.isFinite(monthlyMsrp) || monthlyMsrp <= 0) {
    /* Enterprise tiers and anything hand-priced land here, which is correct: the form path
       skips Enterprise for exactly this reason rather than quoting a zero. */
    return {
      ok: false,
      reason:
        `"${item.name}" has no sell price in the catalogue, so it is priced by hand — ` +
        "the lead is saved, price it and send",
    };
  }

  /* Cost may legitimately be absent — margin then reads as unknown rather than as 100%,
     which is what a 0 would have claimed. */
  const monthlyCost = Number.isFinite(item.wholesale ?? NaN) ? (item.wholesale as number) : 0;

  /* TERM. Stated when the sender said so, annual when nobody did — and `termAssumed`
     records which, because the two are not interchangeable downstream. The units differ,
     not just the number: `annual_yearly` carries ₹/seat/YEAR and `monthly` carries
     ₹/seat/MONTH, which is the boundary lib/quotes/commitment-rate.ts exists to police.
     Writing a monthly rate onto an annual line is a 12× error in the customer's favour or
     ours depending on direction, and both are unacceptable on a GST document. */
  const termAssumed = input.term == null;
  const term = input.term ?? "annual";
  const annual = term === "annual";

  /* ── The monthly-flex tier is its OWN price ─────────────────────────────────
     Not `msrp`. Live: annual ₹270/seat/month, monthly ₹325 — the flex tier costs more because
     there is no commitment behind it, which is the whole point of having two.

     ⚠️ THE FALLBACK KEEPS THE UNIT, NOT THE PRICE. With no monthly tier recorded we use
     `msrp` — under-priced, but ₹/seat/MONTH on a monthly line. The alternative failure is a
     ₹/seat/YEAR figure on a monthly line, which is a twelvefold error on a GST document;
     commitment-rate.ts made the same choice for the same reason and says so at length. Under
     by a tier is a commercial mistake somebody can spot on the quote. Out by 12× is not.

     Deliberately NOT refusing to quote when the tier is missing: 71 of the pre-reset
     catalogue's rows had no `prices` matrix at all, so refusing would have taken the whole
     monthly path down for most products to avoid an under-price on some. */
  const flexTier = item.prices?.monthly ?? null;
  const flexMsrp = flexTier && flexTier.msrp > 0 ? flexTier.msrp : monthlyMsrp;
  const flexCost = flexTier && flexTier.wholesale > 0 ? flexTier.wholesale : monthlyCost;

  const newId = input.newLineId ?? (() => globalThis.crypto.randomUUID());
  const items: EnquiryQuoteLine[] = [{
    id:         newId(),
    name:       item.name,
    qty:        seats,
    rate:       annual ? monthlyMsrp * 12 : flexMsrp,
    cost:       annual ? monthlyCost * 12 : flexCost,
    commitment: annual ? "annual_yearly" : "monthly",
  }];

  const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);

  /* ── The volume rate card ────────────────────────────────────────────────
     Applied HERE, in the one function both the form path and the AI path price through, so
     an agent-built quote and a hand-built quote for the same seat count cannot come out at
     different money.

     The floor is checked against the LINE's own rate and cost — not against a global rupee
     figure. See lib/pricing/volume-slabs.ts for why that distinction is the whole guard. */
  /* ── AND NOT ON THE FLEX TIER ─────────────────────────────────────────────
     Pardeep, 31 Aug 2026: "monthly committment par koi discount nahi hai."

     Commercially that is the whole point of two tiers. The flex rate is ALREADY higher — Rs
     325 against Rs 270 — precisely because the customer promises nothing. Taking a volume
     discount off it spends the premium the tier exists to earn, for a commitment nobody made.

     Measured on the mail that prompted this: Q-ADPL-2026-27-0057 went out at 37 seats with 3%
     off the monthly rate. The AI's own reply had it right — it quoted 3% on the ANNUAL line
     and plain Rs 325 monthly — because `netCostBlock` discounts `msrpPerSeatPerYear` and
     nothing else. So the model and the pricer disagreed on the same lead, and the pricer was
     the one writing the document. One condition, and they agree again. */
  const slab = annual ? slabFor(seats) : ({ kind: "flex" } as const);
  const priced =
    slab.kind === "slab"
      ? discountedRate(items[0].rate, slab.slab.percent, items[0].cost)
      : { rate: items[0].rate, appliedPercent: 0, note: null };

  const discountPct = priced.appliedPercent;
  /* Rounded the same way every screen that renders a quote rounds it, so the stored `amount`
     and the figure the customer reads on the document are the same number. */
  const discountValue = Math.round(subtotal * (discountPct / 100));

  /* One rounding, at the end, on the ex-GST total — the same single-rounding rule
     buildWorkspaceLines follows, so the two paths cannot disagree by a rupee on the same
     product and seat count. */
  const amount = input.taxRatePct === 0
    ? subtotal - discountValue                       // R-1532: Bill of Supply — no GST
    : Math.round((subtotal - discountValue) * 1.18);

  /* The rate card, in words, on the draft's own notes. Whoever opens this quote must READ
     why the price is what it is rather than reverse-engineer it from the total — the same
     reason `assumption` states the term instead of leaving it to be inferred. */
  const slabNote =
    priced.note ??
    (slab.kind === "flex"
      /* Says WHY, not just "no discount": the customer will ask why 37 seats got nothing off,
         and the answer belongs on the document.

         NO SECOND RATE IN IT, and that is not brevity. This note first read "Rs 325 against
         Rs 270 on an annual term", and the test above went red — correctly. The assumption
         must name the rate the LINE carries and no other, because a `270` appearing there is
         itself a signal: it means the monthly tier was missing and the annual rate was used.
         Adding it as an explanation would have made that signal unreadable. */
      ? `Monthly (flex) — list price, no volume discount: the flex rate already carries the ` +
        `no-commitment premium, so the volume rate card does not apply on this tier.`
      : discountPct > 0 && slab.kind === "slab"
        ? `${slab.slab.label}: ${discountPct}% off list for ${seats} seats (volume rate card).`
        : slab.kind === "slab"
          ? `${seats} seats is inside the ${slab.slab.minSeats}–${slab.slab.maxSeats} band — list price, no discount.`
          : null);

  return {
    ok: true,
    items,
    subtotal,
    amount,
    discountPct,
    discountNote: priced.note,
    termAssumed,
    /* The rate named here must be the one actually on the line. It said `monthlyMsrp` for both
       terms, so a monthly quote priced at the flex tier would have described itself with the
       ANNUAL rate — the note contradicting the line it explains. Same class as the email that
       omitted the volume discount, one field further in. */
    assumption:
      (termAssumed
        ? `Term ASSUMED annual (₹${monthlyMsrp}/seat/month × 12). The mail did not say ` +
          "monthly or annual — check this line before sending."
        : annual
          ? `Term ANNUAL, as stated in the mail (₹${monthlyMsrp}/seat/month × 12).`
          : `Term MONTHLY, as stated in the mail (₹${flexMsrp}/seat/month, the flex tier` +
            `${flexTier ? "" : " — no monthly tier recorded, so the annual rate was used"}).`) +
      (slabNote ? `\n${slabNote}` : ""),
  };
}
