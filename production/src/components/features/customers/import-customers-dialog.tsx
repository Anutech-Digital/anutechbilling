/**
 * ImportCustomersDialog — bulk-import customers from a .csv file.
 *
 * Built for migrating from Zoho (Books/Billing exports) and similar. The column
 * matcher recognises a simple ResellerOS header AND common Zoho export headers
 * (Customer Number / Company Name / Display Name / First Name / Last Name /
 * Email / Mobile Phone / GST Identification Number (GSTIN) / Billing State /
 * Place Of Supply).
 *
 * Mapping → customers:
 *   - customer_number  ← "Customer Number" (stable join key for subscriptions)
 *   - name             ← First + Last (fallback: Company Name)
 *   - contact_name     ← First + Last
 *   - contact_email    ← Email      (Zoho "-No Value-" placeholders → blank)
 *   - contact_phone    ← Mobile Phone (fallback Phone)
 *   - gstin / state / state_code (state_code derived from GSTIN, else state name)
 *   - notes            ← "Company: <Company Name>" so the company isn't lost
 *
 * Dedup: by customer_number (primary), else by email — within the file AND
 * against existing customers in this tenant.
 *
 * Inserts are chunked (500/batch) so large migrations (1000+ rows) don't hit
 * payload limits.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { readAllRows, existingCustomerKeys, type ExistingCustomerRow } from "./import-existing";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { cn, GST_STATE_BY_CODE, gstStateFromGstin } from "@/lib/utils";

const CSV_HEADER = "customer_number,first_name,last_name,company_name,email,mobile_phone,gstin,billing_state";
const SAMPLE_CSV = [
  CSV_HEADER,
  `CUS-00001,Aravinder,Singh,DELUX SPORTS INTERNATIONAL,arvinder@deluxsports.com,+917889077965,03AAFFD8232J1ZL,Punjab`,
  `CUS-00002,Siddharth,Jain,PKS Developers Pvt Ltd.,info@pksdevelopers.com,9810562000,,Delhi`,
].join("\n");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// state name (lowercased) → GST state code, derived from the canonical map.
const STATE_NAME_TO_CODE: Record<string, string> = Object.entries(GST_STATE_BY_CODE)
  .reduce((acc, [code, name]) => { acc[name.toLowerCase()] = code; return acc; }, {} as Record<string, string>);

/** Zoho exports write "-No Value-" for empty cells — treat as blank. */
function nv(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t || t.toLowerCase() === "-no value-") return "";
  return t;
}

interface ParsedRow {
  rowNum: number;
  customer_number?: string;
  name: string;
  contact_name?: string;
  company?: string;
  contact_email?: string;
  contact_phone?: string;
  gstin?: string;
  state?: string;
  state_code?: string;
  error?: string;
  dup?: boolean;
}

interface ImportCustomersDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
}

export function ImportCustomersDialog({ open, onOpenChange, onImportComplete }: ImportCustomersDialogProps) {
  const { data: me } = useCurrentUser();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = React.useState<ParsedRow[] | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [existingNums, setExistingNums] = React.useState<Set<string>>(new Set());
  const [existingEmails, setExistingEmails] = React.useState<Set<string>>(new Set());

  // Load existing customer_numbers + emails (this tenant, via RLS) to flag dupes.
  React.useEffect(() => {
    if (!open) {
      setParsed(null);
      setFileName(null);
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    (async () => {
      const supabase = createClient();
      try {
        // R-295: every customer, not the first 1000 — else #1001+ re-import as duplicates.
        const rows = await readAllRows<ExistingCustomerRow>(supabase, "customers", "id, contact_email, customer_number");
        const { nums, emails } = existingCustomerKeys(rows);
        setExistingNums(nums);
        setExistingEmails(emails);
      } catch (e) {
        toastError(e, { description: "Existing customers didn't load, so duplicates can't be checked. Close and reopen." });
      }
    })();
  }, [open]);

  const downloadSample = () => {
    const blob = new Blob([SAMPLE_CSV], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "customers-sample.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error("File too large (over 8 MB).", {
        description: "Split it into smaller CSV files and import them one after another.",
      });
      return;
    }
    setFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseCustomersCsv(text, existingNums, existingEmails);
      if (rows.length === 0) {
        toast.error("No rows found in this file.", {
        description: "The first row must be the header (name, email, …) with customers below it. Download the sample CSV to see the layout.",
      });
        return;
      }
      setParsed(rows);
    } catch (err) {
      toastError(err, {
        fallback: "Couldn't read the file.",
        description: "Save it as CSV (UTF-8) from Excel or Google Sheets and choose it again.",
      });
    }
  };

  const handleImport = async () => {
    if (!parsed || !me) return;
    const valid = parsed.filter((r) => !r.error && !r.dup);
    if (valid.length === 0) {
      toast.error("No new customers to import.", {
        description: "Every row is either already in Customers or has an error — fix the rows marked red, or choose another file.",
      });
      return;
    }
    setImporting(true);
    // Counted outside the try, so a failure part-way can say how many rows already went in.
    let inserted = 0;
    try {
      const supabase = createClient();
      const payload = valid.map((r) => ({
        tenant_id: me.tenantId,
        customer_number: r.customer_number || null,
        name: r.name,
        contact_name: r.contact_name || null,
        contact_email: r.contact_email || null,
        contact_phone: r.contact_phone || null,
        gstin: r.gstin || null,
        state: r.state || null,
        state_code: r.state_code || null,
      }));

      // Chunked insert so 1000+ rows don't hit payload limits.
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error } = await supabase.from("customers").insert(chunk);
        if (error) throw error;
        inserted += chunk.length;
      }

      const skipped = parsed.length - valid.length;
      /* R-174: rows whose state did not map to a GST state are imported, not hidden — but said so. */
      const noState = valid.filter((r) => !r.state_code).length;
      toast.success(
        `Imported ${inserted} customer${inserted === 1 ? "" : "s"}` +
        (skipped > 0 ? ` · ${skipped} skipped` : ""),
        noState > 0 ? { description: `${noState} without a state — pick it in Customers → "State missing" before invoicing them.` } : undefined,
      );
      onImportComplete?.();
      onOpenChange(false);
    } catch (err) {
      toastError(err, {
        fallback: "Import failed.",
        description: inserted > 0
          ? `${inserted} customer${inserted === 1 ? " was" : "s were"} imported before it stopped. Close and reopen Import before trying again — rows with a customer number or email already in Customers then show as "already exist".`
          : "Nothing was imported. Check your connection and press Import again.",
      });
    } finally {
      setImporting(false);
    }
  };

  const validCount = parsed?.filter((r) => !r.error && !r.dup).length ?? 0;
  const dupCount   = parsed?.filter((r) => r.dup && !r.error).length ?? 0;
  const noStateCount = parsed?.filter((r) => !r.error && !r.dup && !r.state_code).length ?? 0;
  const errorCount = parsed?.filter((r) => r.error).length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-2xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="download" size={18} className="text-amber" />
            Import customers
          </DialogTitle>
          <DialogDescription className="break-words">
            Upload a CSV (export from Zoho as CSV, or Save-As CSV from Excel). Zoho columns
            (Customer Number, First/Last Name, Company Name, Email, Mobile Phone, GSTIN, Billing State)
            map automatically; "-No Value-" cells are treated as blank.
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="space-y-4">
            <div className="rounded-md bg-amber-soft/60 border border-amber/30 px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="text-sm text-amber-ink min-w-0">
                <p className="font-semibold">Pehli baar? Sample file download karo.</p>
                <p className="text-xs opacity-90 mt-0.5">Header + example rows. Zoho ka export bhi seedha chalega.</p>
              </div>
              <Button type="button" variant="default" size="sm" icon="download"
                onClick={downloadSample} className="sm:shrink-0 w-full sm:w-auto justify-center">
                Download sample.csv
              </Button>
            </div>

            <label htmlFor="cust-csv-file" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg",
              "p-8 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose a CSV file</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB</p>
              <input ref={fileInputRef} id="cust-csv-file" type="file" accept=".csv,text/csv"
                onChange={handleFileChange} className="sr-only" />
            </label>

            <div className="text-xs text-ink-3">
              <p className="font-semibold uppercase tracking-wider mb-1.5 text-3xs">Recognised columns</p>
              <code className="block bg-paper-2 border border-hairline rounded-md px-3 py-2 font-mono text-2xs overflow-x-auto">
                {CSV_HEADER}
              </code>
              <p className="mt-2">
                Name = <span className="font-semibold text-ink">First + Last</span> (Company Name fallback). Customer Number
                is the stable key used to attach subscriptions later.
              </p>
            </div>
          </div>
        )}

        {parsed && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink min-w-0">
                <p className="font-semibold truncate">{fileName}</p>
                <p className="text-xs text-ink-3 mt-0.5 inline-flex items-center gap-2 flex-wrap">
                  <Badge kind="success" size="sm">{validCount} new</Badge>
                  {dupCount > 0 && <Badge kind="warning" size="sm">{dupCount} already exist</Badge>}
                  {noStateCount > 0 && <Badge kind="warning" size="sm" title="No GST state — their invoice will be refused until a state is picked">{noStateCount} without state</Badge>}
                  {errorCount > 0 && <Badge kind="danger" size="sm">{errorCount} skipped</Badge>}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" icon="x"
                onClick={() => { setParsed(null); setFileName(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                Choose another file
              </Button>
            </div>

            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[280px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3 w-8">#</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Cust&nbsp;No</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Company (name)</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Contact</th>
                      <th className="p-2 text-left font-semibold text-ink-3">State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 300).map((r) => (
                      <tr key={r.rowNum} className={cn(
                        "border-b border-hairline last:border-0",
                        r.error && "bg-rose/5",
                        r.dup && !r.error && "bg-amber-soft/40",
                      )}>
                        <td className="p-2 text-ink-3 tabular-nums">{r.rowNum}</td>
                        <td className="p-2 text-ink-2 font-mono text-3xs">{r.customer_number || "—"}</td>
                        <td className="p-2">
                          {r.error ? (
                            <span className="text-rose inline-flex items-center gap-1">
                              <Icon name="alert" size={11} />{r.error}
                            </span>
                          ) : (
                            <span className="font-medium text-ink">
                              {r.name}
                              {r.dup && <span className="ml-1.5 text-3xs text-amber-ink">(already exists)</span>}
                            </span>
                          )}
                        </td>
                        <td className="p-2 text-ink-2">{r.contact_name || <span className="text-ink-3">—</span>}</td>
                        <td className="p-2 text-ink-2">{r.state_code ? r.state : <span className="text-amber-ink">{r.state ? `${r.state} — not a GST state` : "State missing"}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-ink-3">
              New customers import into <span className="font-semibold text-ink">{me?.tenantName ?? "your tenant"}</span>.
              Rows whose Customer Number (or email) already exists are skipped.
              {parsed.length > 300 && <> Showing first 300 of {parsed.length} rows.</>}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
            Cancel
          </Button>
          {parsed && validCount > 0 && (
            <Button type="button" variant="primary" loading={importing} onClick={handleImport}>
              Import {validCount} customer{validCount === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CSV parsing — recognises ResellerOS + Zoho column names.
// ============================================================
function parseCustomersCsv(text: string, existingNums: Set<string>, existingEmails: Set<string>): ParsedRow[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row + at least one data row.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const col = (aliases: string[]): number => {
    for (const a of aliases) { const i = header.indexOf(a); if (i >= 0) return i; }
    return -1;
  };

  const idxNum     = col(["customer_number", "customer number", "customer no", "customer id"]);
  const idxCompany = col(["company name", "company_name", "company"]);
  const idxDisplay = col(["display name", "display_name", "customer name", "customer_name", "name"]);
  const idxFirst   = col(["first_name", "first name", "firstname"]);
  const idxLast    = col(["last_name", "last name", "lastname"]);
  const idxContact = col(["contact_name", "contact name", "primary contact", "contact person"]);
  const idxEmail   = col(["contact_email", "email", "emailid", "email id", "email address"]);
  const idxMobile  = col(["mobile_phone", "mobile phone", "mobilephone", "mobile"]);
  const idxPhone   = col(["contact_phone", "phone"]);
  const idxGstin   = col(["gstin", "gst_no", "gst no", "gst identification number (gstin)", "gst identification number", "gst"]);
  const idxState   = col(["billing_state", "billing state", "state", "place of supply", "place_of_supply", "shipping state"]);

  if (idxFirst === -1 && idxCompany === -1 && idxDisplay === -1 && idxContact === -1) {
    throw new Error("Couldn't find a name column (First Name / Company Name / Display Name).");
  }

  const seenNum = new Set<string>();
  const seenEmail = new Set<string>();
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const rowNum = i + 1;
    const cell = (idx: number) => (idx >= 0 ? nv(cols[idx]) : "");

    const first = cell(idxFirst);
    const last  = cell(idxLast);
    const company = cell(idxCompany);
    const display = cell(idxDisplay);
    const contact = cell(idxContact);

    // Customer name = Company (B2B standard); Primary Contact = person (First+Last).
    const person = [first, last].filter(Boolean).join(" ").trim();
    const name = company || person || display || contact;
    const contact_name = person || contact || display || undefined;
    if (!name) {
      rows.push({ rowNum, name: "", error: "Missing name" });
      continue;
    }

    const customer_number = cell(idxNum) || undefined;
    const email = cell(idxEmail);
    const gstin = cell(idxGstin);
    const stateRaw = cell(idxState);
    // State name: a 2-letter code like "PB"/"DL" isn't a GST state name, so prefer
    // GSTIN-derived code, then a full state-name match.
    const fromGstin = gstin ? gstStateFromGstin(gstin) : { code: null, name: null };
    const stateName = stateRaw.length > 2 ? stateRaw : (fromGstin.name ?? stateRaw);
    const stateCode = fromGstin.code ?? (stateName ? STATE_NAME_TO_CODE[stateName.toLowerCase()] : undefined) ?? undefined;

    // Dedup: customer_number first (stable), else email.
    let dup = false;
    const numKey = customer_number?.toLowerCase();
    const emailKey = email.toLowerCase();
    if (numKey) {
      if (existingNums.has(numKey) || seenNum.has(numKey)) dup = true;
      seenNum.add(numKey);
    } else if (emailKey) {
      if (existingEmails.has(emailKey) || seenEmail.has(emailKey)) dup = true;
      seenEmail.add(emailKey);
    }

    rows.push({
      rowNum,
      customer_number,
      name,
      contact_name,
      company: company || undefined,
      contact_email: email && EMAIL_RE.test(email) ? email : (email || undefined),
      contact_phone: (cell(idxMobile) || cell(idxPhone)) || undefined,
      gstin: gstin || undefined,
      state: stateName || undefined,
      state_code: stateCode,
      dup,
    });
  }
  return rows;
}

function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuote = false;
      else cur += ch;
    } else if (ch === '"') inQuote = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
