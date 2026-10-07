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
import { docHsnLines, type Advance, type HsnSourceLine } from "@/lib/gst/gstr1";
import { isInterStateSupply, frozenParty } from "@/lib/gst/place-of-supply";
import { expenseHeadsByState, type Heads } from "@/lib/gst/gstr3b";
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { isCreditNoteLate } from "@/lib/gst/credit-note-deadline";
import { istRangeUtc, type GstPeriod } from "@/lib/gst/periods";
import { toIstDate } from "@/lib/dates/ist";
import { createClient } from "@/lib/supabase/client";
import { gstCashHeadline, gstr3bFromReport, type GstReport, type InputRow, type OutputRow } from "./cash-to-pay";

type DateRange = GstPeriod;

export function useGstReport(range: DateRange) {
  return useQuery({
    queryKey: ["accounting", "gst", range],
    queryFn: async (): Promise<GstReport> => {
      const supabase = createClient();

      // ── Output: invoices issued in the period ─────────────────────
      const { data: invoices, error: invErr } = await supabase
        .from("invoices")
        .select("id, amount, invoice_date, customer_name, customer_id, status, taxable_value, tax_amount, tax_rate, inter_state, line_items, adjusted_advances, customer_gstin, pos_state_code, customer_country, billing_address, seller_state_code")
        .gte("invoice_date", range.from)
        .lte("invoice_date", range.to)
        .in("status", ["pending", "paid", "overdue"]);
      if (invErr) throw invErr;

      // Credit / debit notes issued in the period — they NET the output tax (a
      // credit note reduces it, a debit note increases it), so GSTR-1/3B is right.
      const [{ data: creditNotes }, { data: debitNotes }] = await Promise.all([
        supabase.from("credit_notes")
          .select("id, invoice_id, credit_date, customer_name, customer_id, amount, taxable_value, tax_amount, tax_rate, inter_state")
          .gte("credit_date", range.from).lte("credit_date", range.to),
        supabase.from("debit_notes")
          .select("id, invoice_id, debit_date, customer_name, customer_id, amount, taxable_value, tax_amount, tax_rate, inter_state")
          .gte("debit_date", range.from).lte("debit_date", range.to),
      ]);

      /* ── Advances received in the period (GSTR-1 Table 11A) ─────────────────
         Every quote payment gets a receipt voucher; it is an advance until the quote's
         invoice is issued. received_at is a timestamp, so the period is the IST day range. */
      const { data: pays } = await supabase
        .from("payments")
        .select("id, receipt_voucher_no, amount, received_at, quote_id, customer_id")
        .eq("status", "received")
        .gte("received_at", istRangeUtc(range.from, range.to).fromUtc)
        .lt("received_at", istRangeUtc(range.from, range.to).toUtcExclusive);
      const payQuoteIds = Array.from(new Set((pays ?? []).map((p) => p.quote_id).filter((x): x is string => !!x)));
      const quoteById = new Map<string, { invoiceId: string | null; rate: number | null; customerId: string | null }>();
      const invDateById = new Map<string, string>();
      if (payQuoteIds.length) {
        const { data: qs } = await supabase.from("quotes").select("id, invoice_id, tax_rate, customer_id").in("id", payQuoteIds);
        for (const q of qs ?? []) quoteById.set(q.id, { invoiceId: q.invoice_id ?? null, rate: q.tax_rate ?? null, customerId: q.customer_id ?? null });
        const invIds = Array.from(new Set((qs ?? []).map((q) => q.invoice_id).filter((x): x is string => !!x)));
        if (invIds.length) {
          const { data: qInv } = await supabase.from("invoices").select("id, invoice_date").in("id", invIds);
          for (const iv of qInv ?? []) invDateById.set(iv.id, iv.invoice_date);
        }
      }

      // Pull GSTIN / state / country from customers table (invoices + notes + advances)
      const customerIds = Array.from(new Set([
        ...(invoices ?? []).map((i) => i.customer_id),
        ...(creditNotes ?? []).map((n) => n.customer_id),
        ...(debitNotes ?? []).map((n) => n.customer_id),
        ...(pays ?? []).map((p) => p.customer_id ?? (p.quote_id ? quoteById.get(p.quote_id)?.customerId : null)),
      ].filter((x): x is string => !!x)));
      const custById = new Map<string, { gstin: string | null; stateCode: string | null; state: string | null; country: string | null }>();
      if (customerIds.length > 0) {
        const { data: customers } = await supabase
          .from("customers")
          .select("id, gstin, state_code, state, country")
          .in("id", customerIds);
        for (const c of customers ?? []) custById.set(c.id, { gstin: c.gstin ?? null, stateCode: c.state_code ?? null, state: c.state ?? null, country: c.country ?? null });
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
      const { data: tenantRow } = await supabase
        .from("tenants").select("state_code, state, gstin").limit(1).maybeSingle();
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
        const { data: parents } = await supabase.from("invoices")
          .select("id, invoice_date, line_items, customer_gstin, pos_state_code, customer_country, billing_address, seller_state_code")
          .in("id", noteParentIds);
        for (const iv of parents ?? []) { linesByInvoice.set(iv.id, linesOf(iv.line_items)); snapByInvoice.set(iv.id, iv); invoiceDateById.set(iv.id, iv.invoice_date); }
      }
      const itemIds = Array.from(new Set(Array.from(linesByInvoice.values()).flatMap((ls) => ls.map((l) => l.item_id)).filter((x): x is string => !!x)));
      const hsnByItem = new Map<string, string | null>();
      if (itemIds.length) {
        const { data: items } = await supabase.from("items").select("id, hsn").in("id", itemIds);
        for (const it of items ?? []) hsnByItem.set(it.id, it.hsn ?? null);
      }

      const outputRows: OutputRow[] = (invoices ?? []).map((i) => {
        const amount       = i.amount ?? 0;
        const taxRate      = i.tax_rate ?? 18;
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
          interState:    i.inter_state ?? false,
          docType:       "invoice",
          lines:         docHsnLines(taxableValue, linesByInvoice.get(i.id), hsnByItem),
        };
      });

      // Notes as SIGNED output rows — credit note negative, debit note positive.
      const noteLines = (taxable: number, invoiceId: string | null | undefined) =>
        docHsnLines(taxable, invoiceId ? linesByInvoice.get(invoiceId) : null, hsnByItem);
      for (const n of creditNotes ?? []) {
        const c = noteParty(n.invoice_id, custOf(n.customer_id));
        outputRows.push({
          invoiceId: n.id, invoiceDate: n.credit_date, customerName: n.customer_name ?? "—",
          customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
          amount: -(n.amount ?? 0), taxableValue: -(n.taxable_value ?? 0), gst: -(n.tax_amount ?? 0),
          taxRate: n.tax_rate ?? 18, interState: n.inter_state ?? false, docType: "credit_note",
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
          taxRate: n.tax_rate ?? 18, interState: n.inter_state ?? false, docType: "debit_note",
          lines: noteLines(n.taxable_value ?? 0, n.invoice_id),
        });
      }
      outputRows.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

      /* Advances for 11A (received this period, from payments) and 11B (received earlier,
         adjusted on an invoice dated this period, from the invoice's frozen
         adjusted_advances snapshot). buildAdvances decides which table each lands in. */
      const advances: Advance[] = [];
      for (const p of pays ?? []) {
        const q = p.quote_id ? quoteById.get(p.quote_id) : undefined;
        const c = custOf(p.customer_id ?? q?.customerId);
        advances.push({
          paymentId: p.id, voucherNo: p.receipt_voucher_no ?? null,
          receivedDate: toIstDate(p.received_at),
          adjustedOn: q?.invoiceId ? invDateById.get(q.invoiceId) ?? null : null,
          gross: p.amount ?? 0, rate: q?.rate ?? 18,
          interState: isInterStateSupply(c?.stateCode ?? null, sellerStateCode, { customerGstin: c?.gstin ?? null, sellerGstin }),
          customerGstin: c?.gstin ?? null, customerStateCode: c?.stateCode ?? null, customerState: c?.state ?? null, customerCountry: c?.country ?? null,
        });
      }
      for (const i of invoices ?? []) {
        const c = partyOf(i, custOf(i.customer_id));
        for (const a of Array.isArray(i.adjusted_advances) ? i.adjusted_advances : []) {
          if (!a?.received_at) continue;
          const receivedDate = toIstDate(a.received_at);
          if (receivedDate >= range.from) continue;   // same-period advance: already neither 11A nor 11B
          advances.push({
            paymentId: a.payment_id, voucherNo: a.voucher_no ?? null, receivedDate, adjustedOn: i.invoice_date,
            gross: a.amount ?? 0, rate: i.tax_rate ?? 18, interState: i.inter_state ?? false,
            customerGstin: c.gstin, customerStateCode: c.stateCode, customerState: c.state, customerCountry: c.country,
          });
        }
      }

      // ── Input: vendor bills + GST-paying expenses ─────────────────
      const { data: bills } = await supabase
        .from("vendor_bills")
        .select("id, bill_date, vendor_name, vendor_gstin, subtotal, cgst, sgst, igst, total, category, bill_no")
        .gte("bill_date", range.from)
        .lte("bill_date", range.to);

      /* Vendor bill me igst/cgst/sgst apne khaane me hote hain, isliye ye NAAPE hue hain. */
      const inputRowsBills: InputRow[] = (bills ?? []).map((b) => ({
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

      const { data: expenses } = await supabase
        .from("expenses")
        .select("id, expense_date, vendor_name, vendor_id, bill_type, amount, gst_paid, igst, cgst, sgst, category, bill_no")
        .gte("expense_date", range.from)
        .lte("expense_date", range.to)
        .gt("gst_paid", 0);

      /* Reverse charge (migration 20260927220000): the buyer's own IGST on imported services. */
      const { data: rcmExp } = await supabase
        .from("expenses")
        .select("id, expense_date, vendor_name, amount, rcm_tax")
        .gte("expense_date", range.from).lte("expense_date", range.to).eq("rcm", true);
      const rcmRows = (rcmExp ?? []).map((e) => ({ id: e.id, vendor: e.vendor_name ?? "—", date: e.expense_date, amount: e.amount ?? 0, tax: e.rcm_tax ?? 0 }));

      /* ── Sirf wahi GST credit hai jo credit ho SAKTA hai (27 Sep 2026) ─────────
         Pehle har `gst_paid > 0` kharcha ITC mein jaata tha — kaccha bill, bina GSTIN wala
         vendor, staff ka khana sab. GSTR-2B mein wo kabhi nahi milte, aur 17(5) wale claim
         hi nahi ho sakte. Ab lib/gst/itc.ts tay karta hai; jo credit nahi bana wo
         `blockedItc` mein wajah ke saath dikhta hai. */
      const { data: vendorRows } = await supabase.from("vendors").select("id, gstin");
      const vendorGstinOf = new Map((vendorRows ?? []).map((v) => [v.id, v.gstin ?? null]));
      const withGstin = (expenses ?? []).map((e) => ({ ...e, vendorGstin: e.vendor_id ? vendorGstinOf.get(e.vendor_id) ?? null : null }));
      const blockedItc = splitItc(withGstin);
      const claimable = withGstin.filter((e) => itcEligibility(e).eligible);
      /* R-258: a guessed split (no IGST/CGST on the bill) follows the vendor GSTIN's state —
         another state than ours means the vendor charged IGST, not CGST+SGST. */
      const ownStateCode = sellerStateCode ?? stateCodeFromGstin(sellerGstin);
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
        .map((e) => { const h = headsOf(e); return { igst: h.igst, cgst: h.cgst, sgst: h.sgst }; });

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

      return { outputRows, inputRows, outputTotal, outputGST, inputTotal, inputGST, blockedItc, blocked17Heads, rcmRows, sellerStateCode, sellerState, sellerGstin, advances, lateCreditNotes };
    },
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
