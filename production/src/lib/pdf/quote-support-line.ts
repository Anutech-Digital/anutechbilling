/**
 * R-367 — the "default free support is included" line on a quote.
 *
 * A quote without a paid support line still comes with support: the Free tier
 * (lib/support/tiers.ts) is what every customer has when they buy nothing. The
 * builder says so on the support cards ("Included by default"), but the preview
 * and the PDF said nothing, so the customer never learned it (tester report,
 * Q-A378-27-0002, 7 Oct 2026).
 *
 * ONE builder for both documents — the preview dialog and QuotePDF each call this
 * with the same line items, so the two cannot disagree. A quote that already
 * carries a support line (a paid company-wide plan or a product-wise add-on) gets
 * NO extra line: its priced row in the table is the support statement, and a
 * second "Free — Included" under it would contradict it.
 *
 * No price is printed: the free tier has none, and inventing "₹0" would read as a
 * line item.
 */
import { SUPPORT_TIERS, isSupportSkuId } from "@/lib/support/tiers";

export interface IncludedSupportLine {
  /** Tier label from lib/support/tiers — "Free". */
  planName: string;
  /** The line as printed: "Support: Free — Included". */
  text:     string;
  /** What the plan gives, from the same tier definition. */
  detail:   string;
}

interface LineLike {
  item_id?: string | null;
  name?:    string | null;
}

/** Does this line already sell support (catalogue SUP-… row, or a "… Support" line)? */
function isSupportLine(l: LineLike): boolean {
  if (isSupportSkuId(l.item_id)) return true;
  /* Lines typed without a catalogue row: "Standard Support", "Workspace Starter Support (Yearly)". */
  return /\bsupport\b/i.test(l.name ?? "");
}

export function includedSupportLine(lines: readonly LineLike[] | null | undefined): IncludedSupportLine | null {
  const items = lines ?? [];
  /* An empty quote is not offering anything yet — nothing to say support comes with. */
  if (items.length === 0) return null;
  if (items.some(isSupportLine)) return null;
  const free = SUPPORT_TIERS.find((t) => t.monthly === 0 && t.annualTotal === 0);
  if (!free) return null;
  return {
    planName: free.label,
    text:     `Support: ${free.label} — Included`,
    /* Same facts the builder's plan card lists (support-plan-picker), so the customer
       reads on the quote what the seller saw: "… · First response in 24h · Email only ·
       No live calls" (Abhishek's report, 7 Oct). */
    detail:   [free.summary, ...supportTierFacts(free)].join(" · "),
  };
}

/** The plan card's bullet facts for a tier, as plain text. */
export function supportTierFacts(tier: (typeof SUPPORT_TIERS)[number]): string[] {
  const channel =
    tier.channels.whatsapp === "24x7" ? "WhatsApp, 24/7"
    : tier.channels.whatsapp === "business_hours" ? "WhatsApp in business hours"
    : "Email only";
  const calls =
    tier.channels.meetCallsPerMonth === null ? "Unlimited live calls"
    : tier.channels.meetCallsPerMonth > 0 ? `${tier.channels.meetCallsPerMonth} live calls a month`
    : "No live calls";
  return [`First response in ${tier.slaHours}h`, channel, calls];
}
