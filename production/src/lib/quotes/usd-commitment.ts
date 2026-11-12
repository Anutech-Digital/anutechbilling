/**
 * R-2638 — a Commitment switch (Annual ⇄ Monthly) on a catalogue line of a quote billed on the
 * item's USD price. The builder's ₹ tier path put the ₹ catalogue on the USD line (rate AND list),
 * so typing the item's USD price back read as a 65% "discount" and asked the owner to approve it.
 *
 * A line is "on the USD price list" only when its list price IS the item's USD price for its
 * current commitment (within ₹1 a unit). That keeps the builder's pricing basis out of it: the
 * basis is not saved with a quote, so a reopened "India rate → USD" quote — list = the ₹ price —
 * is not on the USD list and keeps the ₹ path exactly as before.
 *
 * Re-priced the way the currency / rate effect does: list = the USD price for the new commitment
 * (catalogLineListRate, the same price as adding the item), the line's discount ratio kept, and a
 * cost the user typed (or that the catalogue cannot give) converted to the new unit, not left in
 * the old one.
 */
import type { Item, LineCommitment, QuoteLineItem } from "@/lib/supabase/database.types";
import { catalogLineListRate } from "./catalog-line";
import { convertRateForCommitment } from "./commitment-rate";
import { inrRateFromForeign } from "./foreign-totals";

type CatalogRow = Pick<Item, "msrp" | "wholesale" | "prices"> & { name?: string | null; vendor?: string | null; item_type?: string | null };

export function usdCommitmentReprice(args: {
  line: QuoteLineItem;
  item: CatalogRow;
  commitment: LineCommitment;
  /** The item's USD tier and the quote's rate — null when the quote does not bill on it. */
  usd: { msrp: number; wholesale: number; fx: number } | null;
  /** The user typed this line's cost — keep it (in the new unit). */
  costTyped: boolean;
}): QuoteLineItem | null {
  const { line, item, commitment, usd } = args;
  if (!usd || !(usd.msrp > 0) || !line.commitment || line.bulk) return null;

  const listNow = line.list_rate ?? line.rate;
  const usdNow = catalogLineListRate(item, line.commitment, usd).rate;
  if (!(usdNow > 0) || Math.abs(listNow - usdNow) > 1) return null;   // not on the USD list

  const next = catalogLineListRate(item, commitment, usd);
  if (!(next.rate > 0)) return null;
  const ratio = listNow > 0 && line.rate < listNow ? line.rate / listNow : 1;
  const rate = ratio < 1 ? inrRateFromForeign(next.rate * ratio, 1) : next.rate;
  const keptCost = convertRateForCommitment({ rate: 0, cost: line.cost, from: line.commitment, to: commitment }).cost;
  return {
    ...line,
    commitment,
    rate,
    list_rate: next.rate,
    cost: args.costTyped || !(next.cost > 0) ? keptCost : next.cost,
  };
}
