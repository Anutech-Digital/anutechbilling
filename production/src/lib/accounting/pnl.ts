/**
 * The P&L model — and the reason it exists is a number the old page got wrong.
 *
 * ─── THE PAGE WAS REPORTING A 100% GROSS MARGIN ─────────────────────────────
 * /accounting/pnl reads COGS from `vendor_bills where category like 'COGS-%'`. That table
 * has **zero rows** on the live tenant. So the report showed:
 *
 *     Revenue      ₹x
 *   − COGS         ₹0
 *   = Gross Margin 100%
 *
 * A reseller does not have a 100% margin. They buy licences and sell them.
 *
 * And the cost is NOT missing from the app — only from that table. The subscriptions
 * carry it: 9 Google subscriptions, 199 seats, ₹1,08,552/month of MRR against ₹70,340 of
 * wholesale. That is a 35.2% margin, which is a healthy reseller number and the one the
 * owner needed to see. The P&L was reading the empty table instead of the full one.
 *
 * ─── SO COGS HAS A BASIS, AND THE BASIS IS ALWAYS ON SCREEN ─────────────────
 * `billed`    — real vendor bills exist. Accrual, auditable, what a CA wants.
 * `estimated` — no bills, so cost is derived from subscription × wholesale rate.
 * `unknown`   — neither is available, and the margin is NOT reported.
 *
 * The two are never silently mixed and an estimate never renders as a fact. An estimate
 * is far better than a zero — zero produces a confident wrong answer, and "unknown"
 * produces no answer at all — but it is somebody's rate card, not their invoice, and the
 * screen has to say which one it is.
 *
 * ─── A ZERO COST MEANS TWO DIFFERENT THINGS ─────────────────────────────────
 * Taken from lib/subscriptions/margin.ts, which already got this right. Against Google,
 * Microsoft or Zoho, a zero cost is data nobody filled in. Against the reseller's OWN
 * support product it is genuinely free of vendor cost — ANUTECH's 4 support subscriptions
 * really do carry ₹0 wholesale.
 *
 * Treating the first as 100% margin puts the healthiest number in the app on the row we
 * know least about, which is exactly backwards.
 *
 * ─── WHOLE RUPEES ───────────────────────────────────────────────────────────
 * Everything in and out is integer rupees. The only division is the margin percentage,
 * which is presentation, never stored.
 */

import { rupee } from "@/lib/utils";

/** Vendors whose products are BOUGHT and resold — a zero cost here is missing data. */
export const RESOLD_VENDORS: ReadonlySet<string> = new Set(["google", "microsoft", "zoho"]);

/**
 * `mixed` (R-1645): some vendors have bills in the period and are costed from them, the rest
 * keep their subscription estimate. Before, one bill from any vendor switched the estimate
 * off for every vendor.
 */
export type CogsBasis = "billed" | "estimated" | "mixed" | "unknown";

/** True when part or all of the licence cost is the subscription-book estimate. */
export function isEstimatedBasis(b: CogsBasis): boolean {
  return b === "estimated" || b === "mixed";
}

/**
 * Which subscription vendor a COGS bill category belongs to (R-1645) — the categories the
 * bill forms offer (add-vendor-bill-dialog, create-bill-from-po-dialog). COGS-Other and
 * anything unknown belong to no resold vendor: they add to cost and switch no estimate off.
 */
const COGS_CATEGORY_VENDOR: Readonly<Record<string, string>> = {
  "COGS-Workspace": "google",
  "COGS-M365":      "microsoft",
  "COGS-Zoho":      "zoho",
};

export function vendorOfCogsCategory(category: string | null | undefined): string | null {
  return (category && COGS_CATEGORY_VENDOR[category]) || null;
}

export interface VendorLine {
  /** `google`, `microsoft`, `zoho`, `support`, … as stored on the subscription. */
  vendor: string;
  /** Human label — "Google Workspace", not "google". */
  label: string;
  /** ₹ the customer pays, for the period. */
  revenue: number;
  /** ₹ the vendor charges, for the period. */
  cost: number;
  /** revenue − cost. */
  gross: number;
  /**
   * Integer percent of REVENUE, or null when it cannot honestly be stated.
   *
   * Null, never 0 and never 100, when a resold vendor has no cost recorded — see the
   * header. `0` would read as "we make nothing" and `100` as "it is all profit"; both
   * are assertions, and the truth is that nobody knows.
   */
  marginPct: number | null;
  /** Why the margin is null, in the operator's words. */
  marginNote: string | null;
  seats: number;
  subscriptions: number;
}

export interface PnlPeriod {
  revenue: number;
  /** ₹, on whichever basis `cogsBasis` names — licence cost + project delivery cost. */
  cogs: number;
  /** The basis of the LICENCE part. Project delivery cost is always a booked figure. */
  cogsBasis: CogsBasis;
  /** Licence / resale cost (0 when the basis is `unknown`) = billedLicenceCogs + estimatedLicenceCogs. */
  licenceCogs: number;
  /** R-1645/R-1646: the part of licenceCogs from vendor bills (incl. blocked GST). */
  billedLicenceCogs: number;
  /**
   * R-1646: the part of licenceCogs estimated from the subscription book — not billed yet.
   * The Trial Balance books it as its own head with a provision, the Balance Sheet carries
   * the same provision, so all three reports state one profit.
   */
  estimatedLicenceCogs: number;
  /** Salary on customer projects + project-tagged expenses (lib/accounting/project-cost.ts). */
  projectCost: number;
  /** Revenue invoiced against project milestones — not costed like a licence. */
  projectRevenue: number;
  /** Operating expenses — salaries, hosting, office. NOT cost of goods, so net of projectCost. */
  expenses: number;
  /** revenue − cogs. Null when the basis is `unknown`. */
  grossMargin: number | null;
  /** Integer percent of revenue. Null when the basis is `unknown`, or revenue is 0. */
  grossMarginPct: number | null;
  /** Revenue − cost of goods − expenses. Null only when the licence cost basis is `unknown`. */
  netProfit: number | null;
  /**
   * R-1649: the project delivery cost could not be read by this role (salaries are owner /
   * manager / accountant only — R-1001). Then `projectCost` is 0, the salary stays inside
   * `expenses`, and `grossMargin` is null — hidden, never overstated. Net profit is unaffected
   * (project cost is a reclassification, never an addition).
   */
  projectCostHidden?: boolean;
  byVendor: VendorLine[];
  /** R-2095: how the estimated licence cost was worked out — null when nothing is estimated. */
  estimateBasis?: CogsEstimateBasis | null;
}

const VENDOR_LABELS: Record<string, string> = {
  google:    "Google Workspace",
  microsoft: "Microsoft 365",
  zoho:      "Zoho",
  support:   "In-House Support",
};

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

export interface VendorInput {
  vendor: string;
  revenue: number;
  /** ₹ from vendor bills, when any exist for this vendor in the period. */
  billedCost: number | null;
  /** ₹ derived from subscription seats × the item's wholesale rate. */
  estimatedCost: number;
  seats: number;
  subscriptions: number;
}

/**
 * One vendor's line, with the margin stated only when it can be.
 */
export function vendorLine(v: VendorInput): VendorLine {
  const resold = RESOLD_VENDORS.has(v.vendor);
  const cost = v.billedCost ?? v.estimatedCost;
  const costKnown = v.billedCost !== null || v.estimatedCost > 0 || !resold;

  const gross = v.revenue - cost;
  let marginPct: number | null = null;
  let marginNote: string | null = null;

  if (!costKnown) {
    marginNote =
      `No wholesale cost recorded for ${vendorLabel(v.vendor)}. ` +
      `Licences you buy and resell cannot have a 100% margin — add the vendor's rate or bill to see the real number.`;
  } else if (v.revenue <= 0) {
    marginNote = "No revenue in this period, so there is no margin to report.";
  } else {
    marginPct = Math.round((gross / v.revenue) * 100);
  }

  return {
    vendor: v.vendor,
    label: vendorLabel(v.vendor),
    revenue: v.revenue,
    cost,
    gross,
    marginPct,
    marginNote,
    seats: v.seats,
    subscriptions: v.subscriptions,
  };
}

/**
 * R-2095 (staging P&L, 30 Oct 2026): the COGS drill-down said "No transactions" beside an
 * estimated cost. The estimate's own working: the licence revenue × the subscription book's
 * wholesale ÷ price ratio, from the vendors without a bill (their subscriptions and seats).
 */
export interface CogsEstimateBasis {
  licenceRevenue: number;
  /** Book cost ÷ book price, one decimal. Null when the book has no price (cost taken as is). */
  ratioPct: number | null;
  estimated: number;
  vendors: Array<{ vendor: string; label: string; subscriptions: number; seats: number; bookRevenue: number; bookCost: number }>;
}

export interface PnlInput {
  revenue: number;
  /** Every operating cost booked in the period, INCLUDING the part that is project cost. */
  expenses: number;
  /**
   * The part of `expenses` that is project delivery cost (project-cost.ts). It is moved,
   * not added: cost of goods goes up and operating expenses go down by the same rupees.
   */
  projectCost?: number;
  /** R-1649: the caller could not read the salaries behind the project cost — hide the margin. */
  projectCostHidden?: boolean;
  /** Part of `revenue` invoiced against projects — the licence ratio is not applied to it. */
  projectRevenue?: number;
  /** Total ₹ of vendor bills in the period. Null when the table holds none. */
  billedCogs: number | null;
  /**
   * R-1645: the part of `billedCogs` per subscription vendor (vendorOfCogsCategory). A vendor
   * with a bill is costed from its bills; every other vendor keeps its estimate. The rest of
   * `billedCogs` (COGS-Other) is added on top. Absent / null = no per-vendor split (an older
   * report_pnl) — then the old rule: any bill switches the whole estimate off.
   */
  billedByVendor?: Readonly<Record<string, number>> | null;
  vendors: VendorInput[];
}

/**
 * Build the period.
 *
 * `billedCogs` takes precedence when it exists — a real invoice beats a rate card, and a
 * CA can only sign off on the invoice. The estimate is the fallback that keeps the report
 * useful for a reseller who has not entered a single bill, which is the live situation.
 */
export function buildPnl(input: PnlInput): PnlPeriod {
  /* R-1645: a vendor with a bill in the period is costed from its bills, on its own line. */
  const perVendor = input.billedByVendor ?? null;
  const billedFor = (vendor: string): number | null => {
    const b = perVendor?.[vendor] ?? 0;
    return b > 0 ? b : null;
  };
  const byVendor = input.vendors
    .map((v) => {
      const b = billedFor(v.vendor);
      return vendorLine(b === null ? v : { ...v, billedCost: b });
    })
    .sort((a, b) => b.revenue - a.revenue);

  /* ── THE ESTIMATE IS A RATIO, NOT A RUPEE TOTAL ─────────────────────────────
     This was wrong on the first pass and the live data showed it immediately.

     Invoiced revenue and subscription cost accrue on completely different clocks. ANUTECH
     invoiced ₹9,14,376 on 17 August — annual terms, billed in one day — while the
     subscription book accrued about ₹35,283 of licence cost over that half-month. Putting
     those two in the same waterfall gave a 96% margin: a whole year of revenue against a
     fortnight of cost.

     So when there are no vendor bills, the book supplies the RATIO (cost ÷ revenue,
     62.5% here) and it is applied to the revenue actually recognised. The rupees then sit
     on the same clock and the margin matches the per-vendor figures below it — 37%, not
     96%, and not the 100% this page shipped with.

     The assumption is stated on screen: it holds while what you invoiced resembles what
     you sell. A reseller who suddenly bills a large one-off consulting job would see it
     costed like a licence, which is why the fix is a vendor bill, not a better guess. */
  const bookRevenue = byVendor.reduce((s, v) => s + v.revenue, 0);
  /* R-1645: only the vendors WITHOUT a bill are estimated — their book cost against the whole
     book's revenue, so a billed vendor's share of revenue is not costed a second time. */
  const unbilled = byVendor.filter((v) => billedFor(v.vendor) === null);
  const bookCost = unbilled.reduce((s, v) => s + v.cost, 0);
  /* Project revenue is software the team built, not a licence bought — costing it at the
     licence ratio is the "one-off consulting job costed like a licence" error above. Its
     cost is the project delivery cost, which is booked, so only the rest is estimated. */
  const projectRevenue = Math.min(Math.max(0, input.projectRevenue ?? 0), input.revenue);
  /* R-1649: a project cost built on unreadable salaries is not a figure — it stays in operating
     expenses (where it was booked) and the gross margin is hidden below. */
  const projectCostHidden = input.projectCostHidden === true;
  const projectCost = projectCostHidden ? 0 : Math.max(0, input.projectCost ?? 0);
  const licenceRevenue = input.revenue - projectRevenue;
  const estimated = bookRevenue > 0
    ? Math.round(licenceRevenue * (bookCost / bookRevenue))
    : bookCost;

  /* `unknown` only when there is genuinely nothing to go on: no bills, no estimate, and
     revenue that must have cost something. Revenue with no cost basis at all is the case
     that must NOT render as a margin. */
  const anyResoldWithoutCost = unbilled.some(
    (v) => RESOLD_VENDORS.has(v.vendor) && v.cost === 0 && v.revenue > 0,
  );
  const billed = input.billedCogs !== null && input.billedCogs > 0 ? input.billedCogs : 0;
  const nothingKnown = (): CogsBasis => (licenceRevenue > 0 && anyResoldWithoutCost ? "unknown" : "billed");

  let billedPart = 0;
  let estimatedPart = 0;
  let cogsBasis: CogsBasis;
  if (perVendor !== null) {
    /* R-1645: the bills, plus the estimate of every vendor that has none. */
    billedPart = billed;
    estimatedPart = Math.max(0, estimated);
    cogsBasis = billedPart > 0 && estimatedPart > 0 ? "mixed"
      : billedPart > 0 ? "billed"
      : estimatedPart > 0 ? "estimated"
      : nothingKnown();
  } else if (billed > 0) {
    /* No per-vendor split (an older report_pnl): a real invoice beats a rate card, whole. */
    billedPart = billed;
    cogsBasis = "billed";
  } else if (estimated > 0) {
    /* Part of the book may be priced and part not. The estimate is still the best figure
       available, and the caller surfaces which vendors are missing. */
    estimatedPart = estimated;
    cogsBasis = "estimated";
  } else {
    cogsBasis = nothingKnown();
  }

  const licenceCogs = billedPart + estimatedPart;
  const cogs = licenceCogs + projectCost;
  const expenses = input.expenses - projectCost;
  const knownGross = cogsBasis === "unknown" ? null : input.revenue - cogs;
  const grossMargin = projectCostHidden ? null : knownGross;
  const grossMarginPct =
    grossMargin === null || input.revenue <= 0
      ? null
      : Math.round((grossMargin / input.revenue) * 100);
  const netProfit = knownGross === null ? null : knownGross - expenses;

  return {
    revenue: input.revenue,
    cogs,
    cogsBasis,
    licenceCogs,
    billedLicenceCogs: billedPart,
    estimatedLicenceCogs: estimatedPart,
    projectCost,
    projectRevenue,
    expenses,
    grossMargin,
    grossMarginPct,
    netProfit,
    projectCostHidden,
    byVendor,
    /* R-2095 */
    estimateBasis: estimatedPart > 0 ? {
      licenceRevenue,
      ratioPct: bookRevenue > 0 ? Math.round((bookCost / bookRevenue) * 1000) / 10 : null,
      estimated: estimatedPart,
      vendors: unbilled.filter((v) => v.cost > 0 || v.revenue > 0).map((v) => ({
        vendor: v.vendor, label: v.label, subscriptions: v.subscriptions, seats: v.seats, bookRevenue: v.revenue, bookCost: v.cost,
      })),
    } : null,
  };
}

/* ─── ESTIMATING A PERIOD'S COST FROM THE SUBSCRIPTION BOOK ───────────────── */

export interface SubscriptionCost {
  vendor: string;
  seats: number;
  /** ₹ the CUSTOMER pays per month. */
  mrr: number;
  /** ₹ the VENDOR charges per seat per month. 0 = none recorded. */
  wholesalePerSeatMonth: number;
  /** YYYY-MM-DD. */
  startDate: string | null;
  /** YYYY-MM-DD — when the term ends. */
  renewalDate: string | null;
}

/**
 * How many months of this subscription fall inside the window.
 *
 * ─── WHY NOT JUST MULTIPLY BY THE PERIOD'S LENGTH ───────────────────────────
 * A subscription sold in January did not cost anything in April. Multiplying every
 * subscription's monthly wholesale by twelve for an FY report would bill the reseller for
 * months before they had the customer — and the error grows with the length of the
 * period, so it is largest on the annual report somebody actually files against.
 *
 * Overlap is measured in days and divided by 30.44, then rounded to two decimals. Days
 * are what the dates give us; a "months" figure derived any other way pretends to a
 * precision the data does not have.
 */
export function monthsActiveInPeriod(
  sub: Pick<SubscriptionCost, "startDate" | "renewalDate">,
  from: string,
  to: string,
): number {
  const AVG_DAYS_PER_MONTH = 30.44;
  const day = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00+05:30`);

  /* No start date means we do not know when it began. Assuming the window's start would
     bill the whole period to a subscription that may have begun yesterday. */
  if (!sub.startDate) return 0;

  const begin = Math.max(day(sub.startDate), day(from));
  /* No renewal date → still running, so it runs to the end of the window. That is the
     safe direction: it under-states nothing and over-states only a subscription somebody
     forgot to close. */
  const finish = Math.min(sub.renewalDate ? day(sub.renewalDate) : day(to), day(to));

  if (finish < begin) return 0;
  const days = (finish - begin) / 86_400_000 + 1;   // inclusive of both days
  return Math.round((days / AVG_DAYS_PER_MONTH) * 100) / 100;
}

/**
 * Roll the subscription book into per-vendor revenue and cost for the window.
 *
 * Both sides come from the SAME rows, so a vendor's margin is internally coherent. Mixing
 * invoiced revenue with rate-card cost — different groupings, different timing — produces
 * per-vendor margins that do not reconcile with anything.
 *
 * Rupees are rounded once, at the end of each vendor, never per subscription: rounding
 * 199 seats individually and summing drifts from the total the customer is billed.
 */
export function vendorsFromSubscriptions(
  subs: readonly SubscriptionCost[],
  from: string,
  to: string,
): VendorInput[] {
  const acc = new Map<string, { revenue: number; cost: number; seats: number; count: number }>();

  for (const s of subs) {
    const months = monthsActiveInPeriod(s, from, to);
    if (months <= 0) continue;
    const prev = acc.get(s.vendor) ?? { revenue: 0, cost: 0, seats: 0, count: 0 };
    prev.revenue += s.mrr * months;
    prev.cost += s.wholesalePerSeatMonth * s.seats * months;
    prev.seats += s.seats;
    prev.count += 1;
    acc.set(s.vendor, prev);
  }

  return [...acc.entries()].map(([vendor, v]) => ({
    vendor,
    revenue: Math.round(v.revenue),
    billedCost: null,
    estimatedCost: Math.round(v.cost),
    seats: v.seats,
    subscriptions: v.count,
  }));
}

/** The short "where from" under the licence-cost line — the P&L page and headline say it one way. */
export function licenceCostHint(p: Pick<PnlPeriod, "cogsBasis" | "estimatedLicenceCogs">, billCount: number): string {
  const bills = `${billCount} vendor bill${billCount === 1 ? "" : "s"}`;
  if (p.cogsBasis === "mixed") return `${bills} + ${rupee(p.estimatedLicenceCogs)} estimated from your wholesale rates`;
  if (p.cogsBasis === "estimated") return "estimated from your wholesale rates";
  return bills;
}

/** One line the page prints under the COGS row, saying where the number came from. */
export function cogsBasisNote(p: PnlPeriod): string {
  switch (p.cogsBasis) {
    case "mixed":
      return `Part estimated: ${rupee(p.billedLicenceCogs)} is from vendor bills recorded for this period; ${rupee(p.estimatedLicenceCogs)} is estimated for the vendors with no bill yet, from your subscription book's wholesale-to-price ratio. Enter those vendors' invoices to make it exact.`;
    case "billed":
      if (p.projectCost > 0 && p.licenceCogs === 0) return "Project delivery cost only — salary on customer projects and project-tagged expenses. No licence cost in this period.";
      return p.cogs > 0
        ? "From vendor bills recorded for this period."
        : "No cost of goods for this period — nothing bought to resell.";
    case "estimated":
      return "Estimated: no vendor bills are recorded, so your subscription book's wholesale-to-price ratio has been applied to what you invoiced. It holds while what you bill looks like what you sell — enter the vendor's invoices to make it exact.";
    case "unknown":
      if (p.projectCost > 0) return "The licence cost is not recorded, so the margin cannot be shown — only the project delivery cost (salary on customer projects) is. A licence you buy and resell is never 100% profit.";
      return "Cost of goods is not recorded, so the margin cannot be shown. A licence you buy and resell is never 100% profit.";
  }
}

/* ─── PERIOD COMPARISON ───────────────────────────────────────────────────── */

export type DeltaKind = "up" | "down" | "flat" | "new" | "gone" | "incomparable";

export interface Delta {
  kind: DeltaKind;
  /** Integer percent, or null when a percentage would be meaningless. */
  pct: number | null;
  /** ₹ difference, always present. */
  absolute: number;
  /** What the badge should say. Never a bare number. */
  label: string;
}

/**
 * Compare two figures across periods.
 *
 * ─── THE TWO TRAPS ──────────────────────────────────────────────────────────
 * **Growth from zero is not a percentage.** ₹0 → ₹50,000 is not "+100%" and not "∞"; it is
 * new business. Printing a percentage there is arithmetic nobody can act on.
 *
 * **A part-period is not a decline.** Comparing 18 days of this month against all 31 of
 * last month shows a fall that has not happened. `partialCurrent` marks that case
 * `incomparable`, so the page shows a note instead of a red badge that is simply wrong.
 */
export function compareFigures(
  current: number,
  previous: number,
  opts: { partialCurrent?: boolean } = {},
): Delta {
  const absolute = current - previous;

  if (opts.partialCurrent) {
    return {
      kind: "incomparable", pct: null, absolute,
      label: "period still running",
    };
  }
  if (previous === 0 && current === 0) {
    return { kind: "flat", pct: null, absolute: 0, label: "nothing either period" };
  }
  if (previous === 0) {
    return { kind: "new", pct: null, absolute, label: "new this period" };
  }
  if (current === 0) {
    return { kind: "gone", pct: null, absolute, label: "nothing this period" };
  }

  const pct = Math.round((absolute / Math.abs(previous)) * 100);
  if (pct === 0) return { kind: "flat", pct: 0, absolute, label: "unchanged" };
  return {
    kind: pct > 0 ? "up" : "down",
    pct,
    absolute,
    label: `${pct > 0 ? "+" : ""}${pct}%`,
  };
}

/**
 * Is the current period still running?
 *
 * Used to mark a comparison incomparable rather than printing a fall that is only the
 * calendar. Dates are YYYY-MM-DD; `today` is the caller's IST date.
 */
export function isPartialPeriod(to: string, today: string): boolean {
  return to.slice(0, 10) > today.slice(0, 10);
}
