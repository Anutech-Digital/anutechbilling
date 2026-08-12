/**
 * Customers — the reseller's book of business.
 *
 * Rebuilt to read like a relationship + money tool (not an accountant's ledger):
 *   • money-first StatStrip (customers · MRR · ARR · receivables) — the receivables
 *     figure is loud + clickable because "who owes me" is the action number;
 *   • visible segment chips (was a hidden dropdown) so the shape of the book shows;
 *   • a sortable table with a colored avatar + an MRR column (the value of each
 *     relationship) so the eye is drawn to the valuable and the at-risk.
 * Money math is unchanged — this is layout/hierarchy only.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCustomers, useOpenCreditsByCustomer } from "@/lib/queries/customers";
import { useProjectReceivablesByCustomer } from "@/lib/queries/projects";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useOutstandingReceivables } from "@/lib/queries/payments";
import { FAB } from "@/components/ui/fab";
import { ImportCustomersDialog } from "@/components/features/customers/import-customers-dialog";
import { ImportDomainsDialog } from "@/components/features/customers/import-domains-dialog";
import { CustomerPanel } from "@/components/features/customers/customer-panel";
import { InvoiceChooserDialog } from "@/components/features/invoices/invoice-chooser-dialog";
import { CreateProjectQuoteDialog } from "@/components/features/projects/create-project-quote-dialog";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { rupee, cn, cleanDisplayName, phoneSuffixOf } from "@/lib/utils";

// Saved-view segments (Zoho-style) — compact filters over already-loaded data
// (receivables + unused credit + subscriptions).
type ViewCtx = { amount: number; credit: number; hasSub: boolean };
const VIEW_DEFS: { id: string; label: string; test: (x: ViewCtx) => boolean }[] = [
  { id: "all",        label: "All",              test: () => true },
  { id: "unpaid",     label: "Has receivables",  test: (x) => x.amount > 0 },
  { id: "subscribed", label: "With subscriptions", test: (x) => x.hasSub },
  { id: "nosub",      label: "No subscription",  test: (x) => !x.hasSub },
  { id: "credit",     label: "Has credit",       test: (x) => x.credit > 0 },
];

// Columns tuned for a reseller: who they are (name + who-to-call folded in) ·
// subscription status · place of supply · what they're worth (MRR) · what they
// owe (receivables) · credit on file · a per-row actions menu. Widths are
// percentages so the table always fills its container — no h-scroll.
const CUST_COL_WIDTHS = ["30%", "13%", "12%", "13%", "16%", "12%", "4%"];

type SortKey = "name" | "mrr" | "receivables" | "credits";

// Stable per-customer avatar colour so the list is scannable by shape/colour.
const AVATAR_COLORS = ["amber", "indigo", "slate", "emerald", "ink", "muted"] as const;
function avatarColor(seed: string): (typeof AVATAR_COLORS)[number] {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// The muted line under a customer's name: who to call. Shows the contact person
// ONLY when it differs from the customer name (an individual customer IS the
// contact — repeating the name is noise), then the phone; else falls back to
// domain / email / state so the cell is never empty-but-informative.
type CustomerLike = {
  name: string; display_name: string | null; contact_name: string | null;
  contact_phone: string | null; contact_email: string | null; domain: string | null; state: string | null;
};
function customerSubline(c: CustomerLike): string {
  const primary = cleanDisplayName(c.display_name || c.name);
  const parts: string[] = [];
  if (c.contact_name?.trim() && c.contact_name.trim() !== primary) parts.push(c.contact_name.trim());
  const phone = c.contact_phone?.trim() || phoneSuffixOf(c.display_name || c.name);
  if (phone) parts.push(phone);
  if (parts.length) return parts.join(" · ");
  return c.domain || c.contact_email || c.state || "";
}

// Subscription status pill — maps 1:1 to the segment filters so the visible
// tags and the filter counts always agree.
function subStatus(hasActiveSub: boolean, archived: boolean):
  { label: string; kind: "success" | "muted"; dot: boolean } {
  if (archived) return { label: "Inactive", kind: "muted", dot: false };
  if (hasActiveSub) return { label: "Active", kind: "success", dot: true };
  return { label: "No subscription", kind: "muted", dot: false };
}

export default function CustomersPage() {
  const { data: customers, isLoading, error, refetch } = useCustomers();
  const { data: subscriptions } = useSubscriptions();
  const { data: outstanding } = useOutstandingReceivables();
  const { data: creditsByCustomer = {} } = useOpenCreditsByCustomer();
  const { data: projRecv = {} } = useProjectReceivablesByCustomer();

  // customer_id → outstanding = subscription dues + project invoiced-but-unpaid,
  // so project receivables show on the list too (matches the customer 360 page).
  const outstandingByCustomer = React.useMemo(() => {
    const map = new Map<string, { days: number; amount: number }>();
    for (const o of outstanding ?? []) {
      if (!o.customer_id) continue;
      const prev = map.get(o.customer_id);
      if (!prev || o.days_outstanding > prev.days) {
        map.set(o.customer_id, { days: o.days_outstanding, amount: o.outstanding_amount });
      }
    }
    // Add project receivables (invoiced milestones not yet paid).
    for (const [custId, amt] of Object.entries(projRecv)) {
      if (!amt) continue;
      const prev = map.get(custId);
      map.set(custId, { days: prev?.days ?? 0, amount: (prev?.amount ?? 0) + amt });
    }
    return map;
  }, [outstanding, projRecv]);

  const router = useRouter();
  const goAdd = () => router.push("/customers/new" as never);
  const [search, setSearch] = React.useState("");
  const [importOpen, setImportOpen] = React.useState(false);
  const [domainsOpen, setDomainsOpen] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [view, setView] = React.useState("all");
  // Archived (is_active=false) customers are hidden by default; this toggle
  // swaps the whole list to show ONLY archived ones (Zoho-style status filter).
  const [showArchived, setShowArchived] = React.useState(false);
  const [sort, setSort] = React.useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "name", dir: "asc" });
  const [visible, setVisible] = React.useState(60);
  const [kpiOpen, setKpiOpen] = React.useState(true);
  // Row action → "Create invoice": open the invoice chooser for that customer.
  const [invoiceForCustomer, setInvoiceForCustomer] = React.useState<string | null>(null);
  const [projInvoiceForCustomer, setProjInvoiceForCustomer] = React.useState<string | null>(null);

  // MRR/ARR per customer from active subscriptions.
  const subsByCustomer = React.useMemo(() => {
    const map = new Map<string, { mrr: number; arr: number }>();
    for (const s of subscriptions ?? []) {
      if (!s.customer_id || s.status !== "active") continue;
      const prev = map.get(s.customer_id) ?? { mrr: 0, arr: 0 };
      map.set(s.customer_id, { mrr: prev.mrr + s.mrr, arr: prev.arr + s.mrr * 12 });
    }
    return map;
  }, [subscriptions]);

  const activeView = VIEW_DEFS.find((v) => v.id === view) ?? VIEW_DEFS[0];

  const viewCounts = React.useMemo(() => {
    const m: Record<string, number> = Object.fromEntries(VIEW_DEFS.map((v) => [v.id, 0]));
    for (const c of customers ?? []) {
      const out = outstandingByCustomer.get(c.id);
      const ctx: ViewCtx = { amount: out?.amount ?? 0, credit: creditsByCustomer[c.id] ?? 0, hasSub: subsByCustomer.has(c.id) };
      for (const v of VIEW_DEFS) if (v.test(ctx)) m[v.id]++;
    }
    return m;
  }, [customers, outstandingByCustomer, creditsByCustomer, subsByCustomer]);

  // Filter — segment then free-text.
  const archivedCount = (customers ?? []).filter((c) => c.is_active === false).length;
  const filtered = (customers ?? []).filter((c) => {
    // Active by default; the Archived toggle swaps to show only inactive ones.
    if ((c.is_active === false) !== showArchived) return false;
    const out = outstandingByCustomer.get(c.id);
    const ctx: ViewCtx = { amount: out?.amount ?? 0, credit: creditsByCustomer[c.id] ?? 0, hasSub: subsByCustomer.has(c.id) };
    if (!activeView.test(ctx)) return false;
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return (
      c.name.toLowerCase().includes(s) ||
      (c.display_name?.toLowerCase().includes(s) ?? false) ||
      (c.domain?.toLowerCase().includes(s) ?? false) ||
      (c.contact_name?.toLowerCase().includes(s) ?? false) ||
      (c.contact_email?.toLowerCase().includes(s) ?? false)
    );
  });

  // Sort by the chosen column.
  const sortVal = React.useCallback((c: (typeof filtered)[number], key: SortKey): number | string => {
    if (key === "mrr") return subsByCustomer.get(c.id)?.mrr ?? 0;
    if (key === "receivables") return outstandingByCustomer.get(c.id)?.amount ?? 0;
    if (key === "credits") return creditsByCustomer[c.id] ?? 0;
    return (c.display_name || c.name).toLowerCase();
  }, [subsByCustomer, outstandingByCustomer, creditsByCustomer]);

  const sorted = React.useMemo(() => {
    const arr = [...filtered];
    arr.sort((a, b) => {
      const va = sortVal(a, sort.key);
      const vb = sortVal(b, sort.key);
      let cmp = 0;
      if (typeof va === "number" && typeof vb === "number") cmp = va - vb;
      else cmp = String(va).localeCompare(String(vb));
      return sort.dir === "asc" ? cmp : -cmp;
    });
    return arr;
  }, [filtered, sort, sortVal]);

  const shown = sorted.slice(0, visible);
  const hasMore = sorted.length > shown.length;
  React.useEffect(() => { setVisible(60); }, [search, view]);

  // Toggle sort: same key flips direction; a new money key defaults to desc
  // (biggest first — the reseller wants top payers / biggest debtors on top).
  const toggleSort = (key: SortKey) =>
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: key === "name" ? "asc" : "desc" },
    );

  // KPIs.
  const total = customers?.length ?? 0;
  const totalMRR = Array.from(subsByCustomer.values()).reduce((s, x) => s + x.mrr, 0);
  const totalARR = totalMRR * 12;
  const totalReceivables = Array.from(outstandingByCustomer.values()).reduce((s, x) => s + x.amount, 0);

  const stats: React.ComponentProps<typeof StatStrip>["items"] = [];
  if (!isLoading && customers) {
    stats.push({ label: "Customers", value: total });
    if (totalMRR > 0) stats.push({ label: "Monthly revenue", value: rupee(totalMRR, { compact: true }) });
    if (totalARR > 0) stats.push({ label: "Yearly revenue", value: rupee(totalARR, { compact: true }) });
    stats.push({
      label: "To collect",
      value: rupee(totalReceivables, { compact: true }),
      tone: totalReceivables > 0 ? "rose" : "default",
      // The money-owed number is the action figure — tap it to see who owes.
      ...(totalReceivables > 0 ? { onClick: () => setView("unpaid"), active: view === "unpaid" } : {}),
    });
  }

  function handleExport() {
    const rows = customers ?? [];
    if (rows.length === 0) { toast.error("No customers to export yet."); return; }
    const cols = ["name", "contact_name", "contact_email", "contact_phone", "gstin", "state", "domain", "since"] as const;
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const c of rows) lines.push(cols.map((k) => esc((c as Record<string, unknown>)[k])).join(","));
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `customers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${rows.length} customer${rows.length === 1 ? "" : "s"} to CSV`);
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Customers</h1>
          <p className="text-sm text-ink-3 mt-1">Your book of business — recurring revenue, money owed, and who to grow.</p>
        </div>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon="more_h">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem]">
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={handleExport}>
                <Icon name="download" size={15} /> Export CSV
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setImportOpen(true)}>
                <Icon name="upload" size={15} /> Import customers
              </DropdownMenuItem>
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setDomainsOpen(true)}>
                <Icon name="link" size={15} /> Link domains
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="primary" icon="plus" onClick={goAdd}>Add customer</Button>
        </div>
      </div>

      {/* Collapsible Customer Analytics Banner */}
      {stats.length > 0 && !selectedId && (
        <div className="mb-4 bg-paper border border-hairline rounded-lg overflow-hidden transition-all shadow-xs">
          <button
            type="button"
            onClick={() => setKpiOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3.5 py-2.5 bg-paper-2/70 hover:bg-paper-2 transition-colors text-left cursor-pointer"
          >
            <div className="flex items-center gap-2 flex-wrap text-xs">
              <Icon name="bar_chart" size={15} className="text-amber-ink" />
              <span className="font-semibold text-ink">Customer Portfolio &amp; Receivables</span>
              <span className="text-ink-3">·</span>
              <span className="text-ink-2 font-mono font-medium">Customers: <b className="text-ink">{total}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Monthly Revenue: <b className="text-amber-ink">{rupee(totalMRR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">Yearly Revenue: <b className="text-emerald">{rupee(totalARR, { compact: true })}</b></span>
              <span className="text-ink-3 font-mono">·</span>
              <span className="text-ink-2 font-mono font-medium">To Collect: <b className="text-rose-600">{rupee(totalReceivables, { compact: true })}</b></span>
            </div>
            <div className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0 ml-2">
              <span>{kpiOpen ? "Collapse" : "Expand"}</span>
              <Icon name={kpiOpen ? "chevron_up" : "chevron_down"} size={14} />
            </div>
          </button>

          {kpiOpen && (
            <div className="p-3 border-t border-hairline bg-paper">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Total Customers</p>
                  <p className="font-serif text-lg font-bold text-ink tabular-nums mt-0.5">{total}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Monthly Revenue</p>
                  <p className="font-serif text-lg font-bold text-amber-ink tabular-nums mt-0.5">{rupee(totalMRR, { compact: true })}</p>
                </div>
                <div className="bg-paper-2/40 border border-hairline rounded-lg p-3 text-left">
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">Yearly Revenue</p>
                  <p className="font-serif text-lg font-bold text-emerald tabular-nums mt-0.5">{rupee(totalARR, { compact: true })}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setView("unpaid")}
                  className="bg-paper-2/40 border border-hairline hover:border-rose/60 transition-colors rounded-lg p-3 text-left cursor-pointer"
                >
                  <p className="text-[10px] uppercase font-semibold text-ink-3 tracking-wider">To Collect (Unpaid)</p>
                  <p className="font-serif text-lg font-bold text-rose-600 tabular-nums mt-0.5">{rupee(totalReceivables, { compact: true })}</p>
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sticky Segment chips + search */}
      {!isLoading && customers && customers.length > 0 && !selectedId && (
        <div className="sticky top-[56px] z-20 bg-paper/95 backdrop-blur-md py-3 -mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 mb-4 border-b border-hairline transition-all space-y-3">
          <div className="flex justify-between items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 py-0.5 min-w-0">
              {VIEW_DEFS.map((v) => {
                const active = view === v.id;
                const isDebt = v.id === "unpaid";
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setView(v.id)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer",
                      active
                        ? "border-amber bg-amber-soft text-amber-ink"
                        : "border-hairline text-ink-2 hover:bg-paper-2",
                    )}
                  >
                    {v.label}
                    <span className={cn(
                      "rounded-full px-1.5 tabular-nums text-[11px]",
                      active ? "bg-amber/25 text-amber-ink"
                        : isDebt && viewCounts[v.id] > 0 ? "bg-rose-soft text-rose"
                        : "bg-paper-2 text-ink-3",
                    )}>{viewCounts[v.id]}</span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-2 shrink-0 w-full sm:w-auto">
              {(archivedCount > 0 || showArchived) && (
                <button
                  type="button"
                  onClick={() => { setShowArchived((v) => !v); setSelectedId(null); }}
                  aria-pressed={showArchived}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium whitespace-nowrap transition-colors cursor-pointer",
                    showArchived ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2",
                  )}
                  title={showArchived ? "Back to active customers" : "Show archived customers"}
                >
                  <Icon name="inbox" size={13} />
                  {showArchived ? "Active" : "Archived"}
                  <span className="rounded-full bg-paper-2 px-1.5 tabular-nums text-[11px] text-ink-3">{archivedCount}</span>
                </button>
              )}
              <div className="w-full sm:w-56">
                <Input
                  prefix={<Icon name="search" size={14} />}
                  placeholder="Customer or domain…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Error ── */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load customers"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* ── Loading ── */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5, 6].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Empty ── */}
      {!isLoading && !error && customers && customers.length === 0 && (
        <EmptyState
          icon="users"
          title="No customers yet"
          body="Add your first customer to start tracking subscriptions, invoices, and renewals."
          action={<Button variant="primary" icon="plus" onClick={goAdd}>Add your first customer</Button>}
          secondary={<Button icon="download" onClick={() => setImportOpen(true)}>Import CSV</Button>}
        />
      )}

      {/* ── Mobile card list ── */}
      {!isLoading && !error && sorted.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {shown.map((c) => {
            const outInfo = outstandingByCustomer.get(c.id);
            const receivable = outInfo?.amount ?? 0;
            const days = outInfo?.days ?? 0;
            const credit = creditsByCustomer[c.id] ?? 0;
            const mrr = subsByCustomer.get(c.id)?.mrr ?? 0;
            return (
              <li key={c.id}>
                <Link
                  href={`/customers/${c.id}` as never}
                  className={cn(
                    "block bg-paper border rounded-lg p-3 active:bg-paper-2/50",
                    receivable > 0 ? "border-rose/40" : "border-hairline",
                  )}
                >
                  <div className="flex items-start gap-3">
                    <Avatar name={cleanDisplayName(c.display_name || c.name)} color={avatarColor(c.id)} size="sm" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <p className="font-medium text-ink truncate">{cleanDisplayName(c.display_name || c.name)}</p>
                        {subsByCustomer.has(c.id) && <Badge kind="success" size="sm" dot>Active</Badge>}
                      </div>
                      <p className="text-[11px] text-ink-3 truncate mt-0.5">
                        {customerSubline(c) || "—"}
                      </p>
                    </div>
                    {mrr > 0 && (
                      <span className="text-xs tabular-nums text-ink-2 shrink-0">{rupee(mrr, { compact: true })}<span className="text-ink-3">/mo</span></span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-3 pt-2 mt-2 border-t border-hairline/60 text-xs">
                    <span className="text-ink-3">
                      Owes <b className={receivable > 0 ? "text-rose" : "text-ink-2"}>{rupee(receivable)}</b>
                      {receivable > 0 && days > 0 && <span className={days > 45 ? "text-rose" : "text-ink-3"}> · {days}d</span>}
                    </span>
                    <span className="text-ink-3">
                      Credit <b className={credit > 0 ? "text-emerald" : "text-ink-2"}>{rupee(credit)}</b>
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
          {hasMore && (
            <li className="pt-1 text-center">
              <Button variant="default" size="sm" onClick={() => setVisible((v) => v + 100)}>
                Show more ({sorted.length - shown.length} left)
              </Button>
            </li>
          )}
        </ul>
      )}

      {/* ── Desktop table — full-width (no customer selected) ── */}
      {!isLoading && !error && sorted.length > 0 && !selectedId && (
        <div className="hidden md:block">
          <Card flush>
            <div className="relative">
              <table className="w-full table-fixed">
                <colgroup>
                  {CUST_COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
                </colgroup>
                <thead className="bg-paper-2 border-b border-hairline-strong">
                  <tr>
                    <SortHead label="Customer"        sortKey="name"        sort={sort} onSort={toggleSort} />
                    <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                    <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Place of supply</th>
                    <SortHead label="Monthly"         sortKey="mrr"         sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="To collect"      sortKey="receivables" sort={sort} onSort={toggleSort} align="right" />
                    <SortHead label="Unused credits"  sortKey="credits"     sort={sort} onSort={toggleSort} align="right" />
                    <th className="px-2 py-2.5"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const outInfo = outstandingByCustomer.get(c.id);
                    const receivable = outInfo?.amount ?? 0;
                    const days = outInfo?.days ?? 0;
                    const credit = creditsByCustomer[c.id] ?? 0;
                    const mrr = subsByCustomer.get(c.id)?.mrr ?? 0;
                    const st = subStatus(subsByCustomer.has(c.id), c.is_active === false);
                    const primaryName = cleanDisplayName(c.display_name || c.name);
                    return (
                      <tr
                        key={c.id}
                        onClick={() => setSelectedId(c.id)}
                        role="button"
                        tabIndex={0}
                        aria-label={`Open ${primaryName}`}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSelectedId(c.id); } }}
                        className={cn(
                          "group border-b border-hairline last:border-0 cursor-pointer transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                          receivable > 0 ? "hover:bg-rose-soft/20" : "hover:bg-paper-2/50",
                        )}
                      >
                        <td className={cn("px-3 py-2.5", receivable > 0 && "border-l-2 border-l-rose")}>
                          <div className="flex items-center gap-2.5 min-w-0">
                            <Avatar name={primaryName} color={avatarColor(c.id)} size="sm" className="shrink-0" />
                            <div className="min-w-0">
                              <div className="font-medium text-sm text-ink truncate">{primaryName}</div>
                              {customerSubline(c) && (
                                <div className="text-[11px] text-ink-3 truncate mt-0.5">{customerSubline(c)}</div>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2.5">
                          <Badge kind={st.kind} size="sm" dot={st.dot}>{st.label}</Badge>
                        </td>
                        <td className="px-3 py-2.5 text-sm text-ink-2 truncate">{c.state || <span className="text-ink-3">N/A</span>}</td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {mrr > 0
                            ? <span className="text-sm font-medium text-ink">{rupee(mrr, { compact: true })}<span className="text-[11px] text-ink-3">/mo</span></span>
                            : <span className="text-sm text-ink-3">{rupee(0)}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          {receivable > 0 ? (
                            <div>
                              <div className="text-sm font-semibold text-rose">{rupee(receivable)}</div>
                              {days > 0 && (
                                <div className={cn("text-[11px]", days > 45 ? "text-rose font-medium" : "text-ink-3")}>{days}d outstanding</div>
                              )}
                            </div>
                          ) : <span className="text-sm text-ink-3">{rupee(0)}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <span className={credit > 0 ? "text-sm font-medium text-emerald" : "text-sm text-ink-3"}>{credit > 0 ? rupee(credit) : rupee(0)}</span>
                        </td>
                        <td className="px-2 py-2.5 text-right">
                          <RowActions
                            customerName={primaryName}
                            onView={() => setSelectedId(c.id)}
                            onEdit={() => router.push(`/customers/${c.id}/edit` as never)}
                            onNewQuote={() => router.push(`/quotes/new?customer=${c.id}` as never)}
                            onInvoice={() => setInvoiceForCustomer(c.id)}
                            onManageSubs={() => router.push(`/customers/${c.id}` as never)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="flex items-center gap-1.5 text-xs text-ink-3 mt-3">
            <Icon name="info" size={11} />
            Click any row to open the Customer 360 — activity, subscriptions, invoices, and contacts. Click a column header to sort.
          </div>
          {hasMore && (
            <div className="flex justify-center py-3">
              <Button variant="default" size="sm" onClick={() => setVisible((v) => v + 100)}>
                Show more ({sorted.length - shown.length} left)
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Search / filter empty ── */}
      {!isLoading && !error && customers && customers.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No customers match"
            body={search ? `No results for "${search}". Try a different search term.` : "No customers in this view."}
            action={<Button icon="x" onClick={() => { setSearch(""); setView("all"); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* ── Master-detail (a customer is selected, desktop) ──
          Fixed viewport-height + internal scroll ONLY in the 2xl split view (so
          the list rail scrolls independently). Below 2xl the panel is full-width
          and flows in the page — auto height, no nested scrollbar (single page
          scrollbar instead of the ugly double one). */}
      {!isLoading && !error && selectedId && (
        <div className="hidden md:flex border border-hairline rounded-xl overflow-hidden bg-paper xl:h-[calc(100vh-200px)] xl:min-h-[480px]">
          {/* List rail only on very wide screens — below 2xl the detail panel
              takes the FULL width so its content never gets squeezed/cut. The
              panel's own Close (×) returns to the full list. */}
          <div className="hidden xl:flex w-[300px] border-r border-hairline flex-col min-h-0">
            <div className="p-2 border-b border-hairline">
              <Input
                prefix={<Icon name="search" size={14} />}
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="flex-1 overflow-y-auto">
              {shown.map((c) => {
                const sub = subsByCustomer.get(c.id);
                const receivable = outstandingByCustomer.get(c.id)?.amount ?? 0;
                const active = c.id === selectedId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    className={cn(
                      "w-full text-left px-3 py-2.5 border-b border-hairline/60 transition-colors flex items-center gap-2.5",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset",
                      active ? "bg-amber-soft/50" : "hover:bg-paper-2/50",
                    )}
                  >
                    <Avatar name={cleanDisplayName(c.display_name || c.name)} color={avatarColor(c.id)} size="sm" className="shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm text-ink truncate">{cleanDisplayName(c.display_name || c.name)}</div>
                      <div className="flex items-center justify-between gap-2 text-[11px] mt-0.5">
                        <span className="truncate text-ink-3">{c.domain || c.contact_email || "—"}</span>
                        {receivable > 0
                          ? <span className="tabular-nums flex-shrink-0 text-rose font-medium">{rupee(receivable, { compact: true })}</span>
                          : sub ? <span className="tabular-nums flex-shrink-0 text-ink-3">{rupee(sub.mrr, { compact: true })}/mo</span> : null}
                      </div>
                    </div>
                  </button>
                );
              })}
              {hasMore && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + 100)}
                  className="w-full text-center py-2 text-xs text-amber-ink hover:bg-paper-2/50"
                >
                  Show more ({sorted.length - shown.length} left)
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 min-w-0 min-h-0">
            <CustomerPanel customerId={selectedId} onClose={() => setSelectedId(null)} />
          </div>
        </div>
      )}

      <ImportCustomersDialog open={importOpen} onOpenChange={setImportOpen} onImportComplete={() => refetch()} />
      <ImportDomainsDialog open={domainsOpen} onOpenChange={setDomainsOpen} onComplete={() => refetch()} />

      {/* Row action → Create invoice (subscription/one-off or project). */}
      <InvoiceChooserDialog
        open={!!invoiceForCustomer}
        onOpenChange={(o) => { if (!o) setInvoiceForCustomer(null); }}
        customerId={invoiceForCustomer ?? ""}
        onChooseProject={() => { setProjInvoiceForCustomer(invoiceForCustomer); setInvoiceForCustomer(null); }}
      />
      <CreateProjectQuoteDialog
        open={!!projInvoiceForCustomer}
        onOpenChange={(o) => { if (!o) setProjInvoiceForCustomer(null); }}
        mode="invoice"
        prefillCustomerId={projInvoiceForCustomer ?? undefined}
      />

      <FAB icon="plus" label="Add customer" onClick={goAdd} />
    </div>
  );
}

/** Sortable column header — click to sort, shows the active direction arrow. */
function SortHead({
  label, sortKey, sort, onSort, align = "left",
}: {
  label: string;
  sortKey: SortKey;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort: (k: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === sortKey;
  return (
    <th className={cn("group px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}${active ? (sort.dir === "asc" ? " (ascending)" : " (descending)") : ""}`}
        className={cn(
          "inline-flex items-center gap-1 hover:text-ink transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded",
          align === "right" && "flex-row-reverse",
          active && "text-ink",
        )}
      >
        {label}
        {/* Modern sort indicator: only shown when active, or faintly on hover. */}
        <Icon
          name={active && sort.dir === "asc" ? "chevron_up" : "chevron_down"}
          size={13}
          className={cn(
            "transition-opacity",
            active ? "text-amber opacity-100" : "text-ink-3 opacity-0 group-hover:opacity-60",
          )}
        />
      </button>
    </th>
  );
}

/** Per-row overflow menu (View · Edit · New quote · Create invoice · Manage subs).
 *  stopPropagation on the trigger so opening it doesn't also fire the row click. */
function RowActions({
  customerName, onView, onEdit, onNewQuote, onInvoice, onManageSubs,
}: {
  customerName: string;
  onView: () => void;
  onEdit: () => void;
  onNewQuote: () => void;
  onInvoice: () => void;
  onManageSubs: () => void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <IconButton
          icon="more_h"
          size="sm"
          variant="ghost"
          aria-label={`Actions for ${customerName}`}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[12rem]" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onView)}>
          <Icon name="eye" size={15} /> View details
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onEdit)}>
          <Icon name="edit" size={15} /> Edit customer
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onNewQuote)}>
          <Icon name="plus" size={15} /> New quote
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onInvoice)}>
          <Icon name="receipt" size={15} /> Create invoice
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={stop(onManageSubs)}>
          <Icon name="refresh" size={15} /> Manage subscriptions
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
