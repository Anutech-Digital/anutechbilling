/**
 * GST Reports — single-page view of GST output, input, and net liability
 * for the selected period.
 *
 *   Output GST (sales)  : amount of CGST + SGST + IGST collected from
 *                         customers via invoices
 *   Input GST (purchases): amount of CGST + SGST + IGST paid to vendors
 *                         via vendor_bills + expenses
 *   Cash to pay          : output tax left after input credit is set off in
 *                         the s.49(5) / Rule 88A order (IGST credit first, never
 *                         CGST↔SGST), plus reverse charge — R-258, lib/gst/gstr3b.ts.
 *                         Unused credit is carried forward per head.
 *
 * Two CSV export buttons let Pardeep hand his CA a ready-to-import file
 * for GSTR-1 / GSTR-3B filing on the IRP portal. (Real IRN generation
 * via ClearTax IRP API is a separate P0 task — see LAUNCH_READINESS.md.)
 */
"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { buildGstr1, buildAdvances, docHeads, gstr1Csv, gstr1Json, isExportDoc, GSTR1_HEADERS } from "@/lib/gst/gstr1";
import { gstr3bRows } from "@/lib/gst/gstr3b";
import { parseGstr2b, reconcile2b, type Reconciliation } from "@/lib/gst/gstr2b";
import { Term } from "@/components/shared/term";
import { gstLastMonth, gstThisMonth, gstThisQuarter, type GstPeriod } from "@/lib/gst/periods";
import { gstAllToDate, gstRangeFromParams, gstThisFy } from "./range";
import { useGstReport, useGstPaidInRange } from "./report";
import { gstCashHeadline, gstr3bFromReport, outputTaxBridge, toGstr1Doc } from "./cash-to-pay";
import { OutputTaxBridgeCard } from "./output-tax-bridge-card";
import { compareGstr1, gstr1VsBooksCsv, parseGstr1Json, returnFromBooks, GSTR1_VS_BOOKS_HEADERS, type Gstr1VsBooks } from "@/lib/gst/gstr1a";

// ────────────────────────────────────────────────────────────────
// Date range helpers — month default (most common GST filing cadence)
// ────────────────────────────────────────────────────────────────

/* GST periods are IST calendar months: lib/gst/periods.ts (WC-gst, 30 Sep 2026 — was a
   hand-rolled +5.5h copy here). */
type DateRange = GstPeriod;
const thisMonth = () => gstThisMonth();
const lastMonth = () => gstLastMonth();
const thisQuarter = () => gstThisQuarter();

// GST report rows + the cash-to-pay headline: ./report.ts (loader) and ./cash-to-pay.ts
// (pure) — R-394, shared with the Accounting Overview tile so both show one number.

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
   span the Accounting Overview GST folder covers (R-394: the tile opens the default range). */
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
  const { paid: gstPaidInRange } = useGstPaidInRange(range);

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

  /* ── R-343: GSTR-1 vs books ───────────────────────────────────────────
     The filed GSTR-1 JSON is read in the browser and compared with the period rebuilt
     from the books (same buildGstr1). Export only: no tax is computed here, nothing saved.
     GSTR-1A has no upload file (GSTN: online / GSP only), so this is a worklist. */
  const [vs1, setVs1] = React.useState<{ fp: string | null; result: Gstr1VsBooks; fileName: string } | null>(null);
  const filedRef = React.useRef<HTMLInputElement>(null);
  /* A comparison belongs to the period it was made for — a new range clears it. */
  React.useEffect(() => { setVs1(null); }, [range.from, range.to]);
  async function onPickFiledGstr1(file: File | null) {
    if (!file || !data) return;
    try {
      const parsed = parseGstr1Json(JSON.parse(await file.text()));
      if (parsed.errors.length) {
        toast.error("This isn't a GSTR-1 JSON file.", {
          description: "Pick the GSTR-1 JSON you uploaded for this period (the file from Download GSTR-1 JSON).",
        });
        return;
      }
      if (data.sellerGstin && parsed.gstin && parsed.gstin.toUpperCase() !== data.sellerGstin.toUpperCase()) {
        toast.error(`This file is for GSTIN ${parsed.gstin}, not yours (${data.sellerGstin}).`, {
          description: "Pick the GSTR-1 JSON filed for your own GSTIN.",
        });
        return;
      }
      const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
      const result = compareGstr1(parsed, returnFromBooks(data.outputRows.map(toGstr1Doc), seller));
      setVs1({ fp: parsed.fp, result, fileName: file.name });
      const fp = range.from.slice(5, 7) + range.from.slice(0, 4);
      if (parsed.fp && parsed.fp !== fp) toast.warning(`This GSTR-1 is for ${parsed.fp}, the page shows ${fp}. Set the date range to the same month.`);
    } catch {
      toast.error("Couldn't read this file.", { description: "It isn't valid JSON. Pick the GSTR-1 JSON you uploaded for this period." });
    } finally {
      if (filedRef.current) filedRef.current.value = "";
    }
  }
  function exportVs1() {
    if (!vs1) return;
    downloadCSV(`gstr1-vs-books-${range.from}-to-${range.to}.csv`, [...GSTR1_VS_BOOKS_HEADERS], gstr1VsBooksCsv(vs1.result));
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

  const g3b = data ? gstr3bFromReport(data, range) : null;
  const bridge = data && g3b ? outputTaxBridge(data, range, g3b) : null;   // R-521: card → 3B, every part named
  const advTax = bridge ? bridge.lines.filter((l) => l.key === "advances_11a" || l.key === "advances_11b").reduce((s, l) => s + l.tax, 0) : 0;

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
          Output GST (collected from customers), less Input GST credit (paid to vendors) set off head by head = cash to pay.
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
          footnote={bridge && advTax !== 0 ? (
            <a href="#output-tax-bridge" className="underline decoration-dotted hover:text-ink">
              {advTax > 0 ? "+" : "−"} {rupee(Math.abs(advTax))} tax on advances = {rupee(bridge.gstr3b.tax)} in GSTR-3B
            </a>
          ) : undefined}
        />
        <SummaryCard
          label={<><Term k="input_gst">Input GST</Term> paid</>}
          taxable={data?.inputTotal ?? 0}
          gst={data?.inputGST ?? 0}
          rowCount={data?.inputRows.length ?? 0}
          rowLabel="bill/expense"
        />
        <Card className="p-4 md:p-5 border-2 border-amber/30 bg-amber-soft/20">
          {/* R-258: the big number is CASH — output tax left after input credit is set off in
              the statutory order (s.49(5) / Rule 88A: IGST credit first, never CGST↔SGST;
              lib/gst/gstr3b.ts setOffItc), plus reverse-charge tax, less GST already paid for
              these months (R-257). The old "output − input" ignored both rules. Per-head
              working (credit used, cash, carried forward) sits below. */}
          {(() => {
            /* R-394: label, number and hint from ./cash-to-pay gstCashHeadline — the
               Accounting Overview tile prints the same object for the default range. */
            const hl = gstCashHeadline(g3b, data ? gstPaidInRange : 0);
            const { paid, cash, left } = hl;
            const so = g3b?.setOff;
            const carry = hl.carryForward;
            const heads = [["IGST", "igst"], ["CGST", "cgst"], ["SGST", "sgst"]] as const;
            return (
              <>
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
                  {hl.label}
                </div>
                {isLoading ? <Skeleton className="h-8 w-32 mt-2" /> : (
                  <>
                    <div className={`font-serif text-2xl md:text-3xl ${data && left > 0 ? "text-rose" : "text-emerald"}`}>
                      {data ? rupee(hl.amount) : "—"}
                    </div>
                    <div className="text-xs text-ink-3 mt-1.5 leading-relaxed">
                      {!data ? "" : hl.hint}
                    </div>
                    {data && paid > 0 && (
                      <div className="mt-2 pt-2 border-t border-amber/20 text-xs space-y-0.5 tabular-nums">
                        <div className="flex justify-between text-ink-2"><span>Cash after credit</span><span>{rupee(cash)}</span></div>
                        <div className="flex justify-between text-ink-2"><span>Paid for these months</span><span>− {rupee(paid)}</span></div>
                      </div>
                    )}
                    {so && (so.liability.igst + so.liability.cgst + so.liability.sgst + carry) > 0 && (
                      <table className="w-full mt-2 pt-2 border-t border-amber/20 text-xs tabular-nums" aria-label="GST set-off by head">
                        <thead className="text-3xs uppercase tracking-wider text-ink-3">
                          <tr><th className="text-left font-semibold py-0.5">Head</th><th className="text-right font-semibold">Output</th><th className="text-right font-semibold">Credit used</th><th className="text-right font-semibold">Cash</th><th className="text-right font-semibold">Carried fwd</th></tr>
                        </thead>
                        <tbody className="text-ink-2">
                          {heads.map(([label, k]) => (
                            <tr key={k}>
                              <td className="py-0.5">{label}</td>
                              <td className="text-right">{rupee(so.liability[k] + (k === "igst" ? g3b.rcmTax : 0))}</td>
                              <td className="text-right">{rupee(so.paidByCredit[k])}</td>
                              <td className="text-right">{rupee(g3b.pay[k])}</td>
                              <td className="text-right">{rupee(so.carryForward[k])}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {bridge && so && advTax !== 0 && (
                      <p className="text-3xs text-ink-3 mt-1.5 leading-relaxed">
                        Output = invoices/notes {rupee(bridge.card.tax)} {advTax > 0 ? "+" : "−"} tax on advances {rupee(Math.abs(advTax))}{g3b.rcmTax > 0 ? ` + reverse charge ${rupee(g3b.rcmTax)}` : ""}. <a href="#output-tax-bridge" className="underline decoration-dotted">Breakdown</a>
                      </p>
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

      {/* R-343: GSTR-1 vs books — what to amend / add in GSTR-1A before GSTR-3B locks it */}
      {data && (
        <Card className="mb-6 p-4 md:p-5 border border-indigo/30 bg-indigo/5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">GSTR-1 vs books — {range.label}</p>
              <p className="text-xs text-ink-2 mt-0.5 leading-relaxed max-w-3xl">
                After filing GSTR-1, pick the GSTR-1 JSON you uploaded. Every invoice or note changed, added or removed in the
                books since then is listed. Fix them in <b>GSTR-1A</b> on the portal <b>before filing GSTR-3B</b> — 3B sales figures
                are auto-filled from GSTR-1/1A and locked. GSTR-1A is filled online only (no upload file). The file is read in
                your browser and not saved.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <input ref={filedRef} type="file" accept=".json,application/json" className="hidden" aria-label="Filed GSTR-1 JSON" onChange={(e) => onPickFiledGstr1(e.target.files?.[0] ?? null)} />
              <Button variant="default" size="sm" onClick={() => filedRef.current?.click()}><Icon name="file" size={14} className="mr-1.5" />Pick filed GSTR-1 JSON</Button>
              {vs1 && (vs1.result.docs.length > 0 || vs1.result.b2cs.length > 0) && <Button variant="ghost" size="sm" icon="download" onClick={exportVs1}>CSV</Button>}
            </div>
          </div>
          {vs1 && (() => {
            const r = vs1.result;
            const changed = r.docs.filter((d) => d.status === "changed");
            const missing = r.docs.filter((d) => d.status === "missing_in_return");
            const notInBooks = r.docs.filter((d) => d.status === "not_in_books");
            const totalDiff = r.taxDiff.igst + r.taxDiff.cgst + r.taxDiff.sgst;
            return (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Changed</div><div className="font-mono text-ink font-semibold">{changed.length}</div><div className="text-xs text-ink-3">{r.unchanged} same</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Missing in return</div><div className="font-mono text-ink font-semibold">{missing.length}</div><div className="text-xs text-ink-3">add in GSTR-1A</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Not in books</div><div className="font-mono text-ink font-semibold">{notInBooks.length}</div><div className="text-xs text-ink-3">check books</div></div>
                  <div className="rounded-md bg-paper p-2.5"><div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Tax: books − filed</div><div className={`font-mono font-semibold ${totalDiff === 0 ? "text-emerald" : "text-rose"}`}>{rupee(totalDiff)}</div><div className="text-xs text-ink-3 truncate" title={vs1.fileName}>{vs1.fp ?? "?"} · {vs1.fileName}</div></div>
                </div>
                {r.docs.length > 0 && (
                  <ul className="text-xs text-ink-2 space-y-1.5">
                    {r.docs.slice(0, 30).map((d) => (
                      <li key={`${d.status}|${d.table}|${d.num}`} className="rounded-md bg-paper px-2.5 py-1.5">
                        <div className="flex justify-between gap-3">
                          <span className="truncate"><b className="text-ink">{d.num}</b> · {d.table}{d.date ? ` · ${formatDate(d.date)}` : ""}{d.ctin ? ` · ${d.ctin}` : ""}</span>
                          <span className="font-mono shrink-0">{d.taxDiff === 0 ? "tax same" : `tax ${d.taxDiff > 0 ? "+" : ""}${rupee(d.taxDiff)}`}</span>
                        </div>
                        {d.changes.length > 0 && <div className="text-ink-3">{d.changes.join(" · ")}</div>}
                        <div className={d.gstinChanged ? "text-rose" : "text-indigo-ink"}>{d.action}</div>
                      </li>
                    ))}
                  </ul>
                )}
                {r.docs.length > 30 && <p className="text-xs text-ink-3">+{r.docs.length - 30} more in the CSV.</p>}
                {r.b2cs.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-ink mb-1">B2CS (small B2C) totals differ — amend these lines in GSTR-1A</p>
                    <ul className="text-xs text-ink-2 space-y-0.5">{r.b2cs.map((l) => <li key={`${l.pos}|${l.rate}`} className="flex justify-between gap-3"><span>Place of supply {l.pos} · {l.rate}%</span><span className="font-mono">taxable {rupee(l.filed?.taxable ?? 0)} → {rupee(l.books?.taxable ?? 0)}</span></li>)}</ul>
                  </div>
                )}
                {r.docs.length === 0 && r.b2cs.length === 0 && <p className="text-xs text-emerald">Books match the filed GSTR-1 — no GSTR-1A needed.</p>}
              </div>
            );
          })()}
        </Card>
      )}

      {/* R-521: Output GST card → GSTR-3B 3.1, every part named (advances 11A/11B) */}
      {bridge && g3b && (data?.outputRows.length || data?.advances.length) ? (
        <OutputTaxBridgeCard bridge={bridge} g3b={g3b} advTax={advTax} rangeLabel={range.label} />
      ) : null}

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
                  const isNet = box === "Net", isRev = box === "4(B)(1)", isInfo = box === "—", isItc = (box.startsWith("4(") && !isRev) || box === "C/F";
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
            6.1 = credit set off in the legal order: IGST credit pays IGST first, then CGST/SGST; CGST credit pays
            CGST, then IGST; SGST credit pays SGST, then IGST. CGST and SGST credit never pay each other. Net = cash
            left to pay (reverse charge always in cash); unused credit is carried forward. Where a bill had no
            IGST/CGST split, the vendor GSTIN state decides (other state = IGST). Interest and late fee are extra.
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
        <>
        {data.lateCreditNotes > 0 && (
          <div role="alert" className="mb-3 rounded-md bg-amber-soft/60 border border-amber/40 px-3 py-2 text-xs text-amber-ink leading-relaxed">
            <b>{data.lateCreditNotes} late credit note{data.lateCreditNotes === 1 ? "" : "s"}</b> — issued after GST s.34&apos;s
            limit for the invoice (30 Nov after its financial year, or the annual return date if earlier). They may not
            reduce output GST; confirm with your CA before filing. Marked &ldquo;Late&rdquo; below.
          </div>
        )}
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
                    <td className="px-4 py-3 font-mono text-ink-2">
                      {r.invoiceId}
                      {r.lateCreditNote && (
                        <span title="Credit note issued after the GST s.34 time limit — confirm with your CA" className="ml-2 rounded bg-amber-soft/60 px-1.5 py-0.5 font-sans text-3xs font-semibold text-amber-ink">Late</span>
                      )}
                    </td>
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
        </>
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
                  baanta gaya hai (vendor ka GSTIN doosre rajya ka ho to poora IGST maana gaya). <strong>GSTR-3B me IGST aur CGST/SGST alag column hain</strong> —
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
  label, taxable, gst, rowCount, rowLabel, rowNote, footnote,
}: {
  /** R-521: one line naming what GSTR-3B adds to this figure (tax on advances). */
  footnote?: React.ReactNode;
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
      {footnote && <div className="text-xs text-ink-2 mt-1.5 leading-relaxed">{footnote}</div>}
    </Card>
  );
}
