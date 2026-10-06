/**
 * ImportSubscriptionsDialog — bulk-import existing subscriptions from a CSV
 * (Zoho Billing "GWS_Subscription_Import" style), matching each row to a
 * customer by Customer Number.
 *
 * Migration mode: these are pre-existing live services, so they're inserted
 * directly as subscription rows (no fake quote/payment/invoice money-spine).
 *
 * Mapping → subscriptions:
 *   - customer        ← matched via Customer Number → customers.customer_number
 *   - plan            ← Item Name (normalised: "Google Workspace - X" → "Google Workspace X")
 *   - vendor          ← derived from plan (google / microsoft / zoho / other)
 *   - seats           ← Quantity
 *   - mrr (₹/month)   ← (Item Price × Quantity) ÷ period-months, where the period
 *                       is inferred from Start↔End dates (monthly→÷1, quarterly→÷3,
 *                       annual→÷12). Commitment is recorded as annual.
 *   - start_date      ← Start Date   (Excel serial OR date string → ISO)
 *   - renewal_date    ← End Date
 *   - domain          ← Domain Name
 *
 * MONEY-HONESTY: the dry-run preview shows each line's computed MRR + the total
 * MRR/ARR so the operator verifies the money before committing. Nothing is
 * written until "Import" is clicked.
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
import { readAllRows, type ExistingCustomerRow } from "@/components/features/customers/import-existing";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  buildImportDedupeIndex, duplicateReason,
  type ImportDedupeIndex, type TrackedSubscription,
} from "@/lib/subscriptions/import-dedupe";
import { mapHeader, monthlyRateFrom, periodMonths } from "@/lib/export/subscription-portable";
import { attachPrimaryContact } from "@/lib/contacts/attach";
import { withStateCode } from "@/lib/gst/gstin-state";
import { cn, rupee, formatDate } from "@/lib/utils";

interface ParsedSub {
  rowNum: number;
  customer_number: string;
  customer_id?: string;
  customer_name?: string;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  seats: number;
  mrr: number;
  periodMonths: number;
  start_date?: string;
  renewal_date?: string;
  domain?: string;
  error?: string;   // unmatched / invalid → skipped
  /** Set when this subscription is already on file. Skipped, never merged. */
  duplicate?: string;
  /* ── Carried for a row whose customer does not exist yet ──────────────────
     The portable export writes the customer's identity and their primary contact
     alongside the subscription, so a restore can rebuild the customer rather than
     skipping the row. The contact is mandatory for that: this app refuses to create a
     customer with nobody on it. */
  customer_gstin?: string;
  customer_state?: string;
  contact_name?: string;
  contact_email?: string;
  contact_phone?: string;
  /** The customer NAME as the file spells it — only used when creating. */
  file_customer_name?: string;
  /** Google's own seat count, so a restore does not lose the reconciliation. */
  vendor_seats?: number;
  /** True when this row will create the customer as well as the subscription. */
  willCreateCustomer?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportComplete?: () => void;
}

export function ImportSubscriptionsDialog({ open, onOpenChange, onImportComplete }: Props) {
  const { data: me } = useCurrentUser();
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = React.useState<ParsedSub[] | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  // customer_number(lower) → { id, name }
  const [custMap, setCustMap] = React.useState<Map<string, { id: string; name: string }>>(new Map());
  const [domainMap, setDomainMap] = React.useState<Map<string, { id: string; name: string }>>(new Map());
  /** Subscriptions already on file, indexed by domain and by customer+plan. */
  const [dedupe, setDedupe] = React.useState<ImportDedupeIndex>(() => buildImportDedupeIndex([]));

  React.useEffect(() => {
    if (!open) {
      setParsed(null); setFileName(null); setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    (async () => {
      const supabase = createClient();
      /* Both lookups in one round trip. The second is the duplicate guard: this importer
         inserts every matched row and never asked whether the subscription was already
         here, which is correct for the one-time Zoho migration it was built for and
         wrong every time after. See lib/subscriptions/import-dedupe.ts. */
      /* R-295: every row, not the first 1000 — both lookups paged past PostgREST's cap. */
      let data: ExistingCustomerRow[], subs: TrackedSubscription[];
      try {
        [data, subs] = await Promise.all([
          readAllRows<ExistingCustomerRow>(supabase, "customers", "id, name, customer_number, domain"),
          readAllRows<TrackedSubscription>(supabase, "subscriptions", "id, domain, customer_id, plan"),
        ]);
      } catch (e) {
        toastError(e, { description: "Existing customers and subscriptions didn't load, so duplicates can't be checked. Close and reopen." });
        return;
      }
      const m = new Map<string, { id: string; name: string }>();
      /* Domain is the SECOND way in, for a portable export whose customer numbers do not
         exist in this workspace — restoring into a fresh app, or moving between them. */
      const d = new Map<string, { id: string; name: string }>();
      data.forEach((c) => {
        if (c.customer_number) m.set(c.customer_number.trim().toLowerCase(), { id: c.id, name: c.name });
        if (c.domain) d.set(c.domain.trim().toLowerCase().replace(/^www\./, ""), { id: c.id, name: c.name });
      });
      setCustMap(m);
      setDomainMap(d);
      setDedupe(buildImportDedupeIndex(subs));
    })();
  }, [open]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error("File too large (>8 MB)."); return; }
    setFileName(file.name);
    try {
      const text = await file.text();
      const rows = parseSubsCsv(text, custMap, domainMap).map((r) => ({
        ...r,
        /* Only worth asking for rows that matched a customer — an unmatched row is
           already being skipped and a second reason would just be noise. */
        duplicate: r.error ? undefined : (duplicateReason(r, dedupe) ?? undefined),
      }));
      if (rows.length === 0) { toast.error("No rows found (header + data needed)."); return; }
      setParsed(rows);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read the file");
    }
  };

  const handleImport = async () => {
    if (!parsed || !me) return;
    /* A row is importable when it has a customer OR can create one. `willCreateCustomer`
       is only set when the file carried a contact name and email, because this app refuses
       to create a customer with nobody on it. */
    const valid = parsed.filter((r) => !r.error && !r.duplicate && (r.customer_id || r.willCreateCustomer));
    if (valid.length === 0) {
      const dupes = parsed.filter((r) => r.duplicate).length;
      toast.error(
        dupes > 0 ? "Every matched subscription is already in the app" : "No matched subscriptions to import.",
        dupes > 0
          ? { description: `${dupes} row${dupes === 1 ? " was" : "s were"} skipped because that domain already has a subscription. Nothing was imported — re-importing would have created a second copy of each.` }
          : { description: "No row matched a customer by Customer Number. Check the file has that column, and that the numbers match your customers." },
      );
      return;
    }
    setImporting(true);
    try {
      const supabase = createClient();

      /* ── Customers the file brings with it ──────────────────────────────────
         Created BEFORE the subscriptions, and each one gets its contact person in the
         same step — the same writer the Add Subscription dialog and the Customers page
         use, so a restored customer is indistinguishable from one created by hand.

         A customer whose contact cannot be written is removed again and its rows are
         reported, rather than left on the books with nobody to invoice. That is the same
         rule the rest of the app follows; a restore is not an excuse to break it. */
      const createFailures: string[] = [];
      for (const r of valid.filter((x) => x.willCreateCustomer)) {
        const name = r.file_customer_name || r.domain || r.customer_number || "Unnamed customer";
        const { data: created, error: custErr } = await supabase
          .from("customers")
          // R-173: withStateCode turns the file's state (or a valid GSTIN) into state_code —
          // without it these customers could never be invoiced ("no state on record").
          .insert(withStateCode({
            tenant_id: me.tenantId,
            name,
            domain: r.domain ?? null,
            gstin: r.customer_gstin ?? null,
            state: r.customer_state ?? null,
            state_code: null as string | null,
            customer_number: r.customer_number || null,
            contact_name: r.contact_name ?? null,
            contact_email: r.contact_email ?? null,
            contact_phone: r.contact_phone ?? null,
          }) as never)
          .select("id")
          .single();
        if (custErr || !created?.id) {
          createFailures.push(`${name}: ${custErr?.message ?? "the customer could not be created"}`);
          r.error = "could not create the customer";
          continue;
        }
        const outcome = await attachPrimaryContact(supabase, {
          tenantId: me.tenantId,
          customerId: created.id,
          name: r.contact_name!,
          email: r.contact_email ?? null,
          phone: r.contact_phone ?? null,
          role: "poc",
          company: name,
        });
        if (outcome.kind === "failed") {
          await supabase.from("customers").delete().eq("id", created.id);
          createFailures.push(`${name}: ${outcome.reason}`);
          r.error = "the contact could not be saved, so the customer was not created";
          continue;
        }
        r.customer_id = created.id;
        r.customer_name = name;
      }

      /* Rows whose customer creation just failed drop out here rather than inserting a
         subscription pointing at nothing. */
      const insertable = valid.filter((r) => r.customer_id && !r.error);
      if (insertable.length === 0) {
        setImporting(false);
        toast.error("Nothing could be imported", {
          description: createFailures[0] ?? "Every row was refused. Open the preview to see why.",
        });
        return;
      }

      const payload = insertable.map((r) => ({
        tenant_id: me.tenantId,
        customer_id: r.customer_id!,
        customer_name: r.customer_name ?? "",
        plan: r.plan,
        vendor: r.vendor,
        seats: r.seats,
        used: 0,
        mrr: r.mrr,
        start_date: r.start_date ?? null,
        renewal_date: r.renewal_date ?? null,
        status: "active" as const,
        domain: r.domain ?? null,
        outstanding_amount: 0,
        auto_renew: true,
        /* Carried through so a restore does not lose the reconciliation — otherwise every
           restored row reads "never checked against the vendor" and the licence-leakage
           card has to be rebuilt by hand. */
        vendor_seats: r.vendor_seats ?? null,
        vendor_synced_at: r.vendor_seats == null ? null : new Date().toISOString(),
      }));
      let inserted = 0;
      for (let i = 0; i < payload.length; i += 500) {
        const chunk = payload.slice(i, i + 500);
        const { error } = await supabase.from("subscriptions").insert(chunk);
        if (error) throw error;
        inserted += chunk.length;
      }
      /* Duplicates counted SEPARATELY from unmatched rows. "12 skipped" reads as a
         problem with the file; "12 already in the app" reads as the guard working. */
      const dupes = parsed.filter((r) => r.duplicate).length;
      const unmatchedCount = parsed.filter((r) => r.error).length;
      const createdCustomers = insertable.filter((r) => r.willCreateCustomer).length;
      toast.success(
        `Imported ${inserted} subscription${inserted === 1 ? "" : "s"}`,
        (dupes > 0 || unmatchedCount > 0 || createdCustomers > 0)
          ? {
              description: [
                createdCustomers > 0 ? `${createdCustomers} new customer${createdCustomers === 1 ? "" : "s"} created from the file` : null,
                dupes > 0 ? `${dupes} already in the app, left alone` : null,
                unmatchedCount > 0 ? `${unmatchedCount} skipped` : null,
              ].filter(Boolean).join(" · "),
              duration: 9000,
            }
          : undefined,
      );
      onImportComplete?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  };

  /* `matched` drives the Subscriptions / MRR / ARR tiles AND the import itself, so it has
     to mean "will actually be written". Counting duplicates here would show an MRR total
     that includes revenue already in the app — the operator verifies that number before
     committing, and it would be wrong in the direction that looks fine. */
  const matched = parsed?.filter((r) => !r.error && !r.duplicate && (r.customer_id || r.willCreateCustomer)) ?? [];
  const newCustomers = parsed?.filter((r) => !r.error && !r.duplicate && r.willCreateCustomer) ?? [];
  const duplicates = parsed?.filter((r) => r.duplicate) ?? [];
  const unmatched = parsed?.filter((r) => r.error) ?? [];
  const totalMRR = matched.reduce((s, r) => s + r.mrr, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-3xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="refresh" size={18} className="text-amber" />
            Import subscriptions
          </DialogTitle>
          <DialogDescription className="break-words">
            Reads this app&apos;s own <b>Export</b> file — so a subscription list can be moved
            between workspaces or restored from a backup. A row attaches by{" "}
            <span className="font-mono text-2xs">Customer Number</span> or{" "}
            <span className="font-mono text-2xs">Domain</span>, and creates the customer when
            neither is on file. A Zoho Billing export still works too.
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="space-y-4">
            <label htmlFor="sub-csv-file" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-8 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={28} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose a CSV file</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB · import customers first (subs match by Customer Number)</p>
              <input ref={fileInputRef} id="sub-csv-file" type="file" accept=".csv,text/csv" onChange={handleFileChange} className="sr-only" />
            </label>
            {custMap.size === 0 && (
              <p className="text-xs text-rose">No customers with a Customer Number found yet — import customers (with the Customer Number column) first, else nothing will match.</p>
            )}
          </div>
        )}

        {parsed && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink min-w-0">
                <p className="font-semibold truncate">{fileName}</p>
                <p className="text-xs text-ink-3 mt-0.5 inline-flex items-center gap-2 flex-wrap">
                  <Badge kind="success" size="sm">{matched.length} to import</Badge>
                  {/* A row that brings its own customer is a normal import, not a warning —
                      but the operator should know the file is about to create records
                      beyond the subscriptions they asked for. */}
                  {newCustomers.length > 0 && (
                    <Badge kind="info" size="sm">{newCustomers.length} new customer{newCustomers.length === 1 ? "" : "s"}</Badge>
                  )}
                  {/* Amber, not rose: an already-imported row is the guard working, not a
                      broken file. Rose is reserved for rows that matched nothing. */}
                  {duplicates.length > 0 && (
                    <Badge kind="warning" size="sm">{duplicates.length} already in the app</Badge>
                  )}
                  {unmatched.length > 0 && <Badge kind="danger" size="sm">{unmatched.length} no customer</Badge>}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" icon="x"
                onClick={() => { setParsed(null); setFileName(null); if (fileInputRef.current) fileInputRef.current.value = ""; }}>
                Choose another file
              </Button>
            </div>

            {/* Money summary — verify before commit */}
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Subscriptions</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5">{matched.length}</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total MRR</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5 text-emerald">{rupee(totalMRR)}</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
                <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Total ARR</div>
                <div className="text-sm font-semibold tabular-nums mt-0.5">{rupee(totalMRR * 12, { compact: true })}</div>
              </div>
            </div>

            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[280px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3 w-8">#</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Customer</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Plan</th>
                      <th className="p-2 text-right font-semibold text-ink-3">Seats</th>
                      <th className="p-2 text-right font-semibold text-ink-3">MRR</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Renewal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {parsed.slice(0, 300).map((r) => (
                      <tr key={r.rowNum} className={cn(
                        "border-b border-hairline last:border-0",
                        r.error ? "bg-rose/5" : r.duplicate ? "bg-amber-soft/30" : "",
                      )}>
                        <td className="p-2 text-ink-3 tabular-nums">{r.rowNum}</td>
                        <td className="p-2">
                          {r.error
                            ? <span className="text-rose inline-flex items-center gap-1"><Icon name="alert" size={11} />{r.customer_number}: {r.error}</span>
                            : r.duplicate
                              /* Names the row AND why it is being left out. "Skipped" on
                                 its own sends the operator hunting for a problem that is
                                 not there. */
                              ? <span className="text-amber-ink inline-flex items-center gap-1"><Icon name="check_circle" size={11} />{r.customer_name} — {r.duplicate}</span>
                              : r.willCreateCustomer
                              ? <span className="text-ink">{r.customer_name} <span className="text-2xs text-amber-ink">· new customer</span></span>
                              : <span className="text-ink">{r.customer_name}</span>}
                        </td>
                        <td className="p-2 text-ink-2">{r.plan}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.seats}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.error || r.duplicate ? "—" : rupee(r.mrr)}</td>
                        <td className="p-2 text-ink-2">{r.renewal_date ? formatDate(r.renewal_date) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <p className="text-xs text-ink-3">
              Matched subs import into <span className="font-semibold text-ink">{me?.tenantName ?? "your tenant"}</span> as <b>active</b>.
              {" "}A row whose customer is not on file <b>creates one</b>, using the Customer,
              GSTIN, State and Contact columns — which is why the export carries them.
              A row with no contact name and email cannot create a customer and is skipped.
              {duplicates.length > 0 && (
                <>
                  {" "}<b>Already in the app</b> = that domain has a subscription here, so the row is
                  left out — importing it again would create a second copy. The existing one is
                  not changed.
                </>
              )}
              {parsed.length > 300 && <> Showing first 300 of {parsed.length} rows.</>}
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>Cancel</Button>
          {parsed && matched.length > 0 && (
            <Button type="button" variant="primary" loading={importing} onClick={handleImport}>
              Import {matched.length} subscription{matched.length === 1 ? "" : "s"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// CSV parsing + money/date derivation
// ============================================================
function nv(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t || t.toLowerCase() === "-no value-") return "";
  return t;
}

/**
 * Parse a date cell → ISO yyyy-mm-dd. Handles:
 *   - Excel serial (e.g. 46200)
 *   - DD-MM-YYYY / DD/MM/YYYY (Indian, day-first) — with optional " HH:MM" time
 *   - YYYY-MM-DD (ISO)
 *   - 2-digit years (→ 20YY)
 * Day-first is assumed for ambiguous dd/mm (Indian convention).
 */
function toISODate(v: string): string | null {
  const s = nv(v);
  if (!s) return null;

  // Excel serial number
  const n = Number(s);
  if (Number.isFinite(n) && n > 20000 && n < 80000) {
    const ms = Date.UTC(1899, 11, 30) + Math.round(n) * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }

  // Strip any time component, then split d/m/y on -, / or .
  const datePart = s.split(/[ T]/)[0];
  const m = datePart.match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})$/);
  if (m) {
    const a = m[1], b = m[2], c = m[3];
    let yyyy: string, mm: string, dd: string;
    if (a.length === 4) { yyyy = a; mm = b; dd = c; }          // YYYY-MM-DD
    else { dd = a; mm = b; yyyy = c.length <= 2 ? `20${c.padStart(2, "0")}` : c; }  // DD-MM-YYYY (Indian)
    const iso = `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
    if (!isNaN(new Date(`${iso}T00:00:00Z`).getTime())) return iso;
  }

  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function vendorFor(plan: string): ParsedSub["vendor"] {
  const p = plan.toLowerCase();
  if (p.includes("google")) return "google";
  if (p.includes("microsoft") || p.includes("m365") || p.includes("office")) return "microsoft";
  if (p.includes("zoho")) return "zoho";
  return "other";
}

/**
 * Read a subscription CSV — the app's own portable export first, a Zoho Billing file second.
 *
 * Header mapping and the money rule both live in `lib/export/subscription-portable.ts`, so
 * the reader and the writer cannot drift. That file explains why the monthly rate is its
 * own column and why a missing period is REFUSED rather than assumed to be a year.
 */
function parseSubsCsv(
  text: string,
  custMap: Map<string, { id: string; name: string }>,
  byDomain: Map<string, { id: string; name: string }>,
): ParsedSub[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header row + at least one data row.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));
  const idx = mapHeader(header);

  if (idx.plan === -1) {
    throw new Error("Couldn't find a Plan / Item Name column — that is the one column every row needs.");
  }
  /* A file with neither a customer number nor a domain cannot be attached to anybody.
     Saying so once, up front, beats every row failing individually. */
  if (idx.customerNumber === -1 && idx.domain === -1) {
    throw new Error("Couldn't find a 'Customer Number' or 'Domain' column — one of them is needed to attach each row to a customer.");
  }

  const rows: ParsedSub[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseLine(lines[i]);
    const rowNum = i + 1;
    const cell = (at: number) => (at >= 0 ? nv(cols[at]) : "");
    const num = (at: number) => { const v = cell(at); return v === "" ? null : (Number(v) || 0); };

    const customer_number = cell(idx.customerNumber);
    const rawPlan = cell(idx.plan);
    const plan = rawPlan.replace(/\s*-\s*/, " ").trim() || rawPlan;  // "Google Workspace - Business Starter" → "…Business Starter"
    const seats = Math.max(0, Math.round(Number(cell(idx.seats)) || 0));
    const domain = cell(idx.domain) || undefined;
    const start = toISODate(cell(idx.start));
    const end = toISODate(cell(idx.end));

    const months = periodMonths(start ?? null, end ?? null);
    const rate = monthlyRateFrom(num(idx.monthly), num(idx.itemPrice), seats, months);

    const base: ParsedSub = {
      rowNum, customer_number,
      plan: plan || "—",
      vendor: vendorFor(plan),
      seats,
      mrr: rate.ok ? rate.mrr : 0,
      periodMonths: months ?? 0,
      start_date: start ?? undefined,
      renewal_date: end ?? undefined,
      domain,
      /* Carried so a row whose customer does not exist yet can CREATE one — this app
         refuses to create a customer with no contact person. */
      customer_gstin: cell(idx.gstin) || undefined,
      customer_state: cell(idx.state) || undefined,
      contact_name: cell(idx.contactName) || undefined,
      contact_email: cell(idx.contactEmail) || undefined,
      contact_phone: cell(idx.contactPhone) || undefined,
      file_customer_name: cell(idx.customerName) || undefined,
      vendor_seats: idx.vendorSeats >= 0 && cell(idx.vendorSeats) !== "" ? Number(cell(idx.vendorSeats)) : undefined,
    };

    /* Customer number first, domain second — the number is an identifier somebody chose,
       the domain is an identifier the service imposes. Both beat the company NAME, which
       is typed differently every time it is typed. */
    const match =
      (customer_number ? custMap.get(customer_number.toLowerCase()) : undefined)
      ?? (domain ? byDomain.get(domain.trim().toLowerCase().replace(/^www\./, "")) : undefined);

    if (!plan || seats <= 0) { rows.push({ ...base, error: "missing plan or seats" }); continue; }
    if (!rate.ok)            { rows.push({ ...base, error: rate.reason }); continue; }
    if (match) { rows.push({ ...base, customer_id: match.id, customer_name: match.name }); continue; }

    /* No customer on file. That is not an error any more — the row can create one, as
       long as it carries a contact person. Without that the customer cannot be created
       at all, so say which column is missing rather than a bare "not found". */
    if (base.contact_name && base.contact_email) {
      rows.push({ ...base, customer_name: base.file_customer_name ?? domain ?? customer_number, willCreateCustomer: true });
    } else {
      rows.push({
        ...base,
        error: customer_number || domain
          ? "no such customer, and the file has no Contact Name + Contact Email to create one"
          : "no customer number or domain",
      });
    }
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
