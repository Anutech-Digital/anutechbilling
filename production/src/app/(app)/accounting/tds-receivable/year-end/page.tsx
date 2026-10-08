/**
 * TDS Year-End Summary + Form 26AS Reconciliation
 *
 * Per-FY snapshot of TDS receivable position:
 *   • Total claimable (cert received + verified on 26AS)
 *   • Already claimed in ITR
 *   • Pending certificate (blocking)
 *   • Disputed (likely lost)
 *   • Customer-wise breakdown
 *   • Section-wise breakdown (194J vs 194C etc.)
 *
 * Plus a Form 26AS CSV upload that auto-matches govt deposits to our
 * tds_receivable rows by TAN + amount — flips matched rows to
 * verified_26as in one bulk action.
 *
 * CA-ready CSV export of all rows for the FY.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import {
  useTdsReceivables,
  fiscalYearFromDate,
  TDS_STATUS_LABEL,
  type TdsReceivable,
  type TdsStatus,
} from "@/lib/queries/tds-receivable";
import { istToday } from "@/lib/dates/ist";

const STATUS_COLOR: Record<TdsStatus, "rose" | "emerald" | "amber" | "slate" | "indigo"> = {
  pending_cert:  "rose",
  cert_received: "amber",
  verified_26as: "emerald",
  claimed:       "indigo",
  disputed:      "rose",
  written_off:   "slate",
};

// ────────────────────────────────────────────────────────────────
// CSV utils (local — same pattern as /accounting/gst page)
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

/**
 * Parse a 26AS-style CSV. Form 26AS doesn't have a fixed export format —
 * users typically convert PDF → Excel → CSV. We try to detect the columns
 * we care about (TAN, amount, date) loosely so most exports work.
 */
interface ParsedRow {
  rowIndex: number;
  tan:      string;
  amount:   number;
  date:     string | null;
  raw:      Record<string, string>;
}

function parse26ASCsv(text: string): ParsedRow[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // Detect delimiter (comma vs tab vs semicolon)
  const headerLine = lines[0];
  const delim = headerLine.includes("\t") ? "\t"
              : headerLine.includes(";")  ? ";"
              :                              ",";

  function splitLine(line: string): string[] {
    // Basic CSV split — handles quoted values, not escaped quotes within.
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQuotes = !inQuotes; continue; }
      if (c === delim && !inQuotes) { cells.push(cur); cur = ""; continue; }
      cur += c;
    }
    cells.push(cur);
    return cells.map((s) => s.trim());
  }

  const headers = splitLine(headerLine).map((h) => h.toLowerCase());

  // Column detection — heuristic match
  const tanIdx = headers.findIndex((h) =>
    /\btan\b/.test(h) || h.includes("deductor") && h.includes("tan"),
  );
  const amountIdx = headers.findIndex((h) =>
    h.includes("amount") || h.includes("tds") && (h.includes("amt") || h.includes("amount")),
  );
  const dateIdx = headers.findIndex((h) =>
    h.includes("date") || h.includes("deposit"),
  );

  if (tanIdx < 0 || amountIdx < 0) return [];

  const out: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const tan    = (cells[tanIdx]    ?? "").toUpperCase().trim();
    const amount = Number((cells[amountIdx] ?? "").replace(/[^0-9.-]/g, ""));
    if (!tan || !Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      rowIndex: i,
      tan,
      amount: Math.round(amount),
      date:   dateIdx >= 0 ? (cells[dateIdx] ?? null) : null,
      raw:    Object.fromEntries(headers.map((h, j) => [h, cells[j] ?? ""])),
    });
  }
  return out;
}

interface MatchResult {
  row26AS:        ParsedRow;
  matchedTdsRows: TdsReceivable[];
  status:         "matched" | "no-match-in-system" | "amount-mismatch";
}

function reconcile(rows26AS: ParsedRow[], systemRows: TdsReceivable[]): MatchResult[] {
  const tolerance = 10; // ₹10 rounding tolerance
  return rows26AS.map((r26): MatchResult => {
    const candidates = systemRows.filter((s) => s.customer_tan?.toUpperCase() === r26.tan);
    if (candidates.length === 0) {
      return { row26AS: r26, matchedTdsRows: [], status: "no-match-in-system" };
    }
    // Try amount match within tolerance
    const exact = candidates.filter((c) => Math.abs(c.tds_amount - r26.amount) <= tolerance);
    if (exact.length > 0) {
      return { row26AS: r26, matchedTdsRows: exact, status: "matched" };
    }
    return { row26AS: r26, matchedTdsRows: candidates, status: "amount-mismatch" };
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function TdsYearEndPage() {
  const currentFY = fiscalYearFromDate(istToday());
  const [fy, setFy] = React.useState<string>(currentFY);
  const { data: rows = [], isLoading } = useTdsReceivables({ fiscalYear: fy });

  // FY options: current + 4 prev
  const fyOptions = React.useMemo(() => {
    const cur = parseInt(currentFY.slice(2, 4), 10);
    return [0, 1, 2, 3, 4].map((offset) => {
      const start = cur - offset;
      return `FY${String(start).padStart(2, "0")}${String(start + 1).padStart(2, "0")}`;
    });
  }, [currentFY]);

  // Aggregates
  const summary = React.useMemo(() => {
    const s = {
      total:      0,
      claimable:  0,
      claimed:    0,
      pending:    0,
      disputed:   0,
      writtenOff: 0,
      counts: {
        total:      0,
        claimable:  0,
        claimed:    0,
        pending:    0,
        disputed:   0,
        writtenOff: 0,
      },
    };
    for (const r of rows) {
      s.total += r.tds_amount;
      s.counts.total += 1;
      switch (r.status) {
        case "cert_received":
        case "verified_26as":
          s.claimable += r.tds_amount;
          s.counts.claimable += 1;
          break;
        case "claimed":
          s.claimed += r.tds_amount;
          s.counts.claimed += 1;
          break;
        case "pending_cert":
          s.pending += r.tds_amount;
          s.counts.pending += 1;
          break;
        case "disputed":
          s.disputed += r.tds_amount;
          s.counts.disputed += 1;
          break;
        case "written_off":
          s.writtenOff += r.tds_amount;
          s.counts.writtenOff += 1;
          break;
      }
    }
    return s;
  }, [rows]);

  // Customer breakdown
  const byCustomer = React.useMemo(() => {
    const map = new Map<string, { customerName: string; tan: string | null; total: number; count: number; statuses: Record<string, number> }>();
    for (const r of rows) {
      const key = r.customer_id ?? r.customer_name;
      const cur = map.get(key) ?? {
        customerName: r.customer_name,
        tan:          r.customer_tan ?? null,
        total:        0,
        count:        0,
        statuses:     {},
      };
      cur.total += r.tds_amount;
      cur.count += 1;
      cur.statuses[r.status] = (cur.statuses[r.status] ?? 0) + r.tds_amount;
      if (!cur.tan && r.customer_tan) cur.tan = r.customer_tan;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [rows]);

  // Section breakdown
  const bySection = React.useMemo(() => {
    const map = new Map<string, { total: number; count: number }>();
    for (const r of rows) {
      const cur = map.get(r.section) ?? { total: 0, count: 0 };
      cur.total += r.tds_amount;
      cur.count += 1;
      map.set(r.section, cur);
    }
    return Array.from(map.entries())
      .map(([section, v]) => ({ section, ...v }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  // CSV export
  function exportFullCsv() {
    if (rows.length === 0) {
      toast.error("No TDS rows for this FY", { description: "Pick another financial year, or add TDS rows first." });
      return;
    }
    downloadCSV(
      `tds-${fy}-${istToday()}.csv`,
      [
        "TDS ID", "Date", "Customer", "TAN", "Section", "Rate %",
        "Pre-GST", "TDS amount", "Net paid", "Fiscal year",
        "Status", "Form 16A received", "26AS verified", "Claimed in ITR",
        "Invoice", "Notes",
      ],
      rows.map((r) => [
        r.id, r.payment_received_date, r.customer_name, r.customer_tan ?? "",
        r.section, Number(r.rate_pct).toFixed(2),
        r.gross_amount, r.tds_amount, r.net_paid, r.fiscal_year,
        TDS_STATUS_LABEL[r.status],
        r.form_16a_received_date ?? "",
        r.appears_in_26as ? (r.appears_in_26as_date ?? "yes") : "",
        r.claimed_in_itr_date ?? "",
        r.invoice_id ?? "", r.notes ?? "",
      ]),
    );
    toast.success(`Exported ${rows.length} TDS rows for ${fy}`);
  }

  // 26AS reconciliation state
  const [matchResults, setMatchResults] = React.useState<MatchResult[] | null>(null);
  const [recoUploading, setRecoUploading] = React.useState(false);
  const reco26ASInputRef = React.useRef<HTMLInputElement>(null);

  async function handle26ASCsv(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setRecoUploading(true);
      const text   = await file.text();
      const parsed = parse26ASCsv(text);
      if (parsed.length === 0) {
        toast.error("Could not find TAN / Amount columns", { description: "The CSV header row must include 'TAN' and 'Amount'. Export 26AS again as CSV and upload it." });
        return;
      }
      const results = reconcile(parsed, rows);
      setMatchResults(results);
      const matched = results.filter((r) => r.status === "matched").length;
      toast.success(`Parsed ${parsed.length} rows · ${matched} matched · ${results.length - matched} need review`);
    } catch (err) {
      toastError(err, { fallback: "Could not read the CSV", description: "Export 26AS again as CSV and upload it." });
    } finally {
      setRecoUploading(false);
      if (reco26ASInputRef.current) reco26ASInputRef.current.value = "";
    }
  }

  // Bulk-mark matched as verified_26as
  async function bulkVerifyMatches() {
    if (!matchResults) return;
    const idsToVerify = new Set<string>();
    for (const m of matchResults) {
      if (m.status === "matched") {
        for (const tds of m.matchedTdsRows) {
          if (tds.status === "cert_received" || tds.status === "pending_cert") {
            idsToVerify.add(tds.id);
          }
        }
      }
    }
    if (idsToVerify.size === 0) {
      toast.message("No matched rows need verification (already verified/claimed).");
      return;
    }
    try {
      const supabase = createClient();
      const today = istToday();
      const { error } = await supabase
        .from("tds_receivable")
        .update({
          status:               "verified_26as",
          appears_in_26as:      true,
          appears_in_26as_date: today,
        })
        .in("id", Array.from(idsToVerify));
      if (error) throw error;
      toast.success(`${idsToVerify.size} TDS rows marked verified on 26AS`);
      // Force refresh by clearing match results — page will refetch
      setMatchResults(null);
      window.location.reload();
    } catch (err) {
      toastError(err, { fallback: "Could not mark rows verified", description: "Nothing was changed. Refresh the page and try again." });
    }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <div className="text-xs text-ink-3 mb-1">
            <Link href="/accounting/tds-receivable" className="hover:text-ink">← Back to TDS Receivable</Link>
          </div>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Year-End Summary</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-2xl">
            Per-fiscal-year TDS position for ITR filing. Export CSV for your CA
            and upload Form 26AS to reconcile govt deposits.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor="year-end-fiscal-year" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Fiscal year</label>
          <select id="year-end-fiscal-year"
            value={fy}
            onChange={(e) => setFy(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper font-mono"
          >
            {fyOptions.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
          <Button variant="default" size="sm" onClick={exportFullCsv} disabled={rows.length === 0}>
            <Icon name="download" size={14} className="mr-1.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-6">
        <KPI label="Total TDS · this FY"  value={rupee(summary.total)}      count={summary.counts.total}                                         big />
        <KPI label="Ready to claim"       value={rupee(summary.claimable)}  count={summary.counts.claimable}   tone="emerald" />
        <KPI label="Already claimed"      value={rupee(summary.claimed)}    count={summary.counts.claimed}     tone="indigo"  />
        <KPI label="Pending (chase)"      value={rupee(summary.pending)}    count={summary.counts.pending}     tone="rose"    />
        <KPI label="Disputed"             value={rupee(summary.disputed)}   count={summary.counts.disputed}    tone="rose"    />
      </div>

      {/* Action banner if there are blockers */}
      {summary.pending > 0 && (
        <Card className="p-4 mb-6 border-amber/40 bg-amber-soft/30">
          <div className="text-sm text-ink-2 leading-relaxed">
            <Icon name="alert" size={16} className="text-amber-ink inline mr-1.5 align-text-bottom" />
            <b>{rupee(summary.pending)}</b> across {summary.counts.pending} {summary.counts.pending === 1 ? "entry" : "entries"} is
            blocked on Form 16A certificate. Open each entry → use the WhatsApp chase button.
            <Link href="/accounting/tds-receivable?status=pending_cert" className="text-amber-ink underline ml-1">
              View pending list →
            </Link>
          </div>
        </Card>
      )}

      {/* ── Form 26AS reconciliation ─────────────────────────────── */}
      <Card className="p-5 md:p-6 mb-6">
        <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
          <div>
            <h2 className="font-serif text-xl text-ink leading-tight">Form 26AS Reconciliation</h2>
            <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
              Upload your Form 26AS as CSV (download from TRACES portal → convert to CSV).
              System will match govt deposits to your TDS rows by TAN + amount
              (±₹10 tolerance) and flag mismatches.
            </p>
          </div>
          <div>
            <input
              ref={reco26ASInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handle26ASCsv}
              className="hidden"
            />
            <Button variant="primary" size="sm" loading={recoUploading} onClick={() => reco26ASInputRef.current?.click()}>
              <Icon name="upload" size={14} className="mr-1.5" />
              Upload 26AS CSV
            </Button>
          </div>
        </div>

        {matchResults && matchResults.length > 0 && (
          <>
            <div className="flex flex-wrap gap-1.5 mb-3">
              <span className="text-xs px-2.5 py-1 rounded-full bg-emerald-soft text-emerald font-semibold">
                {matchResults.filter((r) => r.status === "matched").length} matched
              </span>
              <span className="text-xs px-2.5 py-1 rounded-full bg-amber-soft text-amber-ink font-semibold">
                {matchResults.filter((r) => r.status === "amount-mismatch").length} amount mismatch
              </span>
              <span className="text-xs px-2.5 py-1 rounded-full bg-rose-soft text-rose-ink font-semibold">
                {matchResults.filter((r) => r.status === "no-match-in-system").length} not in system
              </span>
              <div className="ml-auto">
                <Button variant="primary" size="sm" onClick={bulkVerifyMatches}>
                  <Icon name="check_circle" size={14} className="mr-1.5" />
                  Bulk verify matched rows on 26AS
                </Button>
              </div>
            </div>
            <div className="overflow-x-auto max-h-96">
              <table className="w-full text-xs">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold sticky top-0">
                  <tr>
                    <th className="text-left  px-3 py-2">26AS row</th>
                    <th className="text-left  px-3 py-2">TAN</th>
                    <th className="text-right px-3 py-2">26AS amount</th>
                    <th className="text-left  px-3 py-2">Match status</th>
                    <th className="text-left  px-3 py-2">Matched TDS rows</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {matchResults.map((m) => (
                    <tr key={m.row26AS.rowIndex}>
                      <td className="px-3 py-2 text-ink-3 font-mono">#{m.row26AS.rowIndex}</td>
                      <td className="px-3 py-2 font-mono text-ink">{m.row26AS.tan}</td>
                      <td className="px-3 py-2 text-right font-mono">{rupee(m.row26AS.amount)}</td>
                      <td className="px-3 py-2">
                        {m.status === "matched" && <Badge color="emerald">Matched</Badge>}
                        {m.status === "amount-mismatch" && <Badge color="amber">Amount mismatch</Badge>}
                        {m.status === "no-match-in-system" && <Badge color="rose">Not in system</Badge>}
                      </td>
                      <td className="px-3 py-2">
                        {m.matchedTdsRows.length > 0 ? (
                          <div className="space-y-0.5">
                            {m.matchedTdsRows.map((t) => (
                              <div key={t.id} className="text-xs">
                                <span className="font-mono text-ink-2">{t.id.slice(0, 14)}…</span>
                                <span className="ml-1 text-ink-3">·</span>
                                <span className="ml-1 font-mono">{rupee(t.tds_amount)}</span>
                                <span className="ml-1 text-ink-3">·</span>
                                <span className="ml-1">{TDS_STATUS_LABEL[t.status]}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-ink-3 italic text-xs">
                            No TDS row with matching TAN — add manually or investigate
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {matchResults && matchResults.length === 0 && (
          <div className="text-sm text-ink-3 text-center py-4">
            No usable rows found in the uploaded CSV. Make sure headers include TAN and Amount columns.
          </div>
        )}
      </Card>

      {/* Two-column breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-6 mb-6">
        {/* Customer breakdown */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-hairline">
            <h2 className="font-serif text-lg text-ink">By customer</h2>
            <p className="text-xs text-ink-3">Who deducted how much · sorted by total</p>
          </div>
          {isLoading ? (
            <div className="p-5 space-y-2">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
            </div>
          ) : byCustomer.length === 0 ? (
            <EmptyState
              compact
              icon="users"
              title="No TDS in this FY"
              body="Record a payment with TDS deducted to see breakdown."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-paper-2/30 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-2.5">Customer</th>
                  <th className="text-left  px-4 py-2.5">TAN</th>
                  <th className="text-right px-4 py-2.5">Entries</th>
                  <th className="text-right px-4 py-2.5">Total TDS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {byCustomer.map((c) => (
                  <tr key={c.customerName + c.tan} className="hover:bg-paper-2/40">
                    <td className="px-4 py-2.5 font-medium text-ink">{c.customerName}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">{c.tan ?? "—"}</td>
                    <td className="px-4 py-2.5 text-right text-ink-2 font-mono">{c.count}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-ink">{rupee(c.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        {/* Section breakdown */}
        <Card className="overflow-hidden">
          <div className="px-5 py-4 border-b border-hairline">
            <h2 className="font-serif text-lg text-ink">By section</h2>
            <p className="text-xs text-ink-3">Which IT section · sorted by total</p>
          </div>
          {bySection.length === 0 ? (
            <EmptyState compact icon="file" title="—" body="No data" />
          ) : (
            <ul className="divide-y divide-hairline">
              {bySection.map((s) => {
                const pct = summary.total > 0 ? (s.total / summary.total) * 100 : 0;
                return (
                  <li key={s.section} className="px-5 py-3">
                    <div className="flex items-baseline justify-between mb-1">
                      <div>
                        <span className="font-mono text-sm font-semibold text-ink">{s.section}</span>
                        <span className="text-xs text-ink-3 ml-2">{s.count} entries</span>
                      </div>
                      <div className="font-mono text-sm font-semibold text-ink">{rupee(s.total)}</div>
                    </div>
                    <div className="h-1.5 rounded-full bg-paper-2 overflow-hidden">
                      <div
                        className="h-full bg-amber rounded-full"
                        style={{ width: `${Math.max(3, pct)}%` }}
                      />
                    </div>
                    <div className="text-xs text-ink-3 mt-0.5">{pct.toFixed(1)}% of FY total</div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Detailed table */}
      <Card className="overflow-hidden">
        <div className="px-5 py-4 border-b border-hairline">
          <h2 className="font-serif text-lg text-ink">All TDS rows · {fy}</h2>
          <p className="text-xs text-ink-3">{rows.length} entries · ready for CA review</p>
        </div>
        {isLoading ? (
          <div className="p-5 space-y-2">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            compact
            icon="receipt"
            title="No TDS entries"
            body="Try a different fiscal year or record some payments with TDS."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/30 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-2.5">Date</th>
                  <th className="text-left  px-4 py-2.5">Customer</th>
                  <th className="text-left  px-4 py-2.5">TAN</th>
                  <th className="text-left  px-4 py-2.5">Section</th>
                  <th className="text-right px-4 py-2.5">Pre-GST</th>
                  <th className="text-right px-4 py-2.5">TDS</th>
                  <th className="text-left  px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-2.5 text-ink-2">{formatDate(r.payment_received_date)}</td>
                    <td className="px-4 py-2.5 text-ink">{r.customer_name}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-3">{r.customer_tan ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-ink-2">{r.section}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-ink-2">{rupee(r.gross_amount)}</td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-rose">{rupee(r.tds_amount)}</td>
                    <td className="px-4 py-2.5">
                      <Badge color={STATUS_COLOR[r.status]}>{TDS_STATUS_LABEL[r.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td colSpan={5} className="px-4 py-2.5 text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                    Total · {rows.length} entries
                  </td>
                  <td className="px-4 py-2.5 text-right font-serif text-base text-ink">{rupee(summary.total)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Primitives
// ────────────────────────────────────────────────────────────────

function KPI({
  label, value, count, tone, big,
}: {
  label: string;
  value: string;
  count?: number;
  tone?: "emerald" | "rose" | "amber" | "indigo";
  big?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : tone === "indigo"  ? "text-indigo"
                   : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-2xl md:text-3xl" : "text-xl md:text-2xl"} ${colorClass} leading-tight`}>
        {value}
      </div>
      {count !== undefined && (
        <div className="text-xs text-ink-3 mt-1">{count} {count === 1 ? "entry" : "entries"}</div>
      )}
    </Card>
  );
}
