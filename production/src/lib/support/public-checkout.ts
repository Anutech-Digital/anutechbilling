/**
 * R-2083 (29 Oct 2026) — buying a support plan on the website: /buy/support and
 * POST /api/public/checkout/support. The pure rules, so they are tested without a request,
 * a database or Razorpay.
 *
 * The support desk (DSP) shows the plans from GET /api/public/catalog?function=support and its
 * "Upgrade" button sends the customer here as
 *   /buy/support?plan=standard|enterprise&term=monthly|yearly&email=…&billing_customer_id=…
 * Only the CHOICE (plan + term) and the buyer's details come from the browser. The price is
 * the server's price book (lib/catalog/catalog-prices — the same figure the public catalogue
 * shows), and the line points at the selling company's own catalogue row, so record_payment
 * files the subscription with vendor 'support' — which is what makes trg_queue_support_sync
 * write the support_sync_outbox row that R-2067's cron sends to DSP.
 *
 * Free is not sold (nothing to pay). Yearly is the whole-year total (₹9,996, not 12 × ₹999 —
 * lib/support/tiers.ts), on an annual_yearly line; monthly is one month on a monthly line, and
 * the quote is billing_cycle 'monthly' like the Workspace monthly (flex) order (R-1974).
 */
import { z } from "zod";
import { annualSaving, supportTier, type SupportTier } from "./tiers";

export const SUPPORT_BUY_PLANS = ["standard", "enterprise"] as const;
export type SupportBuyPlan = (typeof SUPPORT_BUY_PLANS)[number];
export const SUPPORT_BUY_TERMS = ["monthly", "yearly"] as const;
export type SupportBuyTerm = (typeof SUPPORT_BUY_TERMS)[number];

/** The quote's `plan` text for a website support order — also how the payment path knows one. */
export const supportQuotePlan = (plan: SupportBuyPlan) => `support-${plan}`;
export function isSupportCheckoutPlan(plan: string | null | undefined): boolean {
  return /^support-(standard|enterprise)$/.test(plan ?? "");
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The page's query, cleaned: an unknown plan/term falls back to Standard / Yearly (shown, editable). */
export function parseSupportBuyParams(sp: Record<string, string | string[] | undefined>): {
  plan: SupportBuyPlan;
  term: SupportBuyTerm;
  email: string;
  billingCustomerId: string;
} {
  const plan = first(sp.plan).trim().toLowerCase();
  const term = first(sp.term).trim().toLowerCase();
  const email = first(sp.email).trim().slice(0, 200);
  const id = first(sp.billing_customer_id).trim();
  return {
    plan: (SUPPORT_BUY_PLANS as readonly string[]).includes(plan) ? (plan as SupportBuyPlan) : "standard",
    term: term === "monthly" || term === "month" ? "monthly" : "yearly",
    email: z.string().email().safeParse(email).success ? email : "",
    billingCustomerId: /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : "",
  };
}

/** What POST /api/public/checkout/support accepts. Amounts are not in it — any sent are ignored. */
export const supportCheckoutSchema = z.object({
  plan: z.enum(SUPPORT_BUY_PLANS),
  term: z.enum(SUPPORT_BUY_TERMS),
  fullName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().min(10).max(20),
  gstin: z.string().max(20).optional(),
  /** GST place of supply ("07" or a state name). Required unless a valid GSTIN gives it. */
  stateCode: z.string().max(60).optional(),
  /** DSP's id for the customer (customers.customer_number or the customer's uuid). */
  billingCustomerId: z.string().trim().max(64).regex(/^[A-Za-z0-9-]*$/).optional(),
  /** Simulated payment — refused unless simulatedPaymentAllowed (never on a deployment). */
  simulate: z.boolean().optional(),
});
export type SupportCheckoutInput = z.infer<typeof supportCheckoutSchema>;

export interface SupportItemRow {
  id: string;
  name: string;
}

export interface SupportOrderLine {
  id: string;
  /** The selling company's catalogue row — record_payment reads the subscription's vendor from it. */
  item_id: string;
  name: string;
  qty: 1;
  rate: number;
  cost: 0;
  commitment: "annual_yearly" | "monthly";
}

export interface SupportOrder {
  tier: SupportTier;
  term: SupportBuyTerm;
  planLabel: string;
  /** "Standard Support (Yearly)" — the Razorpay window, emails and the thanks page. */
  tierName: string;
  line: SupportOrderLine;
  subtotal: number;
  gst: number;
  amount: number;
}

export const SUPPORT_GST_PERCENT = 18;

/** ₹ incl. 18% GST, whole rupees — the same rounding as every website checkout. */
export const withSupportGst = (exGst: number) => Math.round(exGst * (1 + SUPPORT_GST_PERCENT / 100));

export const supportTierName = (plan: SupportBuyPlan, term: SupportBuyTerm) =>
  `${supportTier(plan).label} Support (${term === "yearly" ? "Yearly" : "Monthly"})`;

/**
 * The order for one plan + term at the server's price. `price` is the price book's ex-GST
 * figure for one term; a missing or non-positive one is refused (null), never sold at ₹0.
 */
export function buildSupportOrder(args: {
  plan: SupportBuyPlan;
  term: SupportBuyTerm;
  price: number | null;
  item: SupportItemRow;
  lineId?: string;
}): SupportOrder | null {
  const { plan, term, price, item } = args;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price <= 0) return null;
  const tier = supportTier(plan);
  const subtotal = price;
  const amount = withSupportGst(subtotal);
  return {
    tier,
    term,
    planLabel: supportQuotePlan(plan),
    tierName: supportTierName(plan, term),
    line: {
      id: args.lineId ?? globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2),
      item_id: item.id,
      name: item.name.trim() || supportTierName(plan, term),
      qty: 1,
      rate: price,
      cost: 0,
      commitment: term === "yearly" ? "annual_yearly" : "monthly",
    },
    subtotal,
    gst: amount - subtotal,
    amount,
  };
}

/** One plan + term as the page shows it — the server's figures, never computed in the browser. */
export interface SupportPriceView {
  plan: SupportBuyPlan;
  term: SupportBuyTerm;
  label: string;
  exGst: number;
  gst: number;
  total: number;
}

export function supportPriceView(plan: SupportBuyPlan, term: SupportBuyTerm, exGst: number): SupportPriceView {
  const total = withSupportGst(exGst);
  return { plan, term, label: supportTierName(plan, term), exGst, gst: total - exGst, total };
}

/** "Save 17%" on yearly, from the two prices actually charged; null when there is no saving. */
export function yearlySavingPct(monthly: number, yearly: number): number | null {
  if (!(monthly > 0) || !(yearly > 0)) return null;
  const twelve = monthly * 12;
  return yearly < twelve ? Math.round(((twelve - yearly) / twelve) * 100) : null;
}

/** The tier's own saving (code prices) — only for the plan card's fine print. */
export const tierYearlySaving = (plan: SupportBuyPlan) => annualSaving(supportTier(plan));

export const sameEmail = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

/* ── After payment (lib text the Razorpay settlement uses for a support order) ─────────────── */

/** The customer's "what happens next" — nothing to set up; the desk gets the plan by itself. */
export function supportWhatNext(tierName: string, slaHours?: number): string {
  return [
    "WHAT HAPPENS NEXT",
    `  • Your ${tierName} plan is switched on at our support desk within a few minutes`,
    "  • Raise tickets from the support desk with this same email address",
    slaHours ? `  • First response within ${slaHours} hour${slaHours === 1 ? "" : "s"} on this plan` : null,
  ].filter(Boolean).join("\n");
}

/** The seller's alert — no console work: the plan reaches the support desk on its own (R-2067). */
export const SUPPORT_OWNER_ACTION =
  "NOTHING TO SET UP BY HAND\n" +
  "  The plan reaches the support desk on its own (the support-sync job runs every 5 minutes).\n" +
  "  If the customer still shows Free there after 15 minutes, check that job's automation switch\n" +
  "  and DSP_SUPPORT_URL / DSP_WEBHOOK_SECRET.";
