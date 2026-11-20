/**
 * Lead Sources.
 *
 * Layout:
 *   - Page header (Sales · Lead Sources + Share form / Import CSV / Add Lead)
 *   - 4 KPIs: Leads MTD / Avg conversion / Top source / Avg response
 *   - 2-col: Capture channels (real, grouped by leads.source; click a channel
 *     to see its leads in a modal) | Public pages (enquiry form + buy page)
 *   - Recent inbound leads (real Supabase data, last 7 days)
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import type { Route } from "next";
import { useLeadsCreatedSince, useLeadTotalCount, type LeadSourceRow } from "@/lib/queries/leads";
import { AddLeadForm } from "@/components/features/leads/add-lead-form";
import { ShareFormSheet, ENQUIRY_SHARE, BUY_SHARE, type ShareTarget } from "@/components/features/leads/share-form-sheet";
import { KPI } from "@/components/shared/kpi";
import { EmptyState } from "@/components/shared/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FAB } from "@/components/ui/fab";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import type { Lead } from "@/lib/supabase/database.types";
import { captureChannel } from "@/lib/leads/capture-channel";
import { istMonthStartUtc, leadAddedInMonth } from "@/lib/company/summary";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { LEADGEN_CHANNELS } from "@/lib/navigation/drilldown";

// ─── Lead-source channel meta + aggregation (derived from real leads.source) ──

const SOURCE_ICON: Record<string, string> = {
  whatsapp: "whatsapp", website: "globe", referral: "award", cold: "send",
  ads: "target", linkedin: "users", email: "mail", manual: "user", import: "download",
  facebook: "target", marketplace: "cart", seo: "globe",
};
const SOURCE_LABEL: Record<string, string> = {
  whatsapp: "WhatsApp Business", website: "Website form", referral: "Referral",
  cold: "Cold outreach", ads: "Google Ads", linkedin: "LinkedIn",
  email: "Email / Inbound", manual: "Manual entry", import: "CSV import",
  facebook: "Facebook / Instagram", marketplace: "IndiaMART / JustDial", seo: "Google search / SEO",
};

/** Collapse a raw leads.source string into a canonical channel key. One rule, shared with
 *  the dashboard Company section — see lib/leads/capture-channel.ts. */
const normalizeSource = captureChannel;

interface CaptureChannel { id: string; label: string; icon: string; count: number; won: number; conv: number; leads: LeadSourceRow[]; }

/** This-month lead count + conversion by capture channel, from real leads.
 *  Also carries the matching leads so a channel row can expand to show them. */
function computeCaptureChannels(leads: readonly LeadSourceRow[]): CaptureChannel[] {
  /* The IST month (lib/company/summary.ts) — the same "this month" as the dashboard Company section. */
  const now = new Date();
  const byKey = new Map<string, LeadSourceRow[]>();
  for (const l of leads) {
    /* R-2969: the dashboard's "Leads added" test (summary.ts#leadAddedInMonth), so a channel row
       and the dashboard count the same leads. */
    if (!leadAddedInMonth(l, "all", now)) continue;
    const key = normalizeSource(l.source);
    const arr = byKey.get(key) ?? [];
    arr.push(l);
    byKey.set(key, arr);
  }
  return Array.from(byKey.entries())
    .map(([id, arr]) => {
      const won = arr.filter((l) => l.stage === "won").length;
      return {
        id,
        label: SOURCE_LABEL[id] ?? id,
        icon:  SOURCE_ICON[id] ?? "inbox",
        count: arr.length,
        won,
        conv:  arr.length > 0 ? Math.round((won / arr.length) * 100) : 0,
        leads: arr.slice().sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()),
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** R-2969: every channel at once — this month's leads, any source (the dashboard's "Leads added"). */
function allChannelsRow(channels: readonly CaptureChannel[]): CaptureChannel {
  const leads = channels.flatMap((c) => c.leads)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const won = channels.reduce((s, c) => s + c.won, 0);
  return {
    id: "all", label: "All channels", icon: "inbox", count: leads.length, won,
    conv: leads.length > 0 ? Math.round((won / leads.length) * 100) : 0, leads,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StageBadge({ stage }: { stage: Lead["stage"] }) {
  const map: Record<Lead["stage"], React.ReactNode> = {
    new:     <Badge kind="info"    dot>New</Badge>,
    contact: <Badge kind="warning" dot>Contacted</Badge>,
    demo:    <Badge kind="success" dot>Demo done</Badge>,
    trial:   <Badge kind="info"    dot>Trial</Badge>,
    quote:   <Badge kind="warning" dot>Quote sent</Badge>,
    won:     <Badge kind="success" dot>Won</Badge>,
    lost:    <Badge kind="muted"   dot>Lost</Badge>,
  };
  return <>{map[stage]}</>;
}

function SourceIcon({ source }: { source: string | null }) {
  const key = normalizeSource(source);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-3">
      <Icon name={SOURCE_ICON[key] ?? "inbox"} size={13} />
      {SOURCE_LABEL[key] ?? key}
    </span>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LeadGenPage() {
  /* WC-scale: only the leads this page counts — created since the earlier of the 1st of the
     month and 14 days ago (the week-over-week delta) — read whole in pages, plus an exact
     all-time count. It used to be useLeads(): every lead, cut at PostgREST's 1000 rows, so
     "Total leads" stopped at 1,000 and a busy month's channels counted part of it. */
  const [windowStart] = React.useState(() => {
    const monthStart = istMonthStartUtc();
    const twoWeeks = new Date(Date.now() - 14 * 86_400_000);
    return (monthStart < twoWeeks ? monthStart : twoWeeks).toISOString();
  });
  const { data: leads, isLoading } = useLeadsCreatedSince(windowStart);
  const { data: totalLeads } = useLeadTotalCount();
  const router = useRouter();
  // Real capture channels: this-month lead count + conversion by source.
  const captureChannels = React.useMemo(() => computeCaptureChannels(leads ?? []), [leads]);
  // Which capture channel's leads are shown in the modal (by id).
  const [openChannel, setOpenChannelState] = React.useState<string | null>(null);
  /* R-2969: ?channel= opens the list from a link — the dashboard's "Leads added" (all) and
     "From the website" (website). Closing it clears the address too. */
  const [urlChannel, setUrlChannel] = useUrlChoice<(typeof LEADGEN_CHANNELS)[number]>("channel", LEADGEN_CHANNELS, "");
  React.useEffect(() => { if (urlChannel) setOpenChannelState(urlChannel); }, [urlChannel]);
  const setOpenChannel = (id: string | null) => {
    setOpenChannelState(id);
    if (!id && urlChannel) setUrlChannel("");
  };
  const openCh = openChannel === "all"
    ? allChannelsRow(captureChannels)
    : captureChannels.find((c) => c.id === openChannel)
      /* A link to a channel with no lead this month still opens — empty, with the reason. */
      ?? (openChannel ? { id: openChannel, label: SOURCE_LABEL[openChannel] ?? openChannel, icon: SOURCE_ICON[openChannel] ?? "inbox", count: 0, won: 0, conv: 0, leads: [] } : null);
  // Which public page (if any) the Share sheet is open for.
  const [share, setShare]         = React.useState<ShareTarget | null>(null);
  const [addOpen, setAddOpen]     = React.useState(false);
  // Current host (no protocol) for the "Live at …/buy/workspace" hint. Reads
  // window on the client so it always reflects the real deployed domain.
  const [captureHost, setCaptureHost] = React.useState("");
  React.useEffect(() => {
    setCaptureHost(window.location.host);
  }, []);

  // Last-7-days leads, plus the 7 days before that for a REAL week-over-week delta
  const now       = Date.now();
  const cutoff    = new Date(now - 7 * 86_400_000);
  const prevStart = new Date(now - 14 * 86_400_000);
  const recentLeads = (leads ?? []).filter(
    (l) => new Date(l.created_at) >= cutoff,
  );
  const prevWeekLeads = (leads ?? []).filter((l) => {
    const t = new Date(l.created_at);
    return t >= prevStart && t < cutoff;
  }).length;

  // KPI calculations
  const mtdLeads    = recentLeads.length;
  const weekDelta   = mtdLeads - prevWeekLeads; // real w/w change
  const total       = captureChannels.reduce((s, x) => s + x.count, 0);
  const avgConv     = Math.round(
    captureChannels.reduce((s, x) => s + x.count * x.conv, 0) / Math.max(1, total),
  );
  const topSource   = captureChannels[0]; // already sorted by count desc (may be undefined)

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
            Sales
          </p>
          <h1 className="font-serif text-3xl text-ink">Lead Sources</h1>
          <p className="mt-1 text-sm text-ink-3">
            Where new leads come from · capture forms · manual entry · bulk import
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={() => setShare(ENQUIRY_SHARE)}
          >
            <Icon name="link" size={14} />
            Share form
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setAddOpen(true)}
          >
            <Icon name="plus" size={14} />
            Add Lead
          </Button>
        </div>
      </div>

      {/* ── KPIs ── */}
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <KPI
          label="Leads · Last 7 days"
          value={mtdLeads}
          trend={
            prevWeekLeads === 0
              ? "vs 0 last week"
              : `${weekDelta >= 0 ? "+" : ""}${weekDelta} vs last week`
          }
          trendKind={weekDelta > 0 ? "up" : weekDelta < 0 ? "down" : "neutral"}
          icon="inbox"
        />
        <KPI
          label="Avg conversion"
          value={avgConv}
          unit="%"
          trend="lead → won"
          trendKind="up"
          icon="target"
        />
        <KPI
          label="Top source"
          value={topSource ? topSource.label.split(" ")[0] : "—"}
          trend={topSource ? `${topSource.count} this month` : "No leads yet"}
          trendKind="neutral"
          icon={topSource?.icon ?? "inbox"}
        />
        <KPI
          label="Total leads"
          value={totalLeads ?? 0}
          trend="all time · all sources"
          trendKind="neutral"
          icon="users"
        />
      </div>

      {/* ── Capture channels + Public form ── */}
      <div
        className="mb-5 grid gap-5"
        style={{ gridTemplateColumns: "1.4fr 1fr" }}
      >
        {/* Capture channels */}
        <Card className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-ink">Capture channels</p>
              <p className="text-xs text-ink-3">Sources of new leads this month</p>
            </div>
            <Button
              variant="default"
              size="sm"
              onClick={() => setShare(ENQUIRY_SHARE)}
            >
              <Icon name="link" size={12} />
              Get capture link
            </Button>
          </div>
          {captureChannels.length === 0 ? (
            <div className="py-8 text-center text-sm text-ink-3">
              No leads captured this month yet. New leads are grouped here by their source
              (WhatsApp, website form, referral, import, …) automatically.
            </div>
          ) : (
            <div className="divide-y divide-hairline">
              {captureChannels.map((s) => (
                /* Row — click to see this channel's leads in a modal (keeps the
                   page compact even when a channel has hundreds of leads). */
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setOpenChannel(s.id)}
                  className="w-full grid items-center gap-3 py-2.5 text-left rounded-md hover:bg-paper-2/40 transition-colors"
                  style={{ gridTemplateColumns: "32px 1fr 64px 80px 20px" }}
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                    <Icon name={s.icon} size={15} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink truncate">{s.label}</p>
                    <p className="text-xs text-ink-3">{s.won} won this month</p>
                  </div>
                  <div className="text-right font-serif text-lg tabular-nums text-ink">
                    {s.count}
                  </div>
                  <div className="text-right">
                    <p className="text-xs font-medium tabular-nums text-ink">{s.conv}%</p>
                    <p className="text-xs text-ink-3">conv rate</p>
                  </div>
                  <Icon name="chevron_right" size={14} className="text-ink-3 justify-self-end" />
                </button>
              ))}
            </div>
          )}
        </Card>

        {/* Public pages — the two links a reseller shares with prospects:
            the enquiry form (lead sends a requirement) and the Google Workspace
            buy page (self-serve purchase). Each can be shared or opened. */}
        <Card className="p-5">
          <div className="mb-4">
            <p className="text-sm font-semibold text-ink">Public pages</p>
            <p className="text-xs text-ink-3">Share a link or embed on your website</p>
          </div>

          {/* ── Enquiry form (with live WYSIWYG preview) ── */}
          <div className="mb-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Enquiry form</p>
                <p className="text-xs text-ink-3">Prospect sends a requirement → new lead</p>
              </div>
              <Button
                variant="default"
                size="sm"
                className="shrink-0"
                onClick={() => setShare(ENQUIRY_SHARE)}
              >
                <Icon name="external" size={12} />
                Share
              </Button>
            </div>

            {/* Live preview of the REAL /enquiry page. pointer-events-none keeps
                it look-only; the card always matches what customers see. */}
            <div className="overflow-hidden rounded-lg border border-hairline bg-paper-2">
              <div className="relative h-[300px] overflow-hidden">
                <iframe
                  src="/enquiry?embed=1"
                  title="Public enquiry form preview"
                  className="pointer-events-none absolute left-0 top-0 h-[500px] w-[167%] origin-top-left scale-[0.6] border-0"
                  tabIndex={-1}
                  aria-hidden="true"
                />
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
              <code className="min-w-0 truncate rounded bg-paper-2 px-2 py-1 font-mono text-xs text-ink-3">
                {captureHost}/enquiry
              </code>
              <Button
                variant="default"
                size="sm"
                className="shrink-0"
                onClick={() => window.open("/enquiry", "_blank", "noopener")}
              >
                <Icon name="external" size={12} />
                Open
              </Button>
            </div>
          </div>

          {/* ── Google Workspace buy page ── */}
          <div className="border-t border-hairline pt-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">Google Workspace buy page</p>
                <p className="text-xs text-ink-3">Self-serve purchase · live GST pricing</p>
              </div>
              <div className="flex shrink-0 gap-1.5">
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => setShare(BUY_SHARE)}
                >
                  <Icon name="external" size={12} />
                  Share
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => window.open("/buy/workspace", "_blank", "noopener")}
                >
                  <Icon name="external" size={12} />
                  Open
                </Button>
              </div>
            </div>
            <code className="block min-w-0 truncate rounded bg-paper-2 px-2 py-1 font-mono text-xs text-ink-3">
              {captureHost}/buy/workspace
            </code>
          </div>
        </Card>
      </div>

      {/* ── Recent inbound leads ── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-ink">Recent inbound</p>
            <p className="text-xs text-ink-3">Last 7 days · sorted by recency</p>
          </div>
          <Button variant="default" size="sm" asChild>
            <Link href={"/leads" as Route}>
              <Icon name="arrow_right" size={13} />
              Open Pipeline
            </Link>
          </Button>
        </div>

        {isLoading ? (
          <div className="space-y-2 p-5">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : recentLeads.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No inbound leads in the last 7 days"
            body="Leads captured via webhook, form, or manual entry appear here."
            compact
          />
        ) : (
          <>
          {/* Desktop / tablet — table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-hairline bg-muted/30">
                  {["Lead", "Source", "Contact", "Captured", "Stage", ""].map(
                    (h) => (
                      <th
                        key={h}
                        className="px-5 py-2.5 text-left text-xs font-medium text-ink-3"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {recentLeads.slice(0, 10).map((lead) => (
                  <tr
                    key={lead.id}
                    className="border-b border-hairline last:border-0 hover:bg-muted/20"
                  >
                    <td className="px-5 py-3">
                      <p className="font-semibold text-ink">{lead.company}</p>
                      <p className="font-mono text-xs text-ink-3">
                        {lead.id.slice(0, 8).toUpperCase()}
                      </p>
                    </td>
                    <td className="px-5 py-3">
                      <SourceIcon source={lead.source} />
                    </td>
                    <td className="px-5 py-3 text-ink">
                      {lead.contact_name ?? "—"}
                    </td>
                    <td className="px-5 py-3 text-xs text-ink-3">
                      {formatDate(lead.created_at, "relative")}
                    </td>
                    <td className="px-5 py-3">
                      <StageBadge stage={lead.stage} />
                    </td>
                    <td className="px-5 py-3">
                      <Button variant="default" size="sm" asChild>
                        <Link href={`/leads?lead=${lead.id}` as any}>
                          <Icon name="arrow_right" size={12} />
                          Open
                        </Link>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile — card list mirroring the table columns */}
          <ul className="md:hidden divide-y divide-hairline">
            {recentLeads.slice(0, 10).map((lead) => (
              <li key={lead.id}>
                <button
                  type="button"
                  onClick={() => router.push(`/leads?lead=${lead.id}` as never)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold text-ink truncate">{lead.company}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <SourceIcon source={lead.source} />
                      <span className="text-xs text-ink-3 truncate">· {lead.contact_name ?? "—"}</span>
                    </div>
                    <p className="mt-1 text-xs text-ink-3">
                      {formatDate(lead.created_at, "relative")}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <StageBadge stage={lead.stage} />
                    <Icon name="arrow_right" size={14} className="text-ink-3" />
                  </div>
                </button>
              </li>
            ))}
          </ul>
          </>
        )}
      </Card>

      {/* ── Channel leads modal — the leads captured via one channel this
          month. A scrollable dialog instead of an inline accordion, so the
          page stays compact even when a channel has hundreds of leads. ── */}
      <Dialog open={!!openChannel} onOpenChange={(o) => { if (!o) setOpenChannel(null); }}>
        <DialogContent className="max-w-md p-0">
          <DialogHeader className="px-5 pt-5">
            <DialogTitle className="flex items-center gap-2">
              {openCh && (
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600">
                  <Icon name={openCh.icon} size={14} />
                </span>
              )}
              {openCh?.label ?? "Channel"}
            </DialogTitle>
            <DialogDescription>
              {openCh && !isLoading
                ? `${openCh.count} lead${openCh.count === 1 ? "" : "s"} this month · ${openCh.won} won · ${openCh.conv}% conversion`
                : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[60vh] overflow-y-auto px-3 pb-4 pt-1">
            {isLoading ? (
              <Skeleton className="h-24 w-full" />
            ) : openCh?.leads.length ? (
              <div className="space-y-0.5">
                {openCh.leads.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => { setOpenChannel(null); router.push(`/leads?lead=${l.id}` as never); }}
                    className="w-full flex items-center justify-between gap-3 px-2 py-2 rounded-md text-left hover:bg-paper-2 transition-colors"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-ink truncate">{l.company}</span>
                      <span className="block text-xs text-ink-3 truncate">
                        {l.contact_name ?? l.contact_email ?? "—"} · {formatDate(l.created_at)}
                      </span>
                    </span>
                    <Icon name="arrow_right" size={13} className="text-ink-3 shrink-0" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="py-8 text-center text-sm text-ink-3">No leads in this channel this month.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Share form sheet ── */}
      {share && <ShareFormSheet target={share} onClose={() => setShare(null)} />}

      {/* ── Add Lead modal (same one used in Lead Pipeline) ── */}
      <AddLeadForm open={addOpen} onOpenChange={setAddOpen} />

      {/* Mobile FAB — primary list action */}
      <FAB icon="plus" label="Add lead" onClick={() => setAddOpen(true)} ariaLabel="Add lead" />
    </div>
  );
}
