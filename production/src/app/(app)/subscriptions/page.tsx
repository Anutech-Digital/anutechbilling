/**
 * Subscriptions — list matching prototype design.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useSubscriptions, useSetSubscriptionDomain, useDeleteSubscription } from "@/lib/queries/subscriptions";
import { useActiveTrials } from "@/lib/queries/trials";
import ExtendSubscriptionDialog from "@/components/features/subscriptions/extend-subscription-dialog";
import AddSeatsDialog            from "@/components/features/subscriptions/add-seats-dialog";
import { EditSubscriptionDialog } from "@/components/features/subscriptions/edit-subscription-dialog";
import { ImportSubscriptionsDialog } from "@/components/features/subscriptions/import-subscriptions-dialog";
import { ReconcileGoogleDialog } from "@/components/features/subscriptions/reconcile-google-dialog";
import { ImportGoogleSubsDialog } from "@/components/features/subscriptions/import-google-subs-dialog";
import Link from "next/link";
import { toast } from "sonner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button, IconButton } from "@/components/ui/button";
import { FAB } from "@/components/ui/fab";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { rupee, formatDate, daysBetween, cleanDisplayName } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { Subscription } from "@/lib/supabase/database.types";

// Vendor pill — capitalised label + a stable colour per vendor (Google/Microsoft
// blue, Zoho green) so the vendor reads at a glance.
function vendorMeta(v: string): { label: string; kind: "info" | "success" | "muted" } {
  const s = (v ?? "").toLowerCase();
  if (s === "google")    return { label: "Google",    kind: "info" };
  if (s === "microsoft") return { label: "Microsoft", kind: "info" };
  if (s === "zoho")      return { label: "Zoho",      kind: "success" };
  return { label: v ? v.charAt(0).toUpperCase() + v.slice(1) : "—", kind: "muted" };
}

// Margin estimate per subscription (until items linked)
function estimateMargin(s: Subscription) {
  // Heuristic: ~17% margin on typical reseller subs
  const cost = Math.round(s.mrr * 0.83);
  return { margin: s.mrr - cost, marginPct: Math.round(((s.mrr - cost) / s.mrr) * 100), cost };
}

/** Billing cycle / term, derived from the start↔renewal span. */
function billingCycle(start: string | null, renewal: string | null): string | null {
  if (!start || !renewal) return null;
  const m = Math.round(daysBetween(start, renewal) / 30.44);
  if (m <= 1) return "Monthly";
  if (m <= 4) return "Quarterly";
  if (m <= 8) return "Half-yearly";
  return "Annual";
}

export default function SubscriptionsPage() {
  const router = useRouter();
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  const { data: trials } = useActiveTrials();
  const [tab, setTab] = React.useState("all");
  const [vendor, setVendor] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [extendSub,   setExtendSub]   = React.useState<Subscription | null>(null);
  const [addSeatsSub, setAddSeatsSub] = React.useState<Subscription | null>(null);
  const [editSub,     setEditSub]     = React.useState<Subscription | null>(null);
  const delSub = useDeleteSubscription();
  const confirm = useConfirm();
  const handleDeleteSub = async (s: Subscription) => {
    const body = `This removes the subscription (and any draft purchase order for it). `
      + `It's for correcting a wrong / duplicate entry.\n\n`
      + `Blocked if it came from a paid quote — in that case delete the payment in Payments instead (that unwinds it cleanly).`;
    if (await confirm({
      title: `Delete ${s.customer_name}'s "${s.plan}" subscription?`,
      body,
      confirmLabel: "Delete",
      danger: true,
    })) delSub.mutate(s.id);
  };
  const [importOpen,  setImportOpen]  = React.useState(false);
  const [reconcileOpen, setReconcileOpen] = React.useState(false);
  const [addGoogleOpen, setAddGoogleOpen] = React.useState(false);
  const [visible, setVisible] = React.useState(60);  // render cap — paginates large lists

  const today = new Date();
  const daysUntil = (renewal: string | null) =>
    renewal ? daysBetween(today, renewal) : null;

  // Filter — paid subs only (trials handled separately below)
  const filtered = (subs ?? []).filter((s) => {
    const dl = daysUntil(s.renewal_date);
    if (tab === "active" && s.status !== "active") return false;
    if (tab === "expiring" && (dl === null || dl < 0 || dl > 30)) return false;
    if (tab === "expired" && s.status !== "expired") return false;
    if (tab === "trials") return false;  // trials handled in separate table below
    if (vendor !== "all" && s.vendor !== vendor) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !s.customer_name.toLowerCase().includes(q) &&
        !(s.domain?.toLowerCase().includes(q) ?? false) &&
        !s.plan.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    return true;
  });

  // Render only the first `visible` rows — avoids hanging on 800+ subscriptions.
  const shown = filtered.slice(0, visible);
  const hasMore = filtered.length > shown.length;
  React.useEffect(() => { setVisible(60); }, [tab, vendor, search]);

  // Trial-specific filter (for the Trials tab)
  const filteredTrials = (trials ?? []).filter((t) => {
    if (vendor !== "all") {
      // Derive vendor from plan label (trials don't have explicit vendor column)
      const pl = (t.plan ?? "").toLowerCase();
      const v  = pl.includes("google") ? "google"
              : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
              : pl.includes("zoho") ? "zoho" : "other";
      if (v !== vendor) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !t.company.toLowerCase().includes(q) &&
        !(t.domain?.toLowerCase().includes(q) ?? false) &&
        !(t.plan?.toLowerCase().includes(q) ?? false)
      ) {
        return false;
      }
    }
    return true;
  });

  // Counts
  const counts = {
    all: subs?.length ?? 0,
    active: (subs ?? []).filter((s) => s.status === "active").length,
    expiring: (subs ?? []).filter((s) => {
      const dl = daysUntil(s.renewal_date);
      return dl !== null && dl >= 0 && dl <= 30;
    }).length,
    expired: (subs ?? []).filter((s) => s.status === "expired").length,
    trials: trials?.length ?? 0,
  };

  const tabs: TabBarItem[] = [
    { id: "all",      label: "All",          count: counts.all },
    { id: "active",   label: "Active",       count: counts.active, dot: "emerald" },
    { id: "trials",   label: "Trials",       count: counts.trials, dot: "amber" },
    { id: "expiring", label: "Expiring 30d", count: counts.expiring, dot: "amber" },
    { id: "expired",  label: "Expired",      count: counts.expired, dot: "rose" },
  ];

  // KPIs
  const activeSubs = (subs ?? []).filter((s) => s.status === "active");
  const activeMRR = activeSubs.reduce((s, x) => s + x.mrr, 0);
  const activeARR = activeMRR * 12;
  const totalSeats = activeSubs.reduce((s, x) => s + x.seats, 0);
  const usedSeats = activeSubs.reduce((s, x) => s + x.used, 0);
  const monthlyMargin = activeSubs.reduce((acc, s) => acc + estimateMargin(s).margin, 0);
  const annualMargin = monthlyMargin * 12;
  const avgMarginPct = activeSubs.length > 0
    ? Math.round(activeSubs.reduce((a, s) => a + estimateMargin(s).marginPct, 0) / activeSubs.length)
    : 0;
  const atRiskCount = (subs ?? []).filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).length;
  const atRiskMRR = (subs ?? []).filter((s) => {
    const dl = daysUntil(s.renewal_date);
    return s.status === "active" && dl !== null && dl >= 0 && dl <= 30;
  }).reduce((s, x) => s + x.mrr, 0);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Revenue</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Subscriptions</h1>
          <p className="text-sm text-ink-3 mt-1">All active + expired across vendors</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button icon="refresh" onClick={() => setReconcileOpen(true)}>Reconcile Google</Button>
          <Button icon="upload" onClick={() => setImportOpen(true)}>Import</Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => router.push("/quotes/new" as never)}
            title="A subscription starts from a paid quote — this opens the quote builder"
          >
            New subscription
          </Button>
        </div>
      </div>

      {/* Compact metric strip (replaces the big KPI-card grid) */}
      {!isLoading && subs && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Active MRR",   value: rupee(activeMRR, { compact: true }), tone: "amber" },
            { label: "Active ARR",   value: rupee(activeARR, { compact: true }), tone: "emerald" },
            { label: "Margin · ARR", value: `${rupee(annualMargin, { compact: true })} · ${avgMarginPct}%`, tone: "emerald" },
            { label: "Total subs",   value: `${counts.all} · ${counts.active} active` },
            { label: "Seats used",   value: `${usedSeats} of ${totalSeats}` },
            { label: "Trials",       value: trials?.length ?? 0 },
          ]}
        />
      )}

      {/* Trials in progress — virtual subs (deployed in Google CSP, not billed yet) */}
      {!isLoading && trials && trials.length > 0 && tab !== "trials" && (
        <Card
          title="Trials in progress"
          sub={`${trials.length} trial${trials.length === 1 ? "" : "s"} active · seats provisioned, billing pending`}
          className="mb-4"
        >
          <ul className="divide-y divide-hairline -my-1">
            {trials.map((t) => {
              const dr = t.days_remaining ?? 0;
              return (
                <li key={t.id} className="py-2">
                  <Link
                    href={`/leads?lead=${t.id}` as never}
                    className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 hover:bg-paper-2/40 -mx-2 px-2 py-1.5 rounded transition-colors"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-ink truncate">{t.company}</p>
                      <p className="text-[11px] text-ink-3 truncate flex items-center gap-2">
                        {t.domain && <span className="font-mono">{t.domain}</span>}
                        <span>·</span>
                        <span>{t.plan?.replace(/^google-workspace-/, "Google Workspace ").replace(/-/g, " ")}</span>
                        <span>·</span>
                        <span className="tabular-nums">{t.seats ?? 0} seats</span>
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Trial ends</p>
                      <p className="text-xs tabular-nums text-ink-2">
                        {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                      </p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : dr === 1 ? "1d" : `${dr}d left`}
                    </Badge>
                    <Button size="sm" variant="primary" icon="check_circle">
                      Convert
                    </Button>
                  </Link>
                </li>
              );
            })}
          </ul>
          <p className="text-[11px] text-ink-3 mt-3 pt-3 border-t border-hairline flex items-center gap-1.5">
            <Icon name="info" size={11} />
            Trials are NOT counted in MRR/ARR. Click a row to open the lead and send a paid quote.
          </p>
        </Card>
      )}

      {/* AI suggestion */}
      {!isLoading && subs && atRiskCount > 0 && (
        <div className="mb-4">
          <GeminiCard
            title="Renewal intelligence"
            actions={
              <Button size="sm" variant="primary" icon="mail" onClick={() => router.push("/renewals" as never)}>Bulk renewal email</Button>
            }
            compact
          >
            <b>{atRiskCount} subscription{atRiskCount === 1 ? "" : "s"} expiring in next 30 days.</b>{" "}
            Worth {rupee(atRiskMRR, { compact: true })} MRR — start renewal conversations now.
          </GeminiCard>
        </div>
      )}

      {/* Tabs */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="mb-3">
          <TabBar value={tab} onChange={setTab} items={tabs} />
        </div>
      )}

      {/* Filter row */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="flex justify-between items-center gap-3 flex-wrap mb-3">
          <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5">
            {[
              { value: "all", label: "All Vendors" },
              { value: "google", label: "Google" },
              { value: "microsoft", label: "Microsoft" },
              { value: "zoho", label: "Zoho" },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setVendor(opt.value)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded transition-colors",
                  vendor === opt.value ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="w-64">
            <Input
              prefix={<Icon name="search" size={14} />}
              placeholder="Customer or domain…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load subscriptions"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
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

      {/* Empty */}
      {!isLoading && !error && subs && subs.length === 0 && (
        <EmptyState
          icon="refresh"
          title="No subscriptions yet"
          body="Subscriptions are created automatically when an accepted quote moves to provisioning. Start by creating a quote."
          action={
            <Button asChild variant="primary" icon="file">
              <a href="/quotes/new">Create a quote</a>
            </Button>
          }
        />
      )}

      {/* Mobile card list — phones only */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {shown.map((s) => {
            const dl = daysUntil(s.renewal_date);
            return (
              <li key={s.id} className="bg-paper border border-hairline rounded-lg p-3">
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{cleanDisplayName(s.customer_name)}</p>
                    <DomainCell sub={s} compact />
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(s.mrr)}</p>
                    <p className="text-[10px] text-ink-3">/mo · {s.seats} seats</p>
                  </div>
                </div>
                <p className="text-xs text-ink-2 mb-2 truncate">{s.plan}</p>
                <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
                  <div className="flex items-center gap-1.5">
                    <Badge
                      kind={
                        s.status === "active"    ? "success" :
                        s.status === "paused"    ? "warning" :
                        s.status === "cancelled" ? "danger"  : "muted"
                      }
                      size="sm"
                      dot
                    >
                      {s.status}
                    </Badge>
                    {dl !== null && dl >= 0 && dl <= 30 && (
                      <Badge kind={dl <= 7 ? "danger" : "warning"} size="sm">
                        {dl}d
                      </Badge>
                    )}
                  </div>
                  <span className="text-ink-3 tabular-nums">
                    {s.renewal_date ? formatDate(s.renewal_date) : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Desktop table */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider" title="Seats in use / licensed">Seats</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">MRR</th>
                  <th className="text-right px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider" title="Monthly margin">Margin</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Started</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Renewal</th>
                  <th className="text-left px-3 py-2.5 text-[11px] font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="px-2 py-2.5 text-right w-28"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => {
                  const m = estimateMargin(s);
                  const dl = daysUntil(s.renewal_date);
                  const cycle = billingCycle(s.start_date, s.renewal_date);
                  const isUrgent = dl !== null && dl >= 0 && dl <= 30;
                  return (
                    <tr
                      key={s.id}
                      className="group border-b border-hairline last:border-0 hover:bg-paper-2/50 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${cleanDisplayName(s.customer_name)}`}
                      onClick={() => s.customer_id && router.push(`/customers/${s.customer_id}` as never)}
                      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && s.customer_id) { e.preventDefault(); router.push(`/customers/${s.customer_id}` as never); } }}
                    >
                      <td className="px-3 py-2.5 align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="font-medium text-sm text-ink break-words leading-snug">{cleanDisplayName(s.customer_name)}</div>
                        <DomainCell sub={s} />
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-top">
                        <div className="break-words leading-snug">{s.plan}</div>
                        {cycle && <Badge kind="muted" size="sm" className="mt-1">{cycle}</Badge>}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {(() => { const vm = vendorMeta(s.vendor); return <Badge kind={vm.kind} dot>{vm.label}</Badge>; })()}
                      </td>
                      {/* Seats — used / licensed; flag low utilisation (unused
                          licences = churn risk at renewal OR a missed upsell). */}
                      <td className="px-3 py-2.5 text-right tabular-nums text-sm align-top" title={`${s.used} in use of ${s.seats} licensed`}>
                        <span className={cn(s.seats > 0 && s.used / s.seats < 0.5 ? "text-amber-ink font-medium" : "text-ink")}>{s.used}</span>
                        <span className="text-ink-3"> / {s.seats}</span>
                      </td>
                      {/* MRR — the money, given weight. */}
                      <td className="px-3 py-2.5 text-right tabular-nums align-top">
                        <span className="font-serif text-[15px] font-semibold text-ink">{rupee(s.mrr)}</span>
                      </td>
                      {/* Margin — colour-coded badge. */}
                      <td className="px-3 py-2.5 text-right align-top">
                        <div className="flex flex-col items-end gap-0.5">
                          <Badge kind={m.marginPct >= 18 ? "success" : m.marginPct >= 14 ? "warning" : "danger"} size="sm">
                            {m.marginPct}%
                          </Badge>
                          <span className="text-[10px] text-ink-2 tabular-nums font-medium">{rupee(m.margin)}</span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-sm text-ink-2 align-top whitespace-nowrap">{s.start_date ? formatDate(s.start_date) : "—"}</td>
                      <td className="px-3 py-2.5 text-sm align-top whitespace-nowrap">
                        <div className="text-ink-2">{s.renewal_date ? formatDate(s.renewal_date) : "—"}</div>
                        {dl !== null && s.status !== "expired" && dl >= 0 && dl <= 30 && (
                          <div className="mt-0.5"><Badge kind={dl <= 7 ? "danger" : "warning"} dot>{dl === 0 ? "Due today" : `In ${dl}d`}</Badge></div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 align-top">
                        {s.status === "expired" && dl !== null ? (
                          <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>
                        ) : s.status === "active" ? (
                          <Badge kind="success" dot>Active</Badge>
                        ) : (
                          <Badge kind="muted">{s.status}</Badge>
                        )}
                        {s.outstanding_amount > 0 && (
                          <div className="mt-1">
                            <Badge kind="warning" dot>
                              {rupee(s.outstanding_amount)} due
                            </Badge>
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {(s.status === "expired" || isUrgent) && (
                            <Button size="sm" variant={s.status === "expired" ? "danger" : "primary"} icon="refresh" title="Send the renewal quote" onClick={() => router.push("/renewals" as never)}>Renew</Button>
                          )}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                aria-label="Subscription actions"
                                className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
                              >
                                <Icon name="more_h" size={20} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="min-w-[13rem]">
                              <DropdownMenuLabel>Actions</DropdownMenuLabel>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setAddSeatsSub(s)}>
                                <Icon name="plus" size={16} /> Manage seats
                              </DropdownMenuItem>
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setExtendSub(s)}>
                                <Icon name="clock" size={16} /> Extend term
                              </DropdownMenuItem>
                              {s.customer_id && (
                                <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => router.push(`/customers/${s.customer_id}` as never)}>
                                  <Icon name="receipt" size={16} /> View invoices
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => setEditSub(s)}>
                                <Icon name="edit" size={16} /> Correct details
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer text-rose" onClick={() => handleDeleteSub(s)}>
                                <Icon name="trash" size={16} /> Cancel / delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}
      {!isLoading && !error && tab !== "trials" && hasMore && (
        <div className="flex justify-center py-3">
          <Button variant="default" size="sm" onClick={() => setVisible((v) => v + 100)}>
            Show more ({filtered.length - shown.length} left)
          </Button>
        </div>
      )}

      {/* Trials tab — same column layout, virtual-sub rows */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider" title="Licensed seats · seats in use">Seats</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">MRR</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Started</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Trial ends</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="w-24"></th>
                </tr>
              </thead>
              <tbody>
                {filteredTrials.map((t) => {
                  const dr = t.days_remaining ?? 0;
                  const planLabel = (t.plan ?? "")
                    .replace(/^google-workspace-/, "Google Workspace ")
                    .replace(/-/g, " ")
                    .replace(/\b\w/g, (c) => c.toUpperCase());
                  const pl = (t.plan ?? "").toLowerCase();
                  const v  = pl.includes("google") ? "google"
                          : pl.includes("microsoft") || pl.includes("m365") || pl.includes("365") ? "microsoft"
                          : pl.includes("zoho") ? "zoho" : "other";
                  return (
                    <tr
                      key={t.id}
                      onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                      className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer"
                    >
                      <td className="p-3">
                        <div className="font-medium text-sm text-ink">{t.company}</div>
                        {t.domain && <div className="text-[11px] text-ink-3 font-mono">{t.domain}</div>}
                      </td>
                      <td className="p-3 text-sm text-ink-2">{planLabel}</td>
                      <td className="p-3">
                        <Badge kind={v === "zoho" ? "success" : "info"}>{v}</Badge>
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">{t.seats ?? 0}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-ink-3">—</td>
                      <td className="p-3 text-right tabular-nums text-xs text-ink-3">—</td>
                      <td className="p-3 text-sm text-ink-2">
                        {t.trial_started_at ? formatDate(t.trial_started_at) : "—"}
                      </td>
                      <td className="p-3 text-sm">
                        <div>{t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}</div>
                        <div className="mt-0.5">
                          <Badge
                            kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                            size="sm"
                            dot
                          >
                            {dr === 0 ? "today" : dr === 1 ? "1d" : `${dr}d left`}
                          </Badge>
                        </div>
                      </td>
                      <td className="p-3">
                        <Badge kind="warning" dot>Trial</Badge>
                      </td>
                      <td className="p-3">
                        <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                          Convert
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}

      {/* Trials tab — mobile card list (phones only). Without this the Trials
          tab was fully BLANK on mobile — the table is `hidden md:block` and the
          main mobile card `<ul>` excludes trials. */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length > 0 && (
        <ul className="md:hidden space-y-2">
          {filteredTrials.map((t) => {
            const dr = t.days_remaining ?? 0;
            const planLabel = (t.plan ?? "")
              .replace(/^google-workspace-/, "Google Workspace ")
              .replace(/-/g, " ")
              .replace(/\b\w/g, (c) => c.toUpperCase());
            return (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/leads?lead=${t.id}` as never)}
                  className="w-full text-left bg-paper border border-hairline rounded-lg p-3"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-ink truncate">{t.company}</p>
                      {t.domain && <p className="text-[11px] text-ink-3 font-mono truncate">{t.domain}</p>}
                      <p className="text-[11px] text-ink-3 truncate mt-0.5">{planLabel} · {t.seats ?? 0} seats</p>
                    </div>
                    <Badge
                      kind={dr <= 1 ? "danger" : dr <= 3 ? "warning" : dr <= 7 ? "info" : "muted"}
                      size="sm"
                      dot
                    >
                      {dr === 0 ? "today" : dr === 1 ? "1d left" : `${dr}d left`}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-2 border-t border-hairline/60">
                    <span className="text-[11px] text-ink-3">
                      Trial ends {t.trial_expires_at ? formatDate(t.trial_expires_at) : "—"}
                    </span>
                    <Button size="sm" variant="primary" icon="check_circle" onClick={(e) => { e.stopPropagation(); router.push(`/leads?lead=${t.id}` as never); }}>
                      Convert
                    </Button>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Trials tab — empty state */}
      {!isLoading && !error && tab === "trials" && filteredTrials.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="clock"
            title="No active trials"
            body="Trials start at /buy/workspace or via the Start Trial button on the Deal Pipeline page."
            compact
          />
        </div>
      )}

      {/* Filtered empty */}
      {!isLoading && !error && tab !== "trials" && subs && subs.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No subscriptions match"
            body="Try changing tab, vendor filter, or search term."
            action={<Button icon="x" onClick={() => { setTab("all"); setVendor("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Extend dialog */}
      {extendSub && (
        <ExtendSubscriptionDialog
          sub={extendSub}
          open={!!extendSub}
          onOpenChange={(v) => { if (!v) setExtendSub(null); }}
        />
      )}

      {/* Add seats dialog */}
      {addSeatsSub && (
        <AddSeatsDialog
          sub={addSeatsSub}
          open={!!addSeatsSub}
          onOpenChange={(v) => { if (!v) setAddSeatsSub(null); }}
        />
      )}

      {/* Correct subscription details */}
      {editSub && (
        <EditSubscriptionDialog
          sub={editSub}
          open={!!editSub}
          onOpenChange={(v) => { if (!v) setEditSub(null); }}
        />
      )}

      {/* Import subscriptions (CSV migration) */}
      <ImportSubscriptionsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImportComplete={() => refetch()}
      />

      {/* Reconcile vs Google reseller panel (read-only report) → Phase 2 matcher */}
      <ReconcileGoogleDialog
        open={reconcileOpen}
        onOpenChange={setReconcileOpen}
        onAddMissing={() => setAddGoogleOpen(true)}
      />

      {/* Phase 2 — add the missing Google subscriptions (match by customer number) */}
      <ImportGoogleSubsDialog
        open={addGoogleOpen}
        onOpenChange={setAddGoogleOpen}
        onComplete={() => refetch()}
      />

      {/* Real analytics card — MRR by plan. (The "Vendor Reconciliation ·
          Not configured · Phase 2" placeholder that used to sit beside this was
          removed — a dead card the owner can't act on.) */}
      {!isLoading && subs && subs.length > 0 && (
        <div className="mt-6 max-w-xl">
          <Card title="Subscriptions by Plan">
            {(() => {
              const byPlan = new Map<string, { count: number; mrr: number }>();
              for (const s of activeSubs) {
                const prev = byPlan.get(s.plan) ?? { count: 0, mrr: 0 };
                byPlan.set(s.plan, { count: prev.count + 1, mrr: prev.mrr + s.mrr });
              }
              const rows = Array.from(byPlan.entries()).sort(([, a], [, b]) => b.mrr - a.mrr);
              if (rows.length === 0) return <p className="text-xs italic text-ink-3 p-2">No active subscriptions.</p>;
              return (
                <div className="space-y-2">
                  {rows.map(([plan, info]) => (
                    <div key={plan} className="flex justify-between items-center text-sm">
                      <span className="truncate">{plan}</span>
                      <span className="tabular-nums text-ink-2">
                        {info.count} · {rupee(info.mrr, { compact: true })}
                      </span>
                    </div>
                  ))}
                </div>
              );
            })()}
          </Card>
        </div>
      )}

      {/* Mobile primary — the header "New subscription" scrolls away on a phone. */}
      <FAB icon="plus" label="New subscription" onClick={() => router.push("/quotes/new" as never)} />
    </div>
  );
}

// ============================================================
// Domain cell — read-only when populated, inline editor when missing.
// Subs created before migration 0018 (or via manual paths that skip the
// lead/quote flow) can lack a domain — operator can fix it without leaving
// the list.
// ============================================================
function DomainCell({ sub, compact = false }: { sub: Subscription; compact?: boolean }) {
  const [editing, setEditing] = React.useState(false);
  const [value, setValue]     = React.useState("");
  const mut                   = useSetSubscriptionDomain();

  if (sub.domain && !editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(sub.domain ?? ""); setEditing(true); }}
        className={cn(
          "font-mono text-[11px] text-ink-3 hover:text-ink truncate text-left transition-colors",
          compact && "mt-0.5",
        )}
        title="Click to edit domain"
      >
        {sub.domain}
      </button>
    );
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => { setValue(""); setEditing(true); }}
        className={cn(
          "inline-flex items-center gap-1 text-[11px] text-amber-ink hover:underline",
          compact && "mt-0.5",
        )}
      >
        <Icon name="plus" size={11} />
        Add domain
      </button>
    );
  }

  const submit = () => {
    const v = value.trim();
    if (!v) {
      toast.error("Domain can't be blank");
      return;
    }
    mut.mutate(
      { id: sub.id, domain: v },
      {
        onSuccess: () => { toast.success("Domain saved"); setEditing(false); },
        onError:   (e) => { toast.error(e instanceof Error ? e.message : "Could not save"); },
      },
    );
  };

  return (
    <div className={cn("flex items-center gap-1", compact && "mt-1")}>
      <Input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="e.g. acme.in"
        className="h-7 text-[11px] font-mono py-0"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") setEditing(false);
        }}
      />
      <IconButton
        icon="check"
        size="sm"
        aria-label="Save domain"
        onClick={submit}
        disabled={mut.isPending}
      />
      <IconButton
        icon="x"
        size="sm"
        aria-label="Cancel"
        onClick={() => setEditing(false)}
        disabled={mut.isPending}
      />
    </div>
  );
}
