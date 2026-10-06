/**
 * ImportGoogleSubsDialog — Phase 2 of the Google reconciliation.
 *
 * Takes the Google reseller-panel export that you've ANNOTATED with your own
 * "Customer Number" column (same join key the Zoho subscription import used),
 * matches each Google subscription to an existing customer by that number, and
 * bulk-adds the missing subscriptions — WITHOUT creating duplicate customers.
 *
 * Match precedence per row:
 *   1. Customer Number  → customers.customer_number   (exact, preferred)
 *   2. Domain           → customers.domain            (fallback, backfilled)
 *   → found    : link the new subscription to that existing customer
 *   → not found: "needs new customer" (only created if you opt in)
 *
 * Rows whose domain already has an app subscription are skipped (already tracked).
 *
 * MONEY-HONESTY: the Google export carries NO price. MRR is ESTIMATED from the
 * catalog (msrp × seats) and clearly flagged — verify the real rate. Nothing is
 * written until you click the add button; a dry-run preview shows exactly what
 * will happen first. Default is link-only; creating new customers is opt-in.
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
import { useItems } from "@/lib/queries/items";
import { buildPlanPriceIndex } from "@/lib/subscriptions/plan-match";
import { cn, rupee, formatDate } from "@/lib/utils";
import { parseGoogle, classifyRows, normDomain, buildSubscriptionRow, type GRow, type Parsed, type RawSub } from "./google-subs-parse";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onComplete?: () => void;
}

export function ImportGoogleSubsDialog({ open, onOpenChange, onComplete }: Props) {
  const { data: me } = useCurrentUser();
  const { data: items } = useItems();
  const fileRef = React.useRef<HTMLInputElement>(null);

  const [parsed, setParsed] = React.useState<Parsed | null>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [importing, setImporting] = React.useState(false);
  const [syncing, setSyncing] = React.useState(false);       // live Reseller-API pull
  const [needsAuth, setNeedsAuth] = React.useState(false);   // token lacks the reseller scope
  const [createNew, setCreateNew] = React.useState(false);   // opt-in: also create new customers
  const [visible, setVisible] = React.useState(60);

  // Lookups loaded on open.
  const lookups = React.useRef<{
    byNumber: Map<string, { id: string; name: string }>;
    byDomain: Map<string, { id: string; name: string }>;
    appSubDomains: Set<string>;
  }>({ byNumber: new Map(), byDomain: new Map(), appSubDomains: new Set() });

  /* Keyed through planKey, not raw lowercase. Google's export says "Google Workspace
     Business Starter" and the catalogue row is "Google Workspace Starter" — an exact
     match misses, and on 24 Sep 2026 that imported four subscriptions at ₹0/month while
     their COST matched, because the cost side already normalised. See the price-side
     note in lib/subscriptions/plan-match.ts. */
  const priceIndex = React.useMemo(
    () => buildPlanPriceIndex((items ?? []).map((it) => ({
      name: it.name, vendor: it.vendor, msrpPerSeatMonth: it.msrp,
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

  React.useEffect(() => {
    if (!open) {
      setParsed(null); setFileName(null); setImporting(false); setCreateNew(false); setVisible(60);
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    (async () => {
      const supabase = createClient();
      // R-295: every row, not the first 1000 — else subs/customers past #1000 import twice.
      let custs: ExistingCustomerRow[], subs: { domain: string | null }[], cdoms: { domain: string; customer_id: string }[];
      try {
        [custs, subs, cdoms] = await Promise.all([
          readAllRows<ExistingCustomerRow>(supabase, "customers", "id, name, customer_number, domain"),
          readAllRows<{ domain: string | null }>(supabase, "subscriptions", "id, domain"),
          readAllRows<{ domain: string; customer_id: string }>(supabase, "customer_domains", "id, domain, customer_id"),
        ]);
      } catch (e) {
        toastError(e, { description: "Existing customers and subscriptions didn't load, so duplicates can't be checked. Close and reopen." });
        return;
      }
      const nameById = new Map<string, string>();
      const byNumber = new Map<string, { id: string; name: string }>();
      const byDomain = new Map<string, { id: string; name: string }>();
      for (const c of custs) {
        nameById.set(c.id, c.name);
        if (c.customer_number) byNumber.set(String(c.customer_number).trim().toLowerCase(), { id: c.id, name: c.name });
        if (c.domain) byDomain.set(normDomain(c.domain), { id: c.id, name: c.name });
      }
      // customer_domains is the authoritative many-domains-per-customer map.
      for (const cd of cdoms) {
        const name = nameById.get(cd.customer_id);
        if (name) byDomain.set(normDomain(cd.domain), { id: cd.customer_id, name });
      }
      const appSubDomains = new Set<string>();
      for (const s of subs) if (s.domain) appSubDomains.add(normDomain(s.domain));
      lookups.current = { byNumber, byDomain, appSubDomains };
    })();
  }, [open]);

  React.useEffect(() => { setVisible(60); }, [parsed]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) { toast.error("File too large (over 8 MB).", { description: "Export a smaller range from the Google Admin console and upload that." }); return; }
    setFileName(file.name);
    try {
      const text = await file.text();
      const p = parseGoogle(text, lookups.current, priceMap);
      if (p.rows.length === 0) { toast.error("No paid subscriptions found in this file.", { description: "Check it is the Google subscriptions export (CSV), not another report." }); return; }
      setParsed(p);
    } catch (err) {
      toastError(err, { fallback: "Could not read the file.", description: "Upload the Google subscriptions export as CSV." });
    }
  }

  // Re-authenticate with the reseller scope (incremental consent), then return
  // to /subscriptions so the user can hit Sync again with a scoped token.
  async function connectGoogleReseller() {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        scopes: "https://www.googleapis.com/auth/apps.order.readonly",
        redirectTo: `${window.location.origin}/subscriptions`,
        queryParams: { access_type: "offline", prompt: "consent" },
      },
    });
    if (error) toastError(error, { fallback: "Could not open Google sign-in.", description: "Try again in a moment." });
  }

  async function handleSync() {
    setSyncing(true);
    setNeedsAuth(false);
    try {
      const res = await fetch("/api/integrations/google-reseller/subscriptions");
      const data = await res.json();
      if (!res.ok) {
        // Distinct, actionable guidance for the two common setup gaps.
        if (data?.code === "api_disabled") {
          toast.error("Reseller API is not enabled yet.", { description: "Enable it in Google Cloud Console, then sync again.", duration: 8000 });
        } else if (data?.code === "needs_reauth") {
          setNeedsAuth(true);
          toast.error("Google reseller access is needed to sync.", { duration: 8000, action: { label: "Connect Google", onClick: () => { void connectGoogleReseller(); } } });
        } else {
          toastError(data?.error, { fallback: "Sync failed.", description: "Try again, or upload the CSV export instead." });
        }
        return;
      }
      const raws: RawSub[] = data.subscriptions ?? [];
      if (raws.length === 0) { toast.error("Google returned no subscriptions.", { description: "Check the reseller account has active customers, or upload the CSV export." }); return; }
      setFileName(`Google Reseller API · ${raws.length} subscriptions (live)`);
      setParsed({ rows: classifyRows(raws, lookups.current, priceMap), custNumHeader: "Google API (live)", skippedFree: data.skipped ?? 0 });
    } catch (err) {
      toastError(err, { fallback: "Sync failed.", description: "Try again, or upload the CSV export instead." });
    } finally {
      setSyncing(false);
    }
  }

  const counts = React.useMemo(() => {
    const r = parsed?.rows ?? [];
    const link = r.filter((x) => x.category === "link");
    const neu  = r.filter((x) => x.category === "new");
    const inApp = r.filter((x) => x.category === "in_app");
    const willAdd = createNew ? [...link, ...neu] : link;
    const estMrr = willAdd.filter((x) => x.status === "active").reduce((s, x) => s + x.estMrr, 0);
    const newDomains = new Set(neu.map((x) => x.domain));
    return { link, neu, inApp, willAdd, estMrr, newCustomers: newDomains.size };
  }, [parsed, createNew]);

  async function handleAdd() {
    if (!parsed || !me) return;
    const { link, neu, willAdd } = counts;
    if (willAdd.length === 0) { toast.error("Nothing to add.", { description: createNew ? "Every subscription here is already in the app." : "None of these link to an existing customer. Tick 'Also create new customers' to add the unmatched ones." }); return; }
    setImporting(true);
    try {
      const supabase = createClient();
      const domainToId = new Map<string, string>();

      // 1. Optionally create one customer per distinct NEW domain.
      if (createNew && neu.length > 0) {
        const byDomain = new Map<string, GRow>();
        for (const r of neu) if (!byDomain.has(r.domain)) byDomain.set(r.domain, r);
        const custPayload = [...byDomain.values()].map((r) => ({
          tenant_id: me.tenantId,
          name: r.domain,                                  // named after domain; rename later
          domain: r.domain,
          customer_number: r.customer_number || null,
        }));
        for (let i = 0; i < custPayload.length; i += 500) {
          const chunk = custPayload.slice(i, i + 500);
          const { data, error } = await supabase.from("customers").insert(chunk).select("id, domain");
          if (error) throw error;
          for (const c of data ?? []) if (c.domain) domainToId.set(normDomain(c.domain), c.id);
        }
      }

      // 2. Build subscription rows (link rows + new rows that now have a customer).
      const source = createNew ? [...link, ...neu] : link;
      /* One timestamp for the whole import, not one per row: every row in it was read
         from the same file at the same moment, and per-row `new Date()` would scatter
         them across the milliseconds the loop happened to take. */
      const syncedAt = new Date().toISOString();
      const subPayload = source.flatMap((r) => {
        const row = buildSubscriptionRow(r, {
          tenantId: me.tenantId,
          customerId: r.category === "link" ? r.customer_id : domainToId.get(r.domain),
          syncedAt,
        });
        return row ? [row] : [];
      });

      let inserted = 0;
      for (let i = 0; i < subPayload.length; i += 500) {
        const chunk = subPayload.slice(i, i + 500);
        const { error } = await supabase.from("subscriptions").insert(chunk);
        if (error) throw error;
        inserted += chunk.length;
      }
      toast.success(
        `Added ${inserted} subscription${inserted === 1 ? "" : "s"}` +
        (createNew && counts.newCustomers > 0 ? ` · ${counts.newCustomers} new customers` : ""),
        /* R-174: Google's export has no state — new customers need one before a GST invoice. */
        createNew && counts.newCustomers > 0
          ? { description: `Google's list has no state — pick it for the new customers in Customers → "State missing" before invoicing.` }
          : undefined,
      );
      onComplete?.();
      onOpenChange(false);
    } catch (err) {
      toastError(err, { fallback: "Could not add the subscriptions.", description: "Some rows may already be saved. Reopen the import — rows already added are not added twice." });
    } finally {
      setImporting(false);
    }
  }

  const shown = parsed?.rows.slice(0, visible) ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-3xl overflow-x-hidden">
        <DialogHeader className="min-w-0">
          <DialogTitle className="break-words inline-flex items-center gap-2">
            <Icon name="upload" size={18} className="text-amber" />
            Add missing subscriptions from Google
          </DialogTitle>
          <DialogDescription className="break-words">
            Upload the Google export with a <span className="font-mono text-2xs">Customer Number</span> column added.
            Each subscription is matched to an existing customer by that number (domain as fallback). MRR is an
            <b> estimate</b> (catalog × seats) — verify the rate.
          </DialogDescription>
        </DialogHeader>

        {!parsed && (
          <div className="space-y-3">
            {/* Live sync — preferred. Pulls straight from the Reseller API. */}
            <div className="rounded-lg border border-hairline bg-paper-2/40 p-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink inline-flex items-center gap-1.5">
                  <Icon name="refresh" size={14} className="text-amber" /> Sync live from Google
                </p>
                <p className="text-2xs text-ink-3 mt-0.5">
                  No file needed — pulls every subscription via the Reseller API (needs the API enabled + reseller scope).
                </p>
              </div>
              {needsAuth ? (
                <Button type="button" variant="primary" icon="external" onClick={connectGoogleReseller}>
                  Connect Google
                </Button>
              ) : (
                <Button type="button" variant="primary" icon="refresh" loading={syncing} onClick={handleSync}>
                  Sync from Google
                </Button>
              )}
            </div>
            {needsAuth && (
              <p className="text-2xs text-amber-ink -mt-1">
                Sign in with the reseller-admin Google account and approve the reseller permission, then click Sync again.
              </p>
            )}

            <div className="flex items-center gap-3 text-2xs text-ink-3">
              <div className="h-px flex-1 bg-hairline" /> or upload the CSV <div className="h-px flex-1 bg-hairline" />
            </div>

            <label htmlFor="gsub-file" className={cn(
              "block border-2 border-dashed border-hairline-strong rounded-lg p-6 text-center cursor-pointer hover:bg-paper-2/40 transition-colors",
              "focus-within:ring-2 focus-within:ring-amber focus-within:ring-offset-2",
            )}>
              <Icon name="upload" size={24} className="text-ink-3 mx-auto mb-2" />
              <p className="text-sm font-medium text-ink">Choose the annotated Google CSV</p>
              <p className="text-xs text-ink-3 mt-1">Up to 8 MB · needs columns: Customer (domain), Sku, Purchased licenses, + your Customer Number</p>
              <input ref={fileRef} id="gsub-file" type="file" accept=".csv,text/csv" onChange={handleFile} className="sr-only" />
            </label>
            <p className="text-2xs text-ink-3">
              No <b>Customer Number</b> column (or live sync)? Matching falls back to <b>domain</b> only, so customers without a
              backfilled domain won't link — most missing subs would then need new customers.
            </p>
          </div>
        )}

        {parsed && (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink min-w-0">
                <p className="font-semibold truncate">{fileName}</p>
                <p className="text-xs text-ink-3 mt-0.5">
                  Join key:{" "}
                  {parsed.custNumHeader
                    ? <span className="text-emerald font-medium">{parsed.custNumHeader}</span>
                    : <span className="text-rose font-medium">domain only (no customer-number column found)</span>}
                  {parsed.skippedFree > 0 && <> · {parsed.skippedFree} free/blank rows ignored</>}
                </p>
              </div>
              <Button type="button" variant="ghost" size="sm" icon="x"
                onClick={() => { setParsed(null); setFileName(null); if (fileRef.current) fileRef.current.value = ""; }}>
                Choose another file
              </Button>
            </div>

            {/* Dry-run summary */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Stat label="Link to existing" value={String(counts.link.length)} tone="emerald" />
              <Stat label="Needs new customer" value={String(counts.neu.length)} tone="amber" />
              <Stat label="Already in app" value={String(counts.inApp.length)} tone="muted" />
              <Stat label="Will add MRR (est.)" value={rupee(counts.estMrr, { compact: true })} tone="rose" />
            </div>

            {/* Opt-in: create new customers */}
            <label className="flex items-start gap-2 rounded-md border border-hairline bg-paper-2/40 px-3 py-2 cursor-pointer">
              <input type="checkbox" className="mt-0.5 accent-amber" checked={createNew} onChange={(e) => setCreateNew(e.target.checked)} />
              <span className="text-xs text-ink-2">
                Also create <b>{counts.newCustomers}</b> new customers (named after their domain) for the
                <b> {counts.neu.length}</b> unmatched subs. <span className="text-ink-3">Leave off to add only the
                {" "}{counts.link.length} that link to existing customers (recommended first pass — avoids duplicates).</span>
              </span>
            </label>

            <div className="border border-hairline rounded-md overflow-hidden">
              <div className="max-h-[280px] overflow-y-auto overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-paper-2 border-b border-hairline sticky top-0">
                    <tr>
                      <th className="p-2 text-left font-semibold text-ink-3">Domain</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Match</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Plan</th>
                      <th className="p-2 text-right font-semibold text-ink-3">Seats</th>
                      <th className="p-2 text-right font-semibold text-ink-3">MRR (est.)</th>
                      <th className="p-2 text-left font-semibold text-ink-3">Renewal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <tr key={r.rowNum} className={cn("border-b border-hairline last:border-0", r.category === "in_app" && "opacity-50")}>
                        <td className="p-2 font-mono text-2xs text-ink">{r.domain}</td>
                        <td className="p-2">
                          {r.category === "link"   && <Badge kind="success" size="sm">{r.customer_name}</Badge>}
                          {r.category === "new"    && <Badge kind="warning" size="sm">new customer</Badge>}
                          {r.category === "in_app" && <Badge kind="muted" size="sm">already in app</Badge>}
                        </td>
                        <td className="p-2 text-ink-2">{r.plan}{r.status === "paused" && <span className="text-amber-ink"> · suspended</span>}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.seats}</td>
                        <td className="p-2 text-right tabular-nums text-ink-2">{r.estMrr ? rupee(r.estMrr) : "—"}</td>
                        <td className="p-2 text-ink-2">{r.renewal_date ? formatDate(r.renewal_date) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {parsed.rows.length > visible && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + 100)}
                  className="w-full py-2 text-xs font-medium text-amber-ink hover:bg-paper-2/60 border-t border-hairline"
                >
                  Show more ({parsed.rows.length - visible} left)
                </button>
              )}
            </div>

            <p className="text-2xs text-ink-3">
              Adds into <b className="text-ink">{me?.tenantName ?? "your tenant"}</b> with vendor <b>google</b>.
              MRR is a catalog estimate — <b>verify the real rate</b> after import. Suspended-on-Google subs are added as <b>paused</b>.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>Cancel</Button>
          {parsed && counts.willAdd.length > 0 && (
            <Button type="button" variant="primary" loading={importing} onClick={handleAdd}>
              Add {counts.willAdd.length} subscription{counts.willAdd.length === 1 ? "" : "s"}
              {createNew && counts.newCustomers > 0 ? ` + ${counts.newCustomers} customers` : ""}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "rose" | "muted" }) {
  const color = tone === "emerald" ? "text-emerald" : tone === "amber" ? "text-amber-ink" : tone === "rose" ? "text-rose" : "text-ink";
  return (
    <div className="rounded-md border border-hairline bg-paper-2/40 px-3 py-2">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums mt-0.5", color)}>{value}</div>
    </div>
  );
}
