/**
 * R-2602 — "Import Amazon Business report" on the Expenses page.
 *
 * Upload the Amazon Business "Reconciliation by shipment level" CSV → preview: every order with
 * its items and amount, the cancelled rows left out, what is already in, and ONE expected bank
 * debit per Payment Reference ID (what to look for on the HDFC statement) → Import → result.
 *
 * Saving: the SAME `expenses` insert Add Expense does (fields from toAmazonExpenseInserts), every
 * good order of the file in ONE insert statement — all or none (e.g. an order dated in a closed
 * month), so a half-imported file never needs untangling. The rows come in as DRAFTS: unpaid,
 * vendor "Amazon seller (unknown)", ITC off (GST inside the cost) — completed when the seller's
 * GST invoice is attached. Re-uploading the same file skips what is already in (bill_no = Order ID).
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { cn, formatDate, rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { downloadCSV } from "@/lib/csv";
import { parseCsvText } from "@/lib/import/zoho-opening-invoices";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toastError } from "@/lib/errors/toast-error";
import {
  SAMPLE_AMAZON_CSV, buildAmazonImportPreview, readAmazonReportCsv, toAmazonExpenseInserts,
  type AmazonOrderRow, type AmazonPreview, type ExistingExpenseKey,
} from "@/lib/accounting/amazon-business-import";

const MAX_BYTES = 8 * 1024 * 1024;

const VERDICT: Record<AmazonOrderRow["verdict"], { label: string; kind: "success" | "muted" | "warning" | "danger" }> = {
  import: { label: "Will import (draft)", kind: "success" },
  already: { label: "Already in Expenses", kind: "muted" },
  cancelled: { label: "Cancelled — left out", kind: "muted" },
  problem: { label: "Cannot import", kind: "danger" },
};

async function fetchExistingExpenseKeys(): Promise<ExistingExpenseKey[]> {
  const supabase = createClient();
  return fetchAllRows<ExistingExpenseKey>((from, to) =>
    supabase.from("expenses").select("vendor_name, bill_no")
      .not("bill_no", "is", null)
      .order("id", { ascending: true })
      .range(from, to));
}

export function ImportAmazonDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<AmazonPreview | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<{ count: number; total: number; skipped: string[]; debits: AmazonPreview["expectedDebits"] } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  React.useEffect(() => {
    if (!open) return;
    setFileName(null); setPreview(null); setReadError(null); setResult(null);
    if (fileRef.current) fileRef.current.value = "";
  }, [open]);

  const reset = () => {
    setFileName(null); setPreview(null); setReadError(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setReadError(null);
    if (f.size > MAX_BYTES) { setReadError("This file is larger than 8 MB. Download a shorter date range from Amazon Business and try again."); return; }
    setReading(true);
    try {
      const read = readAmazonReportCsv(await f.text());
      if (read.missingColumns.length) {
        setReadError(`These columns are missing: ${read.missingColumns.join(", ")}. Use Amazon Business → Business Analytics → Reconciliation → "Reconciliation by shipment level" (CSV), or the sample below.`);
        return;
      }
      const existing = await fetchExistingExpenseKeys();
      setFileName(f.name);
      setPreview(buildAmazonImportPreview(read.lines, existing));
    } catch (err) {
      setReadError(`The file could not be read: ${err instanceof Error ? err.message : String(err)}. Check your connection and choose the file again.`);
    } finally {
      setReading(false);
    }
  };

  /* The shared CSV writer (BOM for Excel, export logged — R-1006). */
  const downloadSample = () => {
    const [head, ...rows] = parseCsvText(SAMPLE_AMAZON_CSV);
    downloadCSV("amazon-business-import-sample.csv", head, rows);
  };

  const doImport = async () => {
    if (!preview || preview.toImport.length === 0 || saving) return;
    setSaving(true);
    try {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not signed in");
      const { data: me, error: meErr } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a company");
      const rows = toAmazonExpenseInserts(preview.toImport, { fileName: fileName ?? "CSV file", stamp: Date.now().toString(36).toUpperCase() })
        .map((r) => ({ ...r, tenant_id: me.tenant_id }));
      /* One statement → all orders or none (see the header). */
      const { error } = await supabase.from("expenses").insert(rows);
      if (error) throw error;
      const total = preview.toImport.reduce((s, r) => s + r.total, 0);
      setResult({
        count: rows.length, total,
        skipped: preview.rows.filter((r) => r.verdict === "already").map((r) => r.orderId),
        debits: preview.expectedDebits,
      });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      toast.success(`${rows.length} Amazon order${rows.length === 1 ? "" : "s"} imported as drafts — ${rupee(total)}`);
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  const n = preview?.toImport.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-3xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="upload" size={18} className="text-amber" />
            Import Amazon Business report
          </DialogTitle>
          <DialogDescription className="break-words">
            Amazon Business purchases from the &quot;Reconciliation by shipment level&quot; CSV — one draft expense per order,
            unpaid, GST credit off until the seller&apos;s invoice is attached. The preview shows one expected bank debit per payment.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" role="status">
            <div className="rounded-md bg-emerald-soft border border-emerald/30 px-4 py-3 text-sm text-ink">
              <p className="font-semibold inline-flex items-center gap-2"><Icon name="check_circle" size={16} className="text-emerald" />
                {result.count} order{result.count === 1 ? "" : "s"} imported as drafts — {rupee(result.total)}
              </p>
              <p className="text-xs text-ink-2 mt-1">They are in the list below as Unpaid, vendor &quot;Amazon seller (unknown)&quot;. In Banking, open the Amazon debit and pay for these expense bills in Reconcile; attach the GST invoice to claim the credit.</p>
            </div>
            {result.debits.length > 0 && <ExpectedDebits debits={result.debits} />}
            {result.skipped.length > 0 && (
              <p className="text-xs text-ink-2">Skipped (already in Expenses): <span className="font-mono">{result.skipped.join(", ")}</span></p>
            )}
          </div>
        ) : !preview ? (
          <div className="space-y-4">
            <div className="rounded-md bg-paper-2 border border-hairline px-4 py-3 text-xs text-ink-2 space-y-1">
              <p className="font-semibold text-ink">The file</p>
              <p>Amazon Business → Business Analytics → Reconciliation → <b>Reconciliation by shipment level</b> → Download CSV. Columns are found by name: <b>Order ID</b>, <b>Order Date</b>, <b>ASIN</b>, <b>Title</b>, <b>Shipment Quantity</b>, <b>Net total</b>, Payment Reference ID, Payment Date, Tax rate, Total tax amount.</p>
              <p>Each order becomes one draft expense (unpaid, GST credit off). Cancelled rows (quantity 0) are left out. An order already in Expenses (same Order ID) is skipped.</p>
              <Button type="button" variant="ghost" size="sm" icon="download" onClick={downloadSample} className="mt-1 -ml-2">
                Download a sample CSV
              </Button>
            </div>
            <label htmlFor="amazon-import-csv" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer",
              "hover:bg-paper-2/40 transition-colors focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">{reading ? "Reading the file…" : "Choose the Amazon report CSV"}</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB</p>
              <input ref={fileRef} id="amazon-import-csv" type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" disabled={reading} />
            </label>
            {readError && (
              <p role="alert" className="text-xs text-rose-ink inline-flex items-start gap-1.5">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0" />{readError}
              </p>
            )}
          </div>
        ) : (
          <PreviewView preview={preview} fileName={fileName} onReset={reset} />
        )}

        <DialogFooter>
          {result ? (
            <Button type="button" variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              {preview && n > 0 && (
                <Button type="button" variant="primary" loading={saving} onClick={doImport}>
                  Import {n} order{n === 1 ? "" : "s"} as drafts
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExpectedDebits({ debits }: { debits: AmazonPreview["expectedDebits"] }) {
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2 text-xs" data-testid="amazon-expected-debits">
      <p className="font-semibold text-ink">Expected bank debits — one per Amazon payment</p>
      <ul className="mt-1 space-y-0.5">
        {debits.map((d) => (
          <li key={`${d.paymentRef}|${d.paymentDate}`} className="flex items-baseline justify-between gap-3 flex-wrap">
            <span className="text-ink-2">
              {d.paymentDate ? formatDate(d.paymentDate) : "date unknown"} · ref <span className="font-mono text-2xs">{d.paymentRef}</span>
              <span className="block text-3xs text-ink-3">{d.orderIds.length} order{d.orderIds.length === 1 ? "" : "s"}: {d.orderIds.join(", ")}</span>
            </span>
            <span className="tabular-nums font-medium text-ink">{rupee(d.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PreviewView({ preview, fileName, onReset }: { preview: AmazonPreview; fileName: string | null; onReset: () => void }) {
  const c = preview.counts;
  /* Problems first — they need the owner; then what will import; then what is skipped. */
  const order: Record<AmazonOrderRow["verdict"], number> = { problem: 0, import: 1, already: 2, cancelled: 3 };
  const rows = [...preview.rows].sort((a, b) => order[a.verdict] - order[b.verdict]);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink break-all">{fileName}</p>
          <p className="text-sm text-ink mt-1" data-testid="amazon-import-summary">
            <b>{c.import}</b> order{c.import === 1 ? "" : "s"} to import as drafts · <b>{rupee(preview.totalAmount)}</b>
          </p>
          <p className="text-xs text-ink-3 mt-1 inline-flex items-center gap-1.5 flex-wrap">
            {c.already > 0 && <Badge kind="muted" size="sm">{c.already} already in Expenses</Badge>}
            {c.cancelled > 0 && <Badge kind="muted" size="sm">{c.cancelled} cancelled left out</Badge>}
            {c.problem > 0 && <Badge kind="danger" size="sm">{c.problem} cannot import</Badge>}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" icon="x" onClick={onReset}>Choose another file</Button>
      </div>

      {preview.expectedDebits.length > 0 && <ExpectedDebits debits={preview.expectedDebits} />}
      {preview.noPaymentRef.length > 0 && (
        <p className="text-xs text-ink-3">No payment reference in the report for: <span className="font-mono">{preview.noPaymentRef.join(", ")}</span> — find their bank line by amount.</p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">No orders found in this file.</p>
      ) : (
        <div className="border border-hairline rounded-md overflow-hidden">
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                <tr>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Order</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Items</th>
                  <th scope="col" className="p-2 text-right font-semibold text-ink-3">Amount</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.fileLines[0]}`} data-testid="amazon-import-row" className={cn(
                    "border-b border-hairline last:border-0 align-top",
                    r.verdict === "problem" && "bg-rose/5",
                  )}>
                    <td className="p-2 whitespace-nowrap">
                      <span className="font-mono text-2xs text-ink">{r.orderId || "—"}</span>
                      <span className="block text-3xs text-ink-3">{r.orderDate ? formatDate(r.orderDate) : "—"} · line {r.fileLines.join(", ")}</span>
                      {r.paymentRef && <span className="block text-3xs text-ink-3">paid {r.paymentDate ? formatDate(r.paymentDate) : ""} · {r.paymentRef.slice(0, 10)}…</span>}
                    </td>
                    <td className="p-2 text-ink-2 min-w-[12rem]">
                      {r.lines.length === 0 ? <span className="text-ink-3">—</span> : r.lines.map((l) => (
                        <span key={`${l.fileLine}`} className="block truncate max-w-[22rem]" title={`${l.title} (ASIN ${l.asin})`}>
                          {l.qty > 1 ? `${l.qty} × ` : ""}{l.title}
                        </span>
                      ))}
                      {r.verdict === "import" && <span className="block text-3xs text-ink-3 mt-0.5">{r.category}</span>}
                    </td>
                    <td className="p-2 text-right tabular-nums font-medium text-ink whitespace-nowrap">
                      {r.verdict === "problem" || r.verdict === "cancelled" ? "—" : rupee(r.total)}
                      {r.verdict === "import" && r.taxTotal > 0 && (
                        <span className="block text-3xs text-ink-3 font-normal">incl. GST {rupee(r.taxTotal)} (not claimed)</span>
                      )}
                    </td>
                    <td className="p-2 min-w-[11rem]">
                      <Badge kind={VERDICT[r.verdict].kind} size="sm">{VERDICT[r.verdict].label}</Badge>
                      {r.verdict !== "import" && r.message && <span className="block text-3xs text-ink-2 mt-1">{r.message}</span>}
                      {r.notes.map((t) => <span key={t} className="block text-3xs text-ink-3 mt-1">{t}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
