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
 *   POST /api/renewals/bill-together {ids:[…], periods?:[{subscriptionId, periodStart}]}
 *                                               → 200 BillTogetherCreated | 4xx { error, reasons? }
 *                                                  (R-2845: the screen sends the part each line showed — the
 *                                                  route's guard then never bills a part nobody saw)
 *
 * R-2808 also owns suggestBillTogether(): which listed rows were billed together last cycle (the
 * Renewals queue groups them, ticked by default — Pardeep 14 Nov: "un subscription ko group me
 * selected by default dikhao").
 */

export const BILL_TOGETHER_PATH = "/api/renewals/bill-together";

/**
 * Why a subscription cannot go on the together bill. `text` is the plain sentence the screen shows — the screen
 * never switches on the code. R-2845: the ONE list — every code the route's preview returns is here (no wider
 * type elsewhere).
 */
export type BillTogetherReasonCode =
  | "other_customer"        // not the first ticked subscription's customer
  | "yearly"                // renewed once a year, ticked with subscriptions billed in parts (R-2849: yearly ones go together on their own)
  | "mixed_billing"         // R-2849: billed in parts, ticked with yearly renewals — never on one bill
  | "open_renewal_quote"    // a renewal quote / part proforma is already open for it
  | "unpaid_earlier_part"   // an earlier part is still unpaid
  | "already_together"      // its next part is already on a live together proforma (see onTogetherBill)
  | "different_gst"         // its GST rate differs from the others
  | "not_found"             // no such subscription in this company
  | "not_billable"          // not active / Won't renew / next part not worked out / not started next to a started one (R-2807)
  | "first_part_of_sale"    // its first part is billed by its sale quote (R-2831)
  | "sale_sibling";         // sold with others on one sale quote whose parts are not laid / not ticked (R-2092, R-2831)

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

/**
 * R-2849: what the ONE bill is — "parts" = a proforma of each subscription's next part (R-2807..R-2845);
 * "renewal" = ONE renewal quote renewing yearly subscriptions together, a line per subscription's next term
 * (create_renewal_quote_together, R-2847/R-2848). The first ticked subscription decides; the two never mix.
 */
export type BillTogetherKind = "parts" | "renewal";

export interface BillTogetherPreview {
  /** R-2849; absent from a server older than R-2849 (read as "parts"). */
  kind?: BillTogetherKind;
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
  /** Where to open it — `/quotes/<id>`, or `/invoices/<id>` when action is "invoice". */
  href: string;
  alreadyExisted: boolean;
  /** The subscriptions on it. */
  subscriptionIds: string[];
  /**
   * R-2831: "request" = a proforma to send; "invoice" = the money already received paid the group, so its tax
   * invoice was raised at once (invoiceId). Absent from a server older than R-2831 (read as "request").
   */
  /* R-2849: "renewal_quote" = ONE renewal quote for yearly subscriptions (href /quotes/<id>), not sent yet. */
  action?: "request" | "invoice" | "renewal_quote";
  invoiceId?: string | null;
}

/** R-2845: the part one ticked line bills, as the dialog showed it (its line's periodStart). */
export interface BillTogetherPeriod { subscriptionId: string; periodStart: string }

export interface BillTogetherError { error: string; reasons?: Array<{ subscriptionId: string } & BillTogetherReason> }

/** A refusal / failure from the route, with its HTTP status (R-2845: the screen treats 409 "changed / cannot join" apart). */
export class BillTogetherHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "BillTogetherHttpError"; }
}

async function readJson(res: Response): Promise<unknown> {
  try { return await res.json(); } catch { return {}; }
}

/**
 * Is the route deployed (and may this login use it)? 404 / 401 / 403 → false: the screen shows no Bill together.
 * R-2832 (rev-r2808 F6): a 5xx or a "try later" (408 / 425 / 429) is NOT an answer — it throws, so the probe
 * retries instead of caching "no" for its 10-minute stale time.
 */
export async function billTogetherAvailable(fetcher: typeof fetch = fetch): Promise<boolean> {
  const res = await fetcher(BILL_TOGETHER_PATH, { method: "GET" });
  if (res.status >= 500 || res.status === 408 || res.status === 425 || res.status === 429) {
    throw new Error(`Bill together check failed (${res.status})`);
  }
  return res.ok || res.status === 400;
}

/** The lines for these subscriptions. Throws with the route's own words on any other status. */
export async function fetchBillTogetherPreview(ids: readonly string[], fetcher: typeof fetch = fetch): Promise<BillTogetherPreview> {
  const res = await fetcher(`${BILL_TOGETHER_PATH}?ids=${ids.map(encodeURIComponent).join(",")}`, { method: "GET" });
  const json = (await readJson(res)) as Partial<BillTogetherPreview> & { error?: string };
  if (!res.ok || !Array.isArray(json.subs)) throw new Error(json.error ?? `Could not load what will be billed (${res.status})`);
  return json as BillTogetherPreview;
}

/**
 * Make the ONE proforma. Throws with the route's own words (and the refused subscriptions' reasons).
 * `periods` (R-2845) = the part each ticked line showed; the route refuses (409, nothing billed) when one moved.
 */
export async function createTogetherProforma(ids: readonly string[], periods?: readonly BillTogetherPeriod[], fetcher: typeof fetch = fetch): Promise<BillTogetherCreated> {
  const res = await fetcher(BILL_TOGETHER_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(periods?.length ? { ids, periods } : { ids }),
  });
  const json = (await readJson(res)) as Partial<BillTogetherCreated> & Partial<BillTogetherError>;
  if (!res.ok || !json.quoteId) {
    const why = json.reasons?.length ? ` — ${json.reasons.map((r) => r.text).join("; ")}` : "";
    throw new BillTogetherHttpError(`${json.error ?? `Could not create the proforma (${res.status})`}${why}`, res.status);
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
  /** Billed in parts (monthly / quarterly …). False = renewed once a year (R-2849). */
  split: boolean;
  /** Something to bill now: a split row's part is due (stage due / part-due); R-2849: a yearly row's renewal is due
   *  soon with no renewal quote open yet. */
  billable: boolean;
  billingCycle: string | null;
  /** The next part's start (renewal_date for a split row); R-2849: a yearly row's renewal date. */
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
  /** same-bill = their last part was on one quote / invoice; same-domain = same domain + same next period
   *  (R-2849: yearly — same domain + same renewal month). */
  why: "same-bill" | "same-domain";
  /** R-2849: "parts" (one proforma) or "renewal" (one renewal quote for yearly subscriptions). Never mixed. Absent = parts. */
  kind?: BillTogetherKind;
}

/**
 * Rows of ONE customer with something to bill now that either shared their last quote / invoice, or have the same
 * domain and the same next period: split-billed rows — same next part (start + cycle); R-2849 yearly rows — same
 * renewal month. Split and yearly rows are never grouped together. Each row is in at most one group; groups keep
 * the rows' order.
 */
export function suggestBillTogether(rows: readonly BillTogetherRow[]): BillTogetherGroup[] {
  const live = rows.filter((r) => r.billable && !!r.customerId);
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
      if (a.customerId !== b.customerId || a.split !== b.split) continue;
      const bill = (!!a.lastInvoiceId && a.lastInvoiceId === b.lastInvoiceId) || (!!a.lastQuoteId && a.lastQuoteId === b.lastQuoteId);
      const samePeriod = !!a.nextPartStart && !!b.nextPartStart && (a.split
        ? a.nextPartStart === b.nextPartStart && a.billingCycle === b.billingCycle
        : a.nextPartStart.slice(0, 7) === b.nextPartStart.slice(0, 7));
      const domain = !!a.domain && a.domain.toLowerCase() === b.domain?.toLowerCase() && samePeriod;
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
      kind: g[0].split ? "parts" as const : "renewal" as const,
    }));
}

/** The row hint: "Bills with Business Starter" (the group's other plans). */
export function billsWithText(group: BillTogetherGroup, subId: string, planOf: (id: string) => string | null): string {
  const others = group.subIds.filter((id) => id !== subId).map((id) => planOf(id) ?? "another subscription");
  return `Bills with ${others.length <= 2 ? others.join(" and ") : `${others[0]} and ${others.length - 1} more`}`;
}

/**
 * Ticked rows → may "Bill together" be offered? 2+ rows, ONE customer, all billed in parts — or (R-2849) all renewed
 * once a year (one renewal quote). Never a mix. The route still checks everything (reasons); this only decides
 * whether the button shows.
 */
export function canOfferBillTogether(rows: ReadonlyArray<Pick<BillTogetherRow, "customerId" | "split">>): boolean {
  if (rows.length < 2) return false;
  const c = rows[0].customerId;
  const split = rows[0].split;
  return !!c && rows.every((r) => r.customerId === c && r.split === split);
}
