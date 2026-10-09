/**
 * The cart checkout, shared by two callers (25 Sep 2026):
 *   - the site cart:        POST /api/public/checkout/cart   (channel "site")
 *   - the DMS customer panel: POST /api/dms/panel-order       (channel "dms-panel")
 *
 * Owner decision 30: ResellerOS creates every Razorpay order, including a purchase made
 * inside the DMS panel, so both go through THIS function and are priced by the same
 * code. There is no second pricing path to drift. What differs by channel is only
 * bookkeeping: the lead's source, a note naming the DMS account, and two refusals on the
 * panel (no simulation, no trial — DMS starts its in-panel trial itself).
 *
 * Moved here from the route unchanged otherwise; the original header follows.
 *
 * ─── POST /api/public/checkout/cart ─────────────────────────────────────────
 *
 * Real Razorpay checkout for the site cart (Pardeep, 2 Sep: "cart/checkout ko
 * asli banao"). The /checkout page's "Pay" calls this; on success the client
 * opens Razorpay.Checkout({order_id}) and the visitor pays. Razorpay then POSTs
 * to /api/webhooks/razorpay, which marks the quote paid via record_payment and
 * queues provisioning — the same downstream the Workspace direct-buy uses.
 *
 * ─── MONEY SAFETY: the client price is NEVER trusted ────────────────────────
 * Cart lines come from the browser, so `unitPrice` is attacker-controlled. Every
 * line is RE-PRICED here from its `sku` against the server's own source of truth
 * (HOSTING_TIERS for hosting). A line with no recognised sku cannot be charged
 * online — the response tells the visitor to request a quote for it. This is the
 * whole reason a generic cart checkout is riskier than a per-product buy, and
 * it's handled by refusing to charge anything we can't price ourselves.
 *
 * Priceable SKUs: `hosting:starter|standard|plus`, `domain:<tld>` and
 * `mailbox:anutech`. Anything else is sent to a quote (owner decision 20, 24 Sep 2026:
 * Workspace licences, monthly Anutech Mail and SSL are quote items, not cart items).
 *
 * ─── DOMAINS: the live price, re-checked, for the exact name ───────────────
 * Owner decision 19 (24 Sep 2026). Until then a domain line was priced from a fixed
 * table while the search showed the live ResellerClub price, and the line carried only
 * its TLD — "Domain .com" — so nothing downstream knew WHICH name had been paid for. A
 * domain line now carries `domain` (the full name), is re-priced from the same live
 * lookup the search uses (lib/domains/live-lookup.ts), and is refused — never charged a
 * guess — when that lookup is unreachable, the name is taken, or the price is unknown.
 */
import { addDaysISO, istToday } from "@/lib/dates/ist";
import { NextResponse, type NextRequest } from "next/server";
import { captureFromRequest } from "@/lib/marketing/utm";
import { z } from "zod";
import Razorpay from "razorpay";
import { createAdminClient } from "@/lib/supabase/server";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { HOSTING_TIERS } from "@/site/lib/data/hosting-landing-v2";
import { lookupDomains, splitDomain } from "@/lib/domains/live-lookup";
import { MAILBOX_YR } from "@/site/lib/data/domains-landing";
import { applyCartCoupon } from "./cart-coupon";
import { normalisePhone, splitName, type Registrant } from "@/lib/provisioning/domain-registration";
import { isTrialPlan, TRIAL_PLAN_NAME } from "@/lib/hosting/trial-plan";
import { startHostingTrial } from "@/lib/hosting/start-trial";
import { trialsConfigured, TRIALS_PAUSED_MESSAGE } from "@/lib/dms-engine/trials";
import { hostingLimitProblem } from "./hosting-limit";
import { hostingDomain, planDomains, BUY_A_DOMAIN_HREF } from "./hosting-domain";
import { hostingRate } from "./hosting-prices";
import { buyPageTenantId, buyPageTenantIdOrEmpty, BuyPageTenantMissingError, simulatedPaymentAllowed } from "./live-guards";
import { issueInvoiceForOnlinePayment } from "./online-invoice.server";
import { resolveStateCode, stateCodeFromName } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE, isValidGstin } from "@/lib/utils";

/* R-079: production requires BUY_PAGE_TENANT_ID — the hard-coded dev tenant is used only
   off production (lib/checkout/live-guards.ts). This constant is for importers that need a
   value at module load; it is "" in production when unset, so their lookups fail closed.
   runCartCheckout resolves the tenant per request and refuses with a clear error instead. */
export const BUY_PAGE_TENANT_ID = buyPageTenantIdOrEmpty();
const ENV_RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID?.trim() || process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID?.trim() || "";
const ENV_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET?.trim() || "";

const lineSchema = z.object({
  sku: z.string().min(1).max(60).optional(),
  label: z.string().max(200).optional(),
  qty: z.coerce.number().int().min(1).max(1000).default(1),
  cycle: z.enum(["monthly", "yearly", "once"]).optional(),
  /** The full domain name, required on a `domain:<tld>` line — it is what gets registered. */
  domain: z.string().max(253).optional(),
  /** Domain lines only (R-156): registration term, 1–10. Absent → 1. Priced from the registry. */
  years: z.coerce.number().int().min(1).max(10).optional(),
  /**
   * Hosting lines only: the domain THIS plan is set up on (30 Sep 2026, one domain per plan).
   * Its own field, never `domain`: provisioning reads a line's `domain` as a name to REGISTER.
   * Absent on the first plan, the top-level `domain` is used, as before.
   */
  hostingDomain: z.string().max(253).optional(),
});
const cartSchema = z.object({
  fullName: z.string().min(2).max(120),
  /** Optional (owner, 29 Sep 2026). Blank means an individual buyer: the buyer's own name
      is used on the lead, the customer and the GST invoice. */
  companyName: z.string().max(200).optional(),
  email: z.string().email().max(200),
  phone: z.string().min(10).max(20),
  gstin: z.string().max(20).optional(),
  /**
   * The buyer's GST state code ("07") or state name (R-079). Optional: the address's state
   * and a valid GSTIN are also read. It decides CGST+SGST vs IGST on the GST invoice issued
   * when the payment lands; with none of the three, the invoice waits for the desk.
   */
  stateCode: z.string().max(80).optional(),
  /** Required when a hosting line is present — the account is provisioned on it. */
  domain: z.string().max(120).optional(),
  lines: z.array(lineSchema).min(1).max(50),
  /**
   * The registrant's postal address — REQUIRED when the cart holds a domain.
   * Owner decision 22 (24 Sep 2026): a domain is registered under the customer's
   * own details, and ResellerClub will not create the owner record without an
   * address. Collected here so the automatic registration has it.
   */
  address: z
    .object({
      line1: z.string().max(200),
      city: z.string().max(80),
      state: z.string().max(80),
      zipcode: z.string().max(12),
      country: z.string().max(2).optional(),
    })
    .optional(),
  /** The cart page's coupon code. Priced from the server-only table the cart page asks
   *  through POST /api/public/cart-coupon (lib/checkout/coupons, R-329). */
  coupon: z.string().max(40).optional(),
  simulate: z.boolean().optional(),
});

interface QuoteLine {
  id: string; name: string; qty: number; rate: number; cost: number;
  /** The rate before a coupon, when a coupon came off this line's rate (R-225, cart-coupon.ts). */
  list_rate?: number;
  /** What the line's subscription renews at, when a coupon came off its first payment
   *  (R-329). record_payment files the subscription's mrr from it. */
  renewal_rate?: number;
  /** Domain lines only: the exact name paid for, so provisioning registers THAT name. */
  domain?: string;
  /** Domain lines only: whose name it is registered in (owner decision 22). */
  registrant?: Registrant;
  /** Domain lines only: the registration term paid for (R-031), picked in the cart (R-156). */
  years?: number;
  /** Hosting lines only: the tier and the months paid for, read by the provisioning worker. */
  hostingPlan?: string;
  /**
   * Hosting lines only: the domain this plan's account is set up on (30 Sep 2026). With
   * several plans in one order, each line says which domain is its own, so provisioning can
   * queue one hosting request per line (board R-032). Deliberately not `domain`, which
   * provisioning reads as a domain to register.
   */
  hostingDomain?: string;
  months?: 1 | 12;
  /**
   * Hosting lines only: how the plan renews. `record_payment` creates a subscription ONLY
   * for a line carrying this, and the renewals cron works from that subscription. Missing
   * until 25 Sep 2026, so every paid cart hosting order was a one-off that never came up
   * for renewal. Same values as the Workspace checkout and the quote builder.
   * Deliberately NOT on domain or mailbox lines: they renew at a different price.
   */
  commitment?: "annual_yearly" | "monthly";
  /**
   * The tenant's own hosting catalogue item, when it has one. `record_payment` reads the
   * subscription's vendor from it; without it the vendor is guessed from the line name,
   * and "Starter hosting" guesses as `other`.
   */
  item_id?: string;
}

type LineKind = "hosting" | "domain" | "mailbox";
interface Repriced { line: QuoteLine; kind: LineKind; tier?: string; yearly: boolean }

const newId = () => globalThis.crypto?.randomUUID() ?? Math.random().toString(36).slice(2);

/**
 * Re-price one line from its sku against the server's OWN source of truth.
 * Returns null for anything we can't price server-side.
 *
 *   hosting:<tier>   → HOSTING_TIERS (whole rupees)
 *   domain:<tld>     → TLDS reg price. The ₹0 bundle is NOT applied here — it is
 *                      applied after the whole cart is priced, and ONLY when a
 *                      yearly hosting line is present. A client that sends ₹0 for
 *                      a bare domain still gets charged the real reg price.
 *   mailbox:anutech  → MAILBOX_YR. Same bundle rule as the domain.
 */
function repriceLine(sku: string | undefined, cycle: string | undefined, qty: number): Repriced | null {
  if (!sku) return null;
  const s = sku.toLowerCase();
  const yearly = cycle !== "monthly";

  const h = /^hosting:(starter|standard|plus)$/.exec(s);
  if (h) {
    const tier = h[1];
    const t = HOSTING_TIERS.find((x) => x.name.toLowerCase() === tier);
    // The one rate DMS also shows (lib/checkout/hosting-prices.ts, /api/public/hosting-prices).
    const rate = t ? hostingRate(tier, yearly) : null;
    if (!t || rate === null) return null;
    // No `domain` on this line, on purpose: provisioning reads any line's `domain` as a
    // domain to REGISTER (lib/provisioning/products.ts). The subscription takes the
    // hosting domain from the quote instead.
    return { kind: "hosting", tier, yearly, line: { id: newId(), name: `${t.name} hosting (${yearly ? "billed yearly" : "billed monthly"})`, qty, rate, cost: 0, hostingPlan: tier, months: yearly ? 12 : 1, commitment: yearly ? "annual_yearly" : "monthly" } };
  }

  // Domain lines are priced live, per name, in priceDomainLines() — not here.
  if (/^domain:/.test(s)) return null;

  if (s === "mailbox:anutech") {
    return { kind: "mailbox", yearly: true, line: { id: newId(), name: "Mailbox — Anutech Mail, 1 year", qty, rate: Math.round(MAILBOX_YR), cost: 0 } };
  }

  return null;
}

type DomainPricing =
  | { ok: true; line: QuoteLine; firstYear: number }
  | { ok: false; reason: string };

/**
 * The registry's TOTAL for registering this name for `years` (R-156): the 1-year price for
 * one year, else the term's own total from the lookup. Null when the registry does not price
 * that term — the caller refuses rather than multiplying the 1-year price. Exported for tests.
 */
export function termTotal(hit: { price: number; prices?: Record<string, number> }, years: number): number | null {
  if (years === 1) return Math.round(hit.price);
  const v = hit.prices?.[String(years)];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

/**
 * The bundle (₹0 domain with yearly hosting) covers the FIRST YEAR only — renewal.ts says
 * the same of renewals. A multi-year domain in a bundle pays for years 2..N. Exported for tests.
 */
export function bundledDomainRate(termRate: number, firstYear: number): number {
  return Math.max(0, Math.round(termRate - firstYear));
}

/**
 * Price every domain line from the live lookup, one call per base name.
 * Each line must name its domain, match its sku's TLD, have quantity 1, and be
 * available with a known price for its term at this moment. R-156: the term
 * (`years`, default 1) is priced from the registry's own N-year total; a term the
 * registry does not price is refused, never extrapolated from the 1-year price.
 */
async function priceDomainLines(
  lines: { sku?: string; label?: string; qty: number; domain?: string; years?: number }[],
): Promise<Map<number, DomainPricing>> {
  const out = new Map<number, DomainPricing>();
  const wanted = new Map<string, { idx: number; domain: string; tld: string; years: number }[]>();

  lines.forEach((l, idx) => {
    const m = /^domain:(.+)$/.exec((l.sku ?? "").toLowerCase());
    if (!m) return;
    const skuTld = m[1].replace(/^\./, "");
    const parts = splitDomain(l.domain ?? "");
    if (!parts) {
      out.set(idx, { ok: false, reason: `${l.label || "a domain"} (search for the exact name you want, then add it)` });
      return;
    }
    if (parts.tld !== skuTld) {
      out.set(idx, { ok: false, reason: `${l.domain} (its extension does not match the item — remove it and add it again)` });
      return;
    }
    if (l.qty !== 1) {
      out.set(idx, { ok: false, reason: `${l.domain} (a domain is registered once — set its quantity to 1)` });
      return;
    }
    const list = wanted.get(parts.name) ?? [];
    list.push({ idx, domain: `${parts.name}.${parts.tld}`, tld: parts.tld, years: l.years ?? 1 });
    wanted.set(parts.name, list);
  });

  for (const [name, entries] of wanted) {
    const live = await lookupDomains(name, entries.map((e) => e.tld));
    for (const e of entries) {
      if (!live.ok) {
        out.set(e.idx, { ok: false, reason: `${e.domain} (we couldn't reach the domain registry to confirm its price just now — please try again in a minute)` });
        continue;
      }
      const hit = live.domains.find((d) => d.domain === e.domain);
      if (!hit || !hit.available) {
        out.set(e.idx, { ok: false, reason: `${e.domain} (it is no longer available — search for another name)` });
        continue;
      }
      if (!hit.priceKnown || !(hit.price > 0)) {
        out.set(e.idx, { ok: false, reason: `${e.domain} (its price couldn't be confirmed)` });
        continue;
      }
      const term = termTotal(hit, e.years);
      if (term === null) {
        out.set(e.idx, { ok: false, reason: `${e.domain} (a ${e.years}-year price couldn't be confirmed — choose 1 year in the cart)` });
        continue;
      }
      out.set(e.idx, {
        ok: true,
        // The 1-year price, for the bundle: yearly hosting makes the FIRST year free only.
        firstYear: Math.round(hit.price),
        line: {
          id: newId(),
          name: `Domain ${e.domain} — registration, ${e.years} year${e.years === 1 ? "" : "s"}`,
          qty: 1,
          // Whole rupees, like every other line (CLAUDE.md §13). The whole term, paid now.
          rate: term,
          cost: 0,
          domain: e.domain,
          years: e.years, // read by provisioning (R-031) and the domain subscription (R-156)
        },
      });
    }
  }
  return out;
}

/** Who is checking out. The panel names the DMS account the purchase was made from. */
export type CheckoutChannel = { kind: "site" } | { kind: "dms-panel"; dmsUserId: string };

export async function runCartCheckout(request: NextRequest, body: unknown, channel: CheckoutChannel): Promise<NextResponse> {
  const panel = channel.kind === "dms-panel" ? channel : null;
  /* R-079: per request, so a production deployment without BUY_PAGE_TENANT_ID refuses in
     words instead of filing the order under the hard-coded dev tenant. Shadows the
     module constant on purpose — every use below is this resolved value. */
  let BUY_PAGE_TENANT_ID: string;
  try {
    BUY_PAGE_TENANT_ID = buyPageTenantId();
  } catch (e) {
    if (e instanceof BuyPageTenantMissingError) {
      console.error(`[checkout ${channel.kind}] ${e.message}`);
      return NextResponse.json(
        { error: "Online checkout is not configured on this site yet. Nothing was charged. Please use 'Get a quote'." },
        { status: 503 },
      );
    }
    throw e;
  }
  try {
    const parsed = cartSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid checkout: " + parsed.error.issues.map((i) => i.message).join(", ") },
        { status: 400 },
      );
    }
    const { fullName, email, phone, gstin, domain, lines, coupon, address, simulate } = parsed.data;
    const companyName = parsed.data.companyName?.trim() || fullName.trim();

    if (panel && simulate) {
      return NextResponse.json(
        { error: "A panel order cannot be simulated. Nothing was charged. Send the order without `simulate`." },
        { status: 400 },
      );
    }

    // ── A free hosting trial (`hosting-trial:starter`) ─────────────────────
    // Since 24 Sep 2026 "Start free trial" puts a ₹0 trial line in the cart
    // instead of opening a separate form. It is never charged and never quoted:
    // it starts the trial exactly as the old form did (lib/hosting/start-trial)
    // and returns. It checks out ON ITS OWN, so no paid line, coupon or
    // bundle rule ever sees a ₹0 hosting line it could mistake for a plan.
    const trialLines = lines.filter((l) => /^hosting-trial:/i.test(l.sku ?? ""));
    if (trialLines.length && panel) {
      return NextResponse.json(
        {
          error:
            "A free trial is not an order, so it is not started here. Nothing was charged. " +
            "Start it from the panel's own trial button, which checks the one-trial-per-customer record.",
        },
        { status: 400 },
      );
    }
    if (trialLines.length) {
      if (lines.length > 1) {
        return NextResponse.json(
          {
            error:
              `The free ${TRIAL_PLAN_NAME} trial checks out on its own. Nothing was charged. ` +
              "Remove the other items to start the trial now, or remove the trial to pay for them.",
            next: "/cart",
          },
          { status: 400 },
        );
      }
      const t = trialLines[0];
      // One trial is one trial. The cart no longer lets the quantity move, but a
      // stored or hand-built line can still say 5, and that is refused, not rounded.
      if (t.qty !== 1) {
        return NextResponse.json(
          { error: "A free trial is for one hosting account. Nothing was saved. Remove the trial and add it again from the hosting page.", next: "/hosting#choose" },
          { status: 400 },
        );
      }
      const tier = (t.sku ?? "").slice("hosting-trial:".length);
      if (!isTrialPlan(tier)) {
        return NextResponse.json(
          { error: `The free trial is only on the ${TRIAL_PLAN_NAME} plan. Remove this line and add the ${TRIAL_PLAN_NAME} trial from the hosting page.`, next: "/hosting#choose" },
          { status: 400 },
        );
      }
      /* A trial is a hosting account, so it needs its domain too (owner, 30 Sep 2026;
         until then a trial could start with none and the owner helped afterwards). */
      /* Paused, not broken: say so (503) instead of failing deep inside with a 500. */
      if (!trialsConfigured()) {
        return NextResponse.json({ error: TRIALS_PAUSED_MESSAGE, trialsPaused: true }, { status: 503 });
      }
      const trialDomain = hostingDomain(domain);
      if (!trialDomain) {
        return NextResponse.json(
          {
            error:
              "Please enter the domain your hosting should be set up on, like yourcompany.in. Nothing was saved. " +
              "Don't have a domain yet? Register one first, then start your free trial.",
            next: BUY_A_DOMAIN_HREF,
            needDomain: true,
          },
          { status: 400 },
        );
      }
      const started = await startHostingTrial(
        createAdminClient(),
        { fullName, companyName, email, phone, domain: trialDomain, cycle: t.cycle === "monthly" ? "monthly" : "yearly" },
        request,
        body as Record<string, unknown>,
      );
      if (!started.ok) {
        /* One trial per customer is a refusal, not a fault (409) — and the checkout shows it as
           its own pop-up with a way forward (buy the plan, ask for more time), so say which. */
        if (started.alreadyTrialled) {
          return NextResponse.json(
            { error: started.error, alreadyTrialled: true, ...(started.trialStartedOn ? { trialStartedOn: started.trialStartedOn } : {}) },
            { status: 409 },
          );
        }
        return NextResponse.json({ error: started.error }, { status: 500 });
      }
      return NextResponse.json({ success: true, trial: true, leadId: started.leadId, trialEnds: started.trialEnds, confirmationSent: started.confirmationSent });
    }

    // One hosting account per hosting line — quantity above 1 is refused (lib/checkout/hosting-limit.ts).
    const tooMuchHosting = hostingLimitProblem(lines);
    if (tooMuchHosting) return NextResponse.json({ error: tooMuchHosting, next: "/cart" }, { status: 400 });

    // ── Re-price every line server-side; collect anything we can't charge ──
    const items: QuoteLine[] = [];
    const unpriced: string[] = [];
    let hasHosting = false;
    let hasYearlyHosting = false;
    let hostingTier: string | null = null;
    const bundleEligible: QuoteLine[] = []; // domain + mailbox lines that go ₹0 with a yearly plan
    const firstYearOf = new Map<QuoteLine, number>(); // domain line → its 1-year price (R-156)
    const domainPricing = await priceDomainLines(lines);
    const domainNames: string[] = [];
    const domainLineSet: QuoteLine[] = []; // every domain:* line, priced by priceDomainLines
    /* Each hosting line with what was typed for it, in cart order (one domain per plan). */
    const hostingItems: { line: QuoteLine; typed: string | undefined }[] = [];
    for (const [idx, l] of lines.entries()) {
      const dp = domainPricing.get(idx);
      if (dp) {
        if (!dp.ok) { unpriced.push(dp.reason); continue; }
        items.push(dp.line);
        domainLineSet.push(dp.line); // R-225: a coupon never discounts it
        bundleEligible.push(dp.line);
        firstYearOf.set(dp.line, dp.firstYear);
        if (dp.line.domain) domainNames.push(dp.line.domain);
        continue;
      }
      const r = repriceLine(l.sku, l.cycle, l.qty);
      if (!r) { unpriced.push(l.label || l.sku || "an item"); continue; }
      items.push(r.line);
      if (r.kind === "hosting") {
        hasHosting = true; if (r.yearly) hasYearlyHosting = true; hostingTier = hostingTier ?? r.tier ?? null;
        hostingItems.push({ line: r.line, typed: l.hostingDomain ?? (hostingItems.length === 0 ? domain : undefined) });
      }
      if (r.kind === "domain" || r.kind === "mailbox") bundleEligible.push(r.line);
    }
    // THE bundle rule, enforced server-side: the domain (and its mailbox) are ₹0
    // only when a YEARLY hosting line rides along. Otherwise they pay full reg —
    // the client's ₹0 is never trusted. A bare domain, or a monthly plan, is charged.
    if (hasYearlyHosting) {
      for (const line of bundleEligible) {
        const firstYear = firstYearOf.get(line);
        // A domain: its first year is free, any further years are paid (R-156). A mailbox: ₹0.
        line.rate = firstYear === undefined ? 0 : bundledDomainRate(line.rate, firstYear);
      }
    }
    if (unpriced.length) {
      return NextResponse.json(
        { error: `We can't take online payment for: ${unpriced.join("; ")}. Nothing was charged. Remove ${unpriced.length === 1 ? "it" : "them"} from the cart to pay for the rest, or request a quote.`, unpriced },
        { status: 400 },
      );
    }
    if (items.length === 0) {
      return NextResponse.json({ error: "Nothing to pay for." }, { status: 400 });
    }

    // ── A domain is registered in the customer's own name: that needs an address ──
    if (domainNames.length) {
      const a = address;
      const country = (a?.country || "IN").toUpperCase();
      const problems: string[] = [];
      if (!a || a.line1.trim().length < 3) problems.push("address");
      if (!a || a.city.trim().length < 2) problems.push("city");
      if (!a || a.state.trim().length < 2) problems.push("state");
      if (!a || (country === "IN" ? !/^\d{6}$/.test(a.zipcode.trim()) : a.zipcode.trim().length < 3)) problems.push("PIN code");
      if (!/^[A-Z]{2}$/.test(country)) problems.push("country");
      if (problems.length || !a) {
        return NextResponse.json(
          {
            error:
              `To register ${domainNames.join(", ")} in your name we need your ${problems.join(", ")}. ` +
              `The domain registry records the owner's postal address. Nothing was charged.`,
            needAddress: true,
          },
          { status: 400 },
        );
      }
      const registrant: Registrant = {
        ...splitName(fullName),
        email: email.trim().toLowerCase(),
        ...normalisePhone(phone),
        companyName: companyName.trim() || undefined,
        address: { line1: a.line1.trim(), city: a.city.trim(), state: a.state.trim(), zipcode: a.zipcode.trim(), country },
      };
      // Domain lines only: a hosting line's domain is where the account sits, not a purchase.
      for (const line of items) if (line.domain && !line.hostingPlan) line.registrant = registrant;
    }

    // Each hosting plan is set up on its own domain (30 Sep 2026): the one typed for it, or —
    // with a single plan and nothing typed — the one domain being bought in the same cart.
    // The same rule as the checkout form (planDomains in lib/checkout/hosting-domain.ts).
    let cleanDomain = "";
    if (hasHosting) {
      const resolved = planDomains(
        hostingItems.map((h, i) => {
          // Two of the same plan are told apart as "Starter hosting · 1" / "· 2" (R-032).
          const base = (x: typeof h) => x.line.name.replace(/ \(billed .*\)$/, "");
          const same = hostingItems.filter((x) => base(x) === base(h));
          const n = hostingItems.slice(0, i + 1).filter((x) => base(x) === base(h)).length;
          return { label: same.length > 1 ? `${base(h)} · ${n}` : base(h), typed: h.typed };
        }),
        domainNames,
      );
      if (!resolved.ok) {
        return NextResponse.json(
          {
            error:
              `Please add ${resolved.problems.join("; ")}. Nothing was charged. ` +
              "Don't have a domain yet? Add one to this order — it is free with yearly hosting.",
            next: BUY_A_DOMAIN_HREF,
            needDomain: true,
          },
          { status: 400 },
        );
      }
      /* Each hosting line names its account's domain twice, on purpose (R-032):
           `domain` — record_payment gives a subscription its line's own domain (0172), so
             each plan's subscription renews the right account; and
           `hostingDomain` — what provisioning reads. domainsInLines and
             domainSubscriptionsToCreate skip hosting lines, so neither is ever treated as a
             domain to register. */
      hostingItems.forEach((h, i) => { h.line.hostingDomain = resolved.domains[i]; h.line.domain = resolved.domains[i]; });
      // The quote's own domain stays the first plan's, so everything that reads it is unchanged.
      cleanDomain = resolved.domains[0];
    }

    /* Coupon, exactly as the cart page shows it (cartTotals in site/lib/money):
       percent off the gross, before GST. Until 24 Sep 2026 the cart page applied
       ANUTECH10 / MIGRATE15 to the total it SHOWED while this route ignored them, so a
       customer who used a coupon was charged more than they had been shown. An unknown
       code counts for nothing here, as it does on the cart page.
       R-225 (7 Oct 2026): never on a domain line — see lib/checkout/cart-coupon.ts. */
    const domainLines = new Set(domainLineSet);
    const deal = applyCartCoupon(items, (l) => domainLines.has(l), coupon);
    const { couponCode, gross, subtotal } = deal;
    const amount = Math.round(subtotal * 1.18);
    if (amount <= 0) return NextResponse.json({ error: "Nothing to pay for." }, { status: 400 });

    // ── Razorpay credentials (tenant_secrets → env) ────────────────────────
    let rzKeyId = "", rzKeySecret = "", rzMode: "test" | "live" = "test";
    const admin = createAdminClient();
    {
      const { data: rawSecrets } = await admin
        .from("tenant_secrets")
        .select("razorpay_key_id, razorpay_key_secret, razorpay_mode")
        .eq("tenant_id", BUY_PAGE_TENANT_ID)
        .maybeSingle();
      // Sealed at rest (rosv1:…) — decrypt or Razorpay rejects the ciphertext.
      const secrets = decryptTenantSecrets(rawSecrets);
      if (secrets?.razorpay_key_id && secrets.razorpay_key_secret) {
        rzKeyId = secrets.razorpay_key_id; rzKeySecret = secrets.razorpay_key_secret;
        rzMode = secrets.razorpay_mode === "live" ? "live" : "test";
      } else if (ENV_RAZORPAY_KEY_ID && ENV_RAZORPAY_KEY_SECRET) {
        rzKeyId = ENV_RAZORPAY_KEY_ID; rzKeySecret = ENV_RAZORPAY_KEY_SECRET;
        rzMode = ENV_RAZORPAY_KEY_ID.startsWith("rzp_live_") ? "live" : "test";
      }
    }
    const razorpayConfigured = Boolean(rzKeyId) && Boolean(rzKeySecret);
    const isSimulation = simulate === true;
    /* R-079: never on a production deployment or with a live key — ALLOW_SIMULATED_CHECKOUT
       can no longer switch it on there (lib/checkout/live-guards.ts). */
    const simulationAllowed = simulatedPaymentAllowed({ razorpayKeyId: rzKeyId });
    if (!razorpayConfigured && !isSimulation) {
      return NextResponse.json({ error: "Online payment isn't set up yet. Please use 'Get a quote'." }, { status: 503 });
    }
    if (razorpayConfigured && isSimulation) {
      return NextResponse.json({ error: "Simulation is disabled in live mode." }, { status: 400 });
    }
    if (isSimulation && !simulationAllowed) {
      return NextResponse.json({ error: "Online payment isn't available yet. Please use 'Get a quote'." }, { status: 503 });
    }

    // ── Link each hosting line to the tenant's hosting catalogue item ──────
    // So the subscription record_payment builds is filed under vendor `hosting`. Matched
    // on the tenant's own `vendor = 'hosting'` rows by name ("Starter Hosting"); with no
    // match the line is simply left unlinked, which record_payment already handles.
    // Optional: it only files the vendor, so it can never fail the sale.
    if (hasHosting) {
      try {
        const { data: hostingItems, error: itemsErr } = await admin
          .from("items")
          .select("id, name")
          .eq("tenant_id", BUY_PAGE_TENANT_ID)
          .eq("vendor", "hosting");
        if (itemsErr) console.warn("[checkout/cart] hosting catalogue lookup failed; lines left unlinked:", itemsErr.message);
        for (const line of items) {
          if (!line.hostingPlan) continue;
          const match = (hostingItems ?? []).find((i) => i.name?.trim().toLowerCase() === `${line.hostingPlan} hosting`);
          if (match) line.item_id = match.id;
        }
      } catch (err) {
        console.warn("[checkout/cart] hosting catalogue lookup threw; lines left unlinked:", err instanceof Error ? err.message : err);
      }
    }

    // ── Lead (stage='quote' = intent to buy) ───────────────────────────────
    const leadId = "L-" + Date.now().toString(36).toUpperCase();
    // The webhook reads the vendor from this label when lines carry no item_id, so a
    // domain-only cart must say "domain" — as "cart-order" it was filed as vendor 'other'.
    const planLabel = hostingTier ? `hosting-${hostingTier}` : domainNames.length ? "domain-registration" : "cart-order";
    const notes = [
      `DIRECT BUY (${panel ? "DMS panel" : "cart"}) · ${items.length} line(s) · ₹${amount.toLocaleString("en-IN")} incl 18% GST`,
      panel ? `Bought inside the DMS customer panel, DMS account ${panel.dmsUserId}` : null,
      deal.applied
        ? deal.discountPct
          ? `Coupon ${couponCode}: ${deal.ratePct}% off ₹${gross.toLocaleString("en-IN")}`
          : `Coupon ${couponCode}: ${deal.ratePct}% off non-domain lines, ₹${deal.discount.toLocaleString("en-IN")} off (domains at full price; renewals at list)`
        : null,
      hasHosting
        ? hostingItems.length > 1
          ? `Hosting domains: ${hostingItems.map((h) => `${h.line.hostingDomain} (${h.line.hostingPlan})`).join(", ")}`
          : `Hosting domain: ${cleanDomain}`
        : null,
      domainNames.length ? `Domains to register: ${domainNames.join(", ")}` : null,
      gstin ? `GSTIN: ${gstin}` : null,
      ...items.map((i) => `  • ${i.name} × ${i.qty} @ ₹${i.rate}`),
    ].filter(Boolean).join("\n");

    /* ── The buyer's place of supply (R-079) ────────────────────────────────
       record_payment copies the lead's state_code / state / gstin onto the customer it
       creates, and generate_invoice reads the place of supply from that customer. So this
       is where the GST head of the automatic invoice is decided. Same precedence as
       everywhere else (resolveStateCode): an entered state wins, a checksum-valid GSTIN is
       the fallback; nothing is guessed. Only a VALID GSTIN is stored — it prints on the
       tax invoice. */
    const cleanGstin = (gstin ?? "").trim().toUpperCase();
    const validGstin = cleanGstin && isValidGstin(cleanGstin) ? cleanGstin : null;
    const buyerStateCode = resolveStateCode({
      stateCode: stateCodeFromName(parsed.data.stateCode) ?? stateCodeFromName(address?.state),
      gstin: validGstin,
    });
    /* R-091 (1 Oct 2026): a website order with no state paid, and then got NO GST invoice —
       generate_invoice refuses one without the buyer's state. So it is asked for before
       anything is saved. The DMS panel does not send a state for a hosting-only order yet,
       so it is not refused here (that would stop panel purchases); its invoices stay manual. */
    if (!panel && !buyerStateCode) {
      return NextResponse.json(
        {
          error:
            "Please choose your state. It decides whether your GST invoice shows CGST + SGST or IGST, " +
            "and the invoice cannot be issued without it. Nothing was charged.",
          needState: true,
        },
        { status: 400 },
      );
    }

    const { error: leadErr } = await admin.from("leads").insert({
      id: leadId,
      tenant_id: BUY_PAGE_TENANT_ID,
      company: companyName,
      contact_name: fullName,
      contact_email: email,
      contact_phone: phone,
      plan: planLabel,
      seats: items.reduce((s, i) => s + i.qty, 0),
      value: subtotal,
      stage: "quote",
      source: panel ? "dms-panel" : isSimulation ? "buy-cart-direct-sim" : "buy-cart-direct",
      ...captureFromRequest(request, body as Record<string, unknown>),
      domain: cleanDomain || null,
      notes,
      gstin: validGstin,
      state_code: buyerStateCode,
      state: buyerStateCode ? (GST_STATE_BY_CODE[buyerStateCode] ?? null) : null,
    });
    if (leadErr) {
      console.error("[checkout/cart] lead insert failed:", leadErr);
      return NextResponse.json({ error: "Could not start checkout. Please retry." }, { status: 500 });
    }

    // ── Quote number + draft quote (payment_status='awaiting') ─────────────
    const { data: qid, error: numErr } = await admin
      .rpc("next_document_number", { p_doc_type: "quote", p_tenant_id: BUY_PAGE_TENANT_ID });
    if (numErr || !qid) {
      console.error("[checkout/cart] next_document_number failed:", numErr);
      return NextResponse.json({ error: "Could not allocate a quote number. Please retry." }, { status: 500 });
    }
    const quoteId = qid as string;
    /* R-026: the IST calendar day. `toISOString().slice(0, 10)` is the UTC day, so an order
       placed between 00:00 and 05:30 IST was dated yesterday (AGENTS.md §6). */
    const createdDate = istToday();
    const expiresDate = addDaysISO(createdDate, 7);

    const { error: qErr } = await admin.from("quotes").insert({
      id: quoteId,
      tenant_id: BUY_PAGE_TENANT_ID,
      customer_id: null,
      customer_name: companyName,
      lead_id: leadId,
      plan: planLabel,
      seats: items.reduce((s, i) => s + i.qty, 0),
      line_items: items,
      subtotal: deal.quoteSubtotal,
      total_cost: 0,
      discount_pct: deal.discountPct,
      tax_rate: 18,
      amount,
      status: "sent",
      payment_status: "awaiting",
      owner_id: null,
      domain: cleanDomain || null,
      created_date: createdDate,
      expires_date: expiresDate,
      // `notes` is printed on the customer's PDF (lib/pdf/build-props.ts), and it is written
      // once, here, before payment. Until 28 Sep 2026 it said "Razorpay order pending" — false
      // on every paid order's bill — and printed the internal DMS account id. Only a sentence
      // that stays true after payment goes here; the internal detail is on the lead's notes.
      notes: panel ? `Ordered from your hosting control panel.` : `Ordered online.`,
    });
    if (qErr) {
      console.error("[checkout/cart] quote insert failed:", qErr);
      return NextResponse.json({ error: "Could not save quote. Please retry." }, { status: 500 });
    }

    // ── SIMULATION (pre-live-keys preview) — record payment directly ───────
    if (isSimulation) {
      const { error: recErr } = await admin.rpc("record_payment", {
        p_quote_id: quoteId,
        p_amount: amount,
        p_method: "razorpay",
        p_reference: "SIM-" + quoteId,
        p_notes: "[SIMULATION] Test cart payment",
      });
      if (recErr) {
        console.error("[checkout/cart] simulated record_payment failed:", recErr);
        return NextResponse.json({ error: "Simulation failed: " + recErr.message }, { status: 500 });
      }
      // The same automatic GST invoice the webhook issues for a real payment (R-079).
      const invoice = await issueInvoiceForOnlinePayment(admin, { quoteId, tenantId: BUY_PAGE_TENANT_ID, logTag: "[checkout/cart] simulated" });
      return NextResponse.json({
        success: true, simulated: true, quoteId, leadId, totalRupees: amount,
        invoiceId: invoice.status === "issued" || invoice.status === "exists" ? invoice.invoiceId : null,
      });
    }

    // ── LIVE — create Razorpay order ───────────────────────────────────────
    const razorpay = new Razorpay({ key_id: rzKeyId, key_secret: rzKeySecret });
    const order = await razorpay.orders.create({
      amount: amount * 100,
      currency: "INR",
      receipt: quoteId,
      notes: { leadId, quoteId, company: companyName, contact: fullName, email, phone, domain: cleanDomain, plan: planLabel, channel: channel.kind, ...(panel ? { dmsUserId: panel.dmsUserId } : {}) },
    });
    await admin.from("quotes").update({ payment_reference: order.id }).eq("id", quoteId);

    return NextResponse.json({
      success: true,
      orderId: order.id,
      amount: amount * 100,
      currency: "INR",
      razorpayKeyId: rzKeyId,
      razorpayMode: rzMode,
      quoteId,
      leadId,
      customerName: fullName,
      totalRupees: amount,
    });
  } catch (err) {
    // Razorpay's SDK rejects with a plain object ({statusCode, error:{code,description}}),
    // not an Error — surface its `description`, then any message, then the raw shape.
    const rzpDesc = (err as { error?: { description?: string } })?.error?.description;
    let m = rzpDesc || (err instanceof Error ? err.message : "");
    if (!m) { try { m = JSON.stringify(err); } catch { m = String(err); } }
    console.error(`[checkout ${channel.kind}] crashed:`, m);
    // Surface the real reason (mostly a Razorpay order-create rejection) so a
    // failed checkout says WHY instead of a dead-end. §24 actionable errors.
    return NextResponse.json(
      { error: m ? `Payment couldn't start — ${m}` : "Something went wrong. Please try again." },
      { status: 500 },
    );
  }
}
