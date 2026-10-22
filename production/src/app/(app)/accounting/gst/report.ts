/**
 * R-394: the GST report loader, shared by the GST page and the Accounting Overview tile
 * (moved here unchanged from page.tsx). One query key per range, so both screens read
 * the same cached rows; the math lives in ./cash-to-pay.ts.
 */
import { useQuery } from "@tanstack/react-query";

import { expenseGstHeads } from "@/lib/accounting/gst-heads";
import { gstPaidForPeriods } from "@/lib/accounting/tax-payments";
import { useTaxPayments } from "@/lib/queries/tax-payments";
import { splitItc, itcEligibility } from "@/lib/gst/itc";
import { billItcEligibility, splitBillItc, mergeItcSplits } from "@/lib/gst/bill-itc";
import { docGstRate, docHsnLines, type Advance, type HsnSourceLine } from "@/lib/gst/gstr1";
import { snapshotAdvanceGross, type AdvancePayment } from "@/lib/gst/advance-cash";
import { allocateInstalmentPayments, splitPaymentAdvances, type AdvancePortion, type InstalmentInvoice } from "@/lib/gst/instalment-advances";
import { isInterStateSupply, frozenParty } from "@/lib/gst/place-of-supply";
import { expenseHeadsByState, type Heads } from "@/lib/gst/gstr3b";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { isCreditNoteLate } from "@/lib/gst/credit-note-deadline";
import { istRangeUtc, type GstPeriod } from "@/lib/gst/periods";
import { toIstDate } from "@/lib/dates/ist";
import { isTaxInvoiceRow } from "@/lib/invoices/document-kind";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { onlySaleInvoices } from "@/lib/accounting/sale-documents";
import { gstCashHeadline, gstr3bFromReport, type GstReport, type InputRow, type OutputRow } from "./cash-to-pay";

type DateRange = GstPeriod;

type InstPayment = AdvancePayment & { quote_id: string | null };

/**
 * R-1611: the instalment invoices of the split-billed quotes this report touches — the quotes
 * of this period's payments (no invoice of their own) and the quotes behind this period's
 * instalment invoices — and their received payments matched to them oldest-first.
 * `portions`: payment id → its parts (11A side). `adjustedBy`: invoice id → the payment parts
 * it took (11B side). A quote with no raised instalment adds nothing (all advance, as before).
 */
async function loadInstalmentPortions(
  supabase: ReturnType<typeof createClient>,
  args: { payQuoteIds: string[]; periodInvoiceIds: string[]; quoteById: ReadonlyMap<string, { invoiceId: string | null }> },
): Promise<{ portions: Map<string, AdvancePortion[]>; adjustedBy: Map<string, { payment: InstPayment; gross: number }[]> }> {
  const portions = new Map<string, AdvancePortion[]>();
  const adjustedBy = new Map<string, { payment: InstPayment; gross: number }[]>();

  // Subscriptions behind those quotes and behind this period's instalment invoices.
  const subIds = new Set<string>();
  if (args.periodInvoiceIds.length) {
    const data = await fetchAllRowsIn(args.periodInvoiceIds, (run, from, to) => supabase.from("subscription_billings")
      .select("subscription_id").in("invoice_id", run).order("id", { ascending: true }).range(from, to));
    for (const b of data) subIds.add(b.subscription_id);
  }
  const subs: { id: string; quote_id: string | null }[] = [];
  if (args.payQuoteIds.length) {
    subs.push(...await fetchAllRowsIn(args.payQuoteIds, (run, from, to) => supabase.from("subscriptions")
      .select("id, quote_id").in("quote_id", run).order("id", { ascending: true }).range(from, to)));
  }
  const missing = [...subIds].filter((id) => !subs.some((s) => s.id === id));
  if (missing.length) {
    subs.push(...await fetchAllRowsIn(missing, (run, from, to) => supabase.from("subscriptions")
      .select("id, quote_id").in("id", run).order("id", { ascending: true }).range(from, to)));
  }
  // Only a quote with no invoice of its own is split-billed (record_instalment_payment refuses the rest).
  const quoteIds = Array.from(new Set(subs.map((s) => s.quote_id).filter((x): x is string => !!x)));
  const unknownQuotes = quoteIds.filter((id) => !args.quoteById.has(id));
  const ownInvoice = new Set(quoteIds.filter((id) => args.quoteById.get(id)?.invoiceId));
  if (unknownQuotes.length) {
    const data = await fetchAllRowsIn(unknownQuotes, (run, from, to) => supabase.from("quotes")
      .select("id, invoice_id").in("id", run).order("id", { ascending: true }).range(from, to));
    for (const q of data) if (q.invoice_id) ownInvoice.add(q.id);
  }
  const splitSubs = subs.filter((s) => s.quote_id && !ownInvoice.has(s.quote_id));
  if (!splitSubs.length) return { portions, adjustedBy };
  const quoteOfSub = new Map(splitSubs.map((s) => [s.id, s.quote_id as string]));

  const bills = await fetchAllRowsIn([...quoteOfSub.keys()], (run, from, to) => supabase.from("subscription_billings")
    .select("subscription_id, invoice_id, term_start, period_index")
    .in("subscription_id", run).not("invoice_id", "is", null)
    .order("id", { ascending: true }).range(from, to));
  const invIds = Array.from(new Set(bills.map((b) => b.invoice_id).filter((x): x is string => !!x)));
  const invById = new Map<string, { invoice_date: string; paid_amount: number | null; status: string }>();
  if (invIds.length) {
    const data = await fetchAllRowsIn(invIds, (run, from, to) => supabase.from("invoices")
      .select("id, invoice_date, paid_amount, status").in("id", run).order("id", { ascending: true }).range(from, to));
    for (const iv of data) invById.set(iv.id, iv);
  }
  const instByQuote = new Map<string, InstalmentInvoice[]>();
  const orderedBills = [...bills].sort((a, b) =>
    a.term_start.localeCompare(b.term_start) || a.period_index - b.period_index || (a.invoice_id ?? "").localeCompare(b.invoice_id ?? ""));
  for (const b of orderedBills) {
    const iv = b.invoice_id ? invById.get(b.invoice_id) : undefined;
    const quoteId = quoteOfSub.get(b.subscription_id);
    if (!iv || !quoteId || !["pending", "paid", "overdue"].includes(iv.status)) continue;
    const list = instByQuote.get(quoteId) ?? [];
    list.push({ id: b.invoice_id as string, invoiceDate: iv.invoice_date, applied: iv.paid_amount ?? 0 });
    instByQuote.set(quoteId, list);
  }
  if (!instByQuote.size) return { portions, adjustedBy };

  const qPays = await fetchAllRowsIn([...instByQuote.keys()], (run, from, to) => supabase.from("payments")
    .select("id, receipt_voucher_no, amount, credit_applied, received_at, quote_id")
    .eq("status", "received").in("quote_id", run)
    .order("id", { ascending: true }).range(from, to));
  for (const [quoteId, inst] of instByQuote) {
    const quotePays = qPays.filter((p) => p.quote_id === quoteId);
    const byId = new Map(quotePays.map((p) => [p.id, p]));
    for (const [payId, parts] of allocateInstalmentPayments(quotePays, inst)) {
      portions.set(payId, parts);
      const payment = byId.get(payId);
      for (const x of parts) {
        if (!x.invoiceId || !payment) continue;
        adjustedBy.set(x.invoiceId, [...(adjustedBy.get(x.invoiceId) ?? []), { payment, gross: x.gross }]);
      }
    }
  }
  return { portions, adjustedBy };
}

/**
 * R-1586: the whole report from one client — exported so the 1000-row-cap test can drive it
 * with a fake gateway. Every list read pages (fetchAllRows / fetchAllRowsIn); the maths below
 * is unchanged.
 */
export async function loadGstReport(supabase: ReturnType<typeof createClient>, range: DateRange): Promise<GstReport> {

  // ── Output: invoices issued in the period ─────────────────────
  /* R-1586: every list read below pages past the gateway's 1000-row cap (fetchAllRows /
     fetchAllRowsIn, order ending on id). A quarter with 1000+ invoices used to file short. */
  /* R-1739: onlySaleInvoices — an invoice imported from Zoho Books was filed from Zoho. */
  const issued = await fetchAllRows((from, to) => onlySaleInvoices(supabase
    .from("invoices")
    .select("id, amount, invoice_date, customer_name, customer_id, status, taxable_value, tax_amount, tax_rate, inter_state, line_items, adjusted_advances, customer_gstin, pos_state_code, customer_country, billing_address, seller_state_code, document_kind"))
    .gte("invoice_date", range.from)
    .lte("invoice_date", range.to)
    .in("status", ["pending", "paid", "overdue"])
    .order("id", { ascending: true })
    .range(from, to));
  /* R-1529: a Bill of Supply (unregistered / composition supplier) is in no GST return —
     not in GSTR-1, not in GST payable, not as an 11B advance adjustment. Tax Invoices only. */
  const invoices = issued.filter(isTaxInvoiceRow);

  // Credit / debit notes issued in the period — they NET the output tax (a
  // credit note reduces it, a debit note increases it), so GSTR-1/3B is right.
  const [creditNotes, debitNotes] = await Promise.all([
    fetchAllRows((from, to) => supabase.from("credit_notes")
      .select("id, invoice_id, credit_date, customer_name, customer_id, amount, taxable_value, tax_amount, tax_rate, inter_state")
      .gte("credit_date", range.from).lte("credit_date", range.to)
      .order("id", { ascending: true }).range(from, to)),
    fetchAllRows((from, to) => supabase.from("debit_notes")
      .select("id, invoice_id, debit_date, customer_name, customer_id, amount, taxable_value, tax_amount, tax_rate, inter_state")
      .gte("debit_date", range.from).lte("debit_date", range.to)
      .order("id", { ascending: true }).range(from, to)),
  ]);

  /* ── Advances received in the period (GSTR-1 Table 11A) ─────────────────
     Every quote payment gets a receipt voucher; it is an advance until the quote's
     invoice is issued. received_at is a timestamp, so the period is the IST day range. */
  const pays = await fetchAllRows((from, to) => supabase
    .from("payments")
    .select("id, receipt_voucher_no, amount, credit_applied, received_at, quote_id, customer_id")
    .eq("status", "received")
    .gte("received_at", istRangeUtc(range.from, range.to).fromUtc)
    .lt("received_at", istRangeUtc(range.from, range.to).toUtcExclusive)
    .order("id", { ascending: true })
    .range(from, to));
  const payQuoteIds = Array.from(new Set((pays ?? []).map((p) => p.quote_id).filter((x): x is string => !!x)));
  const quoteById = new Map<string, { invoiceId: string | null; rate: number | null; customerId: string | null }>();
  const invDateById = new Map<string, string>();
  if (payQuoteIds.length) {
    const qs = await fetchAllRowsIn(payQuoteIds, (run, from, to) => supabase.from("quotes")
      .select("id, invoice_id, tax_rate, customer_id").in("id", run).order("id", { ascending: true }).range(from, to));
    for (const q of qs) quoteById.set(q.id, { invoiceId: q.invoice_id ?? null, rate: q.tax_rate ?? null, customerId: q.customer_id ?? null });
    const invIds = Array.from(new Set(qs.map((q) => q.invoice_id).filter((x): x is string => !!x)));
    if (invIds.length) {
      const qInv = await fetchAllRowsIn(invIds, (run, from, to) => supabase.from("invoices")
        .select("id, invoice_date").in("id", run).order("id", { ascending: true }).range(from, to));
      for (const iv of qInv) invDateById.set(iv.id, iv.invoice_date);
    }
  }

  /* R-1611: a split-billed (instalment) subscription's quote has no invoice of its own — its
     instalment invoices link through subscription_billings.invoice_id (quote_id NULL). The
     money it received is matched to those invoices oldest-first (lib/gst/instalment-advances.ts):
     the part an instalment took is adjusted on that invoice's date, the rest stays an advance. */
  const inst = await loadInstalmentPortions(supabase, {
    payQuoteIds: payQuoteIds.filter((id) => !quoteById.get(id)?.invoiceId),
    periodInvoiceIds: invoices.map((i) => i.id),
    quoteById,
  });

  // Pull GSTIN / state / country from customers table (invoices + notes + advances)
  const customerIds = Array.from(new Set([
    ...(invoices ?? []).map((i) => i.customer_id),
    ...(creditNotes ?? []).map((n) => n.customer_id),
    ...(debitNotes ?? []).map((n) => n.customer_id),
    ...(pays ?? []).map((p) => p.customer_id ?? (p.quote_id ? quoteById.get(p.quote_id)?.customerId : null)),
  ].filter((x): x is string => !!x)));
  const custById = new Map<string, { gstin: string | null; stateCode: string | null; state: string | null; country: string | null }>();
  if (customerIds.length > 0) {
    const customers = await fetchAllRowsIn(customerIds, (run, from, to) => supabase
      .from("customers")
      .select("id, gstin, state_code, state, country")
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to));
    for (const c of customers) custById.set(c.id, { gstin: c.gstin ?? null, stateCode: c.state_code ?? null, state: c.state ?? null, country: c.country ?? null });
  }
  const custOf = (id: string | null | undefined) => (id ? custById.get(id) : undefined);
  /* R-043: an invoice's buyer as frozen at issue; a credit/debit note takes the
     buyer of the invoice it amends (filled below for parents outside the period). */
  type Snap = Parameters<typeof frozenParty>[0];
  const snapByInvoice = new Map<string, Snap>();
  for (const i of invoices ?? []) snapByInvoice.set(i.id, i);
  const partyOf = (inv: Snap, live: ReturnType<typeof custOf>) => frozenParty(inv, live);
  const noteParty = (invoiceId: string | null | undefined, live: ReturnType<typeof custOf>) =>
    frozenParty(invoiceId ? snapByInvoice.get(invoiceId) : null, live);

  // Seller's own state (place of supply for intra-state B2C). RLS scopes to own tenant.
  /* R-1581: a failed read must fail the report — a missing state code silently turns every
     intra-state sale into IGST (wrong CGST/SGST split on GSTR-1 / 3B). */
  const { data: tenantRow, error: tenantErr } = await supabase
    .from("tenants").select("state_code, state, gstin").limit(1).maybeSingle();
  if (tenantErr) throw tenantErr;
  const sellerStateCode = tenantRow?.state_code ?? null;
  const sellerState = tenantRow?.state ?? null;
  const sellerGstin = tenantRow?.gstin?.trim() || null;

  /* Per-line SAC for the HSN table (27 Sep 2026; R-067 1 Oct 2026). A line's OWN `hsn`
     wins (a project milestone line carries project_sales.sac_code, 998314); else the
     catalogue item's `hsn`; else the SaaS SAC — the same order the invoice printed.
     A note has no lines, so it is split like the invoice it amends (lineHsn/docHsnLines). */
  const linesOf = (raw: unknown): HsnSourceLine[] => (Array.isArray(raw) ? raw as HsnSourceLine[] : []);
  const linesByInvoice = new Map<string, HsnSourceLine[]>();
  for (const i of invoices ?? []) linesByInvoice.set(i.id, linesOf(i.line_items));
  // R-335: parent invoice dates, for the s.34 credit-note time limit.
  const invoiceDateById = new Map<string, string | null>();
  for (const i of invoices ?? []) invoiceDateById.set(i.id, i.invoice_date);
  const noteParentIds = Array.from(new Set([...(creditNotes ?? []), ...(debitNotes ?? [])]
    .map((n) => n.invoice_id).filter((x): x is string => !!x && !linesByInvoice.has(x))));
  if (noteParentIds.length) {
    const parents = await fetchAllRowsIn(noteParentIds, (run, from, to) => supabase.from("invoices")
      .select("id, invoice_date, line_items, customer_gstin, pos_state_code, customer_country, billing_address, seller_state_code")
      .in("id", run)
      .order("id", { ascending: true })
      .range(from, to));
    for (const iv of parents) { linesByInvoice.set(iv.id, linesOf(iv.line_items)); snapByInvoice.set(iv.id, iv); invoiceDateById.set(iv.id, iv.invoice_date); }
  }
  const itemIds = Array.from(new Set(Array.from(linesByInvoice.values()).flatMap((ls) => ls.map((l) => l.item_id)).filter((x): x is string => !!x)));
  const hsnByItem = new Map<string, string | null>();
  if (itemIds.length) {
    const items = await fetchAllRowsIn(itemIds, (run, from, to) => supabase.from("items")
      .select("id, hsn").in("id", run).order("id", { ascending: true }).range(from, to));
    for (const it of items) hsnByItem.set(it.id, it.hsn ?? null);
  }

  /* R-1131: an invoice's rate as filed — stored, else derived from its own tax ÷ taxable
     (lib/gst/gstr1.ts docGstRate); kept so its 11B advance adjustment uses the same rate. */
  const rateByInvoice = new Map<string, ReturnType<typeof docGstRate>>();
  const outputRows: OutputRow[] = (invoices ?? []).map((i) => {
    const amount       = i.amount ?? 0;
    const knownTax     = i.tax_amount ?? (i.taxable_value != null ? amount - i.taxable_value : null);
    const r            = docGstRate(i.tax_rate, i.taxable_value ?? (knownTax != null ? amount - knownTax : null), knownTax);
    rateByInvoice.set(i.id, r);
    const taxRate      = r.rate;
    // Prefer the breakdown persisted at issue time (migration 0116); fall
    // back to reverse-deriving at the row's rate for any legacy invoice.
    const taxableValue = i.taxable_value ?? Math.round(amount * 100 / (100 + taxRate));
    const gst          = i.tax_amount ?? (amount - taxableValue);
    const c = custOf(i.customer_id);
    /* R-043: the buyer as on the day of issue, frozen on the invoice — a later customer
       edit must not move a filed invoice between B2B / B2CL / B2CS. */
    const p = partyOf(i, c);
    return {
      invoiceId:     i.id,
      invoiceDate:   i.invoice_date,
      customerName:  i.customer_name ?? "—",
      customerGstin: p.gstin,
      customerStateCode: p.stateCode,
      customerState:     p.state,
      customerCountry:   p.country,
      amount,
      taxableValue,
      gst,
      taxRate,
      rateMissing:   r.rateMissing,
      interState:    i.inter_state ?? false,
      docType:       "invoice",
      lines:         docHsnLines(taxableValue, linesByInvoice.get(i.id), hsnByItem),
    };
  });

  // Notes as SIGNED output rows — credit note negative, debit note positive.
  const noteLines = (taxable: number, invoiceId: string | null | undefined) =>
    docHsnLines(taxable, invoiceId ? linesByInvoice.get(invoiceId) : null, hsnByItem);
  // R-1131: a note with no stored rate takes the rate its own tax ÷ taxable shows — never 18.
  const noteRate = (n: { tax_rate: number | null; taxable_value: number | null; tax_amount: number | null }) => {
    const r = docGstRate(n.tax_rate, n.taxable_value, n.tax_amount);
    return { taxRate: r.rate, rateMissing: r.rateMissing };
  };
  for (const n of creditNotes ?? []) {
    const c = noteParty(n.invoice_id, custOf(n.customer_id));
    outputRows.push({
      invoiceId: n.id, invoiceDate: n.credit_date, customerName: n.customer_name ?? "—",
      customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
      amount: -(n.amount ?? 0), taxableValue: -(n.taxable_value ?? 0), gst: -(n.tax_amount ?? 0),
      ...noteRate(n), interState: n.inter_state ?? false, docType: "credit_note",
      lateCreditNote: isCreditNoteLate(n.invoice_id ? invoiceDateById.get(n.invoice_id) : null, n.credit_date),
      lines: noteLines(-(n.taxable_value ?? 0), n.invoice_id),
    });
  }
  for (const n of debitNotes ?? []) {
    const c = noteParty(n.invoice_id, custOf(n.customer_id));
    outputRows.push({
      invoiceId: n.id, invoiceDate: n.debit_date, customerName: n.customer_name ?? "—",
      customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
      amount: n.amount ?? 0, taxableValue: n.taxable_value ?? 0, gst: n.tax_amount ?? 0,
      ...noteRate(n), interState: n.inter_state ?? false, docType: "debit_note",
      lines: noteLines(n.taxable_value ?? 0, n.invoice_id),
    });
  }
  outputRows.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

  /* Advances for 11A (received this period, from payments) and 11B (received earlier,
     adjusted on an invoice dated this period, from the invoice's frozen
     adjusted_advances snapshot). buildAdvances decides which table each lands in. */
  /* R-1565: an advance is the CASH that came in (amount − credit_applied). Credit applied to
     a payment was already an advance on the payment that created it — lib/gst/advance-cash.ts. */
  const advances: Advance[] = splitPaymentAdvances(pays ?? [], toIstDate, (p) => {
    const q = p.quote_id ? quoteById.get(p.quote_id) : undefined;
    const c = custOf(p.customer_id ?? q?.customerId);
    return {
      adjustedOn: q?.invoiceId ? invDateById.get(q.invoiceId) ?? null : null,
      /* R-1131: the quote's own rate; a quote with none is flagged, not taxed at 18%. */
      rate: q?.rate ?? 0, rateMissing: q?.rate == null,
      interState: isInterStateSupply(c?.stateCode ?? null, sellerStateCode, { customerGstin: c?.gstin ?? null, sellerGstin }),
      customerGstin: c?.gstin ?? null, customerStateCode: c?.stateCode ?? null, customerState: c?.state ?? null, customerCountry: c?.country ?? null,
    };
  }, (p) => inst.portions.get(p.id));
  /* 11B: the credit part of each adjusted advance (its payment's credit_applied). */
  const snapPayIds = Array.from(new Set((invoices ?? []).flatMap((i) =>
    (Array.isArray(i.adjusted_advances) ? i.adjusted_advances : [])
      .map((a) => a?.payment_id).filter((x): x is string => !!x))));
  const creditByPayment = new Map<string, number>();
  if (snapPayIds.length) {
    const credited = await fetchAllRowsIn(snapPayIds, (run, from, to) => supabase
      .from("payments").select("id, credit_applied").in("id", run).gt("credit_applied", 0)
      .order("id", { ascending: true }).range(from, to));
    for (const p of credited) creditByPayment.set(p.id, p.credit_applied);
  }
  for (const i of invoices ?? []) {
    const c = partyOf(i, custOf(i.customer_id));
    for (const a of Array.isArray(i.adjusted_advances) ? i.adjusted_advances : []) {
      if (!a?.received_at) continue;
      const receivedDate = toIstDate(a.received_at);
      if (receivedDate >= range.from) continue;   // same-period advance: already neither 11A nor 11B
      advances.push({
        paymentId: a.payment_id, voucherNo: a.voucher_no ?? null, receivedDate, adjustedOn: i.invoice_date,
        gross: snapshotAdvanceGross(a, creditByPayment), rate: rateByInvoice.get(i.id)?.rate ?? 0, rateMissing: rateByInvoice.get(i.id)?.rateMissing ?? true,
        interState: i.inter_state ?? false,
        customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
      });
    }
    /* R-1611 11B: money received before this period that this period's instalment invoice
       took (oldest-first match) — unless the invoice's own snapshot already lists it. */
    const snapIds = new Set((Array.isArray(i.adjusted_advances) ? i.adjusted_advances : []).map((a) => a?.payment_id));
    for (const x of inst.adjustedBy.get(i.id) ?? []) {
      const receivedDate = toIstDate(x.payment.received_at);
      if (receivedDate >= range.from || snapIds.has(x.payment.id)) continue;
      advances.push({
        paymentId: x.payment.id, voucherNo: x.payment.receipt_voucher_no ?? null, receivedDate, adjustedOn: i.invoice_date,
        gross: x.gross, rate: rateByInvoice.get(i.id)?.rate ?? 0, rateMissing: rateByInvoice.get(i.id)?.rateMissing ?? true,
        interState: i.inter_state ?? false,
        customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
      });
    }
  }

  // ── Input: vendor bills + GST-paying expenses ─────────────────
  const bills = await fetchAllRows((from, to) => supabase
    .from("vendor_bills")
    .select("id, bill_date, vendor_name, vendor_gstin, subtotal, cgst, sgst, igst, total, category, bill_no, document_type")
    .gte("bill_date", range.from)
    .lte("bill_date", range.to)
    .order("id", { ascending: true })
    .range(from, to));

  /* R-1576: bill ka GST bhi credit tabhi jab ho SAKTA hai — tax invoice, vendor GSTIN,
     sahi head (rajya), 17(5) nahi (lib/gst/bill-itc.ts). Pehle har bill seedha Input me
     jaata tha, proforma aur bina-GSTIN wala bhi. Jo credit nahi bana wo `blockedItc` me. */
  const ownStateCode = sellerStateCode ?? stateCodeFromGstin(sellerGstin);
  const billItcIn = (b: NonNullable<typeof bills>[number]) => ({ ...b, ownStateCode });
  const billSplit = splitBillItc((bills ?? []).map(billItcIn));
  const billBlocked17Heads: Heads[] = (bills ?? [])
    .filter((b) => (billItcEligibility(billItcIn(b)).reason ?? "").includes("17(5)"))
    .map((b) => ({ igst: b.igst ?? 0, cgst: b.cgst ?? 0, sgst: b.sgst ?? 0 }));

  /* Vendor bill me igst/cgst/sgst apne khaane me hote hain, isliye ye NAAPE hue hain. */
  const inputRowsBills: InputRow[] = (bills ?? []).filter((b) => billItcEligibility(billItcIn(b)).eligible).map((b) => ({
    assumed: false,
    source:       "bill",
    id:           b.id,
    billNo:       b.bill_no ?? null,
    date:         b.bill_date,
    vendor:       b.vendor_name,
    vendorGstin:  b.vendor_gstin ?? null,
    taxableValue: b.subtotal ?? 0,
    gst:          (b.cgst ?? 0) + (b.sgst ?? 0) + (b.igst ?? 0),
    igst:         b.igst ?? 0,
    cgst:         b.cgst ?? 0,
    sgst:         b.sgst ?? 0,
    category:     b.category ?? "",
  }));

  const expenses = await fetchAllRows((from, to) => supabase
    .from("expenses")
    .select("id, expense_date, vendor_name, vendor_id, bill_type, amount, gst_paid, igst, cgst, sgst, category, bill_no")
    .gte("expense_date", range.from)
    .lte("expense_date", range.to)
    .gt("gst_paid", 0)
    .order("id", { ascending: true })
    .range(from, to));

  /* Reverse charge (migration 20260927220000): the buyer's own IGST on imported services. */
  const rcmExp = await fetchAllRows((from, to) => supabase
    .from("expenses")
    .select("id, expense_date, vendor_name, amount, rcm_tax")
    .gte("expense_date", range.from).lte("expense_date", range.to).eq("rcm", true)
    .order("id", { ascending: true })
    .range(from, to));
  const rcmRows = rcmExp.map((e) => ({ id: e.id, vendor: e.vendor_name ?? "—", date: e.expense_date, amount: e.amount ?? 0, tax: e.rcm_tax ?? 0 }));

  /* ── Sirf wahi GST credit hai jo credit ho SAKTA hai (27 Sep 2026) ─────────
     Pehle har `gst_paid > 0` kharcha ITC mein jaata tha — kaccha bill, bina GSTIN wala
     vendor, staff ka khana sab. GSTR-2B mein wo kabhi nahi milte, aur 17(5) wale claim
     hi nahi ho sakte. Ab lib/gst/itc.ts tay karta hai; jo credit nahi bana wo
     `blockedItc` mein wajah ke saath dikhta hai. */
  // Only the vendors these expenses name — the map below is read for nothing else.
  const vendorRows = await fetchAllRowsIn(expenses.map((e) => e.vendor_id), (run, from, to) => supabase.from("vendors")
    .select("id, gstin").in("id", run).order("id", { ascending: true }).range(from, to));
  const vendorGstinOf = new Map(vendorRows.map((v) => [v.id, v.gstin ?? null]));
  const withGstin = (expenses ?? []).map((e) => ({ ...e, vendorGstin: e.vendor_id ? vendorGstinOf.get(e.vendor_id) ?? null : null }));
  const blockedItc = mergeItcSplits(splitItc(withGstin), billSplit);
  const claimable = withGstin.filter((e) => itcEligibility(e).eligible);
  /* R-258: a guessed split (no IGST/CGST on the bill) follows the vendor GSTIN's state —
     another state than ours means the vendor charged IGST, not CGST+SGST. */
  const headsOf = (e: (typeof withGstin)[number]) => {
    const h = expenseGstHeads(e);
    const vendorState = stateCodeFromGstin(e.vendorGstin);
    const heads = expenseHeadsByState(h, vendorState, ownStateCode);
    const byState = !h.measured && heads.igst > h.igst;
    return { ...heads, measured: h.measured, assumption: byState ? `Bill par batwara nahi tha — vendor GSTIN doosre rajya (${vendorState}) ka hai, isliye IGST maana gaya` : h.assumption };
  };
  /* s.17(5) blocked rows keep their heads: 3B wants them in 4(A)(5) and again in 4(B)(1). */
  const blocked17Heads: Heads[] = withGstin
    .filter((e) => (itcEligibility(e).reason ?? "").includes("17(5)"))
    .map((e) => { const h = headsOf(e); return { igst: h.igst, cgst: h.cgst, sgst: h.sgst }; })
    .concat(billBlocked17Heads);

  /* ── Ab MAANA nahi jata jab NAAPA hua maujood ho (29 Aug 2026) ──────────
     Yahan pehle har kharche par ye chalta tha:

         igst: 0,  cgst: Math.round(g / 2),  sgst: g - cgst

     Yaani har GST aadha-aadha CGST/SGST maan liya jata tha aur IGST hamesha shunya.
     Purana comment kehta tha ki ye "worksheet me flag" hoga — screen par dhoondha,
     koi flag nahi tha. Padhne wale ko kabhi pata nahi chalta tha ki ye aankda naapa
     hua hai ya maana hua.

     Aur wo maan-na aksar galat hi tha. Us din ka asli bill: Amazon ka seller UP me
     (GSTIN 09…), delivery Delhi (07…), Tax Type **IGST ₹274.42** — jise app CGST ₹137
     + SGST ₹137 bata rahi thi. GSTR-3B ke Table 4(A)(5) me wo alag column hai, aur
     GSTR-2B se mel nahi khata.

     Ab batwara `expenses` me hi rakha jata hai (migration 20260829180000), aur faisla
     `expenseGstHeads` karta hai — jahan bill se aaya ho wahan wahi, jahan na ho wahan
     maan kar bhi SAAF likh kar. */
  const inputRowsExpenses: InputRow[] = claimable.map((e) => {
    const g = e.gst_paid ?? 0;
    const h = headsOf(e);
    return {
      source:       "expense" as const,
      id:           e.id,
      billNo:       e.bill_no ?? null,
      date:         e.expense_date,
      vendor:       e.vendor_name ?? "—",
      vendorGstin:  e.vendorGstin,
      taxableValue: (e.amount ?? 0) - g,
      gst:          g,
      igst:         h.igst,
      cgst:         h.cgst,
      sgst:         h.sgst,
      assumed:      !h.measured,
      assumption:   h.assumption,
      category:     e.category ?? "Expense",
    };
  });

  const inputRows = [...inputRowsBills, ...inputRowsExpenses].sort(
    (a, b) => b.date.localeCompare(a.date),
  );

  // ── Totals ─────────────────────────────────────────────────────
  const outputTotal  = outputRows.reduce((s, r) => s + r.taxableValue, 0);
  const outputGST    = outputRows.reduce((s, r) => s + r.gst, 0);
  const inputTotal   = inputRows.reduce((s, r) => s + r.taxableValue, 0);
  const inputGST     = inputRows.reduce((s, r) => s + r.gst, 0);

  const lateCreditNotes = outputRows.filter((r) => r.lateCreditNote).length;

  // R-1131: documents/advances whose GST rate could not be stored or derived.
  const rateMissingDocs = outputRows.filter((r) => r.rateMissing).length + advances.filter((a) => a.rateMissing).length;

  return { outputRows, inputRows, outputTotal, outputGST, inputTotal, inputGST, blockedItc, blocked17Heads, rcmRows, sellerStateCode, sellerState, sellerGstin, advances, lateCreditNotes, rateMissingDocs };
}

export function useGstReport(range: DateRange) {
  return useQuery({
    queryKey: ["accounting", "gst", range],
    queryFn: (): Promise<GstReport> => loadGstReport(createClient(), range),
  });
}

/** GST paid for the range's return months (tax_payments). */
export function useGstPaidInRange(range: DateRange) {
  const q = useTaxPayments();
  return { ...q, paid: gstPaidForPeriods(q.data ?? [], range.from.slice(0, 7), range.to.slice(0, 7)) };
}

/**
 * The GST headline for a range — the Overview tile's whole source. The GST page builds the
 * same thing from the same two queries (it needs the rows too), via the same pure helpers.
 */
export function useGstCashToPay(range: DateRange) {
  const report = useGstReport(range);
  const paidQ = useGstPaidInRange(range);
  const g3b = report.data ? gstr3bFromReport(report.data, range) : null;
  return {
    headline: report.data ? gstCashHeadline(g3b, paidQ.paid) : null,
    isLoading: report.isLoading || paidQ.isLoading,
    isError: report.isError || paidQ.isError,
    refetch: () => { void report.refetch(); void paidQ.refetch(); },
  };
}
