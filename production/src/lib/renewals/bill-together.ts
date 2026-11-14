/**
 * R-2805 "Bill together" (Pratik, Excel — ITBUZZ: Business Standard + Business Starter, both "Part not
 * billed (Oct)", two separate "Bill next part" buttons, while last cycle they were on ONE bill).
 *
 * THE CONTRACT between the Renewals screen (R-2808) and the route /api/renewals/bill-together (R-2807,
 * which calls R-2810's bill_parts_together). The route imports these types and returns exactly these
 * shapes; the screen only calls the two client functions below. Nothing here touches money — the
 * proforma is made by the RPC.
 *
 *   GET  /api/renewals/bill-together            → 400 { error }  (the screen's "is it there?" probe;
 *                                                  404 = the route is not deployed yet → the screen shows nothing)
 *   GET  /api/renewals/bill-together?ids=a,b    → 200 BillTogetherPreview  (never 404 — an unknown id is a
 *                                                  sub with reason "not_found")
 *   POST /api/renewals/bill-together {ids:[…]}  → 200 BillTogetherCreated | 4xx { error, reasons? }
 *
 * R-2808 also owns suggestBillTogether(): which listed rows were billed together last cycle (the
 * Renewals queue groups them, ticked by default — Pardeep 14 Nov: "un subscription ko group me
 * selected by default dikhao").
 */

export const BILL_TOGETHER_PATH = "/api/renewals/bill-together";

/** Why a subscription cannot go on the together bill. `text` is the plain sentence the screen shows. */
export type BillTogetherReasonCode =
  | "other_customer"        // not the first ticked subscription's customer
  | "yearly"                // not billed in parts (yearly / whole-term renewal quote — R-2809)
  | "open_renewal_quote"    // a renewal quote / part proforma is already open for it
  | "unpaid_earlier_part"   // an earlier part is still unpaid
  | "already_together"      // its next part is already on a live together proforma (see onTogetherBill)
  | "different_gst"         // its GST rate differs from the others
  | "not_found";            // no such subscription in this company

export interface BillTogetherReason { code: BillTogetherReasonCode; text: string }

/** One subscription's line on the together proforma (its next unbilled part). Money in ₹ incl. paise as numbers. */
export interface BillTogetherLine {
  seats: number;
  /** ₹ a seat for the period; null when the part's amount does not divide by the seats. */
  seatRate: number | null;
  /** YYYY-MM-DD, both inclusive (as the proforma prints it). */
  periodStart: string;
  periodEnd: string;
  taxable: number;
  /** GST % (18). */
  taxRate: number;
  tax: number;
  gross: number;
}

/** A live together proforma the subscription's next part is already on. */
export interface TogetherBillRef {
  /** The proforma number (quotes.id, PI series). */
  quoteId: string;
  status: string;
  /** The OTHER subscriptions' plans on it ("Business Starter"). */
  withPlans: string[];
}

export interface BillTogetherSub {
  subscriptionId: string;
  plan: string | null;
  customerId: string | null;
  customerName: string | null;
  /** The line it would add; null when it cannot be billed now (see reasons). */
  line: BillTogetherLine | null;
  /** [] = it can join. */
  reasons: BillTogetherReason[];
  onTogetherBill: TogetherBillRef | null;
}

export interface BillTogetherPreview {
  /** In the order the ids were asked for. */
  subs: BillTogetherSub[];
  /** Of the subs that can join (reasons []). */
  total: { taxable: number; tax: number; gross: number };
  /** "INR" unless the customer is billed in another currency. */
  currency: string;
}

export interface BillTogetherCreated {
  /** The ONE proforma made (or the existing one, alreadyExisted). */
  quoteId: string;
  /** Where to open it — `/quotes/<id>`. */
  href: string;
  alreadyExisted: boolean;
  /** The subscriptions on it. */
  subscriptionIds: string[];
}

export interface BillTogetherError { error: string; reasons?: Array<{ subscriptionId: string } & BillTogetherReason> }

async function readJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return {}; }
}

/** Is the route deployed (and may this login use it)? 404 / 401 / 403 → false: the screen shows no Bill together. */
export async function billTogetherAvailable(fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await fetcher(BILL_TOGETHER_PATH, { method: "GET" });
  return res.ok || res.status === 400;
}

/** The lines for these subscriptions. Throws with the route's own words on any other status. */
export async function fetchBillTogetherPreview(ids: readonly string[], fetcher: typeof fetch = fetch): Promise<BillTogetherPreview> {
  const res = await fetcher(`${BILL_TOGETHER_PATH}?ids=${ids.map(encodeURIComponent).join(",")}`, { method: "GET" });
  const json = (await readJson(res)) as Partial<BillTogetherPreview> & { error?: string };
  if (!res.ok || !Array.isArray(json.subs)) throw new Error(json.error ?? `Could not load what will be billed (${res.status})`);
  return json as BillTogetherPreview;
}

/** Make the ONE proforma. Throws with the route's own words (and the refused subscriptions' reasons). */
export async function createTogetherProforma(ids: readonly string[], fetcher: typeof fetch = fetch): Promise<BillTogetherCreated> {
  const res = await fetcher(BILL_TOGETHER_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  const json = (await readJson(res)) as Partial<BillTogetherCreated> & Partial<BillTogetherError>;
  if (!res.ok || !json.quoteId) {
    const why = json.reasons?.length ? ` — ${json.reasons.map((r) => r.text).join("; ")}` : "";
    throw new Error(`${json.error ?? `Could not create the proforma (${res.status})`}${why}`);
  }
  return json as BillTogetherCreated;
}

// ─── Which listed rows go together ────────────────────────────────────────────

/** What suggestBillTogether reads from a Renewals row. */
export interface BillTogetherRow {
  id: string;
  customerId: string | null;
  customerName: string;
  plan: string | null;
  seats: number | null;
  domain: string | null;
  /** Billed in parts (monthly / quarterly …). */
  split: boolean;
  /** A part is due to bill now (stage due / part-due). */
  billable: boolean;
  billingCycle: string | null;
  /** The next part's start (renewal_date for a split row). */
  nextPartStart: string | null;
  /** The last quote / proforma sent for it and its last invoice (last-docs.ts). */
  lastQuoteId: string | null;
  lastInvoiceId: string | null;
}

export interface BillTogetherGroup {
  customerId: string;
  customerName: string;
  /** In the rows' order; 2+. */
  subIds: string[];
  /** same-bill = their last part was on one quote / invoice; same-domain = same domain + same next period. */
  why: "same-bill" | "same-domain";
}

/**
 * Split-billed rows of ONE customer that are due to bill now and either shared their last quote /
 * invoice, or have the same domain and the same next part (start + cycle). Each row is in at most
 * one group; groups keep the rows' order.
 */
export function suggestBillTogether(rows: readonly BillTogetherRow[]): BillTogetherGroup[] {
  const live = rows.filter((r) => r.split && r.billable && !!r.customerId);
  const parent = new Map<string, string>(live.map((r) => [r.id, r.id]));
  const sameBill = new Set<string>();
  const find = (id: string): string => {
    let p = parent.get(id)!;
    while (p !== parent.get(p)) p = parent.get(p)!;
    parent.set(id, p);
    return p;
  };
  const join = (a: string, b: string, bill: boolean) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
    if (bill) { sameBill.add(a); sameBill.add(b); }
  };
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i], b = live[j];
      if (a.customerId !== b.customerId) continue;
      const bill = (!!a.lastInvoiceId && a.lastInvoiceId === b.lastInvoiceId) || (!!a.lastQuoteId && a.lastQuoteId === b.lastQuoteId);
      const domain = !!a.domain && a.domain.toLowerCase() === b.domain?.toLowerCase()
        && !!a.nextPartStart && a.nextPartStart === b.nextPartStart && a.billingCycle === b.billingCycle;
      if (bill || domain) join(a.id, b.id, bill);
    }
  }
  const groups = new Map<string, BillTogetherRow[]>();
  for (const r of live) {
    const root = find(r.id);
    const g = groups.get(root);
    if (g) g.push(r); else groups.set(root, [r]);
  }
  return [...groups.values()]
    .filter((g) => g.length >= 2)
    .map((g) => ({
      customerId: g[0].customerId!,
      customerName: g[0].customerName,
      subIds: g.map((r) => r.id),
      why: g.every((r) => sameBill.has(r.id)) ? "same-bill" as const : "same-domain" as const,
    }));
}

/** The row hint: "Bills with Business Starter" (the group's other plans). */
export function billsWithText(group: BillTogetherGroup, subId: string, planOf: (id: string) => string | null): string {
  const others = group.subIds.filter((id) => id !== subId).map((id) => planOf(id) ?? "another subscription");
  return `Bills with ${others.length <= 2 ? others.join(" and ") : `${others[0]} and ${others.length - 1} more`}`;
}

/**
 * Ticked rows → may "Bill together" be offered? 2+ rows, ONE customer, all billed in parts.
 * The route still checks everything (reasons); this only decides whether the button shows.
 */
export function canOfferBillTogether(rows: ReadonlyArray<Pick<BillTogetherRow, "customerId" | "split">>): boolean {
  if (rows.length < 2) return false;
  const c = rows[0].customerId;
  return !!c && rows.every((r) => r.customerId === c && r.split);
}
