/**
 * The cart line for a paid hosting plan — one builder, so the hosting page's "Buy now" and
 * the checkout pop-up's "Buy Starter instead" (1 Oct 2026) add the very same line and can
 * never charge differently.
 */
import type { HostingTier } from "@/site/lib/data/hosting-landing-v2";
import type { CartLine } from "@/site/lib/money";

export function paidHostingLine(p: Pick<HostingTier, "name" | "storage" | "bandwidth" | "monthly" | "yearlyTotal">, yearly: boolean): Omit<CartLine, "key" | "qty"> {
  return {
    label: `${p.name} hosting`,
    detail: `${p.storage} · ${p.bandwidth} · DirectAdmin on Google Cloud`,
    /* Whole rupees, exactly as the checkout API charges (Math.round of the
       same figure) — ₹599.88 here against ₹600 there made the shown total
       and the charged total disagree. */
    unitPrice: Math.round(yearly ? p.yearlyTotal : p.monthly),
    unit: yearly ? "year" : "month",
    cycle: yearly ? "yearly" : "monthly",
    sku: `hosting:${p.name.toLowerCase()}`,
  };
}
