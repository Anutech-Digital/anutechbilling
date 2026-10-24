/**
 * The public rate card — every customer price on one page (/rates).
 *
 * R-075 (1 Oct 2026): the header's "All prices" and the hosting page's rate-card link went
 * to /pricing, which is the ResellerOS SOFTWARE plans page — a visitor looking for a domain
 * or hosting price landed on software tiers.
 *
 * ONE RULE: every row here comes from the SAME source its product page shows, so the rate
 * card and the product page can never disagree:
 *   · domains  → getSiteTldPrices() (what /domains' rate table shows — live, R-1599)
 *   · hosting  → HOSTING_TIERS     (what /hosting shows; priced from LANDING_PLANS)
 *   · email    → mergeEditions(live) + MAIL_RATES (what /email shows, live GW overlay)
 *   · SSL      → CERTS             (what /ssl shows)
 * Nothing is typed in here. A price changes in its source, and both pages follow.
 */
import type { Cert } from "./data/catalog";
import type { HostingTier } from "./data/hosting-landing-v2";
import type { MergedEdition } from "./live-catalog";
import { rupee } from "./money";

export interface RateRow {
  name: string;
  note: string;
  /** Already formatted for the column, e.g. "₹499". "—" when not sold that way. Fewer
      cells than columns = the last one spans the rest. */
  cells: string[];
  /** True when the price was read live from the catalogue (not the placeholder). */
  live?: boolean;
}

export interface RateSection {
  id: "domains" | "hosting" | "email" | "ssl";
  title: string;
  unit: string;
  columns: string[];
  rows: RateRow[];
  href: string;
  cta: string;
}

/* R-1465: whole rupees, the site's one formatter — the yearly total then reads exactly what
   checkout charges (₹600, not ₹599.88). */
const inr = rupee;

/**
 * R-1599: what a domain price says when the live registry price is not known right now.
 * The search shows the live price; a placeholder figure is never printed instead.
 */
export const PRICE_AT_SEARCH = "Price at search";

/** A live TLD price, or "—" when that one figure is unknown. */
export const tldCell = (n: number | null): string => (n == null ? "—" : inr(n));

/** The fields a domain rate row needs. Live rows (SiteTld) satisfy it; TLDS does not (no `live`). */
export interface RateTld {
  tld: string;
  use: string;
  reg: number | null;
  renew: number | null;
  transfer: number | null;
  live: boolean;
}

export function buildRateCard(src: {
  tlds: readonly RateTld[];
  hosting: readonly HostingTier[];
  editions: readonly MergedEdition[];
  mailRates: Readonly<Record<string, number>>;
  certs: readonly Cert[];
}): RateSection[] {
  return [
    {
      id: "domains",
      title: "Domains",
      unit: "per year",
      columns: ["Register", "Renew", "Transfer"],
      /* No live register price → one cell across the row, never a placeholder number. */
      rows: src.tlds.map((t) => ({
        name: t.tld,
        note: t.use,
        cells: t.reg == null ? [PRICE_AT_SEARCH] : [inr(t.reg), tldCell(t.renew), tldCell(t.transfer)],
        live: t.live,
      })),
      href: "/domains",
      cta: "Search a domain",
    },
    {
      id: "hosting",
      title: "Web hosting",
      unit: "per month",
      columns: ["Billed monthly", "Billed yearly", "Yearly total"],
      rows: src.hosting.map((h) => ({
        name: h.name,
        note: `${h.storage} · ${h.sites} site${h.sites === "1" ? "" : "s"} · ${h.bandwidth} bandwidth`,
        cells: [inr(h.monthly), inr(h.yearlyMo), inr(h.yearlyTotal)],
      })),
      href: "/hosting",
      cta: "Start a free trial",
    },
    {
      id: "email",
      title: "Business email",
      unit: "per user, per month",
      columns: ["Annual plan", "Monthly plan"],
      rows: [
        ...(src.mailRates["Anutech Mail"] != null
          /* /email prints it as "/mailbox/mo" with no term, so one cell across both columns
             rather than a claim that it is the annual price. */
          ? [{ name: "Anutech Mail", note: "Our own mailboxes", cells: [`${inr(src.mailRates["Anutech Mail"])} · term on the quote`] }]
          : []),
        ...src.editions.map((e) => ({
          name: e.name,
          note: e.note,
          cells: [inr(e.annual), e.monthlyOrNull != null ? inr(e.monthlyOrNull) : "—"],
          live: e.live,
        })),
      ],
      href: "/email",
      cta: "Compare email plans",
    },
    {
      id: "ssl",
      title: "SSL certificates",
      unit: "per year",
      columns: ["Price"],
      rows: src.certs.map((c) => ({ name: c.name, note: c.who, cells: [c.price === "₹0" ? "Free" : `${c.price}${c.unit}`] })),
      href: "/ssl",
      cta: "See SSL options",
    },
  ];
}
