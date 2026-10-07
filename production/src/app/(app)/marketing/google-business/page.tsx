/**
 * Google Business Profile — /marketing/google-business
 *
 * The company's Google listing, in the app: how often it showed on Maps / Search, what
 * people did from it (calls, website, directions), and the reviews with one-tap replies.
 * Data is synced from Google's Business Profile APIs (lib/google/gbp-api.ts) into our own
 * tables, so history is kept beyond Google's 18-month window; the arithmetic on this page
 * is lib/marketing/gbp.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { toast } from "sonner";
import {
  ResponsiveContainer, ComposedChart, Bar, Area, CartesianGrid, XAxis, YAxis, Tooltip, Legend,
} from "recharts";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { TabBar } from "@/components/ui/tabs";
import { EmptyState } from "@/components/shared/empty-state";
import { cn, formatDate } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import {
  comparePeriods, dailySeries, weeklySeries, reviewStats, draftReply, insights, metricsCsvRows, GBP_CSV_HEADERS,
  GBP_METRIC_LAG_DAYS, REPLY_SLA_DAYS, type ReviewLike,
} from "@/lib/marketing/gbp";
import {
  useGbpStatus, useGbpLocations, useGbpReviews, useGbpMetrics, useGbpSyncRuns, useGbpSync, useGbpReply, type GbpReview,
} from "@/lib/queries/gbp";
import { useCompanyName, useReviewLink, useSaveReviewLink } from "@/lib/queries/marketing-hub";
import { istToday, addDaysISO } from "@/lib/dates/ist";

type Range = 28 | 90 | 365;
type ReviewTab = "all" | "unanswered" | "low";

function todayIso(): string { return istToday(); }
function addDays(iso: string, n: number): string { return addDaysISO(iso, n); }
const num = (n: number) => n.toLocaleString("en-IN");

/* Google's redirect lands here with ?gbp=<status>; say it once and clean the URL. */
const OAUTH_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Business Profile connected — first sync done." },
  connected_scopelost: { ok: false, text: "Connected, but an earlier permission was left unticked on the Google consent screen — check Settings › Integrations." },
  connected_syncfailed: { ok: false, text: "Google account connected, but the first sync failed — the reason is shown below." },
  denied: { ok: false, text: "Permission was denied on Google." },
  noscope: { ok: false, text: "\"Manage your business listings\" was not ticked — connect again and leave that box ticked." },
  badstate: { ok: false, text: "The sign-in expired — connect again." },
  notconfigured: { ok: false, text: "Google OAuth keys are not set." },
  error: { ok: false, text: "Could not connect to Google — try again." },
};

export default function GoogleBusinessPage() {
  const status = useGbpStatus();
  const locations = useGbpLocations();
  const sync = useGbpSync();
  const [locId, setLocId] = React.useState<string | null>(null);
  const [range, setRange] = React.useState<Range>(28);

  React.useEffect(() => {
    const p = new URLSearchParams(window.location.search).get("gbp");
    if (!p) return;
    const m = OAUTH_MESSAGES[p];
    if (m) (m.ok ? toast.success : toast.error)(m.text);
    window.history.replaceState({}, "", window.location.pathname);
  }, []);

  const locs = locations.data ?? [];
  const loc = locs.find((l) => l.id === locId) ?? locs[0] ?? null;
  const today = todayIso();
  const fromDay = addDays(today, -(365 + 28 + GBP_METRIC_LAG_DAYS));
  const metrics = useGbpMetrics(loc?.id ?? null, fromDay);
  const reviews = useGbpReviews(loc?.id ?? null);
  const reviewLink = useReviewLink();
  const saveLink = useSaveReviewLink();

  const rows = React.useMemo(() => metrics.data ?? [], [metrics.data]);
  const cmp = React.useMemo(() => comparePeriods(rows, today, range), [rows, today, range]);
  const series = React.useMemo(() => {
    const daily = dailySeries(rows, cmp.from, cmp.to);
    return range === 28 ? daily : weeklySeries(daily);
  }, [rows, cmp.from, cmp.to, range]);
  const stats = React.useMemo(() => reviewStats(reviews.data ?? [], today), [reviews.data, today]);
  const tips = React.useMemo(() => loc ? insights(cmp, stats, { hasWebsite: !!loc.website_uri, hasPhone: !!loc.phone, reviewLinkSaved: !!(reviewLink.data ?? "").trim() }) : [], [cmp, stats, loc, reviewLink.data]);

  const connected = status.data?.connected ?? false;
  const loading = status.isLoading || locations.isLoading;

  const exportCsv = () => downloadCSV(`google-business-${loc?.title ?? "listing"}-${cmp.from}-${cmp.to}.csv`, GBP_CSV_HEADERS, metricsCsvRows(rows.filter((r) => r.day >= cmp.from && r.day <= cmp.to)));

  return (
    <div className="mx-auto max-w-[1400px] p-4 md:p-6 lg:p-8 space-y-5">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Google Business Profile</h1>
          <p className="text-sm text-ink-3 mt-1 max-w-3xl">
            How often your listing showed for searches like &quot;IT company near me&quot;, how many people called / visited the website / asked for directions, and reviews —
            straight from Google, synced nightly. History is kept here (Google keeps only 18 months).
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {connected && loc && (
            <>
              <Button variant="default" icon="download" onClick={exportCsv} disabled={rows.length === 0}>Export CSV</Button>
              {loc.maps_uri && <Button asChild variant="default" icon="external"><a href={loc.maps_uri} target="_blank" rel="noreferrer">Open on Google</a></Button>}
              <Button variant="primary" icon="refresh" onClick={() => sync.mutate()} loading={sync.isPending}>{sync.isPending ? "Syncing…" : "Sync now"}</Button>
            </>
          )}
        </div>
      </header>

      {loading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      ) : !connected || locs.length === 0 ? (
        <ConnectCard status={status.data} hasLocations={locs.length > 0} syncing={sync.isPending} onSync={() => sync.mutate()} />
      ) : (
        <>
          {locs.length > 1 && (
            <TabBar value={loc?.id ?? ""} onChange={(v) => setLocId(v)} items={locs.map((l) => ({ id: l.id, label: l.title, dot: l.last_error ? "rose" : undefined }))} />
          )}

          {loc && (
            <Card className="p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-serif text-2xl text-ink">{loc.title}</h2>
                    {loc.is_verified === true && <Badge kind="success" size="sm">Verified</Badge>}
                    {loc.is_verified === false && <Badge kind="warning" size="sm">Not verified</Badge>}
                    {loc.primary_category && <Badge kind="outline" size="sm">{loc.primary_category}</Badge>}
                  </div>
                  <p className="text-sm text-ink-2 mt-1">{loc.address ?? <span className="text-amber-ink">Address not on Google</span>}</p>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
                    <span className="inline-flex items-center gap-1"><Icon name="phone" size={12} />{loc.phone ?? <span className="text-amber-ink">phone missing</span>}</span>
                    <span className="inline-flex items-center gap-1"><Icon name="globe" size={12} />{loc.website_uri ? <a className="underline" href={loc.website_uri} target="_blank" rel="noreferrer">{loc.website_uri.replace(/^https?:\/\//, "")}</a> : <span className="text-amber-ink">website missing</span>}</span>
                    <span className="inline-flex items-center gap-1"><Icon name="clock" size={12} />{loc.last_synced_at ? `synced ${formatDate(loc.last_synced_at)}` : "not synced yet"}</span>
                  </div>
                  {loc.last_error && <p className="mt-2 text-xs text-rose-ink bg-rose-soft rounded-md px-2 py-1">{loc.last_error}</p>}
                </div>
                <div className="text-right shrink-0">
                  <p className="font-serif text-4xl text-ink leading-none">{loc.average_rating?.toFixed(1) ?? "—"} <span className="text-amber text-2xl">★</span></p>
                  <p className="text-xs text-ink-3 mt-1">{num(loc.total_reviews)} Google reviews</p>
                  {loc.new_review_uri && !(reviewLink.data ?? "").trim() && (
                    <Button size="sm" variant="outline" className="mt-2" onClick={() => saveLink.mutate(loc.new_review_uri!)} loading={saveLink.isPending}>Save review link →</Button>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* Insights — what to do, before the numbers */}
          <div className="grid gap-2 md:grid-cols-2">
            {tips.map((t, i) => (
              <div key={i} className={cn("rounded-lg border px-3 py-2 text-sm flex items-start gap-2",
                t.kind === "act" ? "border-rose/30 bg-rose-soft/30 text-ink" : t.kind === "warn" ? "border-amber/40 bg-amber-soft/30 text-ink" : "border-emerald/30 bg-emerald-soft/30 text-ink")}>
                <Icon name={t.kind === "good" ? "check_circle" : "alert"} size={15} className={cn("mt-0.5 shrink-0", t.kind === "good" ? "text-emerald" : t.kind === "warn" ? "text-amber-ink" : "text-rose")} />
                <span>{t.text}{t.href && <> <Link href={t.href as Route} className="underline text-amber-ink">Open →</Link></>}</span>
              </div>
            ))}
          </div>

          {/* KPIs */}
          <Card className="p-4">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <div>
                <p className="text-sm font-semibold text-ink">Listing performance</p>
                <p className="text-xs text-ink-3">{formatDate(cmp.from)} – {formatDate(cmp.to)} vs previous {range} days · Google publishes {GBP_METRIC_LAG_DAYS} days late</p>
              </div>
              <TabBar value={String(range)} onChange={(v) => setRange(Number(v) as Range)} items={[{ id: "28", label: "28 days" }, { id: "90", label: "90 days" }, { id: "365", label: "12 months" }]} />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <Kpi label="Listing views" value={num(cmp.current.impressions)} change={cmp.change.impressions} hint={`Maps ${num(cmp.current.maps)} · Search ${num(cmp.current.search)}`} />
              <Kpi label="Actions taken" value={num(cmp.current.actions)} change={cmp.change.actions} hint={`${cmp.current.actionRate}% of impressions`} />
              <Kpi label="Calls" value={num(cmp.current.calls)} change={cmp.change.calls} />
              <Kpi label="Website clicks" value={num(cmp.current.website)} change={cmp.change.website} />
              <Kpi label="Directions" value={num(cmp.current.directions)} change={cmp.change.directions} />
              <Kpi label="Messages + bookings" value={num(cmp.current.messages + cmp.current.bookings)} change={null} hint={`Mobile ${num(cmp.current.mobile)} · Desktop ${num(cmp.current.desktop)}`} />
            </div>
            {rows.length === 0 ? (
              <p className="mt-4 text-sm text-ink-3">No performance data yet — after Google approves the quota, the first sync brings in 18 months of data.</p>
            ) : (
              <div className="h-72 mt-4 -ml-2">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={series}>
                    <CartesianGrid stroke="hsl(var(--hairline))" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" tickFormatter={(d: string) => d.slice(5)} />
                    <YAxis yAxisId="imp" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" />
                    <YAxis yAxisId="act" orientation="right" tick={{ fontSize: 11, fill: "hsl(var(--ink-3))" }} stroke="hsl(var(--hairline))" />
                    <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid hsl(var(--hairline))", background: "hsl(var(--paper))" }} labelFormatter={(d) => range === 28 ? formatDate(String(d)) : `Week of ${formatDate(String(d))}`} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area yAxisId="imp" type="monotone" dataKey="impressions" name="Listing views" stroke="hsl(var(--indigo))" fill="hsl(var(--indigo-soft))" strokeWidth={2} />
                    <Bar yAxisId="act" dataKey="calls" name="Calls" stackId="a" fill="hsl(var(--emerald))" maxBarSize={28} />
                    <Bar yAxisId="act" dataKey="website" name="Website" stackId="a" fill="hsl(var(--amber))" maxBarSize={28} />
                    <Bar yAxisId="act" dataKey="directions" name="Directions" stackId="a" fill="hsl(var(--rose))" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <ReviewsSection reviews={reviews.data ?? []} loading={reviews.isLoading} stats={stats} ownerPhone={loc?.phone ?? null} today={today} />

          <SyncHistory />
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, change, hint }: { label: string; value: string; change: number | null; hint?: string }) {
  return (
    <div className="rounded-md border border-hairline p-3">
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">{label}</p>
      <p className="font-serif text-2xl text-ink mt-1 tabular-nums">{value}</p>
      <p className="text-xs mt-0.5">
        {change === null ? <span className="text-ink-3">{hint ?? "pichhla period 0"}</span> : (
          <>
            <span className={cn("font-semibold inline-flex items-center gap-0.5", change > 0 ? "text-emerald" : change < 0 ? "text-rose" : "text-ink-3")}>
              {change > 0 && <Icon name="trending_up" size={11} />}{change < 0 && <Icon name="trending_down" size={11} />}{change > 0 ? "+" : ""}{change}%
            </span>
            {hint && <span className="text-ink-3"> · {hint}</span>}
          </>
        )}
      </p>
    </div>
  );
}

function ConnectCard({ status, hasLocations, syncing, onSync }: { status?: { configured: boolean; connected: boolean; reason: string; lastError: string | null; email: string | null }; hasLocations: boolean; syncing: boolean; onSync: () => void }) {
  const connectedNoData = status?.connected && !hasLocations;
  return (
    <Card className="p-6">
      <div className="flex items-start gap-4 flex-wrap">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-paper-2 text-ink-3 shrink-0"><Icon name="map_pin" size={22} /></div>
        <div className="flex-1 min-w-[260px]">
          <h2 className="font-serif text-2xl text-ink">{connectedNoData ? "Connected — no listing yet" : "Connect Google Business Profile"}</h2>
          <p className="text-sm text-ink-2 mt-1 max-w-2xl">
            {connectedNoData
              ? `${status?.email ?? "Google account"} is connected. The first sync failed, or this account has no listing.`
              : "Connect with the Google account that manages your listing on business.google.com. The app only reads the listing and posts review replies — nothing else."}
          </p>
          {status?.lastError && <p className="mt-2 text-sm text-rose-ink bg-rose-soft rounded-md px-3 py-2">{status.lastError}</p>}
          {!status?.configured && <p className="mt-2 text-sm text-amber-ink">{status?.reason}</p>}
          <ul className="mt-3 text-xs text-ink-3 space-y-1 list-disc pl-4">
            <li>Enable 4 APIs on the Google Cloud project: Business Profile Account Management, Business Information, My Business (v4), Business Profile Performance.</li>
            <li>Google sets the quota for these APIs to 0 by default — fill the &quot;Business Profile API access&quot; form once (approval takes 1–2 weeks).</li>
            <li>Register the redirect URI: <code className="font-mono">/api/integrations/google-business/callback</code></li>
          </ul>
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            {connectedNoData ? (
              <>
                <Button variant="primary" icon="refresh" onClick={onSync} loading={syncing}>Sync again</Button>
                <Button asChild variant="default"><a href="/api/integrations/google-business/connect">Reconnect with another account</a></Button>
              </>
            ) : (
              status?.configured
                ? <Button asChild variant="primary"><a href="/api/integrations/google-business/connect">Connect Google Business Profile</a></Button>
                : <Button variant="primary" disabled>Connect Google Business Profile</Button>
            )}
            <Link href={"/marketing/reviews" as Route} className="text-sm underline text-ink-2">Ask for reviews →</Link>
          </div>
        </div>
      </div>
    </Card>
  );
}

function Stars({ n }: { n: number }) {
  return <span className="text-amber tracking-tight" aria-label={`${n} star`}>{"★".repeat(n)}<span className="text-hairline-strong">{"★".repeat(5 - n)}</span></span>;
}

function ReviewsSection({ reviews, loading, stats, ownerPhone, today }: { reviews: GbpReview[]; loading: boolean; stats: ReturnType<typeof reviewStats>; ownerPhone: string | null; today: string }) {
  const [tab, setTab] = React.useState<ReviewTab>("all");
  const list = reviews.filter((r) => tab === "all" || (tab === "unanswered" ? !r.reply_comment : r.star_rating <= 3));
  const max = Math.max(1, ...Object.values(stats.distribution));
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-sm font-semibold text-ink">Reviews</p>
          <p className="text-xs text-ink-3">{stats.count} total · {stats.last30} in last 30 days ({stats.last30Average ?? "—"}★) · reply rate {stats.replyRate}%</p>
        </div>
        <TabBar value={tab} onChange={(v) => setTab(v as ReviewTab)} items={[
          { id: "all", label: "All", count: reviews.length || undefined },
          { id: "unanswered", label: "Unanswered", count: stats.unanswered || undefined, dot: stats.overdue ? "rose" : undefined },
          { id: "low", label: "≤ 3★", count: reviews.filter((r) => r.star_rating <= 3).length || undefined },
        ]} />
      </div>

      <div className="mt-3 grid gap-4 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          {([5, 4, 3, 2, 1] as const).map((s) => (
            <div key={s} className="flex items-center gap-2 text-xs">
              <span className="w-6 text-ink-3 text-right">{s}★</span>
              <div className="flex-1 h-2 rounded bg-paper-2 overflow-hidden"><div className={cn("h-full", s >= 4 ? "bg-emerald" : s === 3 ? "bg-amber" : "bg-rose")} style={{ width: `${(stats.distribution[s] / max) * 100}%` }} /></div>
              <span className="w-6 text-ink-2 tabular-nums">{stats.distribution[s]}</span>
            </div>
          ))}
          {stats.overdue > 0 && <p className="text-xs text-rose-ink mt-2">{stats.overdue} review{stats.overdue === 1 ? "" : "s"} unanswered for {REPLY_SLA_DAYS}+ days</p>}
        </div>

        <div>
          {loading ? <Skeleton className="h-20 rounded-lg" /> : list.length === 0 ? (
            <EmptyState icon="star" title={reviews.length ? "Nothing matches this filter" : "No reviews yet"} body={reviews.length ? "" : "Ask happy customers for a review — one click from the Google reviews page."} />
          ) : (
            <ul className="divide-y divide-hairline">
              {list.map((r) => <ReviewRow key={r.id} r={r} ownerPhone={ownerPhone} today={today} />)}
            </ul>
          )}
        </div>
      </div>
    </Card>
  );
}

function ReviewRow({ r, ownerPhone, today }: { r: GbpReview; ownerPhone: string | null; today: string }) {
  const company = useCompanyName();
  const reply = useGbpReply();
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const ageDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(r.reviewed_at)) / 86_400_000);
  const overdue = !r.reply_comment && ageDays > REPLY_SLA_DAYS;
  const startReply = () => {
    const like: ReviewLike = { star_rating: r.star_rating, comment: r.comment, reply_comment: r.reply_comment, reviewed_at: r.reviewed_at, reviewer_name: r.reviewer_name };
    setText(draftReply(like, company.data || "our team", ownerPhone));
    setOpen(true);
  };
  return (
    <li className="py-3">
      <div className="flex items-start gap-3">
        {r.reviewer_photo_uri && !r.is_anonymous ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={r.reviewer_photo_uri} alt="" className="h-8 w-8 rounded-full shrink-0" referrerPolicy="no-referrer" />
        ) : <div className="h-8 w-8 rounded-full bg-paper-2 text-ink-3 flex items-center justify-center shrink-0"><Icon name="user" size={14} /></div>}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-ink">{r.is_anonymous ? "Google user" : r.reviewer_name ?? "Google user"}</span>
            <Stars n={r.star_rating} />
            <span className="text-xs text-ink-3">{formatDate(r.reviewed_at)}</span>
            {overdue && <Badge kind="danger" size="sm">{ageDays} days unanswered</Badge>}
          </div>
          {r.comment ? <p className="text-sm text-ink-2 mt-1 whitespace-pre-line">{r.comment}</p> : <p className="text-xs text-ink-3 mt-1 italic">(rating only, no text)</p>}
          {r.reply_comment ? (
            <div className="mt-2 rounded-md bg-paper-2 px-3 py-2 text-sm text-ink-2 border-l-2 border-emerald">
              <p className="text-xs text-ink-3 mb-0.5">Owner reply · {r.replied_at ? formatDate(r.replied_at) : ""}</p>
              <p className="whitespace-pre-line">{r.reply_comment}</p>
            </div>
          ) : open ? (
            <div className="mt-2 space-y-2">
              <Textarea aria-label="Reply to review" value={text} onChange={(e) => setText(e.target.value)} rows={3} className="text-sm" />
              <div className="flex gap-2">
                <Button size="sm" variant="primary" icon="send" onClick={() => reply.mutate({ reviewId: r.id, comment: text }, { onSuccess: () => setOpen(false) })} loading={reply.isPending} disabled={!text.trim()}>Post reply on Google</Button>
                <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="outline" className="mt-2" icon="message" onClick={startReply}>Reply</Button>
          )}
        </div>
      </div>
    </li>
  );
}

function SyncHistory() {
  const runs = useGbpSyncRuns();
  const list = runs.data ?? [];
  if (list.length === 0) return null;
  return (
    <details className="text-xs text-ink-3">
      <summary className="cursor-pointer select-none">Sync history ({list.length})</summary>
      <ul className="mt-2 space-y-1">
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap gap-x-3">
            <span className="tabular-nums">{formatDate(r.started_at)}</span>
            <span>{r.trigger}</span>
            <span className={r.ok === false ? "text-rose-ink" : r.ok ? "text-emerald" : ""}>{r.ok === null ? "running…" : r.ok ? "ok" : "failed"}</span>
            <span>{r.locations} listing · {r.reviews} reviews · {r.metric_rows} rows</span>
            {r.error && <span className="text-rose-ink">{r.error}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
