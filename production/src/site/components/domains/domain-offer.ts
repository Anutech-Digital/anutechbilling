/**
 * What the /domains result card adds to the cart, and what it costs — ONE helper (R-1772).
 *
 * The page used to sum its own figures (domain + hosting + mailbox) while the cart priced the
 * lines it was handed. With "Domain only" the page still counted the mailbox that only the
 * hosting choice adds: ₹1,884 shown, ₹766 charged. Now the page builds the very lines it adds
 * and prices them with the cart's own cartTotals (site/lib/money.ts — the server's bundle rule:
 * yearly hosting frees a FREE_DOMAIN_TLDS domain and one mailbox), so the number next to the
 * button is the cart's number by construction.
 */
import { cartTotals, type CartLine } from "@/site/lib/money";
import type { HostingTier } from "@/site/lib/data/hosting-landing-v2";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { TEST_PRICE_LABEL } from "@/site/lib/domain-search";

export type OfferLine = Omit<CartLine, "key" | "qty">;

export interface DomainOfferInput {
  domain: string;
  /** ".in" */
  tld: string;
  /** The live first-year price (whole rupees), or null when unknown — nothing can be added. */
  domainReg: number | null;
  domainRenew: number | null;
  yearPrices?: Record<string, number>;
  testPrice?: boolean;
  hostingOn: boolean;
  tier: Pick<HostingTier, "name" | "monthly" | "yearlyTotal">;
  yearly: boolean;
  mailOn: boolean;
  /** ₹ one mailbox, one year (R-1786: the price book's figure; default MAILBOX_YR). */
  mailboxYearly?: number;
}

export interface DomainOffer {
  lines: OfferLine[];
  /** Payable incl. 18% GST, whole rupees — what the cart drawer shows for these lines. */
  total: number | null;
  /** The domain line is ₹0 (yearly hosting on an eligible TLD). */
  domainFree: boolean;
  /** What the bundle takes off (free domain + free mailbox), ex GST. */
  saved: number;
}


export function domainOffer(p: DomainOfferInput): DomainOffer {
  if (p.domainReg == null) return { lines: [], total: null, domainFree: false, saved: 0 };
  /* R-1628: the renewal is not repeated here (ex GST) — the cart page and checkout print it on its
     own line, incl. GST, from the same rate card (site/lib/renewal-line.ts). One fact, one place. */
  const regDetail = "Registration, 1 year";
  const lines: OfferLine[] = [{
    label: p.domain,
    // R-1769: a test-list price says so in the cart and at checkout too.
    detail: p.testPrice ? `${TEST_PRICE_LABEL} · ${regDetail}` : regDetail,
    /* At its FULL price (R-1601): the cart works out on every render whether yearly hosting
       makes it free, so removing the plan later puts the price back. */
    unitPrice: p.domainReg,
    unit: "year",
    cycle: "yearly",
    sku: `domain:${p.tld.replace(/^\./, "")}`,
    domain: p.domain,
    years: 1,
    yearPrices: p.yearPrices, // R-156: 2/3/5-year terms, when the registry prices them
  }];
  if (p.hostingOn) {
    lines.push({
      label: `${p.tier.name} hosting`,
      detail: p.yearly
        ? `Billed yearly · renews at the same price · pointed at ${p.domain}`
        : `Billed monthly · pointed at ${p.domain}`,
      // Whole rupees, as the checkout API charges it (Math.round of the same tier figure).
      unitPrice: Math.round(p.yearly ? p.tier.yearlyTotal : p.tier.monthly),
      unit: p.yearly ? "year" : "month",
      cycle: p.yearly ? "yearly" : "monthly",
      sku: `hosting:${p.tier.name.toLowerCase()}`,
    });
    // The mailbox follows the plan — "Domain only" adds none.
    if (p.mailOn) {
      lines.push({
        label: `Mailbox on ${p.domain}`,
        detail: "Anutech Mail · billed yearly",
        unitPrice: p.mailboxYearly ?? MAILBOX_YR, // full price; the cart frees one per yearly plan (R-1601)
        unit: "year",
        cycle: "yearly",
        sku: "mailbox:anutech",
      });
    }
  }
  const t = cartTotals(lines.map((l, i) => ({ ...l, key: `offer-${i}`, qty: 1 })), 0);
  const saved = t.priced.reduce((n, pl) => n + pl.line.unitPrice * pl.line.qty - pl.total, 0);
  return { lines, total: Math.round(t.payable), domainFree: t.priced[0].total === 0, saved };
}
