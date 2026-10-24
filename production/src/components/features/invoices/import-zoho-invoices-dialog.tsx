/**
 * R-1739 — "Import open invoices from Zoho": the ONE dialog for it (Invoices header and
 * Settings → Import open the same component).
 *
 * Upload the Zoho Books invoice export (CSV) → preview (every invoice with money still due:
 * the customer it matched, its balance, or why it will not come in) → Import (one atomic
 * batch, import_opening_invoices) → result. Past imports are listed under the upload step,
 * with "Remove import" while no payment touches them.
 *
 * Imported invoices keep their Zoho number, show the badge "Imported from Zoho", count in
 * dues / aging / statements / reminders and take payments — and never in GST returns,
 * revenue, e-invoicing or our invoice series (lib/accounting/sale-documents.ts).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn, formatDate, rupee } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canDeleteMoney } from "@/lib/auth/roles";
import {
  SAMPLE_ZOHO_INVOICE_CSV, buildPreview, readZohoInvoiceCsv, toImportRpcRows, type Preview, type PreviewRow,
} from "@/lib/import/zoho-opening-invoices";
import {
  fetchImportContext, useImportOpeningInvoices, useInvoiceImportBatches, useRemoveOpeningInvoiceImport,
  type ImportResult, type InvoiceImportBatch,
} from "@/lib/import/zoho-opening-invoices.queries";

const MAX_BYTES = 8 * 1024 * 1024;

/** Who may import (the RPC checks the same roles). Unknown role (loading) → allowed. */
export function canImportOpeningInvoices(role: string | null | undefined): boolean {
  if (!role) return true;
  return role === "owner" || role === "manager" || role === "accountant";
}

const VERDICT: Record<PreviewRow["verdict"], { label: string; kind: "success" | "muted" | "warning" | "danger" }> = {
  import: { label: "Will import", kind: "success" },
  already: { label: "Already imported", kind: "muted" },
  no_customer: { label: "Customer not found", kind: "warning" },
  problem: { label: "Cannot import", kind: "danger" },
};

export function ImportZohoInvoicesDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<Preview | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const importMut = useImportOpeningInvoices();

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
    if (f.size > MAX_BYTES) { setReadError("This file is larger than 8 MB. Export fewer invoices (only Unpaid, Overdue and Partially Paid) and try again."); return; }
    setReading(true);
    try {
      const text = await f.text();
      const read = readZohoInvoiceCsv(text);
      if (read.missingColumns.length) {
        setReadError(`This does not look like a Zoho Books invoice export — these columns are missing: ${read.missingColumns.join(", ")}. In Zoho Books open Sales → Invoices → Export and choose CSV.`);
        return;
      }
      const ctx = await fetchImportContext();
      setFileName(f.name);
      setPreview(buildPreview(read.invoices, ctx.customers, ctx.existingNumbers));
    } catch (err) {
      setReadError(`The file could not be read: ${err instanceof Error ? err.message : String(err)}. Check your connection and choose the file again.`);
    } finally {
      setReading(false);
    }
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_ZOHO_INVOICE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "zoho-invoices-sample.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const doImport = () => {
    if (!preview || preview.toImport.length === 0) return;
    importMut.mutate(
      { rows: toImportRpcRows(preview.rows), fileName },
      {
        onSuccess: (r) => {
          setResult(r);
          toast.success(`${r.imported} invoice${r.imported === 1 ? "" : "s"} imported from Zoho — ${rupee(r.total_balance)} due`);
        },
      },
    );
  };

  const n = preview?.toImport.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-3xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="upload" size={18} className="text-amber" />
            Import open invoices from Zoho
          </DialogTitle>
          <DialogDescription className="break-words">
            Brings over what customers still owe on Zoho Books invoices. They appear in dues, aging,
            statements and reminders and can take payments. Their GST and revenue stay in Zoho — they are
            not counted again in GST returns, the P&amp;L or e-invoicing, and keep their Zoho number.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <ResultView result={result} />
        ) : !preview ? (
          <div className="space-y-4">
            <div className="rounded-md bg-paper-2 border border-hairline px-4 py-3 text-xs text-ink-2 space-y-1">
              <p className="font-semibold text-ink">Get the file from Zoho Books</p>
              <p>Sales → Invoices → filter <b>Unpaid</b>, <b>Overdue</b> and <b>Partially Paid</b> → Export → CSV.</p>
              <p>Only invoices with a Balance above ₹0 are imported. Customers are matched by GSTIN, else by exact name.</p>
              <Button type="button" variant="ghost" size="sm" icon="download" onClick={downloadSample} className="mt-1 -ml-2">
                Download a sample CSV
              </Button>
            </div>

            <label htmlFor="zoho-inv-csv" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer",
              "hover:bg-paper-2/40 transition-colors focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">{reading ? "Reading the file…" : "Choose the Zoho invoice CSV"}</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB</p>
              <input ref={fileRef} id="zoho-inv-csv" type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" disabled={reading} />
            </label>
            {readError && (
              <p role="alert" className="text-xs text-rose-ink inline-flex items-start gap-1.5">
                <Icon name="alert" size={13} className="mt-0.5 shrink-0" />{readError}
              </p>
            )}
            <PastImports enabled={open} />
          </div>
        ) : (
          <PreviewView preview={preview} fileName={fileName} onReset={reset} />
        )}

        <DialogFooter>
          {result ? (
            <Button type="button" variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importMut.isPending}>
                Cancel
              </Button>
              {preview && n > 0 && (
                <Button type="button" variant="primary" loading={importMut.isPending} onClick={doImport}>
                  Import {n} invoice{n === 1 ? "" : "s"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewView({ preview, fileName, onReset }: { preview: Preview; fileName: string | null; onReset: () => void }) {
  const c = preview.counts;
  /* Problems first — they need the owner; then what will import; then already imported. */
  const order: Record<PreviewRow["verdict"], number> = { problem: 0, no_customer: 1, import: 2, already: 3 };
  const rows = [...preview.rows].sort((a, b) => order[a.verdict] - order[b.verdict]);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink break-all">{fileName}</p>
          <p className="text-sm text-ink mt-1" data-testid="zoho-import-summary">
            <b>{c.import}</b> invoice{c.import === 1 ? "" : "s"} to import · <b>{rupee(preview.totalBalance)}</b> due
          </p>
          <p className="text-xs text-ink-3 mt-1 inline-flex items-center gap-1.5 flex-wrap">
            {c.already > 0 && <Badge kind="muted" size="sm">{c.already} already imported</Badge>}
            {c.noCustomer > 0 && <Badge kind="warning" size="sm">{c.noCustomer} customer not found</Badge>}
            {c.problem > 0 && <Badge kind="danger" size="sm">{c.problem} cannot import</Badge>}
            {c.nothingDue > 0 && <span>{c.nothingDue} fully paid left out</span>}
            {c.draftOrVoid > 0 && <span>· {c.draftOrVoid} draft / void left out</span>}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" icon="x" onClick={onReset}>Choose another file</Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">No invoice in this file has money still due.</p>
      ) : (
        <div className="border border-hairline rounded-md overflow-hidden">
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                <tr>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Invoice</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Customer</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3 whitespace-nowrap">Due date</th>
                  <th scope="col" className="p-2 text-right font-semibold text-ink-3">Balance</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.number} className={cn(
                    "border-b border-hairline last:border-0 align-top",
                    r.verdict === "problem" && "bg-rose/5",
                    r.verdict === "no_customer" && "bg-amber-soft/40",
                  )}>
                    <td className="p-2 font-mono text-2xs text-ink whitespace-nowrap">{r.number}</td>
                    <td className="p-2 text-ink-2 min-w-[9rem]">
                      {r.matchedCustomer ? (
                        <>
                          <span className="font-medium text-ink">{r.matchedCustomer}</span>
                          <span className="block text-3xs text-ink-3">matched by {r.matchedBy === "gstin" ? "GSTIN" : "name"}</span>
                        </>
                      ) : r.customerName}
                    </td>
                    <td className="p-2 text-ink-2 whitespace-nowrap">{r.dueDate ? formatDate(r.dueDate) : "—"}</td>
                    <td className="p-2 text-right tabular-nums font-medium text-ink whitespace-nowrap">
                      {rupee(r.balance)}
                      <span className="block text-3xs text-ink-3 font-normal">of {rupee(r.total)}</span>
                    </td>
                    <td className="p-2 min-w-[11rem]">
                      <Badge kind={VERDICT[r.verdict].kind} size="sm">{VERDICT[r.verdict].label}</Badge>
                      {r.verdict !== "import" && r.verdict !== "already" && r.message && (
                        <span className="block text-3xs text-ink-2 mt-1">{r.message}</span>
                      )}
                      {r.notes.map((t) => <span key={t} className="block text-3xs text-ink-3 mt-1">{t}</span>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {c.noCustomer > 0 && (
        <p className="text-xs text-ink-3">
          Customers not found are not imported. Add them in{" "}
          <Link href={"/customers" as never} target="_blank" className="underline text-ink hover:text-amber-ink">Customers</Link>{" "}
          (with their GSTIN), then upload the same file again — what is already imported is skipped.
        </p>
      )}
    </div>
  );
}

function ResultView({ result }: { result: ImportResult }) {
  return (
    <div className="space-y-3" role="status">
      <div className="rounded-md bg-emerald-soft border border-emerald/30 px-4 py-3 text-sm text-ink">
        <p className="font-semibold inline-flex items-center gap-2"><Icon name="check_circle" size={16} className="text-emerald" />
          {result.imported} invoice{result.imported === 1 ? "" : "s"} imported — {rupee(result.total_balance)} now due
        </p>
        <p className="text-xs text-ink-2 mt-1">
          They are in Invoices with the badge “Imported from Zoho”, and in Payments, Aging and customer statements.
        </p>
      </div>
      {result.skipped.length > 0 && (
        <p className="text-xs text-ink-2">
          Skipped (already imported): <span className="font-mono">{result.skipped.join(", ")}</span>
        </p>
      )}
    </div>
  );
}

function PastImports({ enabled }: { enabled: boolean }) {
  const { data: batches } = useInvoiceImportBatches(enabled);
  const { data: me } = useCurrentUser();
  const canRemove = canDeleteMoney(me?.role);
  if (!batches || batches.length === 0) return null;
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Past imports</p>
      <ul className="space-y-1.5">
        {batches.map((b) => <PastImportRow key={b.id} b={b} canRemove={canRemove} />)}
      </ul>
    </div>
  );
}

function PastImportRow({ b, canRemove }: { b: InvoiceImportBatch; canRemove: boolean }) {
  const [asking, setAsking] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const remove = useRemoveOpeningInvoiceImport();
  const removed = !!b.removed_at;
  return (
    <li className="rounded-md border border-hairline bg-paper px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="min-w-0">
          <span className="font-medium text-ink break-all">{b.file_name ?? "Zoho import"}</span>
          <span className="text-ink-3"> · {formatDate(b.created_at)} · {b.row_count} invoice{b.row_count === 1 ? "" : "s"} · {rupee(b.total_balance)}</span>
        </span>
        {removed ? (
          <Badge kind="muted" size="sm" title={b.remove_reason ?? undefined}>Removed {formatDate(b.removed_at!)}</Badge>
        ) : canRemove && b.row_count > 0 && !asking ? (
          <Button type="button" size="sm" variant="ghost" icon="trash" onClick={() => setAsking(true)}>Remove import</Button>
        ) : null}
      </div>
      {asking && !removed && (
        <form
          className="mt-2 flex items-center gap-2 flex-wrap"
          onSubmit={(e) => {
            e.preventDefault();
            remove.mutate({ batchId: b.id, reason }, {
              onSuccess: (r) => { toast.success(`Import removed — ${r.removed} invoice${r.removed === 1 ? "" : "s"} taken out`); setAsking(false); },
            });
          }}
        >
          <label htmlFor={`rm-${b.id}`} className="sr-only">Why are you removing this import?</label>
          <Input id={`rm-${b.id}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why? e.g. wrong file" className="h-8 w-56" />
          <Button type="submit" size="sm" variant="danger" loading={remove.isPending} disabled={reason.trim().length < 3}>
            Remove {b.row_count} invoice{b.row_count === 1 ? "" : "s"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
        </form>
      )}
    </li>
  );
}
