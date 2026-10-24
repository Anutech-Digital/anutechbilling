/**
 * R-1838 — "This money is for:" on a money-in bank line.
 *
 * Pardeep (staging, 24 Oct): Reconcile → Create invoice asked only a product and a total — not
 * the seats, not the unit price, and not WHICH quote the money paid. A renewal payment, an
 * add-seats (pro-rata) payment and a new product's payment all became a one-off invoice beside
 * the subscription they were for.
 *
 * Now the operator says what the money is for, and the server path does the money work
 * (migration 20261024131600: record_desk_payment → generate_invoice → reconcile_bank_txn in one
 * transaction). This module is the pure part of the sheet — nothing here computes an invoice, a
 * subscription or a balance; the amounts due come from the database (bank_credit_open_items).
 *
 *   guessCustomer      — the payer, from the narration (nameOverlap) or a strong invoice match
 *   kindLabel          — "Renewal", "Add seats · pro-rata", …
 *   preselectItem      — the open item whose due equals the credit (or the credit + TDS)
 *   amountCheck        — exact / short (TDS? part payment) / over (extra → customer credit)
 *   saleLineFromItem   — a catalogue product → seats + unit price for the new-sale editor
 *   resultLines        — what happened, in the owner's words, after the save
 */
import { nameOverlap } from "@/lib/accounting/credit-match";
import { tdsRateFor } from "@/lib/banking/invoice-credit-match";
import { billingUnitOf, defaultQtyForUnit, isPerSeat } from "@/lib/catalog/billing-unit";
import { catalogLineListRate } from "@/lib/quotes/catalog-line";
import { addMonthsClamped } from "@/lib/billing/schedule";
import { rupee, formatDate } from "@/lib/utils";
import type { Item } from "@/lib/supabase/database.types";

/* ─── Open items (rows of bank_credit_open_items) ──────────────────────────────────────── */

export type OpenItemKind = "renewal" | "add_seats" | "new" | "one_off" | "invoice" | "instalment";

export interface OpenItem {
  kind: OpenItemKind;
  quote_id: string | null;
  invoice_id: string | null;
  doc_date: string;
  /** Whole rupees still owed — from the database, never recomputed here. */
  amount_due: number;
  /** Ex-GST value — the base TDS is deducted on. */
  taxable_value: number;
  /** A new sale whose payment would file subscription(s). */
  makes_subscription: boolean;
  subscription_id: string | null;
  plan: string | null;
  seats: number | null;
  renewal_date: string | null;
  lines: ReadonlyArray<{ name?: string | null; qty?: number | null; commitment?: string | null }> | null;
}

/** The key of an open item — an invoice when it has one, else its quote. */
export function itemKey(i: Pick<OpenItem, "quote_id" | "invoice_id">): string {
  return i.invoice_id ? `inv:${i.invoice_id}` : `q:${i.quote_id ?? ""}`;
}

export function kindLabel(kind: OpenItemKind): string {
  switch (kind) {
    case "renewal":    return "Renewal";
    case "add_seats":  return "Add seats · pro-rata";
    case "new":        return "New product";
    case "one_off":    return "One-time sale";
    case "instalment": return "Instalment invoice";
    default:           return "Invoice";
  }
}

/** One line under the row: what paying it does. */
export function itemDetail(i: OpenItem): string {
  const doc = i.invoice_id ?? i.quote_id ?? "";
  const plan = i.plan ? `${i.plan}${i.seats ? ` (${i.seats} seats)` : ""}` : "";
  switch (i.kind) {
    case "renewal":
      return `${doc} · ${plan || "subscription"}${i.renewal_date ? ` · renews ${formatDate(i.renewal_date)}` : ""}`;
    case "add_seats":
      return `${doc} · adds seats to ${plan || "the subscription"}`;
    case "new": {
      const first = i.lines?.[0]?.name ?? "";
      return `${doc}${first ? ` · ${first}` : ""}${i.makes_subscription ? " · starts a subscription" : ""}`;
    }
    default:
      return `${doc}${plan ? ` · ${plan}` : ""}`;
  }
}

/* ─── Customer guess ──────────────────────────────────────────────────────────────────── */

export interface CustomerLite { id: string; name: string }

export interface CustomerGuess { customerId: string; reason: string }

/**
 * Who paid. Only a single, unambiguous answer: a narration word shared with exactly ONE
 * customer's name, else the customer of a "certain" open-invoice match (name or invoice no. in
 * the narration AND the amount fits). Two customers sharing the word → no guess; the operator
 * picks. A wrong guess posts a receipt to the wrong customer, which is worse than no guess.
 */
export function guessCustomer(
  credit: { description: string | null },
  customers: readonly CustomerLite[],
  invoiceMatches: ReadonlyArray<{ customerName: string | null; confidence: string }> = [],
): CustomerGuess | null {
  const hits = customers
    .map((c) => ({ c, word: nameOverlap(credit.description, c.name) }))
    .filter((h): h is { c: CustomerLite; word: string } => h.word !== null);
  if (hits.length === 1) return { customerId: hits[0].c.id, reason: `the bank line says “${hits[0].word}”` };

  const certain = invoiceMatches.filter((m) => m.confidence === "certain");
  if (certain.length === 1 && certain[0].customerName) {
    const name = certain[0].customerName.trim().toLowerCase();
    const same = customers.filter((c) => c.name.trim().toLowerCase() === name);
    if (same.length === 1) return { customerId: same[0].id, reason: "an open invoice matches this payment" };
  }
  return null;
}

/* ─── Pre-selection + amount check ────────────────────────────────────────────────────── */

/**
 * The item to tick for the operator: the ONE whose due equals the credit to the rupee, else the
 * ONE that the credit pays less a common TDS rate. Two candidates → none (the operator picks).
 */
export function preselectItem(items: readonly OpenItem[], credit: number): OpenItem | null {
  const exact = items.filter((i) => i.amount_due === credit);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const tds = items.filter((i) => tdsRateFor(credit, i.amount_due, i.taxable_value || null) !== null);
  return tds.length === 1 ? tds[0] : null;
}

export type AmountCheck =
  | { kind: "exact" }
  /** Credit is less than due. `tdsRatePct` when the gap looks like TDS on the taxable value. */
  | { kind: "short"; shortBy: number; tdsRatePct: number | null }
  /** Credit is more than due — record_payment keeps the extra as customer credit. */
  | { kind: "over"; overBy: number };

export function amountCheck(credit: number, due: number, taxable: number | null): AmountCheck {
  if (credit === due) return { kind: "exact" };
  if (credit > due) return { kind: "over", overBy: credit - due };
  return { kind: "short", shortBy: due - credit, tdsRatePct: tdsRateFor(credit, due, taxable && taxable > 0 ? taxable : null) };
}

/** What the operator decided about a short payment. */
export type ShortChoice = "tds" | "part";

/** The TDS amount to send: the whole shortfall when the operator says it was TDS, else 0. */
export function tdsToRecord(check: AmountCheck, choice: ShortChoice): number {
  return check.kind === "short" && choice === "tds" ? check.shortBy : 0;
}

/** The TDS rate % to store with it — the rate that explains the gap, else the gap ÷ taxable. */
export function tdsRateToRecord(check: AmountCheck, taxable: number): number | null {
  if (check.kind !== "short") return null;
  if (check.tdsRatePct !== null) return check.tdsRatePct;
  return taxable > 0 ? Math.round((check.shortBy / taxable) * 10000) / 100 : null;
}

/* ─── New sale ───────────────────────────────────────────────────────────────────────── */

export type SaleCycle = "annual_yearly" | "monthly" | "one_time";

export interface SaleLine {
  itemId: string | null;
  name: string;
  /** Seats for a per-seat product, else quantity. */
  qty: number;
  /** ₹ per seat (unit) for the term: a year (annual), a month (monthly), or once (one-time). */
  rate: number;
  cost: number;
  cycle: SaleCycle;
  perSeat: boolean;
}

type CatalogRow = Pick<Item, "id" | "name" | "vendor" | "msrp" | "wholesale" | "prices"> & { item_type?: string | null };

/** The cycle a catalogue product starts on: one-time items once, everything else annual. */
export function defaultCycle(it: CatalogRow): SaleCycle {
  return billingUnitOf(it) === "one_time" ? "one_time" : "annual_yearly";
}

/** A catalogue product → a sale line priced the way the quote builder prices it. */
export function saleLineFromItem(it: CatalogRow, cycle: SaleCycle = defaultCycle(it), seats?: number | null): SaleLine {
  const unit = billingUnitOf(it);
  const p = catalogLineListRate(it, cycle === "one_time" ? null : cycle);
  return {
    itemId: it.id,
    name: it.name,
    qty: defaultQtyForUnit(unit, seats ?? null),
    rate: Math.round(p.rate),
    cost: Math.round(p.cost),
    cycle,
    perSeat: isPerSeat(unit),
  };
}

/** Change the cycle of a catalogue line: re-price it from the catalogue for that term. */
export function repriceLine(line: SaleLine, it: CatalogRow | undefined, cycle: SaleCycle): SaleLine {
  if (!it) return { ...line, cycle };
  const p = catalogLineListRate(it, cycle === "one_time" ? null : cycle);
  return { ...line, cycle, rate: Math.round(p.rate), cost: Math.round(p.cost) };
}

/**
 * The preview the editor shows before saving: qty × rate, GST at the rate the server will use
 * (18, or 0 for an export customer / a Bill of Supply). Display only — the server computes the
 * quote with create_direct_invoice's rule and the result shows ITS total.
 */
export function salePreview(lines: readonly SaleLine[], gstRatePct: number): { taxable: number; gst: number; total: number } {
  const taxable = lines.reduce((s, l) => s + Math.max(0, Math.round(l.qty)) * Math.max(0, Math.round(l.rate)), 0);
  const gst = Math.round((taxable * gstRatePct) / 100);
  return { taxable, gst, total: taxable + gst };
}

export function saleMakesSubscription(lines: readonly SaleLine[]): boolean {
  return lines.some((l) => l.cycle !== "one_time");
}

export function rateSuffix(line: Pick<SaleLine, "cycle" | "perSeat">): string {
  const per = line.perSeat ? "/seat" : "";
  return line.cycle === "monthly" ? `${per}/month` : line.cycle === "annual_yearly" ? `${per}/year` : " once";
}

/** The RPC's p_lines. */
export function saleLinesPayload(lines: readonly SaleLine[]) {
  return lines.map((l, i) => ({
    id: `line-${i + 1}`,
    item_id: l.itemId,
    name: l.name.trim(),
    qty: Math.round(l.qty),
    rate: Math.round(l.rate),
    cost: Math.round(l.cost),
    commitment: l.cycle,
  }));
}

/** Mixed monthly + annual on one sale is refused by the server (one quote = one billing term). */
export function saleTermsMixed(lines: readonly SaleLine[]): boolean {
  return lines.some((l) => l.cycle === "monthly") && lines.some((l) => l.cycle === "annual_yearly");
}

/* ─── Subscription dates ─────────────────────────────────────────────────────────────── */

/** The renewal date record_payment would file: start + 1 month (monthly) or + 1 year. */
export function defaultRenewal(startISO: string, monthly: boolean): string {
  return addMonthsClamped(startISO, monthly ? 1 : 12);
}

/** Is a quote's subscription monthly? (its lines say so) */
export function linesAreMonthly(lines: OpenItem["lines"]): boolean {
  return (lines ?? []).some((l) => l?.commitment === "monthly");
}

/* ─── Result ─────────────────────────────────────────────────────────────────────────── */

export interface PayForResult {
  /** "advance" — R-1863: booked as the customer's advance (on account), nothing invoiced. */
  kind: OpenItemKind | "advance";
  quote_id: string | null;
  invoice_id: string | null;
  invoice_issued: string | null;
  payment_id: string;
  receipt_voucher_no: string | null;
  amount: number;
  tds_amount: number;
  outstanding: number;
  is_fully_paid: boolean;
  overpaid_credit: number;
  renewal_rolled_forward: boolean;
  subscription_skipped: boolean;
  already_recorded: boolean;
  subscriptions: Array<{ id: string; plan: string | null; seats: number | null; start_date: string | null; renewal_date: string | null; billing_cycle: string | null }>;
  new_quote?: boolean;
  quote_total?: number;
  /* R-1863 advance */
  advance_credit?: number;
  customer_id?: string | null;
  customer_name?: string | null;
  /* R-1863 relink of an old one-off bank sale */
  relinked_from_quote?: string | null;
  relinked_from_invoice?: string | null;
  old_invoice_credited?: string | null;
  old_invoice_voided?: string | null;
  old_credit_note_id?: string | null;
}

export interface ResultLine { text: string; href?: string; tone?: "ok" | "warn" }

/** R-1863: the after-save line for an advance (Pardeep's wording, card R-1863). */
export function advanceMessage(amount: number, customerName: string): string {
  return `${rupee(amount)} kept as advance for ${customerName} — it will be offered when you record their next payment`;
}

/** "Renewal of Google Workspace (15 seats) paid → subscription renewed to 24 Oct 2027", etc. */
export function resultLines(r: PayForResult): ResultLine[] {
  const out: ResultLine[] = [];
  const sub = r.subscriptions[0];
  const subName = sub ? `${sub.plan ?? "subscription"}${sub.seats ? ` (${sub.seats} seats)` : ""}` : "";
  const quoteHref = r.quote_id ? `/quotes/${encodeURIComponent(r.quote_id)}` : undefined;

  /* R-1863: a relink first says what happened to the old one-off sale. */
  if (r.relinked_from_quote) {
    out.push({
      text: r.old_invoice_credited
        ? `Old one-off sale ${r.relinked_from_quote} undone — invoice ${r.old_invoice_credited} reversed by credit note ${r.old_credit_note_id ?? ""}`.trim()
        : r.old_invoice_voided
          ? `Old one-off sale ${r.relinked_from_quote} undone — draft invoice ${r.old_invoice_voided} voided`
          : `Old one-off sale ${r.relinked_from_quote} undone`,
      href: r.old_invoice_credited ? `/invoices/${encodeURIComponent(r.old_invoice_credited)}` : undefined,
    });
  }

  if (r.kind === "advance") {
    out.push({
      text: advanceMessage(r.advance_credit ?? r.amount, r.customer_name ?? "the customer"),
      href: r.customer_id ? `/customers/${encodeURIComponent(r.customer_id)}` : undefined,
    });
    if (r.receipt_voucher_no) out.push({ text: `Receipt voucher ${r.receipt_voucher_no}` });
    return out;
  }

  if (r.already_recorded) {
    out.push({ text: `This payment was already recorded on ${r.quote_id ?? r.invoice_id} — the bank line is now matched to it.`, href: quoteHref });
  } else if (r.kind === "renewal") {
    out.push({
      text: r.renewal_rolled_forward && sub?.renewal_date
        ? `Renewal of ${subName} paid → subscription renewed to ${formatDate(sub.renewal_date)}`
        : `${rupee(r.amount)} recorded on renewal quote ${r.quote_id} — the subscription renews when it is fully paid`,
      href: quoteHref,
    });
  } else if (r.kind === "add_seats") {
    out.push({ text: `Add-seats payment recorded${sub ? ` → ${subName}` : ""}`, href: quoteHref });
  } else if (r.kind === "instalment") {
    out.push({ text: `Instalment ${r.invoice_id} paid${sub ? ` · ${subName}` : ""}` });
  } else {
    out.push({ text: `${rupee(r.amount)} recorded on ${r.new_quote ? "new sale" : "quote"} ${r.quote_id}`, href: quoteHref });
    for (const s of r.subscriptions) {
      out.push({
        text: `Subscription created: ${s.plan ?? "plan"} × ${s.seats ?? 0}${s.renewal_date ? `, renews ${formatDate(s.renewal_date)}` : ""}`,
        href: "/subscriptions",
      });
    }
    if (r.subscription_skipped) {
      out.push({ text: "No subscription created for this paid quote — create it from the quote when needed.", href: quoteHref, tone: "warn" });
    }
  }

  if (r.invoice_issued) out.push({ text: `Invoice ${r.invoice_issued} issued`, href: `/invoices/${encodeURIComponent(r.invoice_issued)}` });
  else if (r.invoice_id && r.kind !== "instalment") out.push({ text: `Invoice ${r.invoice_id}`, href: `/invoices/${encodeURIComponent(r.invoice_id)}` });
  if (r.tds_amount > 0) out.push({ text: `${rupee(r.tds_amount)} TDS booked as TDS receivable — collect the certificate (Form 16A)` });
  if (r.outstanding > 0 && !r.already_recorded) out.push({ text: `${rupee(r.outstanding)} still due on it`, tone: "warn" });
  if (r.overpaid_credit > 0) out.push({ text: `${rupee(r.overpaid_credit)} extra kept as the customer's advance credit` });
  return out;
}

/* ─── R-1863: old one-off bank sales (booked before R-1838) and their relink ─────────────── */

/** A row of bank_old_one_off_bookings. */
export interface OldOneOffBooking {
  txn_id: string;
  txn_date: string;
  amount: number;
  description: string | null;
  payment_id: string;
  receipt_voucher_no: string | null;
  received_on: string;
  quote_id: string;
  customer_id: string | null;
  customer_name: string | null;
  product: string | null;
  invoice_id: string | null;
  invoice_status: string | null;
  invoice_date: string | null;
  invoice_amount: number;
  /** Why it cannot be relinked from the bank page (null = it can). */
  blocker: "books_locked" | "other_receipts" | "invoice_notes" | null;
}

/** "What will happen" — shown before the operator confirms a relink. Mirrors relink_bank_one_off_sale. */
export function relinkSteps(b: OldOneOffBooking): string[] {
  const steps: string[] = [];
  if (b.invoice_id && b.invoice_status === "draft") {
    steps.push(`Draft invoice ${b.invoice_id} is voided.`);
  } else if (b.invoice_id && b.invoice_status !== "void") {
    steps.push(`Invoice ${b.invoice_id} (${rupee(b.invoice_amount)}${b.invoice_date ? `, ${formatDate(b.invoice_date)}` : ""}) gets a full credit note (GST section 34). It stays in your records with nothing due.`);
  }
  steps.push(`The old receipt${b.receipt_voucher_no ? ` ${b.receipt_voucher_no}` : ""} and one-off quote ${b.quote_id} are removed (the voucher number is kept as cancelled).`);
  steps.push(`${rupee(b.amount)} is then recorded on what you pick below — all in one step, or nothing changes.`);
  return steps;
}

/** The blocker in the owner's words, with where to fix it (§24). */
export function relinkBlocker(b: OldOneOffBooking): { text: string; href: string; action: string } | null {
  switch (b.blocker) {
    case "books_locked":
      return {
        text: `The books are locked over this receipt (${formatDate(b.received_on)})${b.invoice_id ? ` or invoice ${b.invoice_id}` : ""}. Unlock the month, relink, then lock it again.`,
        href: "/accounting/close", action: "Open Close month",
      };
    case "other_receipts":
      return { text: `Quote ${b.quote_id} has other receipts too, so it cannot be undone from the bank line.`, href: `/quotes/${encodeURIComponent(b.quote_id)}`, action: "Open quote" };
    case "invoice_notes":
      return {
        text: `Invoice ${b.invoice_id ?? ""} already has a credit / debit note or TDS entry — settle it from the invoice.`,
        href: `/invoices/${encodeURIComponent(b.invoice_id ?? "")}`, action: "Open invoice",
      };
    default:
      return null;
  }
}
