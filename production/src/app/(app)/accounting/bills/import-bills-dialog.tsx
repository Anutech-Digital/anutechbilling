/**
 * R-2324 — "Import bills" on the COGS Bills page. One distributor payment can cover 40–54 bills
 * (R-2319); typing each before reconciling the bank line is not practical.
 *
 * Upload a CSV (Zoho Books bill export, or the simple template) → preview: every bill with the
 * vendor it matched, its amount, or why it will not come in (vendor not found, already in the
 * books, a cell that cannot be read) → Import → result.
 *
 * Saving: the SAME vendor_bills insert Add Bill does (fields from toVendorBillInserts), all good
 * bills of the file in ONE insert statement — atomic per file: either every bill shown as "Will
 * import" is saved, or none is (e.g. a bill dated in a closed month) and the error says why, so
 * a half-imported file never needs untangling. Each bill is written to the activity log by the
 * table's own audit trigger (trg_activity_vendor_bills), as when it is added by hand, and its
 * notes say which file it came from. Re-uploading the same file skips what is already in.
 */
"use client";

import * as React from "react";
import Link from "next/link";
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
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { toastError } from "@/lib/errors/toast-error";
import { useVendors } from "@/lib/queries/vendors";
import { useOwnStateCode } from "@/lib/queries/vendor-bills";
import {
  SAMPLE_BILL_CSV, buildBillImportPreview, readBillCsv, toVendorBillInserts,
  type BillPreview, type BillPreviewRow, type ExistingBillKey,
} from "@/lib/accounting/bill-import";

const MAX_BYTES = 8 * 1024 * 1024;

const VERDICT: Record<BillPreviewRow["verdict"], { label: string; kind: "success" | "muted" | "warning" | "danger" }> = {
  import: { label: "Will import", kind: "success" },
  already: { label: "Already in the books", kind: "muted" },
  no_vendor: { label: "Vendor not found", kind: "warning" },
  problem: { label: "Cannot import", kind: "danger" },
  skipped: { label: "Left out", kind: "muted" },
};

async function fetchExistingBillKeys(): Promise<ExistingBillKey[]> {
  const supabase = createClient();
  return fetchAllRows<ExistingBillKey>((from, to) =>
    supabase.from("vendor_bills").select("vendor_id, vendor_name, bill_no")
      .not("bill_no", "is", null)
      .order("id", { ascending: true })
      .range(from, to));
}

export function ImportBillsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<BillPreview | null>(null);
  const [readError, setReadError] = React.useState<string | null>(null);
  const [reading, setReading] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [result, setResult] = React.useState<{ count: number; total: number; skipped: string[] } | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const vendorsQ = useVendors();
  const ownState = useOwnStateCode();
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
    if (f.size > MAX_BYTES) { setReadError("This file is larger than 8 MB. Export fewer bills (only the open ones) and try again."); return; }
    setReading(true);
    try {
      const read = readBillCsv(await f.text());
      if (read.missingColumns.length) {
        setReadError(`These columns are missing: ${read.missingColumns.join(", ")}. Use the Zoho Books bill export (Purchases → Bills → Export → CSV) or the sample below.`);
        return;
      }
      const [vendors, existing] = await Promise.all([
        vendorsQ.data ? Promise.resolve(vendorsQ.data) : vendorsQ.refetch().then((r) => r.data ?? []),
        fetchExistingBillKeys(),
      ]);
      const own = ownState.data ?? (await ownState.refetch()).data ?? null;
      setFileName(f.name);
      setPreview(buildBillImportPreview(read.bills, vendors, existing, own));
    } catch (err) {
      setReadError(`The file could not be read: ${err instanceof Error ? err.message : String(err)}. Check your connection and choose the file again.`);
    } finally {
      setReading(false);
    }
  };

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_BILL_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "bill-import-sample.csv";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
      const rows = toVendorBillInserts(preview.toImport, { fileName: fileName ?? "CSV file", stamp: Date.now().toString(36).toUpperCase() })
        .map((r) => ({ ...r, tenant_id: me.tenant_id }));
      /* One statement → all bills or none (see the header). */
      const { error } = await supabase.from("vendor_bills").insert(rows);
      if (error) throw error;
      const total = preview.toImport.reduce((s, r) => s + r.total, 0);
      setResult({ count: rows.length, total, skipped: preview.rows.filter((r) => r.verdict === "already").map((r) => r.billNo) });
      qc.invalidateQueries({ queryKey: ["vendor_bills"] });
      qc.invalidateQueries({ queryKey: ["vendors"] });
      toast.success(`${rows.length} bill${rows.length === 1 ? "" : "s"} imported — ${rupee(total)}`);
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
            Import bills
          </DialogTitle>
          <DialogDescription className="break-words">
            Add many vendor bills at once from a CSV — they come in unpaid, exactly as if added with Add Bill,
            ready to be ticked when you reconcile the bank payment.
          </DialogDescription>
        </DialogHeader>

        {result ? (
          <div className="space-y-3" role="status">
            <div className="rounded-md bg-emerald-soft border border-emerald/30 px-4 py-3 text-sm text-ink">
              <p className="font-semibold inline-flex items-center gap-2"><Icon name="check_circle" size={16} className="text-emerald" />
                {result.count} bill{result.count === 1 ? "" : "s"} imported — {rupee(result.total)}
              </p>
              <p className="text-xs text-ink-2 mt-1">They are in the list below as Unpaid. In Banking, open the vendor&apos;s payment line and tick them in Reconcile.</p>
            </div>
            {result.skipped.length > 0 && (
              <p className="text-xs text-ink-2">Skipped (already in the books): <span className="font-mono">{result.skipped.join(", ")}</span></p>
            )}
          </div>
        ) : !preview ? (
          <div className="space-y-4">
            <div className="rounded-md bg-paper-2 border border-hairline px-4 py-3 text-xs text-ink-2 space-y-1">
              <p className="font-semibold text-ink">The file</p>
              <p>Zoho Books: Purchases → Bills → Export → CSV. Or one row per bill with: <b>Vendor Name</b>, Vendor GSTIN, <b>Bill Number</b>, <b>Bill Date</b>, Due Date, <b>Taxable Value</b>, CGST, SGST, IGST (or one GST column), Category.</p>
              <p>Vendors are matched by GSTIN, else by exact name — add a missing vendor on the Vendors page first. A bill already in the books (same vendor and bill number) is skipped.</p>
              <Button type="button" variant="ghost" size="sm" icon="download" onClick={downloadSample} className="mt-1 -ml-2">
                Download a sample CSV
              </Button>
            </div>
            <label htmlFor="bill-import-csv" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer",
              "hover:bg-paper-2/40 transition-colors focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">{reading ? "Reading the file…" : "Choose the bills CSV"}</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB</p>
              <input ref={fileRef} id="bill-import-csv" type="file" accept=".csv,text/csv" onChange={onFile} className="sr-only" disabled={reading} />
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
                  Import {n} bill{n === 1 ? "" : "s"}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewView({ preview, fileName, onReset }: { preview: BillPreview; fileName: string | null; onReset: () => void }) {
  const c = preview.counts;
  /* Problems first — they need the owner; then what will import; then what is skipped. */
  const order: Record<BillPreviewRow["verdict"], number> = { problem: 0, no_vendor: 1, import: 2, already: 3, skipped: 4 };
  const rows = [...preview.rows].sort((a, b) => order[a.verdict] - order[b.verdict]);
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink break-all">{fileName}</p>
          <p className="text-sm text-ink mt-1" data-testid="bill-import-summary">
            <b>{c.import}</b> bill{c.import === 1 ? "" : "s"} to import · <b>{rupee(preview.totalAmount)}</b>
          </p>
          <p className="text-xs text-ink-3 mt-1 inline-flex items-center gap-1.5 flex-wrap">
            {c.already > 0 && <Badge kind="muted" size="sm">{c.already} already in the books</Badge>}
            {c.noVendor > 0 && <Badge kind="warning" size="sm">{c.noVendor} vendor not found</Badge>}
            {c.problem > 0 && <Badge kind="danger" size="sm">{c.problem} cannot import</Badge>}
            {c.skipped > 0 && <span>{c.skipped} draft / void left out</span>}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" icon="x" onClick={onReset}>Choose another file</Button>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-3">No bills found in this file.</p>
      ) : (
        <div className="border border-hairline rounded-md overflow-hidden">
          <div className="max-h-[340px] overflow-y-auto">
            <table className="w-full text-xs">
              <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                <tr>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Bill</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Vendor</th>
                  <th scope="col" className="p-2 text-right font-semibold text-ink-3">Amount</th>
                  <th scope="col" className="p-2 text-left font-semibold text-ink-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={`${r.lines[0]}`} className={cn(
                    "border-b border-hairline last:border-0 align-top",
                    r.verdict === "problem" && "bg-rose/5",
                    r.verdict === "no_vendor" && "bg-amber-soft/40",
                  )}>
                    <td className="p-2 whitespace-nowrap">
                      <span className="font-mono text-2xs text-ink">{r.billNo || "—"}</span>
                      <span className="block text-3xs text-ink-3">{r.billDate ? formatDate(r.billDate) : "—"} · line {r.lines.join(", ")}</span>
                    </td>
                    <td className="p-2 text-ink-2 min-w-[9rem]">
                      <span className="font-medium text-ink">{r.vendorName || "—"}</span>
                      {r.matchedBy && <span className="block text-3xs text-ink-3">matched by {r.matchedBy === "gstin" ? "GSTIN" : "name"} · {r.category}</span>}
                    </td>
                    <td className="p-2 text-right tabular-nums font-medium text-ink whitespace-nowrap">
                      {r.verdict === "problem" ? "—" : rupee(r.total)}
                      {r.verdict !== "problem" && (
                        <span className="block text-3xs text-ink-3 font-normal">
                          {rupee(r.taxable)} + GST {rupee(r.cgst + r.sgst + r.igst)}{r.igst > 0 ? " IGST" : r.cgst > 0 ? " CGST+SGST" : ""}
                        </span>
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
      {c.noVendor > 0 && (
        <p className="text-xs text-ink-3">
          Bills whose vendor is not found are not imported. Add the vendor in{" "}
          <Link href={"/accounting/vendors" as never} target="_blank" className="underline text-ink hover:text-amber-ink">Vendors</Link>{" "}
          (with its GSTIN), then upload the same file again — bills already in are skipped.
        </p>
      )}
    </div>
  );
}
