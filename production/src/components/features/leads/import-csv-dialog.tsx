/**
 * ImportCsvDialog — bulk-upload leads from a .csv file.
 *
 * Same 4 fields as the Quick add lead form:
 *   company (required) · contact_name · contact_email · contact_phone
 *
 * Workflow:
 *   1. User clicks "Download sample CSV" to learn the header format, OR
 *      drags-and-drops / selects a file directly.
 *   2. Parser reads the file client-side, validates each row.
 *      - Missing `company`  →  flagged as error (row skipped on import)
 *      - Invalid email      →  flagged as warning (row still imported)
 *   3. Preview table shows valid rows + errors with row numbers.
 *   4. User clicks "Import N leads" → batch insert via Supabase.
 *
 * Imported leads land in the same shape as a Quick-added lead:
 *   stage = "new", source = "csv", priority = "medium", owner = current user.
 *   Plan / seats / value / GSTIN intentionally NOT supported here — keep
 *   bulk capture fast; qualification happens later in the drawer.
 *
 * Parser is hand-written (no papaparse dep) — handles quoted strings +
 * escaped quotes ("") + commas inside quotes. Fine for the 4-column
 * format we ship; if we ever ship richer CSV (with notes containing
 * newlines), lift to papaparse then.
 *
 * @example
 *   <ImportCsvDialog
 *     open={open}
 *     onOpenChange={setOpen}
 *     onImportComplete={() => refetchLeads()}
 *   />
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { cn } from "@/lib/utils";

// ──────────────────────────────────────────────────────────────
// Sample CSV — single source of truth for the download button +
// the placeholder text users see when they open the dialog.
// ──────────────────────────────────────────────────────────────
const CSV_HEADER = "company,contact_name,contact_email,contact_phone";
const SAMPLE_CSV = [
  CSV_HEADER,
  `Acme Corp Pvt Ltd,Rajesh Kumar,rajesh@acme.com,+91 98765 43210`,
  `Wayne Industries,Bruce Wayne,bruce@wayne.com,+91 99999 12345`,
  `Globex Solutions,Mira Patel,mira@globex.co.in,+91 87654 32109`,
  `"Trim, Inc",Anita Rao,anita@trim.in,+91 90000 11111`,
].join("\n");

// Loose email regex — just catches the most common typos.
// Not strict RFC 5322; we don't need to reject "a@b" since the user
// might legitimately want to save it and fix later.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ParsedRow {
  rowNum:        number;       // 1-based, matches the user's spreadsheet
  company:       string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  error?:        string;       // blocks import for this row
  warning?:      string;       // imports but flagged
}

interface ImportCsvDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after successful import. Parent should refetch leads. */
  onImportComplete?: () => void;
}

export function ImportCsvDialog({ open, onOpenChange, onImportComplete }: ImportCsvDialogProps) {
  const { data: me } = useCurrentUser();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [parsed,    setParsed]    = React.useState<ParsedRow[] | null>(null);
  const [fileName,  setFileName]  = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);

  // Reset state whenever the dialog closes so reopening is clean.
  React.useEffect(() => {
    if (!open) {
      setParsed(null);
      setFileName(null);
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open]);

  // ── Sample download ────────────────────────────────────────
  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "leads-sample.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // ── File picker → parse ────────────────────────────────────
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      toast.error("File too large (over 2 MB)", { description: "Split it into smaller CSV files and import them one by one." });
      return;
    }
    setFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) {
        toast.error("No rows found", { description: "The file needs a header row plus at least one data row. Download the sample to see the format." });
        return;
      }
      setParsed(rows);
    } catch (err) {
      toastError(err, { fallback: "Couldn't read the file", description: "Save it as a CSV (comma separated) and pick it again." });
    }
  };

  // ── Batch insert ───────────────────────────────────────────
  const handleImport = async () => {
    if (!parsed || !me) return;
    const valid = parsed.filter((r) => !r.error);
    if (valid.length === 0) {
      toast.error("No valid rows to import", { description: "Every row needs a company name. Fix the file and pick it again." });
      return;
    }

    setImporting(true);
    try {
      const supabase = createClient();
      // ID generation matches Quick add — base36 timestamp + per-row index
      // so collisions are essentially impossible within a single batch.
      const stamp = Date.now().toString(36).toUpperCase();
      const payload = valid.map((r, i) => ({
        id:            `L-${stamp}-${i}`,
        tenant_id:     me.tenantId,
        company:       r.company,
        contact_name:  r.contact_name  || null,
        contact_email: r.contact_email || null,
        contact_phone: r.contact_phone || null,
        stage:         "new" as const,
        source:        "csv",
        priority:      "medium" as const,
        owner_id:      me.userId || null,
        /* The third create path, and it needs this as much as the other two: an imported
           batch is exactly the kind a colleague reassigns in bulk afterwards, which is when
           owner_id stops answering who brought the leads in. */
        created_by:    me.userId || null,
      }));

      const { error } = await supabase.from("leads").insert(payload);
      if (error) throw error;

      const skipped = parsed.length - valid.length;
      toast.success(
        `Imported ${valid.length} lead${valid.length === 1 ? "" : "s"}` +
        (skipped > 0 ? ` · ${skipped} row${skipped === 1 ? "" : "s"} skipped` : ""),
      );
      onImportComplete?.();
      onOpenChange(false);
    } catch (err) {
      toastError(err, { fallback: "Import failed", description: "No leads were added. Try again; if it repeats, import a smaller file." });
    } finally {
      setImporting(false);
    }
  };

  // Counts for the preview header
  const validCount   = parsed?.filter((r) => !r.error).length ?? 0;
  const errorCount   = parsed?.filter((r) => r.error).length ?? 0;
  const warningCount = parsed?.filter((r) => r.warning && !r.error).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="download" size={18} className="text-amber" />
            Bulk import leads
          </DialogTitle>
          <DialogDescription className="break-words">
            Upload a CSV. 4 fields: company (required), contact name, email, phone.
          </DialogDescription>
        </DialogHeader>

        {/* Step 1 — sample download + file picker */}
        {!parsed && (
          <div className="space-y-4">
            {/* Sample download banner */}
            <div className="rounded-md bg-amber-soft/60 border border-amber/30 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-sm text-amber-ink min-w-0">
                <p className="font-semibold">First time? Download the sample file.</p>
                <p className="text-xs opacity-90 mt-0.5">
                  Header row + 4 example rows. Open in Excel/Sheets to add your leads.
                </p>
              </div>
              <Button
                type="button"
                variant="default"
                size="sm"
                icon="download"
                onClick={downloadSample}
                className="sm:shrink-0 w-full sm:w-auto justify-center"
              >
                Download sample.csv
              </Button>
            </div>

            {/* File picker — also the drop zone */}
            <label
              htmlFor="csv-file"
              className={cn(
                "block border-2 border-dashed border-hairline-strong rounded-lg",
                "p-8 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
                "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
              )}
            >
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose a CSV file</p>
              <p className="text-xs text-ink-3 mt-1">
                Up to 2 MB · Same column order as the sample
              </p>
              <input
                ref={fileInputRef}
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={handleFileChange}
                className="sr-only"
              />
            </label>

            {/* Expected columns reference */}
            <div className="text-xs text-ink-3">
              <p className="font-semibold uppercase tracking-wider mb-1.5 text-3xs">Expected header</p>
              <code className="block bg-paper-2 border border-hairline rounded-md px-3 py-2 font-mono text-xs overflow-x-auto">
                {CSV_HEADER}
              </code>
              <p className="mt-2">
                Only <span className="font-semibold text-ink">company</span> is required.
                Empty cells for the rest are fine.
              </p>
            </div>
          </div>
        )}

        {/* Step 2 — parsed preview */}
        {parsed && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink min-w-0">
                <p className="font-semibold truncate">{fileName}</p>
                <p className="text-xs text-ink-3 mt-0.5 inline-flex items-center gap-2 flex-wrap">
                  <Badge kind="success" size="sm">{validCount} ready</Badge>
                  {errorCount > 0 && <Badge kind="danger" size="sm">{errorCount} skipped</Badge>}
                  {warningCount > 0 && <Badge kind="warning" size="sm">{warningCount} warning</Badge>}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                icon="x"
                onClick={() => {
                  setParsed(null);
                  setFileName(null);
                  if (fileInputRef.current) fileInputRef.current.value = "";
                }}
              >
                Choose another file
              </Button>
            </div>

            {/* Preview table — scrolls if many rows */}
            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[280px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3 w-8">#</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Company</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Contact</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Email</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Phone</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.map((r) => (
                      <tr
                        key={r.rowNum}
                        className={cn(
                          "border-b border-hairline last:border-0",
                          r.error && "bg-rose/5",
                          r.warning && !r.error && "bg-amber-soft/40",
                        )}
                      >
                        <td className="p-2 text-ink-3 tabular-nums">{r.rowNum}</td>
                        <td className="p-2">
                          {r.error ? (
                            <span className="text-rose inline-flex items-center gap-1">
                              <Icon name="alert" size={11} />
                              {r.error}
                            </span>
                          ) : (
                            <span className="font-medium text-ink">{r.company}</span>
                          )}
                        </td>
                        <td className="p-2 text-ink-2">{r.contact_name || <span className="text-ink-3">—</span>}</td>
                        <td className="p-2 text-ink-2 font-mono">
                          {r.contact_email || <span className="text-ink-3 font-sans">—</span>}
                          {r.warning && (
                            <span className="ml-1.5 text-xs text-amber-ink">({r.warning})</span>
                          )}
                        </td>
                        <td className="p-2 text-ink-2 font-mono">{r.contact_phone || <span className="text-ink-3 font-sans">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {validCount > 0 ? (
              <p className="text-xs text-ink-3">
                All leads will land in your <span className="font-semibold text-ink">Inbox</span> as
                <span className="font-semibold text-ink"> New</span> · source
                <span className="font-mono text-ink"> csv</span> · owner = you.
              </p>
            ) : (
              <p className="text-xs text-rose">
                No valid rows. Every row needs a company name — fix the file and retry.
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={importing}
          >
            Cancel
          </Button>
          {parsed && validCount > 0 && (
            <Button
              type="button"
              variant="primary"
              loading={importing}
              onClick={handleImport}
            >
              Import {validCount} lead{validCount === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CSV parsing — hand-rolled. Handles:
//   - Quoted strings:        "Acme, Inc",Rajesh,…
//   - Escaped quotes:        "She said ""hi""",…
//   - Trailing empty fields: ,,,
//   - CRLF + LF line endings
//
// Does NOT handle (intentionally — out of scope):
//   - Multi-line cells (newline inside a quoted string)
//   - BOM marker (Excel often saves with UTF-8 BOM — we strip it below)
// ============================================================
function parseCsv(text: string): ParsedRow[] {
  // Strip BOM if Excel added one.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) {
    throw new Error("CSV needs a header row + at least one data row.");
  }

  // Resolve column indices from header (allow re-ordered columns).
  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idxCompany = header.indexOf("company");
  if (idxCompany === -1) {
    throw new Error("Header missing required column: company");
  }
  const idxName  = header.indexOf("contact_name");
  const idxEmail = header.indexOf("contact_email");
  const idxPhone = header.indexOf("contact_phone");

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const rowNum = i + 1;

    const company = (cols[idxCompany] ?? "").trim();
    if (!company) {
      rows.push({ rowNum, company: "", error: "Missing company name" });
      continue;
    }

    const email = idxEmail >= 0 ? (cols[idxEmail] ?? "").trim() : "";
    const warning = email && !EMAIL_RE.test(email) ? "looks malformed" : undefined;

    rows.push({
      rowNum,
      company,
      contact_name:  idxName  >= 0 ? (cols[idxName]  ?? "").trim() || undefined : undefined,
      contact_email: email || undefined,
      contact_phone: idxPhone >= 0 ? (cols[idxPhone] ?? "").trim() || undefined : undefined,
      warning,
    });
  }
  return rows;
}

/** Split a single CSV line into cells. Handles quoted strings + escaped quotes. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuote = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuote = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}
