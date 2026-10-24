/**
 * Pure parsing + classification for the Google→app subscription matcher.
 * No React / UI imports, so it's unit-testable in isolation. The dialog
 * (import-google-subs-dialog.tsx) consumes these.
 *
 * MONEY-HONESTY: the Google export carries NO price. estMrr is an ESTIMATE
 * (catalog msrp × seats); the UI flags it and never presents it as confirmed.
 */
import { planKey } from "@/lib/subscriptions/plan-match";

export type Category = "link" | "new" | "in_app";

export interface GRow {
  rowNum: number;
  domain: string;
  customer_number: string;
  plan: string;          // SKU
  seats: number;
  estMrr: number;        // catalog msrp × seats (monthly, ESTIMATE)
  status: "active" | "paused";   // Google "Suspended" → paused (closest app status)
  start_date?: string;
  renewal_date?: string;
  category: Category;
  customer_id?: string;  // link
  customer_name?: string;
}

export interface Parsed {
  rows: GRow[];
  custNumHeader: string | null;   // which column we matched as the customer number
  skippedFree: number;            // Cloud Identity Free / blank-SKU rows ignored
}

export interface Lookups {
  byNumber: Map<string, { id: string; name: string }>;
  byDomain: Map<string, { id: string; name: string }>;
  appSubDomains: Set<string>;
}

/** A normalized subscription from EITHER the CSV or the live Reseller API. */
export interface RawSub {
  domain: string;
  sku: string;
  seats: number;
  status: "active" | "paused";
  customer_number?: string;
  start_date?: string;
  renewal_date?: string;
}

/**
 * Classify already-normalized rows against the app's customers/subscriptions
 * and estimate MRR. Shared by the CSV parser and the Reseller-API sync so both
 * produce identical buckets + money.
 */
export function classifyRows(raws: RawSub[], lk: Lookups, priceMap: Map<string, number>): GRow[] {
  const rows: GRow[] = raws.map((r, i) => {
    const domain = normDomain(r.domain);
    const customer_number = (r.customer_number ?? "").trim();
    /* planKey, not raw lowercase: Google says "Google Workspace Business Starter" and the
       catalogue says "Google Workspace Starter". See the price-side note in
       lib/subscriptions/plan-match.ts — an exact match here imported four real
       subscriptions at ₹0. */
    const estMrr = Math.round((priceMap.get(planKey(r.sku)) ?? 0) * r.seats);

    let category: Category;
    let customer_id: string | undefined;
    let customer_name: string | undefined;
    if (lk.appSubDomains.has(domain)) {
      category = "in_app";   // a subscription on this domain is already tracked
    } else {
      const byNum = customer_number ? lk.byNumber.get(customer_number.toLowerCase()) : undefined;
      const match = byNum ?? lk.byDomain.get(domain);
      if (match) { category = "link"; customer_id = match.id; customer_name = match.name; }
      else category = "new";
    }
    return {
      rowNum: i + 1, domain, customer_number, plan: r.sku.trim(), seats: r.seats, estMrr,
      status: r.status, start_date: r.start_date, renewal_date: r.renewal_date,
      category, customer_id, customer_name,
    };
  });
  // Actionable first (link, then new), already-in-app last.
  const order: Record<Category, number> = { link: 0, new: 1, in_app: 2 };
  rows.sort((a, b) => order[a.category] - order[b.category]);
  return rows;
}

export function normDomain(s: string): string {
  return (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * R-1652 — a written calendar date ("November 27, 2026", "Nov 27, 2026 03:15") → YYYY-MM-DD,
 * the SAME day the text names, in every time zone. It is a date, not an instant: never through
 * `toISOString()` — `new Date("November 27, 2026")` is local midnight, which in an IST browser
 * is 18:30 UTC on the 26th, so the import saved every start/renewal date one day early.
 * "Month D, YYYY" is read by hand; anything else Date can parse is read by its LOCAL parts
 * (the day the text names, since the text carries no zone). Impossible dates → null.
 */
export function textDateISO(s: string): string | null {
  const t = (s || "").trim();
  const m = t.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const y = Number(m[3]), mo = mi + 1, d = Number(m[2]);
    if (mi < 0 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
  }
  const d = new Date(t);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Google panel dates look like "November 27, 2026" (sometimes quoted). */
export function gDate(s: string): string | undefined {
  const t = (s || "").trim().replace(/^"|"$/g, "");
  if (!t || t === "-") return undefined;
  return textDateISO(t) ?? undefined;
}

export function parseGoogle(text: string, lk: Lookups, priceMap: Map<string, number>): Parsed {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header + at least one data row.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const rawHeader = parseLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ""));
  const find = (pred: (h: string) => boolean) => header.findIndex(pred);

  const iDomain = find((h) => h === "customer" || h.includes("domain"));
  const iSku    = find((h) => h === "sku");
  const iStatus = find((h) => h.includes("subscription status"));
  const iSeats  = find((h) => h.includes("purchased"));
  const iRenew  = find((h) => h.includes("renewal"));
  const iCreate = find((h) => h.includes("creation"));
  // Customer-number column: must NOT be the "Customer" (domain) column.
  const iNum = find((h) =>
    (h.includes("customer number") || h === "customer_number" || h === "customer no" ||
     h === "customer id" || h === "account number" || h === "reference" || h === "ref" || h === "ref no"));

  if (iDomain === -1) throw new Error("Couldn't find the 'Customer' (domain) column.");
  if (iSku === -1) throw new Error("Couldn't find the 'Sku' column.");

  const raws: RawSub[] = [];
  let skippedFree = 0;

  for (let i = 1; i < lines.length; i++) {
    const c = parseLine(lines[i]);
    const sku = (c[iSku] ?? "").trim();
    if (!sku || sku === "-" || sku.toLowerCase() === "cloud identity free") { skippedFree++; continue; }
    const domain = normDomain(c[iDomain] ?? "");
    if (!domain) continue;
    const statusRaw = (c[iStatus] ?? "").trim();
    raws.push({
      domain,
      sku,
      seats: Math.max(0, Math.round(Number(c[iSeats] ?? 0) || 0)),
      status: /suspend/i.test(statusRaw) ? "paused" : "active",
      customer_number: iNum >= 0 ? (c[iNum] ?? "").trim() : "",
      start_date: gDate(c[iCreate] ?? ""),
      renewal_date: gDate(c[iRenew] ?? ""),
    });
  }

  return { rows: classifyRows(raws, lk, priceMap), custNumHeader: iNum >= 0 ? rawHeader[iNum] : null, skippedFree };
}

export function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Turn matched export rows into `subscriptions` INSERT payloads.
 *
 * ─── WHY THIS IS A FUNCTION AND NOT A `.map()` IN THE DIALOG ────────────────
 * It was a `.map()` in the dialog, and it quietly dropped the one field that made the
 * import worth doing. Reported 21 Sep 2026: four subscriptions imported STRAIGHT FROM
 * the Google export immediately showed "— / 2 · NOT CHECKED" in the licence-leakage
 * column. The app had just been told Google's seat count by Google, written it into
 * `seats`, and then reported that it had never asked.
 *
 * `vendor_seats` is what that column reads, and nothing set it. So the row said "we do
 * not know what the vendor charges" about a row whose every field came from the vendor.
 *
 * Extracted so the payload can be asserted. The defect was invisible in review precisely
 * because a missing key in an object literal looks like nothing at all.
 */
export interface SubscriptionRowInput {
  tenantId: string;
  /** Resolved customer for this row — link target, or a customer just created. */
  customerId: string | undefined;
  /** When the vendor figures were read. Stamped on every row of one import. */
  syncedAt: string;
}

export function buildSubscriptionRow(r: GRow, input: SubscriptionRowInput) {
  if (!input.customerId) return null;
  return {
    tenant_id: input.tenantId,
    customer_id: input.customerId,
    customer_name: r.customer_name ?? r.domain,
    plan: r.plan,
    vendor: "google" as const,
    seats: r.seats,
    used: 0,
    mrr: r.estMrr,
    start_date: r.start_date ?? null,
    renewal_date: r.renewal_date ?? null,
    status: r.status,
    domain: r.domain,
    outstanding_amount: 0,
    auto_renew: true,
    /* ── THE VENDOR'S OWN COUNT, RECORDED AS SUCH ───────────────────────────
       Same number as `seats`, and that is the point rather than a duplication: `seats`
       is what WE bill and an operator may change it tomorrow, while `vendor_seats` is
       what GOOGLE said at this moment. They start equal because the row was born from
       Google's own export; they drift the moment somebody edits one of them, and that
       drift is exactly what the licence-leakage column exists to catch.

       Without this the import created rows that could never leak and could never match
       — they simply read "not checked" forever, until somebody re-uploaded the same
       file through the reconcile dialog to tell the app what it already knew. */
    vendor_seats: r.seats,
    vendor_synced_at: input.syncedAt,
  };
}
