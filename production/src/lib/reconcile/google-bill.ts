/**
 * Google bill check (R-164, 5 Oct 2026) — the pure half.
 *
 * Anutech buys Google Workspace through Net2Secure (an authorised Google reseller): Google bills
 * Net2Secure every month per customer domain, and Net2Secure bills Anutech Google's price plus
 * ₹10 per user per year. Pardeep: "business me len den ki clearity rahe."
 *
 * Input: the text of Google's monthly invoice PDF (its "Summary of costs by domain" pages —
 * select all in the PDF and paste). Output, per domain: who the customer is in ResellerOS, what
 * Google charged, what we bill them (subscription MRR), and the gap. Plus the two lists that
 * matter most for money:
 *   • LEAKAGE — Google is charging for a domain we do not bill anybody for;
 *   • NOT ON THE BILL — we bill a customer whose domain Google did not charge (moved away?
 *     suspended? transferred to another reseller?).
 *
 * The PDF has no seat counts, so the Net2Secure margin is estimated from OUR seat counts; the
 * per-SKU check waits for Google's CSV. The checks are read-only maths; the page writes only
 * when a person presses Add (newSubscriptionRow below).
 *
 * R-320 (7 Oct 2026): "Add all missing" made every subscription "Google Workspace", 1 user, ₹0 —
 * 145 rows on 5 Oct with no edition and no MRR. Now a bill that names the edition and quantity
 * (Google's invoice CSV) gives them to the subscription, and the price is the tenant catalogue's
 * list price for that edition (draftFromBill). The PDF names neither, so those rows still need a
 * person — and the page says why instead of quietly saving ₹0.
 */
import { planPricePerSeat } from "@/lib/catalog/plan-price";

export interface BillLine {
  domain: string;
  customerId: string;
  amount: number;
  /** R-320: the Workspace edition on the bill ("Business Starter"), or absent/null when the bill
   *  does not say — the PDF summary never does; Google's invoice CSV does, per line. Mixed
   *  editions on one domain stay null (never guessed). */
  plan?: string | null;
  /** R-320: licences of that edition on the bill (CSV quantity), or absent/null when not given. */
  seats?: number | null;
}

export interface ParsedBill {
  invoiceNo: string | null;
  periodLabel: string | null;
  lines: BillLine[];
  subtotal: number | null;
  gst: number | null;
  total: number | null;
  /** Σ lines vs the printed subtotal — a paste that lost a page shows here. */
  linesTotal: number;
  /** Lines the parser could not read (shown, never dropped silently). */
  unread: string[];
}

const money = (s: string) => Number(s.replace(/[₹,\s]/g, ""));

/** "accesstel.in C04e9zwp8 529.20" — a domain, a Google customer id (C + 8 chars), a rupee amount. */
const LINE_RE = /^\s*([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s+(C[0-9a-z]{6,12})\s+(-?[\d,]+\.\d{2})\s*$/i;

export function parseGoogleBill(text: string): ParsedBill {
  if (looksLikeCsv(text)) return parseGoogleBillCsv(text);
  const lines: BillLine[] = [];
  const unread: string[] = [];
  const seen = new Set<string>();
  let subtotal: number | null = null, gst: number | null = null, total: number | null = null;
  const taxSeen = new Set<string>();
  const invoiceNo = text.match(/Invoice number:?\s*(\d{6,})/i)?.[1] ?? null;
  const period = text.match(/Summary (?:of costs by domain|for)\s*\n?\s*(\d{1,2} \w+ \d{4}\s*-\s*\d{1,2} \w+ \d{4})/i)?.[1] ?? null;

  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/ /g, " ").trim();
    if (!l) continue;
    const m = l.match(LINE_RE);
    if (m) {
      const key = `${m[1].toLowerCase()}|${m[2]}`;
      // The summary repeats on every page header only as column titles, but a paste of the
      // same page twice must not double a domain.
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push({ domain: m[1].toLowerCase(), customerId: m[2], amount: money(m[3]) });
      continue;
    }
    const st = l.match(/^Subtotal in INR\s*₹?\s*([\d,]+\.\d{2})/i);
    if (st) { subtotal = money(st[1]); continue; }
    const g = l.match(/^Integrated GST \(18%\)\s*₹?\s*([\d,]+\.\d{2})|^(?:CGST|SGST)[^₹\d]*₹?\s*([\d,]+\.\d{2})/i);
    /* First value of each tax line only: the invoice prints its summary on page 1 AND on the
       last page — summing doubled the IGST on the real Sept 2026 bill (₹2,02,359 for ₹1,01,179). */
    if (g) {
      const kind = /^Integrated/i.test(l) ? "igst" : /^CGST/i.test(l) ? "cgst" : "sgst";
      if (!taxSeen.has(kind)) { taxSeen.add(kind); gst = (gst ?? 0) + money(g[1] ?? g[2]); }
      continue;
    }
    const t = l.match(/^Total (?:amount due )?in INR\s*₹?\s*([\d,]+\.\d{2})/i);
    if (t) { total = money(t[1]); continue; }
    // A line that looks like a domain row but did not parse is worth showing.
    if (/^[a-z0-9.-]+\.[a-z]{2,}\s+C[0-9a-z]+/i.test(l)) unread.push(l);
  }
  /* A PDF copy puts labels and amounts on separate lines, in either order ("₹562,110.28 /
     ₹101,179.85 / ₹663,290.13 / Subtotal in INR / …"), so the labelled reads above often miss.
     Fallback: three consecutive rupee amounts where b ≈ 18% of a and c = a + b ARE subtotal,
     IGST and total — the maths identifies them, whatever the layout. */
  if (subtotal === null || gst === null || total === null) {
    const amts = [...text.matchAll(/₹\s?([\d,]+\.\d{2})/g)].map((x) => money(x[1]));
    for (let i = 0; i + 2 < amts.length; i++) {
      const [x, y, z] = [amts[i], amts[i + 1], amts[i + 2]];
      if (x > 0 && Math.abs(y - x * 0.18) <= 1 && Math.abs(z - (x + y)) <= 0.05) { subtotal = x; gst = y; total = z; break; }
    }
  }
  const linesTotal = Math.round(lines.reduce((a, x) => a + x.amount, 0) * 100) / 100;
  return { invoiceNo, periodLabel: period, lines, subtotal, gst, total, linesTotal, unread };
}

// ─── Google's invoice CSV (R-320) ───────────────────────────────────────────────

/**
 * The Workspace edition a bill line's description / SKU names, as a plan label, or null.
 * "Google Workspace Business Starter - Annual Plan" → "Business Starter". Add-ons (Vault, Voice,
 * archived user…), other products and a description naming no edition → null: unknown, not guessed.
 */
export function billEditionOf(desc: string | null | undefined): string | null {
  const n = (desc ?? "").toLowerCase();
  if (!/\b(workspace|g ?suite)\b/.test(n)) return null;
  if (/vault|voice|archiv|essentials|add-?on|gemini|frontline|education|nonprofit/.test(n)) return null;
  const tiers = (["starter", "standard", "plus"] as const).filter((t) => new RegExp(`\\b${t}\\b`).test(n));
  if (/\benterprise\b/.test(n)) {
    if (tiers.length > 1 || tiers[0] === "starter") return null;
    return tiers[0] === "standard" ? "Enterprise Standard" : tiers[0] === "plus" ? "Enterprise Plus" : "Enterprise";
  }
  if (tiers.length !== 1) return null;
  return tiers[0] === "starter" ? "Business Starter" : tiers[0] === "standard" ? "Business Standard" : "Business Plus";
}

/** One CSV record → its cells; a quoted cell may hold commas and doubled quotes. */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Index of the CSV header row (has a domain and an amount/cost column), or -1. */
function csvHeaderIndex(rows: readonly string[]): number {
  return rows.findIndex((l) => {
    const cells = csvCells(l).map((c) => c.toLowerCase());
    return cells.length >= 3 && cells.some((c) => /domain/.test(c)) && cells.some((c) => /amount|cost/.test(c));
  });
}

/** A CSV export (header row near the top) rather than the PDF's text. */
function looksLikeCsv(text: string): boolean {
  const i = csvHeaderIndex(text.split(/\r?\n/).slice(0, 5));
  return i >= 0;
}

/**
 * Google's invoice CSV (R-320): one row per charge — domain, customer id, description / SKU,
 * quantity, amount. Columns are found by header name, so a reordered export still reads. Rows add
 * up per domain. The edition and seats are kept only when the domain's licence rows name ONE
 * edition; seats = the largest quantity on its rows (a mid-month change is two rows of the same
 * edition, not twice the users). A quantity that is not a whole number is not a seat count → null.
 */
export function parseGoogleBillCsv(text: string): ParsedBill {
  const raw = text.split(/\r?\n/);
  const h = csvHeaderIndex(raw);
  const head = csvCells(raw[h] ?? "").map((c) => c.toLowerCase());
  const col = (...res: RegExp[]) => {
    for (const re of res) { const i = head.findIndex((c) => re.test(c)); if (i >= 0) return i; }
    return -1;
  };
  const iDomain = col(/domain/);
  const iId = col(/customer.?id/);
  const iDesc = col(/description/, /sku.?name/, /product/, /sku/, /plan/, /order.?name/);
  const iQty = col(/^quantity$/, /^qty$/, /licen[cs]es?/, /^seats$/);
  const iAmt = col(/^amount/, /amount/, /^cost/, /cost/);
  type Acc = { domain: string; customerId: string; amount: number; seatsBy: Map<string, number> };
  const acc = new Map<string, Acc>();
  const unread: string[] = [];
  for (const l of raw.slice(h + 1)) {
    if (!l.trim()) continue;
    const c = csvCells(l);
    const domain = normDomain(c[iDomain]);
    const amtCell = (c[iAmt] ?? "").trim();
    const amount = money(amtCell);
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain) || !amtCell || !Number.isFinite(amount)) {
      if (domain) unread.push(l.trim());
      continue;
    }
    const customerId = iId >= 0 ? c[iId] ?? "" : "";
    const key = `${domain}|${customerId}`;
    const a = acc.get(key) ?? { domain, customerId, amount: 0, seatsBy: new Map<string, number>() };
    a.amount += amount;
    const plan = iDesc >= 0 ? billEditionOf(c[iDesc]) : null;
    const qty = iQty >= 0 ? Number((c[iQty] ?? "").replace(/,/g, "")) : NaN;
    if (plan) a.seatsBy.set(plan, Math.max(a.seatsBy.get(plan) ?? 0, Number.isInteger(qty) && qty > 0 ? qty : 0));
    acc.set(key, a);
  }
  const lines: BillLine[] = [...acc.values()].map((a) => {
    const one = a.seatsBy.size === 1 ? [...a.seatsBy.entries()][0] : null;
    return {
      domain: a.domain, customerId: a.customerId, amount: Math.round(a.amount * 100) / 100,
      plan: one ? one[0] : null, seats: one && one[1] > 0 ? one[1] : null,
    };
  });
  const linesTotal = Math.round(lines.reduce((s, x) => s + x.amount, 0) * 100) / 100;
  return { invoiceNo: null, periodLabel: null, lines, subtotal: null, gst: null, total: null, linesTotal, unread };
}

// ─── Matching ────────────────────────────────────────────────────────────────

export interface SubLite {
  id: string;
  customer_id: string | null;
  customer_name: string;
  domain: string | null;
  vendor: string;
  status: string;
  seats: number;
  vendor_seats: number | null;
  mrr: number;
  plan: string;
}
export interface CustomerLite { id: string; name: string; domain: string | null }

export const normDomain = (s: string | null | undefined) =>
  (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/** needs_setup: a subscription exists but we bill ₹0 for it (made from the bill, price not set yet). */
export type RowStatus = "ok" | "loss" | "needs_setup" | "no_subscription" | "no_customer";

export interface CheckRow {
  domain: string;
  customerId: string;
  googleCost: number;
  customerName: string | null;
  customerRef: string | null;
  /** What we bill this domain per month (active Google subscriptions' MRR). */
  ourMonthly: number;
  seats: number;
  plans: string[];
  margin: number;
  status: RowStatus;
  /** R-320: edition and licences as Google's bill states them (CSV); null when it does not. */
  billPlan: string | null;
  billSeats: number | null;
}

/** sub_status is active | paused | expired | cancelled. Paused stays in: Google may still bill a suspended account. */
const ACTIVE = new Set(["active", "paused"]);
const isGoogle = (v: string) => v === "google";

export interface BillCheck {
  rows: CheckRow[];
  /** Our active Google subscriptions whose domain is not on this bill. */
  notOnBill: { domain: string; customerName: string; ourMonthly: number; seats: number }[];
  totals: {
    googleCost: number;
    ourMonthly: number;
    margin: number;
    leakage: number;          // Google cost on domains with no customer / no subscription
    leakageCount: number;
    lossCount: number;        // matched but we bill less than Google charges
    seats: number;
  };
}

export function checkBill(lines: readonly BillLine[], subs: readonly SubLite[], customers: readonly CustomerLite[]): BillCheck {
  const googleSubs = subs.filter((s) => isGoogle(s.vendor) && ACTIVE.has(s.status) && s.domain);
  const subsByDomain = new Map<string, SubLite[]>();
  for (const s of googleSubs) {
    const d = normDomain(s.domain);
    subsByDomain.set(d, [...(subsByDomain.get(d) ?? []), s]);
  }
  const custByDomain = new Map(customers.filter((c) => c.domain).map((c) => [normDomain(c.domain), c]));

  const rows: CheckRow[] = lines.map((l) => {
    const ss = subsByDomain.get(l.domain) ?? [];
    const cust = custByDomain.get(l.domain) ?? null;
    const ourMonthly = ss.reduce((a, s) => a + Number(s.mrr || 0), 0);
    const seats = ss.reduce((a, s) => a + Number(s.vendor_seats ?? s.seats ?? 0), 0);
    const margin = Math.round((ourMonthly - l.amount) * 100) / 100;
    const status: RowStatus = !ss.length && !cust ? "no_customer" : !ss.length ? "no_subscription" : ourMonthly === 0 ? "needs_setup" : margin < 0 ? "loss" : "ok";
    return {
      domain: l.domain, customerId: l.customerId, googleCost: l.amount,
      customerName: ss[0]?.customer_name ?? cust?.name ?? null,
      customerRef: ss[0]?.customer_id ?? cust?.id ?? null,
      ourMonthly, seats, plans: [...new Set(ss.map((s) => s.plan))], margin, status,
      billPlan: l.plan ?? null, billSeats: l.seats ?? null,
    };
  });

  const billed = new Set(lines.map((l) => l.domain));
  const notOnBill = [...subsByDomain.entries()]
    .filter(([d]) => !billed.has(d))
    .map(([d, ss]) => ({ domain: d, customerName: ss[0].customer_name, ourMonthly: ss.reduce((a, s) => a + Number(s.mrr || 0), 0), seats: ss.reduce((a, s) => a + Number(s.seats || 0), 0) }))
    .sort((a, b) => b.ourMonthly - a.ourMonthly);

  const leak = rows.filter((r) => r.status === "no_customer" || r.status === "no_subscription");
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    rows: rows.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.googleCost - a.googleCost),
    notOnBill,
    totals: {
      googleCost: r2(rows.reduce((a, r) => a + r.googleCost, 0)),
      ourMonthly: r2(rows.reduce((a, r) => a + r.ourMonthly, 0)),
      margin: r2(rows.reduce((a, r) => a + r.margin, 0)),
      leakage: r2(leak.reduce((a, r) => a + r.googleCost, 0)),
      leakageCount: leak.length,
      lossCount: rows.filter((r) => r.status === "loss").length,
      seats: rows.reduce((a, r) => a + r.seats, 0),
    },
  };
}

const STATUS_RANK: Record<RowStatus, number> = { no_customer: 0, no_subscription: 1, needs_setup: 2, loss: 3, ok: 4 };

/**
 * What Net2Secure should bill for this month: Google's subtotal + ₹`perSeatYear` per seat per
 * year, spread monthly. Seats are OUR counts (the PDF has none), so this is an estimate until
 * the CSV arrives — the page says so.
 */
export function expectedPartnerBill(googleSubtotal: number, seats: number, perSeatYear = 10): { margin: number; expected: number } {
  const margin = Math.round(((seats * perSeatYear) / 12) * 100) / 100;
  return { margin, expected: Math.round((googleSubtotal + margin) * 100) / 100 };
}

// ─── Making the missing subscription ───────────────────────────────────────────

export const GOOGLE_PLANS = ["Business Starter", "Business Standard", "Business Plus", "Enterprise Standard", "Enterprise Plus", "Enterprise", "Google Workspace"] as const;

/**
 * The subscription row for a domain on Google's bill (5 Oct 2026, Pardeep: "customer add karne
 * ka option … sabki subscription banaye aur google ke cost price ko handle kare").
 *
 * Google's cost for the month is spread over the users: vendor_cost_per_seat_month is what the
 * existing COGS / licence-leakage columns read. Whole rupees, as those columns are integers.
 * A missing selling price stays 0 on purpose — the page then shows "Set price & users" instead
 * of inventing a margin.
 */
export function newSubscriptionRow(a: {
  tenantId: string; customerId: string; customerName: string; domain: string;
  plan: string; users: number; sellPerUserMonth: number | null; googleCostMonth: number; syncedAt: string;
  /** R-320: the catalogue row the price came from. */
  itemId?: string | null;
}) {
  const users = Math.max(1, Math.round(a.users));
  return {
    tenant_id: a.tenantId,
    customer_id: a.customerId,
    customer_name: a.customerName,
    domain: normDomain(a.domain),
    plan: a.plan,
    vendor: "google" as const,
    status: "active" as const,
    seats: users,
    used: 0,
    mrr: a.sellPerUserMonth && a.sellPerUserMonth > 0 ? Math.round(a.sellPerUserMonth * users) : 0,
    outstanding_amount: 0,
    auto_renew: true,
    vendor_seats: users,
    vendor_cost_per_seat_month: Math.round(Math.max(0, a.googleCostMonth) / users),
    vendor_synced_at: a.syncedAt,
    ...(a.itemId ? { item_id: a.itemId } : {}),
  };
}

/** A customer name from a domain: "freighttiger.com" → "Freighttiger". Rename later. */
export function nameFromDomain(domain: string): string {
  /* The company part, not the first label: "ai.tattvaspa.org" is Tattvaspa (not "Ai"), and
     "merrymen.co.in" is Merrymen — skip a second-level suffix like co / com / org / net / ac. */
  const labels = normDomain(domain).split(".").filter(Boolean);
  const SLD = new Set(["co", "com", "org", "net", "ac", "edu", "gov", "gen", "firm", "ind", "ltd", "plc"]);
  let i = labels.length - 2;
  while (i > 0 && (SLD.has(labels[i]) || labels[i].length <= 2)) i -= 1;
  const base = (labels[Math.max(0, i)] ?? "").replace(/[-_]+/g, " ").trim();
  return base ? base.split(" ").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ") : domain;
}

// ─── Pricing a subscription made from the bill (R-320) ─────────────────────────

/** A catalogue row as the bill pricing reads it (the shape plan-price.ts takes, plus vendor). */
export type BillCatalogRow = NonNullable<Parameters<typeof planPricePerSeat>[1]>[number] & { vendor?: string | null };

/** The Google subscription the bill implies for one domain, before anyone edits it. */
export interface BillSubDraft {
  /** The bill's edition, or "Google Workspace" when the bill does not name one. */
  plan: string;
  users: number;
  /** ₹/seat/month from the tenant catalogue (list price, R-205 floor applied), or null. */
  sellPerUserMonth: number | null;
  itemId: string | null;
  /** True when the bill names an edition we know but the catalogue has no priced row for it. */
  noCatalogPrice: boolean;
  /** True when the bill names no edition (the PDF) — price and users are left to a person. */
  editionUnknown: boolean;
}

/**
 * The catalogue price for a Workspace edition: the tenant's Google rows only, by exact name
 * first, then the catalogue's own wording ("Google Workspace Business Starter"). Priced through
 * planPricePerSeat → catalogYearlyPrice, so it is the same number a quote shows (R-387). No
 * fallback list: a plan the tenant does not sell has no price here, never an invented one.
 */
export function catalogPriceForEdition(plan: string, catalog: readonly BillCatalogRow[] | null | undefined): { perSeatPm: number; itemId: string } | null {
  // Only a named edition is priced: a catalogue row called just "Google Workspace" must not price an unknown one.
  if (!billEditionOf(`Google Workspace ${plan}`)) return null;
  const google = (catalog ?? []).filter((r) => !r.vendor || r.vendor.toLowerCase() === "google");
  for (const name of [plan, `Google Workspace ${plan}`]) {
    const p = planPricePerSeat(name, google, {});
    if (p?.source === "catalog" && p.itemId) return { perSeatPm: p.perSeatPm, itemId: p.itemId };
  }
  return null;
}

/** Edition + seats from the bill line, price from the catalogue. */
export function draftFromBill(row: Pick<CheckRow, "billPlan" | "billSeats">, catalog: readonly BillCatalogRow[] | null | undefined): BillSubDraft {
  const users = row.billSeats && row.billSeats > 0 ? Math.round(row.billSeats) : 1;
  if (!row.billPlan) {
    return { plan: "Google Workspace", users, sellPerUserMonth: null, itemId: null, noCatalogPrice: false, editionUnknown: true };
  }
  const price = catalogPriceForEdition(row.billPlan, catalog);
  return {
    plan: row.billPlan, users,
    sellPerUserMonth: price?.perSeatPm ?? null, itemId: price?.itemId ?? null,
    noCatalogPrice: !price, editionUnknown: false,
  };
}
