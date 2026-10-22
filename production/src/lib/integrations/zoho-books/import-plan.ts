/**
 * R-1753 — what "Import from Zoho" would bring in, worked out from what was read from Zoho
 * Books (contacts + invoices with their line items). PURE: no database, no Zoho calls. The
 * dry run shows this; the Import sends the same plan to zoho_books_import_apply(), which
 * re-checks every match in SQL (the database is the judge, this is the preview of it).
 *
 * The owner's rules (from his own invoices, card R-1753):
 *   - a subscription line's description says "Domain Name: x" and
 *     "(Subscription|Validity) Period: N Day/s|Month/s|Year/s (dd/mm/yyyy - dd/mm/yyyy)";
 *     dates are DAY-FIRST;
 *   - one subscription per domain + plan (plan = the line's Item Name): the LATEST line wins,
 *     it is live when its period ends today or later, seats = its quantity;
 *   - the subscription's start date ("customer since") = the earliest start seen for that
 *     domain + plan;
 *   - an invoice whose custom field "New Business?" is Pro-rata ADDS its seats to that
 *     subscription (when it falls inside the current period) — it is not a new one;
 *   - custom field "Subs Period" One-Time (or no period at all) → not a subscription;
 *   - custom field "Service Expiry" only as a fallback when the line has no period (it
 *     disagrees with the line's own period on most invoices).
 * Money: monthlyRateFrom() from lib/export/subscription-portable.ts — the CSV importer's rule
 * (price for the period ÷ months, refused rather than guessed when the period is unknown).
 * Open invoices (balance > 0) follow R-1739: whole rupees, INR only, never GST / revenue.
 */
import { GST_STATE_BY_CODE, isValidGstin } from "@/lib/utils";
import { monthlyRateFrom, periodMonths } from "@/lib/export/subscription-portable";
import { buildImportDedupeIndex, duplicateReason, type TrackedSubscription } from "@/lib/subscriptions/import-dedupe";
import { planKey } from "@/lib/subscriptions/plan-match";
import { vendorFromPlanName } from "@/lib/provisioning/plan";
import { parsePlaceOfSupply, parseZohoDate } from "@/lib/import/zoho-opening-invoices";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import type { CustomerGstTreatment } from "@/lib/gst/customer-gst-treatment";

// ── What was read from Zoho (stored between the scan steps) ─────────────────────────────

export interface ZohoContactRec {
  zohoId: string;
  /** Zoho's display name — the name invoices carry. */
  name: string;
  gstin: string | null;
  /** Zoho's own code: business_gst, business_none, consumer, overseas, business_sez … */
  gstTreatment: string | null;
  /** Zoho's place_of_contact ("DL", "07" …). */
  placeOfContact: string | null;
  paymentTermsDays: number | null;
  email: string | null;
  phone: string | null;
  personName: string | null;
  /** "business" | "individual" */
  subType: string | null;
}

export interface ZohoLineRec {
  /** Item Name — the plan. */
  plan: string;
  quantity: number;
  /** Line total before tax (rate × qty − discount), when Zoho gave it. */
  itemTotal: number | null;
  rate: number | null;
  description: string;
}

export interface ZohoInvoiceRec {
  zohoId: string;
  number: string;
  date: string | null;
  dueDate: string | null;
  zohoCustomerId: string;
  customerName: string;
  status: string;
  total: number | null;
  balance: number | null;
  currency: string;
  gstin: string | null;
  placeOfSupply: string | null;
  /** Custom fields (raw text as Zoho shows it). */
  subsPeriod: string | null;
  newBusiness: string | null;
  serviceExpiry: string | null;
  /** Line items from the invoice detail; null = the detail was not read (outside the window). */
  lines: ZohoLineRec[] | null;
}

// ── Line description ────────────────────────────────────────────────────────────────────

export type PeriodUnit = "day" | "month" | "year";
export interface LinePeriod { n: number; unit: PeriodUnit; start: string; end: string }

const DOMAIN_RE = /Domain\s*Name\s*[:\-–]\s*(?:https?:\/\/)?([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,})/i;
const PERIOD_RE =
  /(?:Subscription|Validity)\s*Period\s*[:\-–]\s*(\d{1,4})\s*(Day|Month|Year)s?(?:\s*\/\s*s|\s*\(s\))?\s*\(\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\s*(?:-|–|to)\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\s*\)/i;

export function normDomain(v: string | null | undefined): string | null {
  const d = (v ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/.,;]+$/, "");
  return d || null;
}

/** "Domain Name: t-alpha.in Subscription Period: 1 Year/s (01/04/2026 - 31/03/2027)" → parts. */
export function parseLineDescription(desc: string | null | undefined): { domain: string | null; period: LinePeriod | null } {
  const text = (desc ?? "").replace(/\s+/g, " ");
  const domain = normDomain(DOMAIN_RE.exec(text)?.[1] ?? null);
  const m = PERIOD_RE.exec(text);
  let period: LinePeriod | null = null;
  if (m) {
    const start = parseZohoDate(m[3]);
    const end = parseZohoDate(m[4]);
    const n = Number(m[1]);
    if (start && end && end >= start && n > 0) period = { n, unit: m[2].toLowerCase() as PeriodUnit, start, end };
  }
  return { domain, period };
}

/** Months a period covers: 1 Year/s → 12, 3 Month/s → 3, 30 Day/s → 1. */
export function monthsOf(p: Pick<LinePeriod, "n" | "unit">): number {
  if (p.unit === "year") return 12 * p.n;
  if (p.unit === "month") return p.n;
  return Math.max(1, Math.round(p.n / 30.44));
}

export type Cycle = "monthly" | "quarterly" | "half_yearly" | "yearly";
/** Monthly vs annual from the period: 1 month → monthly, 12 months / 1 year → yearly. */
export function cycleOf(months: number): Cycle {
  if (months < 3) return "monthly";
  if (months < 6) return "quarterly";
  if (months < 12) return "half_yearly";
  return "yearly";
}

/** CF "Subs Period" text → months (fallback only), or "one_time". */
export function subsPeriodMonths(v: string | null | undefined): number | "one_time" | null {
  const t = (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!t) return null;
  if (t.includes("onetime") || t === "once") return "one_time";
  if (t.includes("halfyear") || t.includes("6month")) return 6;
  if (t.includes("quarter") || t.includes("3month")) return 3;
  if (t.includes("month")) return 1;
  if (t.includes("year") || t.includes("annual")) return 12;
  return null;
}

export const isProRata = (v: string | null | undefined) => /pro\s*[-_]?\s*rata/i.test(v ?? "");

// ── Customers ───────────────────────────────────────────────────────────────────────────

/** Zoho gst_treatment code → ours (R-1736). Unknown → null (the database picks from the GSTIN). */
export function mapGstTreatment(code: string | null | undefined): CustomerGstTreatment | null {
  switch ((code ?? "").trim().toLowerCase()) {
    case "business_gst":
    case "business_registered_regular":
    case "tax_deductor":
    case "tax_collector":
      return "registered_regular";
    case "business_registered_composition":
      return "registered_composition";
    case "business_none":
      return "unregistered_business";
    case "consumer":
      return "consumer";
    case "overseas":
      return "overseas";
    case "business_sez":
    case "sez_developer":
      return "sez_with_payment";
    case "deemed_export":
      return "deemed_export";
    default:
      return null;
  }
}

const NEEDS_GSTIN = new Set<CustomerGstTreatment>([
  "registered_regular", "registered_composition", "sez_with_payment", "sez_without_payment", "deemed_export",
]);

/** Same normalisation as the SQL: lower case, single spaces, trimmed. */
export const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export interface ExistingCustomer { id: string; name: string; gstin: string | null }

/** One customer row the Import sends (zoho_books_import_apply p_customers). */
export interface CustomerPayload {
  zoho_id: string;
  name: string;
  gstin: string | null;
  gst_treatment: CustomerGstTreatment | null;
  state: string | null;
  state_code: string | null;
  payment_terms_days: number | null;
  customer_type: "business" | "individual";
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  since: string | null;
}

export type CustomerMatch =
  | { kind: "new" }
  | { kind: "existing"; id: string; name: string; by: "gstin" | "name" }
  /** Created earlier in this same import (two Zoho contacts with one GSTIN / one name). */
  | { kind: "same_as"; zohoId: string; name: string; by: "gstin" | "name" }
  | { kind: "ambiguous"; reason: string };

// ── Problems ────────────────────────────────────────────────────────────────────────────

export type ProblemCode =
  | "unknown_plan" | "missing_gstin" | "invalid_gstin" | "no_period" | "no_domain"
  | "customer_not_found" | "ambiguous_customer" | "prorata_without_base" | "bad_seats" | "no_price"
  | "invoice_problem";

/** Not imported vs imported with a warning. */
export const PROBLEM_BLOCKS: Record<ProblemCode, boolean> = {
  unknown_plan: false, missing_gstin: false, invalid_gstin: false,
  no_period: true, no_domain: true, customer_not_found: true, ambiguous_customer: true,
  prorata_without_base: true, bad_seats: true, no_price: true, invoice_problem: true,
};

export const PROBLEM_LABEL: Record<ProblemCode, string> = {
  unknown_plan: "Plan not in your Items (imported with Zoho's item name)",
  missing_gstin: "Registered in Zoho but no GSTIN (imported as unregistered)",
  invalid_gstin: "GSTIN not valid (imported without it)",
  no_period: "Subscription line with no period (not imported)",
  no_domain: "Subscription line with no domain (not imported)",
  customer_not_found: "Customer not found (not imported)",
  ambiguous_customer: "More than one customer with that name or GSTIN (not imported)",
  prorata_without_base: "Pro-rata seats with no main subscription line (not imported)",
  bad_seats: "No seat quantity (not imported)",
  no_price: "No price on the line (not imported)",
  invoice_problem: "Open invoice that cannot be imported",
};

export interface Problem { code: ProblemCode; ref: string; message: string }

// ── Plan ────────────────────────────────────────────────────────────────────────────────

export interface SubscriptionPayload {
  zoho_customer_id: string;
  customer_name: string;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other";
  seats: number;
  mrr: number;
  start_date: string;
  renewal_date: string;
  domain: string;
  billing_cycle: Cycle;
  term_months: number;
  /** The Zoho invoice the current period came from. */
  source_invoice: string;
  prorata_seats: number;
  from_service_expiry: boolean;
}

export interface InvoicePayload {
  number: string;
  invoice_date: string;
  due_date: string;
  zoho_customer_id: string;
  total: number;
  balance: number;
  currency: string;
  gstin: string | null;
  pos_state_code: string | null;
}

export interface CatalogItem { name: string; vendor: string }

export interface PlanInput {
  contacts: readonly ZohoContactRec[];
  invoices: readonly ZohoInvoiceRec[];
  existingCustomers: readonly ExistingCustomer[];
  existingSubscriptions: readonly TrackedSubscription[];
  items: readonly CatalogItem[];
  /** Zoho invoice numbers already imported as opening invoices (upper-cased). */
  existingInvoiceNumbers: ReadonlySet<string>;
  /** YYYY-MM-DD (IST). */
  today: string;
  /** Subscriptions are read from invoices dated on/after this day (YYYY-MM-DD). */
  since: string;
}

export interface ImportPlan {
  /** The customers this import creates (shown in the dry run). */
  customers: CustomerPayload[];
  /** Every Zoho customer contact, in order — what the Import sends; the database matches again. */
  contactRows: CustomerPayload[];
  matches: Record<string, CustomerMatch>;
  subscriptions: SubscriptionPayload[];
  invoices: InvoicePayload[];
  problems: Problem[];
  counts: {
    contacts: number;
    customersNew: number;
    customersExisting: number;
    subscriptionsToImport: number;
    subscriptionsAlready: number;
    subscriptionsEnded: number;
    oneTimeInvoices: number;
    invoicesToImport: number;
    invoicesAlready: number;
  };
  totals: { mrr: number; openBalance: number };
}

const rupees = (n: number) => Math.round(n);

/** Match each Zoho contact to an existing customer: GSTIN first, then the exact name. */
function matchCustomers(contacts: readonly ZohoContactRec[], existing: readonly ExistingCustomer[]) {
  const byGstin = new Map<string, Array<{ id: string; name: string; zohoId?: string }>>();
  const byName = new Map<string, Array<{ id: string; name: string; zohoId?: string }>>();
  const add = (m: typeof byGstin, k: string, v: { id: string; name: string; zohoId?: string }) =>
    m.set(k, [...(m.get(k) ?? []), v]);
  for (const c of existing) {
    const g = (c.gstin ?? "").trim().toUpperCase();
    if (g) add(byGstin, g, { id: c.id, name: c.name });
    add(byName, normName(c.name), { id: c.id, name: c.name });
  }

  const matches: Record<string, CustomerMatch> = {};
  const customers: CustomerPayload[] = [];
  const contactRows: CustomerPayload[] = [];
  const problems: Problem[] = [];

  for (const c of contacts) {
    let gstin = (c.gstin ?? "").trim().toUpperCase() || null;
    if (gstin && !isValidGstin(gstin)) {
      problems.push({ code: "invalid_gstin", ref: c.name, message: `${c.name}: GSTIN ${gstin} is not valid — imported without it.` });
      gstin = null;
    }
    let treatment = mapGstTreatment(c.gstTreatment);
    if (treatment && NEEDS_GSTIN.has(treatment) && !gstin) {
      problems.push({ code: "missing_gstin", ref: c.name, message: `${c.name}: Zoho says ${c.gstTreatment} but there is no GSTIN — imported as unregistered. Add the GSTIN in Customers.` });
      treatment = null;
    }

    let match: CustomerMatch | null = null;
    if (gstin) {
      const hits = byGstin.get(gstin) ?? [];
      if (hits.length > 1) match = { kind: "ambiguous", reason: `${hits.length} customers have GSTIN ${gstin}` };
      else if (hits.length === 1) {
        const h = hits[0];
        match = h.zohoId ? { kind: "same_as", zohoId: h.zohoId, name: h.name, by: "gstin" } : { kind: "existing", id: h.id, name: h.name, by: "gstin" };
      }
    }
    if (!match) {
      const hits = byName.get(normName(c.name)) ?? [];
      if (hits.length > 1) match = { kind: "ambiguous", reason: `${hits.length} customers are named "${c.name}"` };
      else if (hits.length === 1) {
        const h = hits[0];
        match = h.zohoId ? { kind: "same_as", zohoId: h.zohoId, name: h.name, by: "name" } : { kind: "existing", id: h.id, name: h.name, by: "name" };
      }
    }
    if (match?.kind === "ambiguous") {
      problems.push({ code: "ambiguous_customer", ref: c.name, message: `${c.name}: ${match.reason}. Its subscriptions and invoices are not imported until one of them is fixed in Customers.` });
    }
    const stateCode = parsePlaceOfSupply(c.placeOfContact) ?? stateCodeFromGstin(gstin);
    const row: CustomerPayload = {
      zoho_id: c.zohoId,
      name: c.name.trim(),
      gstin,
      gst_treatment: treatment,
      state: stateCode ? (GST_STATE_BY_CODE[stateCode] ?? null) : null,
      state_code: stateCode,
      payment_terms_days: c.paymentTermsDays != null && c.paymentTermsDays >= 0 ? Math.round(c.paymentTermsDays) : null,
      customer_type: c.subType === "individual" ? "individual" : "business",
      contact_name: (c.personName ?? "").trim() || (c.email ? c.name.trim() : null),
      contact_email: (c.email ?? "").trim() || null,
      contact_phone: (c.phone ?? "").trim() || null,
      since: null,
    };
    /* Every contact goes to the database, in this order; the database repeats the matching. */
    contactRows.push(row);
    if (!match) {
      match = { kind: "new" };
      customers.push(row);
      const self = { id: `zoho:${c.zohoId}`, name: c.name, zohoId: c.zohoId };
      if (gstin) add(byGstin, gstin, self);
      add(byName, normName(c.name), self);
    }
    matches[c.zohoId] = match;
  }
  return { matches, customers, contactRows, problems };
}

interface Candidate {
  key: string;
  domain: string;
  plan: string;
  seats: number;
  perSeatPeriod: number | null;
  start: string;
  end: string;
  months: number;
  invoiceNumber: string;
  invoiceDate: string;
  zohoCustomerId: string;
  customerName: string;
  prorata: boolean;
  fromServiceExpiry: boolean;
}

export function buildImportPlan(input: PlanInput): ImportPlan {
  const { matches, customers, contactRows, problems } = matchCustomers(input.contacts, input.existingCustomers);
  const contactIds = new Set(input.contacts.map((c) => c.zohoId));

  /** Our customer id (or the "zoho:<id>" of one this import creates); null with a problem. */
  const resolve = (zohoCustomerId: string): { ok: true; key: string } | { ok: false; why: "missing" | "ambiguous" } => {
    if (!contactIds.has(zohoCustomerId)) return { ok: false, why: "missing" };
    const m = matches[zohoCustomerId];
    if (!m || m.kind === "ambiguous") return { ok: false, why: "ambiguous" };
    if (m.kind === "existing") return { ok: true, key: m.id };
    if (m.kind === "same_as") return { ok: true, key: `zoho:${m.zohoId}` };
    return { ok: true, key: `zoho:${zohoCustomerId}` };
  };

  // ── Subscription lines ──
  const candidates = new Map<string, Candidate[]>();
  let oneTimeInvoices = 0;
  for (const inv of input.invoices) {
    const status = inv.status.toLowerCase();
    if (status === "void" || status === "draft") continue;
    if (!inv.lines || !inv.date || inv.date < input.since) continue;
    const sp = subsPeriodMonths(inv.subsPeriod);
    if (sp === "one_time") { oneTimeInvoices++; continue; }
    const recurring = typeof sp === "number";
    for (const line of inv.lines) {
      const { domain, period } = parseLineDescription(line.description);
      if (!domain && !period && !recurring) continue; // an ordinary one-off line
      const ref = `${inv.number} · ${line.plan}`;
      if (!domain) {
        problems.push({ code: "no_domain", ref, message: `${ref}: the description has no "Domain Name:".` });
        continue;
      }
      let start: string | null = period?.start ?? null;
      let end: string | null = period?.end ?? null;
      let months: number | null = period ? monthsOf(period) : null;
      let fromServiceExpiry = false;
      if (!period) {
        /* Fallback only: Service Expiry, from the invoice date; months from Subs Period. */
        const exp = parseZohoDate(inv.serviceExpiry);
        if (exp && exp > inv.date) {
          start = inv.date;
          end = exp;
          months = typeof sp === "number" ? sp : periodMonths(start, end);
          fromServiceExpiry = true;
        }
      }
      if (!start || !end || !months) {
        problems.push({ code: "no_period", ref, message: `${ref} (${domain}): no "Subscription Period: … (dd/mm/yyyy - dd/mm/yyyy)" and no Service Expiry.` });
        continue;
      }
      const qty = Math.round(Number(line.quantity) || 0);
      const total = line.itemTotal != null && Number.isFinite(line.itemTotal) ? line.itemTotal : null;
      const perSeatPeriod = qty > 0 ? (total != null ? total / qty : line.rate) : null;
      const key = `${domain}|${planKey(line.plan)}`;
      const c: Candidate = {
        key, domain, plan: line.plan.trim(), seats: qty, perSeatPeriod, start, end, months,
        invoiceNumber: inv.number, invoiceDate: inv.date, zohoCustomerId: inv.zohoCustomerId,
        customerName: inv.customerName, prorata: isProRata(inv.newBusiness), fromServiceExpiry,
      };
      candidates.set(key, [...(candidates.get(key) ?? []), c]);
    }
  }

  const catalogByKey = new Map<string, CatalogItem[]>();
  for (const it of input.items) {
    const k = planKey(it.name);
    if (k) catalogByKey.set(k, [...(catalogByKey.get(k) ?? []), it]);
  }
  const dedupe = buildImportDedupeIndex(input.existingSubscriptions);

  const subscriptions: SubscriptionPayload[] = [];
  let subscriptionsAlready = 0, subscriptionsEnded = 0;
  const latestFirst = (a: Candidate, b: Candidate) =>
    b.start.localeCompare(a.start) || b.invoiceDate.localeCompare(a.invoiceDate) || b.invoiceNumber.localeCompare(a.invoiceNumber);

  for (const group of candidates.values()) {
    const bases = group.filter((c) => !c.prorata).sort(latestFirst);
    const base = bases[0];
    const ref = `${group[0].domain} · ${group[0].plan}`;
    if (!base) {
      const pr = [...group].sort(latestFirst)[0];
      if (pr.end >= input.today) {
        problems.push({ code: "prorata_without_base", ref, message: `${ref}: only pro-rata lines (${pr.invoiceNumber}) — the main subscription invoice is not in the period read.` });
      }
      continue;
    }
    if (base.end < input.today) { subscriptionsEnded++; continue; }

    const prorata = group.filter((c) => c.prorata && c.start >= base.start && c.start <= base.end && c.end >= input.today);
    const prorataSeats = prorata.reduce((s, c) => s + c.seats, 0);
    const seats = base.seats + prorataSeats;
    if (base.seats <= 0) {
      problems.push({ code: "bad_seats", ref, message: `${ref}: ${base.invoiceNumber} has no quantity.` });
      continue;
    }
    const rate = monthlyRateFrom(null, base.perSeatPeriod, seats, base.months);
    if (!rate.ok) {
      problems.push({ code: "no_price", ref, message: `${ref}: ${base.invoiceNumber} — ${rate.reason}.` });
      continue;
    }
    const cust = resolve(base.zohoCustomerId);
    if (!cust.ok) {
      problems.push(cust.why === "missing"
        ? { code: "customer_not_found", ref, message: `${ref}: customer "${base.customerName}" is not a customer contact in Zoho.` }
        : { code: "ambiguous_customer", ref, message: `${ref}: customer "${base.customerName}" matches more than one customer here.` });
      continue;
    }
    const already = cust.key.startsWith("zoho:") ? null
      : duplicateReason({ domain: base.domain, customer_id: cust.key, plan: base.plan }, dedupe);
    if (already) { subscriptionsAlready++; continue; }

    const items = catalogByKey.get(planKey(base.plan)) ?? [];
    if (items.length === 0) {
      problems.push({ code: "unknown_plan", ref, message: `${ref}: "${base.plan}" is not in your Items — imported with Zoho's name, not linked to an item.` });
    }
    const itemVendor = items.length === 1 ? items[0].vendor : null;
    const vendor = (itemVendor && ["google", "microsoft", "zoho"].includes(itemVendor) ? itemVendor : null)
      ?? vendorFromPlanName(base.plan) ?? "other";

    subscriptions.push({
      zoho_customer_id: base.zohoCustomerId,
      customer_name: base.customerName,
      plan: base.plan,
      vendor: vendor as SubscriptionPayload["vendor"],
      seats,
      mrr: rate.mrr,
      start_date: group.reduce((m, c) => (c.start < m ? c.start : m), base.start),
      renewal_date: base.end,
      domain: base.domain,
      billing_cycle: cycleOf(base.months),
      term_months: base.months,
      source_invoice: base.invoiceNumber,
      prorata_seats: prorataSeats,
      from_service_expiry: base.fromServiceExpiry,
    });
  }

  /* A new customer's "since" = the earliest start among the subscriptions it brings. */
  const sinceByZoho = new Map<string, string>();
  for (const s of subscriptions) {
    const r = resolve(s.zoho_customer_id);
    if (!r.ok || !r.key.startsWith("zoho:")) continue;
    const z = r.key.slice(5);
    const cur = sinceByZoho.get(z);
    if (!cur || s.start_date < cur) sinceByZoho.set(z, s.start_date);
  }
  for (const c of customers) c.since = sinceByZoho.get(c.zoho_id) ?? null;

  // ── Open invoices (R-1739 rules) ──
  const invoices: InvoicePayload[] = [];
  let invoicesAlready = 0;
  for (const inv of input.invoices) {
    const status = inv.status.toLowerCase();
    if (["void", "draft", "writtenoff", "written_off"].includes(status)) continue;
    if (inv.balance == null || inv.balance <= 0) continue;
    const ref = inv.number;
    if (input.existingInvoiceNumbers.has(inv.number.toUpperCase())) { invoicesAlready++; continue; }
    let problem: string | null = null;
    if (inv.total == null) problem = "no Total";
    else if (!inv.date) problem = "no invoice date";
    else if ((inv.currency || "INR").toUpperCase() !== "INR") problem = `in ${inv.currency} — only rupee (INR) invoices can be imported; record it by hand`;
    else if (inv.balance > inv.total) problem = `Balance ${inv.balance} is more than the Total ${inv.total}`;
    else if (inv.number.length > 40) problem = "the invoice number is longer than 40 characters";
    else if (rupees(inv.balance) <= 0) problem = "the Balance rounds to ₹0";
    if (problem) { problems.push({ code: "invoice_problem", ref, message: `${ref}: ${problem}.` }); continue; }
    const cust = resolve(inv.zohoCustomerId);
    if (!cust.ok) {
      problems.push(cust.why === "missing"
        ? { code: "customer_not_found", ref, message: `${ref}: customer "${inv.customerName}" is not a customer contact in Zoho.` }
        : { code: "ambiguous_customer", ref, message: `${ref}: customer "${inv.customerName}" matches more than one customer here.` });
      continue;
    }
    invoices.push({
      number: inv.number,
      invoice_date: inv.date!,
      due_date: inv.dueDate ?? inv.date!,
      zoho_customer_id: inv.zohoCustomerId,
      total: rupees(inv.total!),
      balance: rupees(inv.balance),
      currency: "INR",
      gstin: (inv.gstin ?? "").trim().toUpperCase() || null,
      pos_state_code: parsePlaceOfSupply(inv.placeOfSupply),
    });
  }

  const values = Object.values(matches);
  return {
    customers,
    contactRows,
    matches,
    subscriptions,
    invoices,
    problems,
    counts: {
      contacts: input.contacts.length,
      customersNew: customers.length,
      customersExisting: values.filter((m) => m.kind === "existing" || m.kind === "same_as").length,
      subscriptionsToImport: subscriptions.length,
      subscriptionsAlready,
      subscriptionsEnded,
      oneTimeInvoices,
      invoicesToImport: invoices.length,
      invoicesAlready,
    },
    totals: {
      mrr: subscriptions.reduce((s, x) => s + x.mrr, 0),
      openBalance: invoices.reduce((s, x) => s + x.balance, 0),
    },
  };
}

/** The dry run as the screen shows it: counts, totals, problems grouped (first 20 each). */
export function summarisePlan(plan: ImportPlan) {
  const groups = new Map<ProblemCode, Problem[]>();
  for (const p of plan.problems) groups.set(p.code, [...(groups.get(p.code) ?? []), p]);
  return {
    counts: plan.counts,
    totals: plan.totals,
    problems: [...groups.entries()].map(([code, list]) => ({
      code,
      label: PROBLEM_LABEL[code],
      blocks: PROBLEM_BLOCKS[code],
      count: list.length,
      examples: list.slice(0, 20).map((p) => p.message),
    })),
  };
}
export type PlanSummary = ReturnType<typeof summarisePlan>;
