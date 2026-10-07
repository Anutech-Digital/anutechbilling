/**
 * GST Reports — single-page view of GST output, input, and net liability
 * for the selected period.
 *
 *   Output GST (sales)  : amount of CGST + SGST + IGST collected from
 *                         customers via invoices
 *   Input GST (purchases): amount of CGST + SGST + IGST paid to vendors
 *                         via vendor_bills + expenses
 *   Net liability        : Output − Input. Positive = payable. Negative =
 *                         refundable / carry-forward credit.
 *
 * Two CSV export buttons let Pardeep hand his CA a ready-to-import file
 * for GSTR-1 / GSTR-3B filing on the IRP portal. (Real IRN generation
 * via ClearTax IRP API is a separate P0 task — see LAUNCH_READINESS.md.)
 */
"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { expenseGstHeads } from "@/lib/accounting/gst-heads";
import { splitItc, itcEligibility, type ItcSplit } from "@/lib/gst/itc";
import { gstPaidForPeriods } from "@/lib/accounting/tax-payments";
import { useTaxPayments } from "@/lib/queries/tax-payments";
import { rupee, formatDate } from "@/lib/utils";
import { buildGstr1, buildAdvances, docHeads, docHsnLines, gstr1Csv, gstr1Json, gstr3bClass, isExportDoc, GSTR1_HEADERS, type Advance, type HsnSourceLine } from "@/lib/gst/gstr1";
import { isInterStateSupply, frozenParty } from "@/lib/gst/place-of-supply";
import { computeGstr3b, gstr3bRows, type Heads } from "@/lib/gst/gstr3b";
import { parseGstr2b, reconcile2b, type Reconciliation } from "@/lib/gst/gstr2b";
import { createClient } from "@/lib/supabase/client";
import { Term } from "@/components/shared/term";
import { toIstDate } from "@/lib/dates/ist";
import { gstLastMonth, gstThisMonth, gstThisQuarter, istRangeUtc, type GstPeriod } from "@/lib/gst/periods";
import { gstAllToDate, gstRangeFromParams, gstThisFy } from "./range";

// ────────────────────────────────────────────────────────────────
// Date range helpers — month default (most common GST filing cadence)
// ────────────────────────────────────────────────────────────────

/* GST periods are IST calendar months: lib/gst/periods.ts (WC-gst, 30 Sep 2026 — was a
   hand-rolled +5.5h copy here). */
type DateRange = GstPeriod;
const thisMonth = () => gstThisMonth();
const lastMonth = () => gstLastMonth();
const thisQuarter = () => gstThisQuarter();

// ────────────────────────────────────────────────────────────────
// GST aggregation hook
// ────────────────────────────────────────────────────────────────

interface OutputRow {
  invoiceId:    string;
  invoiceDate:  string;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: string | null;  // buyer's GST state code (place of supply)
  customerState:     string | null;
  /** Customer's country — outside India with no GSTIN = export (GSTR-1 EXP, 3B 3.1(b)). */
  customerCountry:   string | null;
  amount:       number;        // GST-inclusive
  taxableValue: number;        // persisted (migration 0116), else reverse-derived
  gst:          number;        // total GST (persisted, else reverse-derived)
  taxRate:      number;        // GST rate %
  interState:   boolean;       // true → IGST; false → CGST + SGST
  docType:      "invoice" | "credit_note" | "debit_note";  // credit/debit notes net the output tax
  /** Per-line HSN/SAC share of the taxable value (catalogue item's `hsn`). See lib/gst/gstr1.ts. */
  lines?:       { hsn: string; description?: string; taxable: number }[];
}
interface InputRow {
  source:       "bill" | "expense";
  id:           string;
  date:         string;
  vendor:       string;
  vendorGstin:  string | null;
  taxableValue: number;        // pre-GST
  gst:          number;        // CGST + SGST + IGST or gst_paid
  igst:         number;        // ITC head split. Bill se naapa hua, ya (jab bill par na ho) maana hua — `assumed` batata hai kaun sa.
  /** `true` = ye batwara BILL se nahi aaya, maana gaya hai. Dekho lib/accounting/gst-heads.ts */
  assumed?:     boolean;
  /** Maana gaya ho to kyun — hover/worksheet me dikhane ke liye. */
  assumption?:  string | null;
  cgst:         number;
  sgst:         number;
  category:     string;
  /** Bill / invoice number as entered — the key GSTR-2B matching uses (lib/gst/gstr2b.ts). */
  billNo:       string | null;
}
interface GstReport {
  outputRows:    OutputRow[];
  inputRows:     InputRow[];
  outputTotal:   number;
  outputGST:     number;
  inputTotal:    number;
  inputGST:      number;
  netLiability:  number;
  /** Expense GST that is NOT credit (kaccha bill, no vendor GSTIN, s.17(5)) — lib/gst/itc.ts. Not in inputRows. */
  blockedItc:    ItcSplit;
  /** The s.17(5) part of that, by head — reported gross in 3B 4(A)(5) and reversed in 4(B)(1). */
  blocked17Heads: Heads[];
  /** Imported services under reverse charge this period (expenses.rcm) — 3B 3.1(d) / 4(A)(3). */
  rcmRows:       { id: string; vendor: string; date: string; amount: number; tax: number }[];
  sellerStateCode: string | null;   // your own state — place of supply for intra-state B2C
  sellerState:     string | null;
  /** Company GSTIN from Settings — the Portal JSON is refused without it. */
  sellerGstin:     string | null;
  /** Receipt-voucher advances relevant to GSTR-1 Table 11A / 11B (lib/gst/gstr1.ts buildAdvances). */
  advances:        Advance[];
}

function useGstReport(range: DateRange) {
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
      const noteParentIds = Array.from(new Set([...(creditNotes ?? []), ...(debitNotes ?? [])]
        .map((n) => n.invoice_id).filter((x): x is string => !!x && !linesByInvoice.has(x))));
      if (noteParentIds.length) {
        const { data: parents } = await supabase.from("invoices")
          .select("id, line_items, customer_gstin, pos_state_code, customer_country, billing_address, seller_state_code")
          .in("id", noteParentIds);
        for (const iv of parents ?? []) { linesByInvoice.set(iv.id, linesOf(iv.line_items)); snapByInvoice.set(iv.id, iv); }
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
      /* s.17(5) blocked rows keep their heads: 3B wants them in 4(A)(5) and again in 4(B)(1). */
      const blocked17Heads: Heads[] = withGstin
        .filter((e) => (itcEligibility(e).reason ?? "").includes("17(5)"))
        .map((e) => { const h = expenseGstHeads(e); return { igst: h.igst, cgst: h.cgst, sgst: h.sgst }; });

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
        const h = expenseGstHeads(e);
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
      const netLiability = outputGST - inputGST;

      return { outputRows, inputRows, outputTotal, outputGST, inputTotal, inputGST, netLiability, blockedItc, blocked17Heads, rcmRows, sellerStateCode, sellerState, sellerGstin, advances };
    },
  });
}

// GSTR-1 sections (B2B / B2CL / B2CS / CDNR / CDNUR / HSN) — lib/gst/gstr1.ts.
// Notes are signed rows here, so the page totals net; the builder puts them in
// their own tables with positive values, the way the portal wants them.
const toGstr1Doc = (r: OutputRow) => ({
  id: r.invoiceId, date: r.invoiceDate, docType: r.docType, customerName: r.customerName,
  customerGstin: r.customerGstin, customerStateCode: r.customerStateCode, customerState: r.customerState, customerCountry: r.customerCountry,
  amount: r.amount, taxableValue: r.taxableValue, gst: r.gst, taxRate: r.taxRate, interState: r.interState, lines: r.lines,
});

// GSTR-3B worksheet — lib/gst/gstr3b.ts (RCM, s.17(5) reversal, cash per head).

// ────────────────────────────────────────────────────────────────
// CSV export helpers
// ────────────────────────────────────────────────────────────────

function csvEscape(s: unknown): string {
  const v = String(s ?? "");
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function downloadCSV(filename: string, headers: string[], rows: (string | number)[][]) {
  const lines = [
    headers.map(csvEscape).join(","),
    ...rows.map((r) => r.map(csvEscape).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

/* R-257: "This FY" and "All to date" join the month/quarter chips — "All to date" is the
   span the Accounting Overview "GST to pay" tile covers, so the tile lands on a lit chip. */
const QUICK_RANGES = [thisMonth, lastMonth, thisQuarter, () => gstThisFy(), () => gstAllToDate()];

/* useSearchParams needs a Suspense boundary or the build refuses to prerender the page
   (same as ledger/loans). */
export default function GstReportPage() {
  return (
    <React.Suspense fallback={<div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-8 w-48" /></div>}>
      <GstReportInner />
    </React.Suspense>
  );
}

function GstReportInner() {
  const router = useRouter();
  const search = useSearchParams();
  /* R-257: ?from=&to= opens the page on the range a link names (the Overview tile);
     otherwise last month on the 1st–20th (the return being filed), this month after. */
  const [range, setRange] = React.useState<DateRange>(() => gstRangeFromParams(search.get("from"), search.get("to")));
  const { data, isLoading } = useGstReport(range);
  const { data: taxPayments } = useTaxPayments();
  const gstPaidInRange = gstPaidForPeriods(taxPayments ?? [], range.from.slice(0, 7), range.to.slice(0, 7));

  /* ── GSTR-2B milaan (27 Sep 2026) ────────────────────────────────────────
     The portal's JSON is read in the browser and matched against this period's ITC rows;
     nothing is uploaded or stored. s.16(2)(aa): only what the supplier filed is credit. */
  const [twoB, setTwoB] = React.useState<{ period: string | null; recon: Reconciliation; count: number } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  async function onPick2b(file: File | null) {
    if (!file || !data) return;
    try {
      const parsed = parseGstr2b(JSON.parse(await file.text()));
      if (parsed.errors.length) {
        toast.error("This isn't a GSTR-2B file.", {
          description: "On the GST portal open Returns → GSTR-2B, download the JSON, and pick that file.",
        });
        return;
      }
      const books = data.inputRows.map((r) => ({ id: r.id, source: r.source, vendor: r.vendor, vendorGstin: r.vendorGstin, billNo: r.billNo, date: r.date, taxable: r.taxableValue, igst: r.igst, cgst: r.cgst, sgst: r.sgst }));
      const recon = reconcile2b(parsed.invoices, books);
      setTwoB({ period: parsed.period, recon, count: parsed.invoices.length });
      const fp = range.from.slice(5, 7) + range.from.slice(0, 4);
      if (parsed.period && parsed.period !== fp) toast.warning(`This 2B is for ${parsed.period}, the page shows ${fp} — set the date range to the same month.`);
    } catch {
      toast.error("Couldn't read this file.", {
        description: "It isn't valid JSON. On the GST portal open Returns → GSTR-2B, download the JSON, and pick that file.",
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  }
  function export2b() {
    if (!twoB) return;
    const r = twoB.recon;
    downloadCSV(`gstr2b-milaan-${range.from}-to-${range.to}.csv`, ["Status", "Supplier GSTIN", "Invoice no.", "Date", "Books id", "2B tax", "Books tax", "Diff"], [
      ...r.matched.map((m): (string | number)[] => ["Matched", m.b2b.gstin, m.b2b.invoiceNo, m.b2b.date ?? "", m.book.id, m.b2b.igst + m.b2b.cgst + m.b2b.sgst, m.book.igst + m.book.cgst + m.book.sgst, 0]),
      ...r.amountDiffers.map((m): (string | number)[] => ["Amount differs", m.b2b.gstin, m.b2b.invoiceNo, m.b2b.date ?? "", m.book.id, m.b2b.igst + m.b2b.cgst + m.b2b.sgst, m.book.igst + m.book.cgst + m.book.sgst, m.diff]),
      ...r.onlyIn2b.map((x): (string | number)[] => ["Only in 2B (bill missing in books)", x.gstin, x.invoiceNo, x.date ?? "", "", x.igst + x.cgst + x.sgst, "", ""]),
      ...r.onlyInBooks.map((b): (string | number)[] => ["Only in books (supplier not filed — hold)", b.vendorGstin ?? "", b.billNo ?? "", b.date, b.id, "", b.igst + b.cgst + b.sgst, ""]),
    ]);
  }

  function exportOutput() {
    if (!data) return;
    downloadCSV(
      `gst-output-${range.from}-to-${range.to}.csv`,
      ["Invoice #", "Invoice date", "Customer", "Customer GSTIN", "Place of supply",
       "Taxable value", "Rate %", "CGST", "SGST", "IGST", "Total GST", "Invoice total"],
      data.outputRows.map((r) => {
        const s = docHeads(r);
        return [
          r.invoiceId, r.invoiceDate, r.customerName, r.customerGstin ?? "",
          isExportDoc(r)
            ? "Export (zero-rated)" : r.interState ? "Inter-state (IGST)" : "Intra-state (CGST+SGST)",
          r.taxableValue, r.taxRate, s.cgst, s.sgst, s.igst, r.gst, r.amount,
        ];
      }),
    );
  }

  function exportGstr1() {
    if (!data) return;
    const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
    const secs = buildGstr1(data.outputRows.map(toGstr1Doc), seller);
    const adv = buildAdvances(data.advances, range, seller);
    const csv = gstr1Csv(secs, adv);
    const stamp = `${range.from}-to-${range.to}`;
    let files = 0;
    for (const key of ["b2b", "b2cl", "b2cs", "cdnr", "cdnur", "exp", "at", "atadj", "hsn"] as const) {
      if (!csv[key].length) continue;
      downloadCSV(`gstr1-${key}-${stamp}.csv`, [...GSTR1_HEADERS[key]], csv[key]);
      files++;
    }
    if (files === 0) {
      toast.error("No invoices to export for GSTR-1 in this period.", {
        description: "Pick another date range above — GSTR-1 is built from the invoices issued in that range.",
      });
      return;
    }
    const notes: string[] = [];
    if (secs.skipped.length) notes.push(`${secs.skipped.length} B2C document(s) skipped (${secs.skipped.slice(0, 3).join(", ")}) — add the customer's state, then re-export.`);
    if (secs.notesNettedIntoB2cs) notes.push(`${secs.notesNettedIntoB2cs} small unregistered note(s) netted into B2CS.`);
    if (adv.skipped.length) notes.push(`${adv.skipped.length} advance(s) skipped — customer's state missing.`);
    if (adv.exportsSkipped) notes.push(`${adv.exportsSkipped} export advance(s) not reported (zero-rated under LUT).`);
    toast.success(`${files} GSTR-1 file(s) downloaded — import each into the GST Offline Tool.${notes.length ? " " + notes.join(" ") : ""}`);
  }

  function exportGstr1Json() {
    if (!data || !data.outputRows.length) {
      toast.error("No invoices in this period to export JSON.", {
        description: "Pick another date range above — the JSON is built from the invoices issued in that range.",
      });
      return;
    }
    /* A return JSON with a placeholder GSTIN is a return for nobody — refuse, don't guess. */
    if (!data.sellerGstin) {
      toast.error("Your company GSTIN is missing.", {
        description: "The return JSON needs your GSTIN. Add it in Settings → Company, then export again.",
        action: { label: "Open Settings", onClick: () => router.push("/settings?tab=company" as Route) },
      });
      return;
    }
    const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
    const secs = buildGstr1(data.outputRows.map(toGstr1Doc), seller);
    const adv = buildAdvances(data.advances, range, seller);
    const payload = gstr1Json(secs, data.sellerGstin, range.from.slice(5, 7) + range.from.slice(0, 4), adv);

    const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(jsonBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `GSTR1_${data.sellerGstin}_${range.from}_to_${range.to}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const parts = [
      secs.b2b.length && `B2B ${secs.b2b.length}`, secs.b2cl.length && `B2CL ${secs.b2cl.length}`, secs.b2cs.length && `B2CS ${secs.b2cs.length}`,
      secs.cdnr.length && `CDNR ${secs.cdnr.length}`, secs.cdnur.length && `CDNUR ${secs.cdnur.length}`, secs.exp.length && `EXP ${secs.exp.length}`,
      adv.at.length && `11A ${adv.at.length}`, adv.atadj.length && `11B ${adv.atadj.length}`, `HSN ${secs.hsn.length}`,
    ].filter(Boolean).join(" · ");
    const warn = secs.skipped.length ? ` ⚠ ${secs.skipped.length} B2C document(s) skipped — add the customer's state.` : "";
    toast.success(`GSTR-1 JSON downloaded (${parts}). Upload on gst.gov.in → Returns → GSTR-1 → Import JSON, then check every table before filing.${warn}`);
  }

  const g3b = data ? (() => {
    const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
    const adv = buildAdvances(data.advances, range, seller);
    return computeGstr3b({
    output: [
      ...data.outputRows.map((r) => {
        const d = toGstr1Doc(r);
        const c = gstr3bClass(d, seller);
        return { taxableValue: r.taxableValue, heads: docHeads(d), zeroRated: c.zeroRated, unregInterPos: c.unregInterPos };
      }),
      /* Tax on advances: 11A adds to 3.1(a), 11B takes it back out. */
      ...adv.at.map((a) => ({ taxableValue: a.advance, heads: a.heads })),
      ...adv.atadj.map((a) => ({ taxableValue: -a.advance, heads: { igst: -a.heads.igst, cgst: -a.heads.cgst, sgst: -a.heads.sgst } })),
    ],
    itc: data.inputRows.map((r) => ({ igst: r.igst, cgst: r.cgst, sgst: r.sgst })),
    blocked17: data.blocked17Heads,
    notIn2b: data.blockedItc.blocked - data.blocked17Heads.reduce((s, h) => s + h.igst + h.cgst + h.sgst, 0),
    rcm: data.rcmRows,
    });
  })() : null;

  function exportGstr3b() {
    if (!g3b) return;
    downloadCSV(
      `gstr3b-worksheet-${range.from}-to-${range.to}.csv`,
      ["Table", "Description", "Taxable value", "IGST", "CGST", "SGST"],
      gstr3bRows(g3b),
    );
  }

  function exportInput() {
    if (!data) return;
    downloadCSV(
      `gst-input-${range.from}-to-${range.to}.csv`,
      ["Type", "ID", "Date", "Vendor", "Vendor GSTIN", "Category", "Taxable value", "GST claimable"],
      data.inputRows.map((r) => [
        r.source, r.id, r.date, r.vendor, r.vendorGstin ?? "", r.category,
        r.taxableValue, r.gst,
      ]),
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">GST Reports</h1>
        <p className="text-sm text-ink-3 mt-1">
          Output GST (collected from customers) − Input GST (paid to vendors) = Net liability.
          Hand the CSV exports to your CA for GSTR-1 / GSTR-3B filing.
        </p>
      </div>

      {/* Range picker */}
      <Card className="mb-6 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_RANGES.map((build) => {
              const target = build();
              const active = range.from === target.from && range.to === target.to;
              return (
                <button
                  key={target.label}
                  type="button"
                  onClick={() => setRange(target)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    active
                      ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                      : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                  }`}
                >
                  {target.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <input aria-label="From date"
              type="date" value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
            <span className="text-xs text-ink-3">to</span>
            <input aria-label="To date"
              type="date" value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
            />
          </div>
        </div>
      </Card>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <SummaryCard
          label={<><Term k="output_gst">Output GST</Term> (on sales)</>}
          taxable={data?.outputTotal ?? 0}
          gst={data?.outputGST ?? 0}
          rowCount={data?.outputRows.length ?? 0}
          rowLabel="invoice"
          rowNote="dated in this period"
        />
        <SummaryCard
          label={<><Term k="input_gst">Input GST</Term> paid</>}
          taxable={data?.inputTotal ?? 0}
          gst={data?.inputGST ?? 0}
          rowCount={data?.inputRows.length ?? 0}
          rowLabel="bill/expense"
        />
        <Card className="p-4 md:p-5 border-2 border-amber/30 bg-amber-soft/20">
          {/* R-257: the big number is what is LEFT to pay (net − GST already paid for these
              months) — the same figure the Overview "GST to pay" tile shows, so tile and
              headline agree. With nothing paid it is simply the net liability. The net and
              the payment stay visible below as the working. Same figures as before, only
              which one is the headline changed. */}
          {(() => {
            const paid = data ? gstPaidInRange : 0;
            const left = data ? data.netLiability - paid : 0;
            return (
              <>
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                  {left < 0
                    ? (paid > 0 ? "Paid more than due" : "GST credit")
                    : paid > 0 ? "GST still to pay" : <Term k="net_liability">Net liability</Term>}
                </div>
                {isLoading ? <Skeleton className="h-8 w-32 mt-2" /> : (
                  <>
                    <div className={`font-serif text-2xl md:text-3xl ${data && left >= 0 ? "text-rose" : "text-emerald"}`}>
                      {data ? rupee(Math.abs(left)) : "—"}
                    </div>
                    <div className="text-xs text-ink-3 mt-1.5 leading-relaxed">
                      {data && left >= 0
                        ? "Payable to government via GSTR-3B"
                        : "Refundable / carry-forward input tax credit"}
                    </div>
                    {/* GST already paid for these return months (booked from the bank). Shown
                        only when some was paid, so an unpaid month still reads as plain "payable". */}
                    {data && paid > 0 && (
                      <div className="mt-2 pt-2 border-t border-amber/20 text-xs space-y-0.5 tabular-nums">
                        <div className="flex justify-between text-ink-2">
                          <span><Term k="net_liability">Net liability</Term></span><span>{rupee(data.netLiability)}</span>
                        </div>
                        <div className="flex justify-between text-ink-2">
                          <span>Paid for these months</span><span>− {rupee(paid)}</span>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </>
            );
          })()}
        </Card>
      </div>

      {/* GSTR-1 filing helper — Offline Tool & Portal JSON export */}
      {data && data.outputRows.length > 0 && (
        <Card className="mb-6 p-4 md:p-5 border border-amber/30 bg-amber-soft/10">
          <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-4">
            <div className="flex items-start gap-3 min-w-0 w-full">
              <Icon name="download" size={20} className="text-amber-ink shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-ink text-base">File GSTR-1 for {range.label}</div>
                <p className="text-xs text-ink-2 mt-1 leading-relaxed max-w-3xl">
                  Export sales data in official <b>GST Portal JSON</b> or <b>GST Offline Tool CSVs</b> (B2B, B2CL, B2CS, CDNR/CDNUR, EXP, advances 11A/11B, HSN). Direct upload on <a href="https://gst.gov.in" target="_blank" rel="noreferrer" className="text-amber-ink underline font-medium">gst.gov.in</a> → file returns with OTP.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2.5 shrink-0 flex-wrap pt-1 xl:pt-0">
              <Button variant="primary" onClick={exportGstr1Json} className="bg-emerald hover:bg-emerald/90 text-white shadow-xs">
                <Icon name="file" size={14} className="mr-1.5" />
                Download GSTR-1 JSON (Portal Direct)
              </Button>
              <Button variant="default" onClick={exportGstr1}>
                <Icon name="download" size={14} className="mr-1.5" />
                CSV (Offline Tool)
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* GSTR-3B worksheet — the summary figures to type on the portal */}
      {g3b && data && (data.outputRows.length > 0 || data.inputRows.length > 0) && (
        <Card className="mb-6 p-4 border border-indigo/30 bg-indigo/5">
          <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
            <div className="min-w-0">
              <div className="font-medium text-ink">GSTR-3B worksheet — {range.label}</div>
              <p className="text-[12px] text-ink-2 mt-0.5 leading-relaxed">
                3B is <b>typed</b> on the portal (no file upload). Enter these figures box-by-box on
                gst.gov.in → Returns → GSTR-3B. <b>Verify before filing.</b>
              </p>
            </div>
            <Button variant="default" size="sm" onClick={exportGstr3b} className="shrink-0">
              <Icon name="download" size={14} className="mr-1.5" /> Download worksheet
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-3 py-2">Box</th>
                  <th className="text-left  px-3 py-2">What to enter</th>
                  <th className="text-right px-3 py-2">Taxable</th>
                  <th className="text-right px-3 py-2">IGST</th>
                  <th className="text-right px-3 py-2">CGST</th>
                  <th className="text-right px-3 py-2">SGST</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline font-mono">
                {gstr3bRows(g3b).map((r) => {
                  const box = String(r[0]);
                  const isNet = box === "Net", isRev = box === "4(B)(1)", isInfo = box === "—", isItc = box.startsWith("4(") && !isRev;
                  const cell = (v: string | number) => (v === "" ? "—" : typeof v === "number" ? rupee(v) : v);
                  const tone = isNet ? "font-semibold text-rose" : isRev ? "text-amber-ink" : isItc ? "text-emerald" : isInfo ? "text-ink-3" : "text-ink";
                  return (
                    <tr key={box + String(r[1])} className={isNet ? "bg-paper-2/30" : isInfo ? "opacity-80" : ""}>
                      <td className="px-3 py-2 text-ink-2">{box}</td>
                      <td className={`px-3 py-2 font-sans ${isNet ? "font-semibold text-ink" : "text-ink"}`}>{String(r[1])}</td>
                      <td className="px-3 py-2 text-right text-ink-3">{cell(r[2])}</td>
                      <td className={`px-3 py-2 text-right ${tone}`}>{cell(r[3])}</td>
                      <td className={`px-3 py-2 text-right ${tone}`}>{cell(r[4])}</td>
                      <td className={`px-3 py-2 text-right ${tone}`}>{cell(r[5])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-ink-3 mt-2 leading-relaxed">
            Net = output − ITC per head (floored at 0). The portal also lets IGST credit set off CGST/SGST,
            so your actual cash payable can be lower. Expense ITC is assumed intra-state (CGST+SGST) — adjust
            if any expense was inter-state / import (IGST). Add reverse-charge, interest or late fee separately.
          </p>
        </Card>
      )}

      {/* Output GST table */}
      <SectionHeader
        title="Output GST · sales (GSTR-1 source data)"
        count={data?.outputRows.length ?? 0}
        onExport={exportOutput}
        disabled={isLoading || !data || data.outputRows.length === 0}
      />
      {isLoading ? (
        <Skeleton className="h-32 w-full mb-6" />
      ) : !data || data.outputRows.length === 0 ? (
        <Card className="mb-6">
          <EmptyState
            icon="file"
            title="No invoices in this period"
            body="Issue GST invoices in this range and they'll show up here as your output (sales) GST for GSTR-1."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden mb-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Invoice #</th>
                  <th className="text-left  px-4 py-3">Date</th>
                  <th className="text-left  px-4 py-3">Customer</th>
                  <th className="text-left  px-4 py-3">GSTIN</th>
                  <th className="text-right px-4 py-3">Taxable value</th>
                  <th className="text-left  px-4 py-3">Head</th>
                  <th className="text-right px-4 py-3">GST</th>
                  <th className="text-right px-4 py-3">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.outputRows.map((r) => {
                  const s = docHeads(r);
                  return (
                  <tr key={r.invoiceId} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3 font-mono text-ink-2">{r.invoiceId}</td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(r.invoiceDate)}</td>
                    <td className="px-4 py-3 text-ink">{r.customerName}</td>
                    <td className="px-4 py-3 font-mono text-ink-3 text-xs">{r.customerGstin ?? "—"}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(r.taxableValue)}</td>
                    <td className="px-4 py-3 text-ink-3 text-xs">
                      {isExportDoc(r)
                        ? (r.gst ? `Export · IGST ${r.taxRate}%` : "Export · LUT (0%)")
                        : r.interState
                        ? `IGST ${r.taxRate}%`
                        : `CGST ${r.taxRate / 2}% + SGST ${r.taxRate / 2}%`}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald">
                      {rupee(r.gst)}
                      <span className="block text-xs text-ink-3">
                        {r.interState || isExportDoc(r) ? `IGST ${rupee(s.igst)}` : `${rupee(s.cgst)} + ${rupee(s.sgst)}`}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(r.amount)}</td>
                  </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td colSpan={4} className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                    Total ({data.outputRows.length})
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(data.outputTotal)}</td>
                  <td className="px-4 py-3"></td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-emerald">{rupee(data.outputGST)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(data.outputTotal + data.outputGST)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}

      {/* GSTR-2B milaan — only what the supplier filed is credit (s.16(2)(aa)). */}
      {data && (
        <Card className="p-4 mb-4 border border-indigo/30 bg-indigo/5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">GSTR-2B milaan — {range.label}</p>
              <p className="text-xs text-ink-2 mt-0.5 leading-relaxed max-w-2xl">
                Portal → Returns → GSTR-2B → <b>Download JSON</b>, phir yahan chuno. Jo supplier ne file kiya sirf wahi credit hai; baaki hold.
                File browser mein hi padhti hai — kahin upload/save nahi hoti.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => onPick2b(e.target.files?.[0] ?? null)} />
              <Button variant="default" size="sm" onClick={() => fileRef.current?.click()}><Icon name="file" size={14} className="mr-1.5" />2B JSON chuno</Button>
              {twoB && <Button variant="ghost" size="sm" icon="download" onClick={export2b}>CSV</Button>}
            </div>
          </div>
          {twoB && (() => {
            const r = twoB.recon;
            const t = (x: { igst: number; cgst: number; sgst: number }) => x.igst + x.cgst + x.sgst;
            return (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Claim karo (2B ✓)</div><div className="font-mono text-emerald font-semibold">{rupee(r.claimable.total)}</div><div className="text-xs text-ink-3">{r.matched.length} matched · {r.amountDiffers.length} farq</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Hold (2B mein nahi)</div><div className="font-mono text-amber-ink font-semibold">{rupee(r.held)}</div><div className="text-xs text-ink-3">{r.onlyInBooks.length} books row</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Bill chhoota (sirf 2B mein)</div><div className="font-mono text-rose font-semibold">{rupee(r.unbooked)}</div><div className="text-xs text-ink-3">{r.onlyIn2b.length} invoice</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">2B file</div><div className="font-mono text-ink">{twoB.count} inv · {twoB.period ?? "?"}</div><div className="text-xs text-ink-3">books ITC {rupee(data.inputGST)}</div></div>
                </div>
                {r.onlyInBooks.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-amber-ink mb-1">Books mein hai, 2B mein nahi — is mahine claim mat karo, agle 2B mein dekho (ya supplier se filing poochho)</p>
                    <ul className="text-xs text-ink-2 space-y-0.5">{r.onlyInBooks.slice(0, 20).map((b) => <li key={b.id} className="flex justify-between gap-3"><span className="truncate">{b.vendor} · {b.billNo ?? "bill no. nahi"} · {formatDate(b.date)}{!b.vendorGstin ? " · GSTIN nahi" : ""}</span><span className="font-mono">{rupee(t(b))}</span></li>)}</ul>
                  </div>
                )}
                {r.onlyIn2b.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-rose mb-1">2B mein hai, books mein nahi — bill dhoondh kar Expenses / Bills mein daalo, credit tabhi milega</p>
                    <ul className="text-xs text-ink-2 space-y-0.5">{r.onlyIn2b.slice(0, 20).map((x, i) => <li key={x.gstin + x.invoiceNo + i} className="flex justify-between gap-3"><span className="truncate">{x.supplierName ?? x.gstin} · {x.invoiceNo} · {x.date ? formatDate(x.date) : "—"}</span><span className="font-mono">{rupee(t(x))}</span></li>)}</ul>
                  </div>
                )}
                {r.amountDiffers.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-ink mb-1">Tax alag hai — 2B ka figure claim karo, books theek karo</p>
                    <ul className="text-xs text-ink-2 space-y-0.5">{r.amountDiffers.slice(0, 20).map((m) => <li key={m.book.id} className="flex justify-between gap-3"><span className="truncate">{m.book.vendor} · {m.b2b.invoiceNo}</span><span className="font-mono">books {rupee(t(m.book))} → 2B {rupee(t(m.b2b))}</span></li>)}</ul>
                  </div>
                )}
                {r.onlyInBooks.length === 0 && r.onlyIn2b.length === 0 && r.amountDiffers.length === 0 && <p className="text-xs text-emerald">Sab match — poora {rupee(r.claimable.total)} claim karo.</p>}
              </div>
            );
          })()}
        </Card>
      )}

      {data && data.blockedItc.blocked > 0 && (
        <Card className="p-4 mb-4 border-amber/40 bg-amber-soft/20">
          <p className="text-sm font-semibold text-ink">GST jo credit nahi bana — {rupee(data.blockedItc.blocked)}</p>
          <p className="text-xs text-ink-2 mt-0.5 mb-2">Ye kharche mein hi gina hai, ITC mein nahi. Wajah theek ho (GST bill lo, vendor ka GSTIN bharo) to agli baar credit milega.</p>
          <ul className="text-xs text-ink-2 space-y-0.5">
            {data.blockedItc.blockedByReason.map((r) => (
              <li key={r.reason} className="flex justify-between gap-3"><span>{r.reason} · {r.count}</span><span className="font-mono tabular-nums">{rupee(r.amount)}</span></li>
            ))}
          </ul>
        </Card>
      )}

      {/* Input GST table */}
      <SectionHeader
        title="Input GST · purchases (GSTR-2A reconciliation source)"
        count={data?.inputRows.length ?? 0}
        onExport={exportInput}
        disabled={isLoading || !data || data.inputRows.length === 0}
      />

      {/* ── Jo batwara MAANA gaya hai, wo saaf bolta hai (29 Aug 2026) ────────
          Yahan kabhi kuch nahi likha tha. Har kharche ka GST aadha-aadha CGST/SGST maan
          liya jata tha, IGST hamesha shunya, aur padhne wale ko pata hi nahi chalta tha.
          Purane code me likha bhi tha ki ise "worksheet me flag" karna hai — kiya nahi
          gaya tha, aur wo teen mahine chup raha.

          Ginti ke saath RAQAM bhi, kyunki "3 row maani hui hain" kam batata hai: 3 row
          ₹40 ki bhi ho sakti hain aur ₹40,000 ki bhi, aur return bharne wale ke liye wo
          do bilkul alag baatein hain.

          Sab naapa hua ho to ye kuch nahi dikhata — ek chetavni jo hamesha dikhti hai,
          do hafte me dikhna band ho jaati hai. */}
      {(() => {
        const rows = data?.inputRows.filter((r) => r.assumed) ?? [];
        if (rows.length === 0) return null;
        const amount = rows.reduce((s, r) => s + r.gst, 0);
        return (
          <Card className="border-amber/40 bg-amber-soft/40">
            <div className="flex items-start gap-2.5 p-3">
              <Icon name="alert" size={15} className="text-amber-ink shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p className="text-xs font-semibold text-ink">
                  {rows.length} {rows.length === 1 ? "row ka" : "rows ka"} GST batwara MAANA hua hai — {rupee(amount)}
                </p>
                <p className="text-xs text-ink-2">
                  In par bill ka IGST/CGST batwara nahi mila, isliye intra-state maan kar aadha-aadha
                  baanta gaya hai. <strong>GSTR-3B me IGST aur CGST/SGST alag column hain</strong> —
                  agar inme koi doosre rajya ka bill hai (jaise Amazon), to uska credit galat khaane
                  me chala jayega aur GSTR-2B se mel nahi khayega. Neeche table me aisi row par{" "}
                  <span className="font-semibold">maana hua</span> likha hai.
                </p>
              </div>
            </div>
          </Card>
        );
      })()}
      {isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !data || data.inputRows.length === 0 ? (
        <Card>
          <EmptyState
            icon="receipt"
            title="No GST-bearing bills in this period"
            body="Add your Google CSP / Microsoft / Zoho bills and expenses here so input GST (ITC) shows up for GSTR-2/3B."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3">Source</th>
                  <th className="text-left  px-4 py-3">Date</th>
                  <th className="text-left  px-4 py-3">Vendor</th>
                  <th className="text-left  px-4 py-3">GSTIN</th>
                  <th className="text-left  px-4 py-3">Category</th>
                  <th className="text-right px-4 py-3">Taxable value</th>
                  <th className="text-right px-4 py-3">GST claimable</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {data.inputRows.map((r) => (
                  <tr key={`${r.source}-${r.id}`} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <span className={`text-3xs uppercase tracking-wider px-2 py-0.5 rounded-full ${
                        r.source === "bill" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2"
                      }`}>
                        {r.source === "bill" ? "Bill" : "Expense"}
                      </span>
                      {/* Jis row ka IGST/CGST batwara BILL se nahi aaya, wo khud bolti hai.
                          Bina iske IGST ka column ek naapa hua shunya jaisa dikhta tha,
                          jabki wo ek maan-na tha — aur return usi par bhar diya jata. */}
                      {r.assumed ? (
                        <span
                          title={r.assumption ?? undefined}
                          className="ml-1.5 inline-block cursor-help rounded-full border border-amber/30 bg-amber-soft/70 px-1.5 py-0.5 text-3xs font-semibold text-amber-ink"
                        >
                          maana hua
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(r.date)}</td>
                    <td className="px-4 py-3 text-ink">{r.vendor}</td>
                    <td className="px-4 py-3 font-mono text-ink-3 text-xs">{r.vendorGstin ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-3 text-xs">{r.category}</td>
                    <td className="px-4 py-3 text-right font-mono text-ink-2">{rupee(r.taxableValue)}</td>
                    <td className="px-4 py-3 text-right font-mono text-emerald">{rupee(r.gst)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td colSpan={5} className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                    Total ({data.inputRows.length})
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(data.inputTotal)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-emerald">{rupee(data.inputGST)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

function SectionHeader({
  title, count, onExport, disabled,
}: {
  title: string;
  count: number;
  onExport: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end justify-between gap-3 mb-3">
      <div>
        <h2 className="font-serif text-xl text-ink leading-tight">{title}</h2>
        {count > 0 && (
          <div className="text-xs text-ink-3 mt-0.5">{count} {count === 1 ? "row" : "rows"}</div>
        )}
      </div>
      <Button variant="default" size="sm" onClick={onExport} disabled={disabled}>
        <Icon name="download" size={14} className="mr-1.5" />
        Export CSV
      </Button>
    </div>
  );
}

function SummaryCard({
  label, taxable, gst, rowCount, rowLabel, rowNote,
}: {
  label: React.ReactNode;
  taxable: number;
  gst: number;
  rowCount: number;
  rowLabel: string;
  /** R-062: GST counts a sale by its INVOICE date — not the day it was paid. Said on the
   *  card, because "two paid invoices, GST shows one" is otherwise read as a bug. */
  rowNote?: string;
}) {
  return (
    <Card className="p-4 md:p-5">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className="font-serif text-2xl md:text-3xl text-ink leading-tight mb-2">{rupee(gst)}</div>
      <div className="text-xs text-ink-3 leading-relaxed">
        on {rupee(taxable)} taxable value · {rowCount} {rowLabel}{rowCount === 1 ? "" : "s"}{rowNote ? ` ${rowNote}` : ""}
      </div>
    </Card>
  );
}
