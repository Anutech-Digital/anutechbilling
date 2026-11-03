/**
 * R-2402 — "Reconcile from Zoho" (bulk): the PLAN for each open money-in bank line. Pure, no I/O.
 *
 * Pardeep (3 Nov, Excel Technologies HDFC 4523): ~199 open money-in lines; one-by-one Reconcile →
 * Find in Zoho → check the subscription → fix dates → Save is 5–8 min a line. Doing 7 by hand
 * found the traps this plan avoids (Anutech-HQ/drafts/RECON-4523/progress-2026-11-03.md):
 *
 *   1. A new sale made a NEW subscription even when the customer already had one for that domain
 *      → a line whose customer + domain has a live subscription books NO subscription; the seat
 *      difference Zoho vs app is listed for a person.
 *   2. A pro-rata add-on line (Zoho billed less than a full term, ending on an existing
 *      subscription's renewal) became its own subscription at the pro-rata price → it books no
 *      subscription and reads "add N seats to <subscription>".
 *   3. Several lines with different periods got ONE renewal date (the latest) → each new
 *      subscription keeps its own start and renewal from its Zoho line (dateFixes after booking).
 *   4. A new customer from Zoho needed "Paid on the customer's behalf" when the payer name differed
 *      → when Zoho matched the payment by the bank UTR, the payer is recorded as paying on the
 *      customer's behalf; matched only by amount + date, the row waits for a person.
 *   5. Zoho's contact email / phone were not carried → a new customer gets them when Zoho has them.
 *
 * A row with a problem (no state, amounts differ by more than ₹1, payer differs without a UTR match,
 * mixed terms, …) is UNTICKED by default and says why. Booking goes through the Reconcile sheet's
 * own path (reconcile_bank_credit_new_sale) — no new money RPC.
 */
import {
  salePreview, type SaleCycle, type SaleLine,
} from "@/lib/banking/credit-pay-for";
import {
  payerFromNarration, payerMatchesCustomer, type KnownPayer, type NarrationPayer, type PayerRelation,
} from "@/lib/banking/customer-payer";
import { tdsSectionGuess } from "@/lib/banking/tds-section";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { GST_STATE_BY_CODE } from "@/lib/utils";
import { parsePlaceOfSupply } from "@/lib/import/zoho-opening-invoices";
import type { FindZohoResult, ZohoMatchLine, ZohoPaymentMatch } from "./payment-match";
import { mapZohoCustomer, normCompanyName, zohoSaleLine, zohoSaleNumber } from "./payment-prefill";

/** Lines the bulk-match route plans per request (each costs about 2–4 Zoho calls). */
export const BULK_PAGE = 8;
/** ₹ the sale total may differ from the money (bank credit + TDS) and still be booked as it is. */
export const AMOUNT_SLACK = 1;
/** Days a pro-rata line's end may sit from an existing subscription's renewal and still be its add-on. */
export const ADD_ON_DAY_SLACK = 3;

// ── Inputs ────────────────────────────────────────────────────────────────────────────────

export interface BulkLine {
  id: string;
  txnDate: string;
  credit: number;
  description: string | null;
  reference: string | null;
}

/** One line of the bulk-match route's answer. */
export interface BulkMatchRow { line: BulkLine; result: FindZohoResult; contact: ZohoContactInfo | null }

/** What Zoho says about the customer (its contact), for a customer the app does not have yet. */
export interface ZohoContactInfo {
  zohoId: string;
  name: string;
  gstin: string | null;
  /** GST state code ("07"), from Zoho's place of contact, else the GSTIN. */
  stateCode: string | null;
  country: string;
  email: string | null;
  phone: string | null;
  personName: string | null;
  gstTreatment: string | null;
  customerType: "business" | "individual";
}

export interface PlanCustomerRow {
  id: string;
  name: string;
  gstin?: string | null;
  state_code?: string | null;
  country?: string | null;
  domain?: string | null;
}

export interface PlanSubRow {
  id: string;
  customer_id: string | null;
  plan: string;
  domain: string | null;
  seats: number;
  status: string;
  start_date: string | null;
  renewal_date: string | null;
}

type CatalogArg = Parameters<typeof zohoSaleLine>[1];

export interface PlanContext {
  customers: readonly PlanCustomerRow[];
  subscriptions: readonly PlanSubRow[];
  catalog: CatalogArg;
  payers: readonly KnownPayer[];
  ownNames: readonly string[];
  /** The company issues bills of supply (no GST) — every sale is at 0%. */
  noGst?: boolean;
}

// ── Output ────────────────────────────────────────────────────────────────────────────────

export type LineAction = "new_sub" | "existing_sub" | "add_seats" | "one_time";

export interface PlanLine {
  name: string;
  qty: number;
  rate: number;
  cycle: SaleCycle;
  domain: string | null;
  start: string | null;
  /** The day after the Zoho period ends — the subscription's renewal date. */
  renewal: string | null;
  months: number | null;
  invoiceNumber: string;
  action: LineAction;
  /** The existing subscription this line belongs to (existing_sub / add_seats). */
  sub: { id: string; plan: string; seats: number; renewal_date: string | null; domain: string | null } | null;
  /** One plain sentence for the table, e.g. "Add 3 seats to Business Starter (zuna.one)". */
  text: string;
}

export interface SeatDiff { subId: string; plan: string; domain: string | null; appSeats: number; zohoSeats: number }

export type PlanCustomer =
  | { kind: "existing"; id: string; name: string; by: "gstin" | "name" }
  | {
      kind: "new"; zohoId: string; name: string; gstin: string | null; stateCode: string | null; state: string | null;
      country: string; email: string | null; phone: string | null; contactName: string | null;
      gstTreatment: string | null; customerType: "business" | "individual";
    };

export interface PlanPayer {
  name: string;
  payer: NarrationPayer;
  /** What is recorded on the line before the sale (set_bank_line_payer); null = nothing. */
  record: { relation: PayerRelation; note: string | null } | null;
  differs: boolean;
}

/** A dated subscription the RPC made with the sale's one start/renewal — corrected after booking. */
export interface DateFix { name: string; qty: number; domain: string | null; start: string; renewal: string }

export interface BookSpec {
  lines: SaleLine[];
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  billingCycle: "monthly" | null;
  externalNumber: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  tdsSection: string | null;
  dateFixes: DateFix[];
}

export interface PlanRow {
  txnId: string;
  txnDate: string;
  credit: number;
  description: string | null;
  kind: "match" | "several";
  zoho: {
    paymentId: string | null;
    paymentNumber: string | null;
    by: ZohoPaymentMatch["by"] | null;
    amount: number | null;
    invoiceNumbers: string[];
    candidates: number;
  };
  customer: PlanCustomer | null;
  lines: PlanLine[];
  seatDiffs: SeatDiff[];
  saleTotal: number | null;
  tds: number;
  payer: PlanPayer | null;
  /** Why the row is not ticked — empty = ready to book. */
  problems: string[];
  /** Things a person should look at after booking (still booked). */
  notes: string[];
  ticked: boolean;
  book: BookSpec | null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string | null => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};
const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
export function nextDay(iso: string): string {
  const d = new Date(day(iso));
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const rupees = (n: number) => `₹${Math.round(n).toLocaleString("en-IN")}`;
const normDom = (d: string | null | undefined) => (d ?? "").trim().toLowerCase() || null;
const normProduct = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const LIVE = new Set(["active", "paused"]);
const isIndia = (c: string | null | undefined) => ["", "in", "ind", "india", "bharat"].includes((c ?? "").trim().toLowerCase());

/** Zoho contact (detail) → what a new app customer is made with. Email / phone: the contact's own,
 *  else its primary contact person's. State: place of contact, else the GSTIN. */
export function zohoContactInfo(raw: Record<string, unknown>, fallback: { zohoId: string; name: string; gstin: string | null }): ZohoContactInfo {
  const persons = Array.isArray(raw.contact_persons) ? (raw.contact_persons as Array<Record<string, unknown>>) : [];
  const primary = persons.find((p) => p.is_primary_contact === true) ?? persons[0] ?? null;
  const gstin = (str(raw.gst_no) ?? fallback.gstin)?.toUpperCase() ?? null;
  const treatment = str(raw.gst_treatment);
  const billing = (raw.billing_address && typeof raw.billing_address === "object") ? raw.billing_address as Record<string, unknown> : {};
  const overseas = treatment === "overseas";
  const country = overseas ? (str(billing.country) ?? str(raw.country) ?? "") : "India";
  const person = [str(primary?.first_name), str(primary?.last_name)].filter(Boolean).join(" ").trim()
    || [str(raw.first_name), str(raw.last_name)].filter(Boolean).join(" ").trim();
  return {
    zohoId: str(raw.contact_id) ?? fallback.zohoId,
    name: str(raw.contact_name) ?? str(raw.company_name) ?? fallback.name,
    gstin,
    stateCode: overseas ? null : (parsePlaceOfSupply(str(raw.place_of_contact)) ?? stateCodeFromGstin(gstin) ?? parsePlaceOfSupply(str(billing.state))),
    country,
    email: str(raw.email) ?? str(primary?.email),
    phone: str(raw.mobile) ?? str(raw.phone) ?? str(primary?.mobile) ?? str(primary?.phone),
    personName: person || null,
    gstTreatment: treatment,
    customerType: str(raw.customer_sub_type) === "individual" ? "individual" : "business",
  };
}

/** TDS rate % that explains the withheld amount (1 / 2 / 10 when within 0.05), else 2 decimals. */
export function tdsRate(tds: number, taxable: number): number | null {
  if (!(tds > 0) || !(taxable > 0)) return null;
  const r = (tds / taxable) * 100;
  for (const k of [1, 2, 10]) if (Math.abs(r - k) <= 0.05) return k;
  return Math.round(r * 100) / 100;
}

/** The live subscription a Zoho line belongs to: same customer and end-domain; the same product
 *  wins when the domain has several. Null = no live subscription for that customer + domain. */
export function liveSubFor(
  line: { name: string; domain: string | null },
  customer: { id: string; domain?: string | null },
  subs: readonly PlanSubRow[],
): PlanSubRow | null {
  const key = normDom(line.domain) ?? normDom(customer.domain);
  const mine = subs.filter((s) => s.customer_id === customer.id && LIVE.has(s.status));
  const sameDomain = mine.filter((s) => (normDom(s.domain) ?? normDom(customer.domain)) === key);
  if (sameDomain.length === 0) return null;
  if (key === null) {
    /* No domain on either side: only the same product counts as "this subscription". */
    return sameDomain.find((s) => normProduct(s.plan) === normProduct(line.name)) ?? null;
  }
  return sameDomain.find((s) => normProduct(s.plan) === normProduct(line.name)) ?? sameDomain[0];
}

/** Zoho billed this annual line for less than a full year (pro-rata). */
function partTerm(zl: ZohoMatchLine, cycle: SaleCycle): boolean {
  return cycle === "annual_yearly" && zl.months !== null && zl.months > 0 && zl.months < 12;
}

const near = (a: string | null, b: string | null, days: number) =>
  !!a && !!b && Math.abs(day(a) - day(b)) / 86_400_000 <= days;

/** The pick-one row ("several Zoho payments could be this line"). */
export function severalRow(line: BulkLine, candidates: number): PlanRow {
  return {
    txnId: line.id, txnDate: line.txnDate, credit: line.credit, description: line.description, kind: "several",
    zoho: { paymentId: null, paymentNumber: null, by: null, amount: null, invoiceNumbers: [], candidates },
    customer: null, lines: [], seatDiffs: [], saleTotal: null, tds: 0, payer: null,
    problems: [`Zoho has ${candidates} payments that could be this line — open the line's Reconcile and use Find in Zoho to pick one.`],
    notes: [], ticked: false, book: null,
  };
}

// ── The plan for one line ────────────────────────────────────────────────────────────────

export function planRow(
  line: BulkLine,
  match: ZohoPaymentMatch,
  contact: ZohoContactInfo | null,
  ctx: PlanContext,
): PlanRow {
  const problems: string[] = [];
  const notes: string[] = [];

  /* 1. Customer — the app's (GSTIN, then name) or a new one from Zoho. */
  const mapped = mapZohoCustomer(match.customer, ctx.customers);
  const appCust = mapped ? ctx.customers.find((c) => c.id === mapped.id) ?? null : null;
  let customer: PlanCustomer;
  if (mapped && appCust) {
    customer = { kind: "existing", id: mapped.id, name: mapped.name, by: mapped.by };
    if (isIndia(appCust.country) && !(appCust.state_code ?? "").trim()) {
      problems.push(`No state: ${appCust.name} has no state in the app, so its GST invoice cannot be raised. Add the state in Customers, then run this again.`);
    }
  } else {
    const c = contact ?? {
      zohoId: match.customer.zohoId, name: match.customer.name, gstin: match.customer.gstin,
      stateCode: stateCodeFromGstin(match.customer.gstin), country: "India", email: null, phone: null,
      personName: null, gstTreatment: null, customerType: "business" as const,
    };
    const foreign = !isIndia(c.country);
    customer = {
      kind: "new", zohoId: c.zohoId, name: c.name.trim(), gstin: foreign ? null : c.gstin,
      stateCode: foreign ? null : c.stateCode, state: !foreign && c.stateCode ? GST_STATE_BY_CODE[c.stateCode] ?? null : null,
      country: c.country || "India", email: c.email, phone: c.phone,
      contactName: c.personName, gstTreatment: c.gstTreatment, customerType: c.customerType,
    };
    if (!foreign && !c.stateCode) {
      problems.push(`No state: Zoho has no state or GSTIN for ${c.name}. Add the place of contact in Zoho, or reconcile this line by hand.`);
    }
    if (c.country === "") {
      problems.push(`No country: Zoho marks ${c.name} as overseas but has no country. Reconcile this line by hand.`);
    }
    if (!c.email && !c.phone) notes.push(`${c.name}: Zoho has no email or phone — the customer is created without one; add it later.`);
  }

  /* 2. Lines and what each does to subscriptions. */
  const custForSubs = customer.kind === "existing" ? { id: customer.id, domain: appCust?.domain ?? null } : null;
  const lines: PlanLine[] = [];
  const saleLines: SaleLine[] = [];
  const seatDiffs: SeatDiff[] = [];
  const unmatched: string[] = [];
  for (const inv of match.invoices) {
    for (const zl of inv.lines) {
      const made = zohoSaleLine(zl, ctx.catalog);
      if (!made) continue;
      if (!made.inCatalog) unmatched.push(zl.name.trim());
      if (!(made.line.rate > 0)) problems.push(`${zl.name.trim()}: Zoho gives no price for this line.`);
      const renewal = zl.start && zl.end && zl.end >= zl.start ? nextDay(zl.end) : null;
      const base = {
        name: made.line.name, qty: made.line.qty, rate: made.line.rate, cycle: made.cycle,
        domain: made.cycle === "one_time" ? null : normDom(zl.domain), start: zl.start, renewal,
        months: zl.months, invoiceNumber: inv.number,
      };
      let pl: PlanLine;
      const sub = made.cycle !== "one_time" && custForSubs ? liveSubFor(zl, custForSubs, ctx.subscriptions) : null;
      const subLite = sub ? { id: sub.id, plan: sub.plan, seats: sub.seats, renewal_date: sub.renewal_date, domain: sub.domain } : null;
      const where = (d: string | null) => (d ? ` (${d})` : "");
      if (made.cycle === "one_time") {
        pl = { ...base, action: "one_time", sub: null, text: "One-time — no subscription" };
      } else if (sub && partTerm(zl, made.cycle) && (near(renewal, sub.renewal_date, ADD_ON_DAY_SLACK) || near(zl.end, sub.renewal_date, ADD_ON_DAY_SLACK))) {
        pl = { ...base, action: "add_seats", sub: subLite, text: `Add ${zl.qty} seat${zl.qty === 1 ? "" : "s"} to ${sub.plan}${where(sub.domain ?? base.domain)} — no new subscription` };
      } else if (sub) {
        pl = { ...base, action: "existing_sub", sub: subLite, text: `Has ${sub.plan}${where(sub.domain ?? base.domain)} — no new subscription` };
        if (sub.seats !== zl.qty) {
          seatDiffs.push({ subId: sub.id, plan: sub.plan, domain: sub.domain ?? base.domain, appSeats: sub.seats, zohoSeats: zl.qty });
        }
      } else {
        pl = { ...base, action: "new_sub", sub: null, text: base.start && renewal ? `New subscription — renews ${renewal}` : "New subscription" };
        if (partTerm(zl, made.cycle)) notes.push(`${made.line.name}: Zoho billed ${zl.months} month${zl.months === 1 ? "" : "s"} — check the yearly price on the new subscription before it renews.`);
      }
      lines.push(pl);
      saleLines.push(made.line);
    }
  }
  if (lines.length === 0) problems.push("The Zoho invoice has no product lines to book.");
  if (match.moreInvoices.length) problems.push(`The Zoho payment covers more invoices (${match.moreInvoices.join(", ")}) than are read here. Reconcile this line by hand.`);
  if (unmatched.length) notes.push(`Not in the catalogue, booked with Zoho's name and price: ${[...new Set(unmatched)].join(", ")}.`);

  /* 2b. A pro-rata add-on whose main line is a NEW subscription in this same bill (no sub yet). */
  for (const pl of lines) {
    if (pl.action !== "new_sub" || pl.months === null || pl.months >= 12 || pl.cycle !== "annual_yearly") continue;
    const main = lines.find((o) => o !== pl && o.action === "new_sub" && (o.months ?? 0) >= 12
      && o.domain === pl.domain && near(o.renewal, pl.renewal, ADD_ON_DAY_SLACK));
    if (main) {
      pl.action = "add_seats";
      pl.text = `Add ${pl.qty} seat${pl.qty === 1 ? "" : "s"} to the new ${main.name} subscription — no subscription of its own`;
      const old = notes.findIndex((n) => n.startsWith(`${pl.name}: Zoho billed`));
      if (old >= 0) notes.splice(old, 1);
      notes.push(`After booking: set the new ${main.name}${pl.domain ? ` (${pl.domain})` : ""} subscription to ${main.qty + pl.qty} seats (${main.qty} + ${pl.qty} added).`);
    }
  }

  /* 3. One sale: which lines make subscriptions. */
  const monthly = lines.some((l) => l.cycle === "monthly");
  const annual = lines.some((l) => l.cycle === "annual_yearly");
  if (monthly && annual) problems.push("The Zoho bill mixes monthly and yearly lines — one sale is one billing term. Reconcile this line by hand.");
  const newSub = lines.filter((l) => l.action === "new_sub");
  const kept = lines.filter((l) => l.action === "existing_sub" || l.action === "add_seats");
  let createSubscription = newSub.length > 0;
  let bookLines = saleLines;
  if (newSub.length > 0 && kept.length > 0) {
    /* Mixed: the lines of existing subscriptions are booked as one-time charges on this sale, so
       the RPC makes subscriptions ONLY for the new ones (the same as unticking "Create subscription"
       for those lines in the sheet). */
    if (newSub.some((l) => l.cycle === "monthly")) {
      problems.push("A new monthly subscription and lines of existing subscriptions are on one bill — reconcile this line by hand.");
    }
    bookLines = saleLines.map((sl, i) => (lines[i].action === "existing_sub" || lines[i].action === "add_seats")
      ? { ...sl, cycle: "one_time" as const, typedFor: "one_time" as const, domain: null }
      : sl);
    notes.push(`${kept.map((l) => l.name).join(", ")}: booked as a charge on the existing subscription — no new subscription.`);
  }
  if (newSub.length === 0) createSubscription = false;

  /* Per-line dates: the sale carries the first new line's dates; the others are corrected after. */
  const dated = newSub.filter((l) => l.start && l.renewal && l.renewal > l.start);
  const first = dated[0] ?? null;
  const dateFixes: DateFix[] = dated.slice(1)
    .filter((l) => l.start !== first!.start || l.renewal !== first!.renewal)
    .map((l) => ({ name: l.name, qty: l.qty, domain: l.domain, start: l.start!, renewal: l.renewal! }));

  /* 4. Money: Zoho payment vs bank line; sale total vs bank + TDS. */
  const foreign = customer.kind === "new" ? !isIndia(customer.country) : !isIndia(appCust?.country);
  const gstRate = ctx.noGst || foreign ? 0 : 18;
  const preview = salePreview(bookLines, gstRate);
  const tds = Math.max(0, Math.round(match.payment.taxWithheld ?? 0));
  if (Math.abs(match.payment.amount - line.credit) > AMOUNT_SLACK) {
    problems.push(`Amount differs: Zoho payment ${rupees(match.payment.amount)}, bank line ${rupees(line.credit)}.`);
  } else if (lines.length && Math.abs(preview.total - (line.credit + tds)) > AMOUNT_SLACK) {
    problems.push(`Amount differs: the sale comes to ${rupees(preview.total)}, the bank line${tds ? ` + TDS ${rupees(tds)}` : ""} is ${rupees(line.credit + tds)}.`);
  }
  const rate = tdsRate(tds, preview.taxable);
  const custGstin = customer.kind === "new" ? customer.gstin : appCust?.gstin ?? null;
  const section = tds > 0 ? tdsSectionGuess(rate, custGstin).section : null;
  if (tds > 0) notes.push(`TDS ${rupees(tds)} (${rate ?? "?"}%) recorded under ${section} — check the customer's Form 16A.`);

  /* 5. Who paid. */
  const narr = payerFromNarration(line.description, ctx.ownNames);
  let payer: PlanPayer | null = null;
  if (narr) {
    const known = customer.kind === "existing" ? ctx.payers.filter((k) => k.customer_id === (customer as { id: string }).id) : [];
    const hit = known.find((k) => k.payer_name_key === narr.key) ?? null;
    const differs = !payerMatchesCustomer(narr, customer.name, known);
    if (differs && match.by !== "utr") {
      problems.push(`Payer differs: the bank says ${narr.name}, Zoho's customer is ${customer.name}, and Zoho matched by amount and date, not the UTR. Check it in the line's Reconcile.`);
      payer = { name: narr.name, payer: narr, record: null, differs };
    } else if (differs) {
      payer = { name: narr.name, payer: narr, differs, record: { relation: "third_party", note: `Zoho payment ${match.payment.number || match.payment.zohoId} carries this bank UTR` } };
    } else {
      payer = { name: narr.name, payer: narr, differs, record: hit ? { relation: hit.relation, note: null } : null };
    }
  }

  const externalNumber = zohoSaleNumber({ invoiceNumbers: [...match.invoices.map((i) => i.number), ...match.moreInvoices] });
  const book: BookSpec = {
    lines: bookLines,
    createSubscription,
    subStart: createSubscription && first ? first.start : null,
    subRenewal: createSubscription && first ? first.renewal : null,
    billingCycle: monthly && !annual ? "monthly" : null,
    externalNumber,
    tdsAmount: tds,
    tdsRatePct: tds > 0 ? rate : null,
    tdsSection: section,
    dateFixes: createSubscription ? dateFixes : [],
  };

  return {
    txnId: line.id, txnDate: line.txnDate, credit: line.credit, description: line.description, kind: "match",
    zoho: {
      paymentId: match.payment.zohoId, paymentNumber: match.payment.number || null, by: match.by,
      amount: match.payment.amount, invoiceNumbers: [...match.invoices.map((i) => i.number), ...match.moreInvoices], candidates: 1,
    },
    customer, lines, seatDiffs, saleTotal: lines.length ? preview.total : null, tds, payer,
    problems, notes, ticked: problems.length === 0, book,
  };
}

/** One answer of the bulk-match route → its plan row; "none" (not in Zoho) → null (left out). */
export function planFromResult(
  line: BulkLine, result: FindZohoResult, contact: ZohoContactInfo | null, ctx: PlanContext,
): PlanRow | null {
  if (result.kind === "none") return null;
  if (result.kind === "several") return severalRow(line, result.candidates.length);
  return planRow(line, result.match, contact, ctx);
}

/** The rows "Book selected" sends: ticked, bookable, not booked already (in this run or before). */
export function rowsToBook(rows: readonly PlanRow[], ticked: ReadonlySet<string>, booked: ReadonlySet<string>): PlanRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!ticked.has(r.txnId) || !r.book || !r.customer || booked.has(r.txnId) || seen.has(r.txnId)) return false;
    seen.add(r.txnId);
    return true;
  });
}

/** The same company twice in one run (two lines, one new Zoho customer) is created once. */
export const newCustomerKey = (c: Extract<PlanCustomer, { kind: "new" }>) =>
  c.gstin ? `gstin:${c.gstin.toUpperCase()}` : `name:${normCompanyName(c.name)}`;

