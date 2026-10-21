/**
 * ReconcileGoogleDialog — compare the app's subscriptions against the Google
 * Workspace reseller-panel export (Partner Sales Console → "Download customers").
 *
 * The Google panel is the source of truth for what's actually provisioned/billed.
 * Match key = the **service domain** (Google "Customer" column ↔ app subscription.domain).
 *
 * READ-ONLY: this is a diagnostic report. It never writes to the DB — it shows the
 * gap (and lets you download each bucket as CSV). Bulk-add of the missing subs is a
 * deliberate next step, after you've reviewed the report.
 *
 * MONEY-HONESTY: the Google export carries NO price. "Only in Google" MRR is an
 * ESTIMATE from the catalog (msrp × seats), clearly labelled — never confirmed.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/ui/badge";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useItems } from "@/lib/queries/items";
import { buildPlanPriceIndex, planKey } from "@/lib/subscriptions/plan-match";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";
import { createClient } from "@/lib/supabase/client";
import { rupee, cn } from "@/lib/utils";
import { PORTALS } from "@/components/shared/portal-dock";

type Bucket = "only_google" | "matched" | "only_app" | "suspended";

interface Row {
  domain: string;
  sku: string;
  seats: number;
  status: string;   // Active / Suspended / …
  renewal: string;
  estMrr?: number;  // only_google
  appSeats?: number; // matched (for diff)
  /** Set only when the domain has exactly ONE active app subscription, so the
   *  vendor seat count can be written back without splitting an aggregate. */
  appSubId?: string;
  /** How many active app subscriptions share this domain. */
  appSubCount?: number;
}

interface Report {
  googleActive: number;
  googleSuspended: number;
  appCount: number;
  estMissingMrr: number;        // monthly, active only_google
  buckets: Record<Bucket, Row[]>;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Opens Phase 2 — the "add missing subscriptions" matcher. */
  onAddMissing?: () => void;
}

const BUCKET_META: { id: Bucket; label: string; tone: "danger" | "success" | "warning" | "muted" }[] = [
  { id: "only_google", label: "Only in Google", tone: "danger" },
  { id: "matched",     label: "Matched",        tone: "success" },
  { id: "suspended",   label: "Suspended (billing risk)", tone: "warning" },
  { id: "only_app",    label: "Only in app",    tone: "muted" },
];

const RESELLER_CONSOLE_URL = PORTALS.find((p) => p.id === "google-reseller")!.url;

export function ReconcileGoogleDialog({ open, onOpenChange, onAddMissing }: Props) {
  const qc = useQueryClient();
  const { data: subs } = useSubscriptions();
  const { data: items } = useItems();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [report, setReport] = React.useState<Report | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [bucket, setBucket] = React.useState<Bucket>("only_google");
  const [visible, setVisible] = React.useState(60);

  React.useEffect(() => {
    if (!open) {
      setReport(null); setFileName(null); setBucket("only_google"); setVisible(60);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, [open]);
  React.useEffect(() => { setVisible(60); }, [bucket]);

  /* Keyed through planKey, not raw lowercase. Google's export says "Google Workspace
     Business Starter" and the catalogue row is "Google Workspace Starter" — an exact
     match misses, and on 24 Sep 2026 that imported four subscriptions at ₹0/month while
     their COST matched, because the cost side already normalised. See the price-side
     note in lib/subscriptions/plan-match.ts. */
  const priceIndex = React.useMemo(
    () => buildPlanPriceIndex((items ?? []).map((it) => ({
      /* R-1704: the R-205 Workspace list-price floor, the same rule as the quote builder. */
      name: it.name, vendor: it.vendor, msrpPerSeatMonth: floorWorkspaceRow(it).msrp,
    }))),
    [items],
  );
  const priceMap = React.useMemo(() => {
    /* The downstream parsers take a plain Map keyed by planKey; the index keeps the
       ambiguity guard, so a key two catalogue rows disagree on never reaches them. */
    const m = new Map<string, number>();
    for (const [k, v] of priceIndex.prices) m.set(k, v);
    return m;
  }, [priceIndex]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error("File too large (>8 MB)."); return; }
    setFileName(file.name);
    try {
      const text = await file.text();
      setReport(buildReport(text, subs ?? [], priceMap));
      setBucket("only_google");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't read the file");
    }
  }

  function downloadBucket() {
    if (!report) return;
    const rows = report.buckets[bucket];
    const cols = ["domain", "sku", "seats", "status", "renewal", "est_mrr"] as const;
    const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = [cols.join(",")];
    for (const r of rows) lines.push([r.domain, r.sku, r.seats, r.status, r.renewal, r.estMrr ?? ""].map(esc).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `reconcile-${bucket}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Downloaded ${rows.length} row${rows.length === 1 ? "" : "s"}`);
  }

  const rows = report?.buckets[bucket] ?? [];
  const shown = rows.slice(0, visible);

  /* Matched domains that can be written back without splitting an aggregate. A
     domain carrying several app subscriptions is deliberately excluded — see the
     comment where appSubId is set. */
  const savableRows = React.useMemo(
    () => (report?.buckets.matched ?? []).filter((r) => r.appSubId),
    [report],
  );
  const [savingSeats, setSavingSeats] = React.useState(false);

  const saveVendorSeats = async () => {
    if (savableRows.length === 0) return;
    setSavingSeats(true);
    try {
      const supabase = createClient();
      const now = new Date().toISOString();
      /* One update per subscription rather than an upsert: an upsert on this table
         would need every NOT NULL column and could resurrect a deleted row. */
      const results = await Promise.all(
        savableRows.map((r) =>
          supabase
            .from("subscriptions")
            .update({ vendor_seats: r.seats, vendor_synced_at: now })
            .eq("id", r.appSubId!),
        ),
      );
      const failed = results.filter((x) => x.error);
      if (failed.length > 0) throw new Error(failed[0].error!.message);

      /* ── TELL THE PAGE ITS DATA CHANGED ───────────────────────────────────
         These updates go through the Supabase client directly rather than through a
         mutation hook, so nothing invalidated the cache and the page behind this dialog
         kept rendering the rows it had loaded. The toast said "License leakage will now
         show a real figure", the dialog closed, and the card still read "10 never
         reconciled" — reported 21 Sep 2026 as "license leakage showing nothing here".

         Nothing was wrong with the write or with the card. The card had simply never
         been told, and only a hard refresh revealed it. That is the worst shape for this
         particular bug: the operator concludes the reconcile did not work and does it
         again.

         Invalidated BEFORE the toast, so the number behind the dialog is already right
         when the dialog closes. */
      await qc.invalidateQueries({ queryKey: ["subscriptions"] });

      const skipped = (report?.buckets.matched ?? []).length - savableRows.length;
      toast.success(`Saved vendor seat counts for ${savableRows.length} subscription${savableRows.length === 1 ? "" : "s"}.`, {
        description: skipped > 0
          ? `${skipped} domain${skipped === 1 ? "" : "s"} skipped — more than one app subscription shares them, so Google's per-domain total cannot be split without guessing.`
          : "License leakage on the subscriptions page will now show a real figure instead of “never reconciled”.",
        duration: 9000,
      });
      onOpenChange(false);
    } catch (e) {
      toast.error("Could not save the seat counts.", { description: (e as Error).message });
    } finally {
      setSavingSeats(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-4xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="inline-flex items-center gap-2">
            <Icon name="refresh" size={18} className="text-amber" /> Match Google&apos;s bill
          </DialogTitle>
          <DialogDescription className="break-words">
            Compares <b>what Google invoices you</b> against what you bill the customer.
            We match by <b>domain</b>. Read-only until you choose to save.
            {/* ── THE LINK, WHERE THE FILE IS ASKED FOR ──────────────────────
                Both console links already existed — on the DASHBOARD, in the portal
                dock. Which is no use here: this is the moment somebody needs the
                console, and being told to "upload the reseller export" without being
                told where it lives is the dead end §24 exists to stop. Asked directly on
                21 Sep 2026: "is this link somewhere?"

                Taken from the PORTALS constant rather than typed again, so there is one
                reviewed list of external URLs — see the note on that constant about why
                it is a source literal and not a database row. */}
            <span className="mt-1.5 block">
              Get it from{" "}
              <a
                href={RESELLER_CONSOLE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-amber-ink underline underline-offset-2 hover:opacity-80"
              >
                Partner Sales Console
              </a>{" "}
              → <b>Download customers</b>. One file covers every customer.
            </span>
          </DialogDescription>
        </DialogHeader>

        {!report && (
          <div className="space-y-3">
            {/* Live path — add the missing subs straight from the Reseller API. */}
            {onAddMissing && (
              <div className="rounded-lg border border-hairline bg-paper-2/40 p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
                    <Icon name="refresh" size={14} className="text-amber" /> Sync &amp; add live from Google
                  </p>
                  <p className="text-2xs text-ink-3 mt-0.5">
                    No file — pull every subscription via the Reseller API and add the missing ones (needs the API enabled + reseller scope).
                  </p>
                </div>
                <Button type="button" variant="primary" icon="refresh"
                  onClick={() => { onOpenChange(false); onAddMissing(); }}>
                  Sync from Google →
                </Button>
              </div>
            )}

            <div className="flex items-center gap-3 text-2xs text-ink-3">
              <div className="h-px flex-1 bg-hairline" /> or get the read-only report from a CSV <div className="h-px flex-1 bg-hairline" />
            </div>

            <label htmlFor="recon-file" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-6 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              "focus-within:ring-2 focus-within:ring-amber",
            )}>
              <Icon name="upload" size={24} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose the Google customers CSV</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB · the file with a <span className="font-mono">Customer / Sku / Subscription status</span> header</p>
              <input ref={fileRef} id="recon-file" type="file" accept=".csv,text/csv" onChange={handleFile} className="sr-only" />
            </label>
          </div>
        )}

        {report && (
          <div className="space-y-3">
            {/* Summary */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              <Stat label="Google subs (active)" value={String(report.googleActive)} />
              <Stat label="App subs" value={String(report.appCount)} />
              <Stat label="Matched domains" value={String(report.buckets.matched.length)} tone="emerald" />
              <Stat label="Only in Google (subs)" value={String(report.buckets.only_google.length)} tone="rose" />
              <Stat label="Missing ARR (est.)" value={rupee(report.estMissingMrr * 12, { compact: true })} tone="rose" />
              <Stat label="Suspended (billing risk)" value={String(report.buckets.suspended.length)} tone="amber" />
            </div>
            <p className="text-2xs text-ink-3">
              <b>Matched = domains</b> in both. One domain can carry several Google line-items (Business Starter + Vault + Storage), so the Google <i>subs</i> count is higher than matched <i>domains</i> — that's why matched stays ≤ your app subs.
              {" "}<b>"Only in Google"</b> = provisioned on Google but not tracked in the app. <b>Missing ARR is an estimate</b> (catalog price × seats) — verify the real rate before relying on it.
            </p>

            {/* Bucket selector */}
            <div className="flex flex-wrap gap-1.5">
              {BUCKET_META.map((b) => (
                <button key={b.id} type="button" onClick={() => setBucket(b.id)}
                  className={cn(
                    "text-xs px-2.5 py-1 rounded-md border transition-colors",
                    bucket === b.id ? "bg-amber text-white border-amber/0" : "bg-paper border-hairline text-ink-2 hover:bg-paper-2",
                  )}>
                  {b.label} <span className="tabular-nums opacity-80">{report.buckets[b.id].length}</span>
                </button>
              ))}
            </div>

            {/* Table */}
            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[320px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3">Domain</th>
                      <th className="p-2 text-left font-semibold text-ink-3">SKU</th>
                      <th className="p-2 text-right font-semibold text-ink-3">Seats</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Status</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Renewal</th>
                      {bucket === "only_google" && <th className="p-2 text-right font-semibold text-ink-3">Est. MRR</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r, i) => (
                      <tr key={i} className="border-b border-hairline last:border-0">
                        <td className="p-2 font-mono text-2xs text-ink">{r.domain}</td>
                        <td className="p-2 text-ink-2">{r.sku}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.seats}{r.appSeats != null && r.appSeats !== r.seats ? ` (app ${r.appSeats})` : ""}</td>
                        <td className="p-2"><Badge kind={r.status === "Active" ? "success" : "warning"} size="sm" dot>{r.status || "—"}</Badge></td>
                        <td className="p-2 text-ink-2">{r.renewal || "—"}</td>
                        {bucket === "only_google" && <td className="p-2 text-right tabular-nums text-ink-2">{r.estMrr ? rupee(r.estMrr) : "—"}</td>}
                      </tr>
                    ))}
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="p-6 text-center text-ink-3">Nothing in this bucket 🎉</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {rows.length > shown.length && (
                <button type="button" onClick={() => setVisible((v) => v + 100)}
                  className="w-full text-center py-2 text-xs text-amber-ink hover:bg-paper-2/50 border-t border-hairline">
                  Show more ({rows.length - shown.length} left)
                </button>
              )}
            </div>

            <p className="text-2xs text-ink-3">{fileName} · matched by domain. Read-only — no records changed.</p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {report && (
            <>
              <Button type="button" variant="default" icon="x" onClick={() => { setReport(null); setFileName(null); if (fileRef.current) fileRef.current.value = ""; }}>
                Another file
              </Button>
              <Button type="button" variant="default" icon="download" onClick={downloadBucket} disabled={rows.length === 0}>
                Download {BUCKET_META.find((b) => b.id === bucket)?.label} ({rows.length})
              </Button>
              {/* The one write this dialog does, and it writes only what Google
                  reported: the vendor's seat count and the date. It never touches
                  `seats` (what we bill) — changing what a customer is charged from a
                  CSV import would be a billing change nobody approved. */}
              <Button
                type="button"
                variant="default"
                icon="save"
                loading={savingSeats}
                disabled={savableRows.length === 0}
                title={savableRows.length === 0
                  ? "Nothing to save — matched domains need exactly one active app subscription each."
                  : undefined}
                onClick={saveVendorSeats}
              >
                Save vendor seat counts ({savableRows.length})
              </Button>
              {onAddMissing && (
                <Button type="button" variant="primary" icon="plus"
                  onClick={() => { onOpenChange(false); onAddMissing(); }}>
                  Add missing to app →
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" | "amber" }) {
  const c = tone === "rose" ? "text-rose" : tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber-ink" : "text-ink";
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums mt-0.5", c)}>{value}</div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
function normDomain(d: string): string {
  return (d || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

function buildReport(
  text: string,
  // `id` and `seats` are needed to write vendor_seats back and to show the seat diff.
  subs: { id: string; domain: string | null; status: string; seats: number }[],
  priceMap: Map<string, number>,
): Report {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) throw new Error("CSV needs a header + data rows.");

  const header = parseLine(lines[0]).map((h) => h.trim().toLowerCase());
  const col = (aliases: string[], contains = false) => {
    for (const a of aliases) {
      const i = contains ? header.findIndex((h) => h.includes(a)) : header.indexOf(a);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iDomain = col(["customer", "domain"]);
  const iSku    = col(["sku"]);
  const iStatus = col(["subscription status", "status"], true);
  const iSeats  = col(["purchased licenses", "purchased"], true);
  const iRenew  = col(["renewal date"], true);
  if (iDomain < 0 || iSku < 0) throw new Error("Couldn't find Customer/Sku columns — is this the Google customers export?");

  // App subscriptions by domain (normalized). Counts are per DOMAIN so the
  // summary reconciles (one domain can carry several Google line-items).
  const appAnyDomains = new Set<string>();
  const appActiveByDomain = new Map<string, number>();
  const appCountByDomain = new Map<string, number>();
  /* Seats and ids per domain, for the seat DIFF and for writing vendor_seats back.
     `appSeats` was declared on Row from the start and never assigned, so the seat
     gap it was meant to show has never once rendered. */
  const appSeatsByDomain = new Map<string, number>();
  const appActiveIdsByDomain = new Map<string, string[]>();
  for (const s of subs) {
    if (!s.domain) continue;
    const d = normDomain(s.domain);
    appAnyDomains.add(d);
    appCountByDomain.set(d, (appCountByDomain.get(d) ?? 0) + 1);
    if (s.status === "active") {
      appActiveByDomain.set(d, (appActiveByDomain.get(d) ?? 0) + 1);
      appSeatsByDomain.set(d, (appSeatsByDomain.get(d) ?? 0) + (s.seats ?? 0));
      appActiveIdsByDomain.set(d, [...(appActiveIdsByDomain.get(d) ?? []), s.id]);
    }
  }

  const buckets: Record<Bucket, Row[]> = { only_google: [], matched: [], only_app: [], suspended: [] };
  let googleActive = 0, googleSuspended = 0, estMissingMrr = 0;
  const googlePaidDomains = new Set<string>();
  const googleAggByDomain = new Map<string, { subs: number; seats: number }>();  // for the matched-domain summary

  for (let i = 1; i < lines.length; i++) {
    const cells = parseLine(lines[i]);
    const sku = (cells[iSku] ?? "").trim();
    if (!sku || sku === "-" || sku.toLowerCase() === "cloud identity free") continue;  // skip non-subs / free
    const domain = normDomain(cells[iDomain] ?? "");
    if (!domain) continue;
    const status = (cells[iStatus] ?? "").trim();
    const seats = Math.max(0, Math.round(Number(cells[iSeats] ?? 0) || 0));
    const renewal = (cells[iRenew] ?? "").trim().replace(/^"|"$/g, "");
    const isActive = /active/i.test(status);
    const isSusp = /suspend/i.test(status);
    if (isActive) googleActive++;
    if (isSusp) googleSuspended++;
    googlePaidDomains.add(domain);

    const inApp = appAnyDomains.has(domain);
    const row: Row = { domain, sku, seats, status: status || "—", renewal };

    if (isSusp && (appActiveByDomain.get(domain) ?? 0) > 0) {
      buckets.suspended.push(row);          // suspended on Google but active in app = billing risk
    }
    if (inApp) {
      const agg = googleAggByDomain.get(domain) ?? { subs: 0, seats: 0 };
      agg.subs += 1; agg.seats += seats;
      googleAggByDomain.set(domain, agg);    // aggregate — matched counted per domain (below)
    } else {
      const est = (priceMap.get(planKey(sku)) ?? 0) * seats;  // ₹/seat/mo × seats, keyed through planKey
      row.estMrr = est || undefined;
      if (isActive) estMissingMrr += est;
      buckets.only_google.push(row);
    }
  }

  // Matched = one row per DOMAIN in both (so matched ≤ app subs; numbers reconcile).
  for (const [domain, agg] of googleAggByDomain) {
    const ids = appActiveIdsByDomain.get(domain) ?? [];
    buckets.matched.push({
      domain,
      sku: `${agg.subs} Google · ${appCountByDomain.get(domain) ?? 0} app`,
      seats: agg.seats,
      appSeats: appSeatsByDomain.get(domain),
      /* Google's seat count is aggregated per domain. Writing it back is only
         unambiguous when the domain has exactly ONE active app subscription —
         splitting an aggregate across several would be a guess about which product
         holds which seats, and this file's own header says the export carries no
         price to disambiguate with. */
      appSubId: ids.length === 1 ? ids[0] : undefined,
      appSubCount: ids.length,
      status: "matched",
      renewal: "",
    });
  }

  // Only-in-app: app subs whose domain isn't a paid Google domain.
  for (const s of subs) {
    if (!s.domain) continue;
    const d = normDomain(s.domain);
    if (!googlePaidDomains.has(d)) {
      buckets.only_app.push({ domain: d, sku: "(app subscription)", seats: 0, status: s.status, renewal: "" });
    }
  }

  return { googleActive, googleSuspended, appCount: subs.length, estMissingMrr, buckets };
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
