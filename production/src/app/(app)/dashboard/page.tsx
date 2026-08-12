/**
 * Dashboard — matches prototype layout.
 *
 * Layout:
 *   - Header (date eyebrow, "Good morning, Name", money one-liner, Quick-add)
 *   - Money-first KPIs: 3 big ₹ tiles (Closed this month / Pipeline / MRR) + a
 *     compact StatStrip of counts (Customers / Drafts to send / Renewals · 30d)
 *   - Main 1.55fr 1fr grid of drag-reorderable widgets:
 *     LEFT  → Today's Focus + Recent Activity + Pipeline by Stage
 *     RIGHT → Chase the cash + Renewals + Trials + Leaderboard + Coming Up + Health
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Reorder, useDragControls } from "framer-motion";

import { useLeads } from "@/lib/queries/leads";
import { useCustomers } from "@/lib/queries/customers";
import { useQuotes } from "@/lib/queries/quotes";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { useProjectReceivablesByCustomer } from "@/lib/queries/projects";
import { useTasks } from "@/lib/queries/tasks";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { PartnerMetricsRow, TenantWithParent } from "@/lib/supabase/database.types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { KPI } from "@/components/shared/kpi";
import { StatStrip } from "@/components/shared/stat-strip";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee, daysBetween, formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { renewalStateLabel, renewalStateTone } from "@/lib/renewals/cadence";
import { TrialsExpiringCard } from "@/components/features/trials/trials-expiring-card";
import { GettingStartedCard } from "@/components/features/dashboard/getting-started-card";
import { PriorityActionHub } from "@/components/features/dashboard/priority-action-hub";
import { Badge } from "@/components/ui/badge";

// ============================================================
// Helpers
// ============================================================

/**
 * Friendly relative-time label for activity feed entries.
 * Examples: "Just now" · "5 min ago" · "2 hrs ago" · "Yesterday"
 */
function relativeTime(ts: number, now: number): string {
  const diffSec = Math.max(1, Math.floor((now - ts) / 1000));
  if (diffSec < 60)    return "Just now";
  const min = Math.floor(diffSec / 60);
  if (min < 60)        return `${min} min ago`;
  const hr  = Math.floor(min / 60);
  if (hr  < 24)        return `${hr} hr${hr === 1 ? "" : "s"} ago`;
  const day = Math.floor(hr / 24);
  if (day === 1)       return "Yesterday";
  return `${day} days ago`;
}

// ============================================================
// Lead stage config (matches prototype LEAD_STAGES)
// ============================================================
const LEAD_STAGES = [
  { id: "new",     label: "New",          dot: "bg-slate",   color: "bg-slate" },
  { id: "contact", label: "Contacted",    dot: "bg-amber",   color: "bg-amber" },
  { id: "demo",    label: "Demo Done",    dot: "bg-indigo",  color: "bg-indigo" },
  { id: "trial",   label: "Trial Active", dot: "bg-rose",    color: "bg-rose" },
  { id: "quote",   label: "Quote Sent",   dot: "bg-indigo",  color: "bg-indigo" },
  { id: "won",     label: "Won",          dot: "bg-emerald", color: "bg-emerald" },
] as const;

// Default card order per column — the seller can drag to re-order and the
// choice is remembered in localStorage (keys below).
const DASH_LEFT  = ["focus", "activity", "pipeline"];
// Money-at-risk (renewals / trials) outranks the leaderboard — for a solo/small
// reseller the leaderboard is a rank-of-one vanity row, so revenue reads first.
// (Order is only the DEFAULT; the seller can still drag-reorder, saved to localStorage.)
const DASH_RIGHT = ["chase", "renewals", "trials", "leaderboard", "comingup", "health"];
const LS_LEFT  = "ros_dash_left";
const LS_RIGHT = "ros_dash_right";

export default function DashboardPage() {
  const router = useRouter();

  // Real data
  const { data: leads }         = useLeads();
  const { data: customers }     = useCustomers();
  const { data: quotes }        = useQuotes();
  const { data: subscriptions } = useSubscriptions();
  const { data: projRecv = {} } = useProjectReceivablesByCustomer();
  const { data: tasksToday }    = useTasks("today");
  const { data: tasksOverdue }  = useTasks("overdue");
  const { data: currentUser }   = useCurrentUser();

  // Draggable-card order per column (persisted). Starts at the default order;
  // snaps to the saved order after mount (avoids hydration mismatch).
  const [leftOrder, setLeftOrder]   = React.useState<string[]>(DASH_LEFT);
  const [rightOrder, setRightOrder] = React.useState<string[]>(DASH_RIGHT);
  React.useEffect(() => {
    try {
      const l = localStorage.getItem(LS_LEFT);  if (l) setLeftOrder(JSON.parse(l));
      const r = localStorage.getItem(LS_RIGHT); if (r) setRightOrder(JSON.parse(r));
    } catch {}
  }, []);
  const persistOrder = (key: string, order: string[]) => {
    try { localStorage.setItem(key, JSON.stringify(order)); } catch {}
  };

  // Time-aware greeting + date
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const dateLabel = now.toLocaleString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });
  // null (not "there") while the user is loading or has no name — the headline
  // then reads a clean "Good morning." instead of an impersonal "…, there."
  const firstName = currentUser?.fullName?.split(/\s+/)[0] ?? null;
  const workspaceName = currentUser?.tenantName ?? "your workspace";

  // Aggregates from real data
  const activeLeads     = (leads ?? []).filter((l) => l.stage !== "won" && l.stage !== "lost");
  const totalPipeline   = activeLeads.reduce((s, l) => s + (l.value ?? 0), 0);
  const newToday        = (leads ?? []).filter((l) => {
    const d = new Date(l.created_at);
    return d.toDateString() === new Date().toDateString();
  }).length;
  const totalCustomers  = customers?.length ?? 0;
  const acceptedQuotes  = (quotes ?? []).filter((q) => q.status === "accepted");
  const acceptedValue   = acceptedQuotes.reduce((s, q) => s + (q.amount ?? 0), 0);
  const draftQuotes     = (quotes ?? []).filter((q) => q.status === "draft").length;

  // "Closed THIS MONTH" — must actually be this month, not all-time (that was a
  // mislabeled money number). Quotes have no accepted_at, so use updated_at as
  // the best proxy for when an accepted quote was closed. Header, KPI tile and
  // the leaderboard all read these SAME figures so they can never disagree.
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const closedThisMonth = acceptedQuotes.filter(
    (q) => q.updated_at && new Date(q.updated_at) >= monthStart,
  );
  const closedThisMonthValue = closedThisMonth.reduce((s, q) => s + (q.amount ?? 0), 0);

  // "Chase the cash" — money owed to us. Real receivables = subscription dues +
  // project invoiced-but-unpaid (same basis as the Customers list / Aging), not
  // just accepted-quote balances (which missed projects entirely).
  const subsOutstanding = (subscriptions ?? []).reduce((s, x) => s + (x.outstanding_amount ?? 0), 0);
  const projectReceivable = Object.values(projRecv).reduce((s, v) => s + v, 0);
  const toCollect = subsOutstanding + projectReceivable;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const overdueFollowups = (leads ?? []).filter(
    (l) => l.follow_up_date && l.stage !== "won" && l.stage !== "lost"
      && new Date(l.follow_up_date).getTime() < todayStart.getTime(),
  ).length;

  // Subscription aggregates — sum MRR across active subs only
  const activeSubs    = (subscriptions ?? []).filter((s) => s.status === "active");
  const activeMRR     = activeSubs.reduce((s, x) => s + (x.mrr ?? 0), 0);

  // Renewal pipeline — what's coming due in the next 30 days. Drives both
  // the "Today's Focus" urgent-renewal row and the "Renewals coming up"
  // side panel. Past renewal_date subs in grace count as urgent too.
  const today = new Date();
  const enrichedRenewals = activeSubs
    .filter((s) => s.renewal_date !== null)
    .map((s) => ({ sub: s, daysUntil: daysBetween(today, s.renewal_date!) }))
    .filter((r) => r.daysUntil <= 30)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const urgentRenewals  = enrichedRenewals.filter((r) => r.daysUntil <= 7);
  const renewalsRevAtRisk = enrichedRenewals.reduce((sum, r) => sum + (r.sub.mrr ?? 0) * 12, 0);

  // Tasks summary for "Today's Focus"
  const overdueTaskCount = tasksOverdue?.length ?? 0;
  const todayTaskCount   = tasksToday?.length   ?? 0;

  // Today's focus — built from real data
  // Order matters: overdue tasks scream first, then today's tasks, then
  // pipeline-level signals.
  const focus = [
    overdueTaskCount > 0 && {
      icon: "alert", tone: "rose",
      title: `${overdueTaskCount} overdue task${overdueTaskCount === 1 ? "" : "s"}`,
      note: "Clear these first — every snooze pushes the deal further.",
      action: "Open", cta: "/tasks",
    },
    todayTaskCount > 0 && {
      icon: "clock", tone: "amber",
      title: `${todayTaskCount} task${todayTaskCount === 1 ? "" : "s"} due today`,
      note: "Follow-ups, calls, emails on your queue.",
      action: "Open", cta: "/tasks",
    },
    urgentRenewals.length > 0 && {
      icon: "refresh", tone: "rose",
      title: `${urgentRenewals.length} renewal${urgentRenewals.length === 1 ? "" : "s"} in next 7 days`,
      note: `${rupee(urgentRenewals.reduce((s, r) => s + (r.sub.mrr ?? 0) * 12, 0), { compact: true })} ARR · call or send the quote`,
      action: "Open", cta: "/renewals",
    },
    activeLeads.length > 0 && {
      icon: "target", tone: "indigo",
      title: `${activeLeads.length} active leads in pipeline`,
      note: `${rupee(totalPipeline, { compact: true })} pipeline value`,
      action: "View", cta: "/leads",
    },
    draftQuotes > 0 && {
      icon: "file", tone: "amber",
      title: `${draftQuotes} draft quote${draftQuotes === 1 ? "" : "s"} to finalize`,
      note: "Not yet sent to customers",
      action: "Open", cta: "/quotes",
    },
    acceptedQuotes.length > 0 && {
      icon: "check_circle", tone: "emerald",
      title: `${acceptedQuotes.length} accepted quote${acceptedQuotes.length === 1 ? "" : "s"}`,
      note: `${rupee(acceptedValue, { compact: true })} ready to invoice`,
      action: "Process", cta: "/quotes",
    },
    totalCustomers === 0 && {
      icon: "users", tone: "amber",
      title: "Add your first customer",
      note: "Start tracking customer health + renewals",
      action: "Add", cta: "/customers",
    },
    {
      icon: "flame", tone: "rose",
      title: `${newToday} new lead${newToday === 1 ? "" : "s"} today`,
      note: newToday > 0 ? "Worth focusing on early" : "Quiet day",
      action: "View",
      cta: "/leads",
    },
  ].filter(Boolean) as Array<{ icon: string; tone: string; title: string; note: string; action: string; cta: string }>;

  // Real recent activity feed — pulls from leads/quotes/payments tables.
  // Prevents the dashboard from showing fake "Welcome to your workspace"
  // placeholders that confused operators (they expected to see what THEY did,
  // not generic welcome messages).
  const activity = React.useMemo(() => {
    const now = Date.now();
    const HRS_24 = 24 * 60 * 60 * 1000;
    const items: Array<{ icon: string; tone: string; title: string; time: string; ts: number }> = [];

    // Recent leads (created in last 24h)
    (leads ?? []).forEach((l) => {
      const ts = new Date(l.created_at).getTime();
      if (now - ts <= HRS_24) {
        items.push({
          icon:  "target",
          tone:  l.stage === "won" ? "emerald" : l.plan ? "indigo" : "amber",
          title: l.stage === "won"
            ? `Lead won: ${l.company}${l.value ? ` · ${rupee(l.value, { compact: true })}` : ""}`
            : `New lead: ${l.company}${l.plan ? ` · ${l.plan}` : ""}`,
          time:  relativeTime(ts, now),
          ts,
        });
      }
    });

    // Recent quotes (created in last 24h)
    (quotes ?? []).forEach((q) => {
      const ts = new Date(q.created_at).getTime();
      if (now - ts <= HRS_24) {
        items.push({
          icon:  "file",
          tone:  q.payment_status === "received" ? "emerald" : "slate",
          title: q.payment_status === "received"
            ? `Quote paid: ${q.id} · ${rupee(q.amount ?? 0, { compact: true })}`
            : `Quote ${q.status === "sent" ? "sent" : "created"}: ${q.id} · ${q.customer_name}`,
          time:  relativeTime(ts, now),
          ts,
        });
      }
    });

    // Sort newest first, take top 6
    return items.sort((a, b) => b.ts - a.ts).slice(0, 6);
  }, [leads, quotes]);

  const leaderboard = [
    { rank: 1, name: `${currentUser?.fullName ?? "You"} (you)`, amount: closedThisMonthValue, deals: closedThisMonth.length, color: "amber" },
  ];

  // Real upcoming follow-ups — pulls from leads.follow_up_date in next 7 days
  // (instead of hardcoded "TechBrand Pvt Ltd" / "Cosmo Tech" that confused
  // operators who couldn't find these companies anywhere in the app).
  const upcoming = React.useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    return (leads ?? [])
      .filter((l) => l.follow_up_date && l.stage !== "won" && l.stage !== "lost")
      .map((l) => {
        const dueTs = new Date(l.follow_up_date!).getTime();
        const dueDate = new Date(l.follow_up_date!);
        const daysAway = Math.floor((dueTs - today.getTime()) / (24 * 60 * 60 * 1000));
        const timeLabel =
          daysAway < 0 ? `${Math.abs(daysAway)}d overdue` :
          daysAway === 0 ? "Today" :
          daysAway === 1 ? "Tomorrow" :
          formatDate(dueDate);
        return {
          type: l.stage === "demo" ? "Demo" : l.stage === "trial" ? "Trial" : "Follow-up",
          who:  l.company,
          time: timeLabel,
          icon: l.stage === "demo" ? "users" : l.stage === "trial" ? "rocket" : "phone",
          tone: daysAway < 0 ? "rose" : daysAway === 0 ? "amber" : "indigo",
          href: `/leads?lead=${l.id}` as const,
          ts:   dueTs,
        };
      })
      .filter((u) => u.ts - today.getTime() < SEVEN_DAYS)  // within next week
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 5);
  }, [leads]);

  const integrations = [
    { name: "Supabase Auth + DB",         status: "Live",       tone: "ok" as const },
    { name: "Razorpay",                   status: "Not setup",  tone: "warn" as const },
    { name: "GST e-Invoice (NIC/IRP)",    status: "Not setup",  tone: "warn" as const },
    { name: "Google CSP Reseller API",    status: "Not setup",  tone: "warn" as const },
    { name: "WhatsApp Business (Gupshup)", status: "Not setup", tone: "warn" as const },
  ];

  // ── Draggable dashboard widgets ───────────────────────────────────────────
  // Each card is addressable by id so the two columns can render in the user's
  // saved order. Chase-the-cash only exists when there's something to chase.
  const hasChase = toCollect > 0 || overdueFollowups > 0 || overdueTaskCount > 0;
  const widgets: Record<string, React.ReactNode> = {
    focus: (
      <Card title="Today's Focus" sub="What needs your attention now"
        actions={<Button size="sm" variant="ghost" icon="filter">All</Button>} flush>
        <div className="px-4 pb-3">
          {focus.map((f, i) => (
            <FocusRow key={i} icon={f.icon} tone={f.tone} title={f.title} note={f.note}
              action={f.action} onClick={() => router.push(f.cta as any)} isLast={i === focus.length - 1} />
          ))}
        </div>
      </Card>
    ),
    activity: (
      <Card title="Recent Activity" sub="Last 24 hours"
        actions={<Button size="sm" variant="ghost" iconRight="external">Full feed</Button>}>
        {activity.length === 0 ? (
          <div className="py-6 text-center text-sm text-ink-3">
            Nothing happened in the last 24 hours.<br/>
            <span className="text-[11px]">Add a lead or send a quote to see activity here.</span>
          </div>
        ) : (
          <div className="space-y-3">
            {activity.map((a, i) => <ActivityRow key={i} icon={a.icon} tone={a.tone} title={a.title} time={a.time} />)}
          </div>
        )}
      </Card>
    ),
    pipeline: (
      <Card title="Pipeline by Stage"
        sub={activeLeads.length > 0
          ? `${rupee(totalPipeline, { compact: true })} across ${activeLeads.length} deal${activeLeads.length === 1 ? "" : "s"}`
          : "No active deals yet"}>
        {!leads ? (
          <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-6" />)}</div>
        ) : activeLeads.length === 0 ? (
          <div className="py-6 text-center text-sm text-ink-3">
            Add your first lead at <Link href={"/leads" as any} className="text-amber-ink underline">/leads</Link>
          </div>
        ) : (
          <div className="space-y-3">
            {LEAD_STAGES.map((s) => {
              const stageLeads = (leads ?? []).filter((l) => l.stage === s.id);
              const value = stageLeads.reduce((sum, l) => sum + (l.value ?? 0), 0);
              const maxValue = Math.max(1, ...LEAD_STAGES.map((stg) =>
                (leads ?? []).filter((l) => l.stage === stg.id).reduce((s, l) => s + (l.value ?? 0), 0)));
              const pct = (value / maxValue) * 100;
              return (
                <div key={s.id} className="grid grid-cols-[120px_1fr_90px_36px] items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={cn("w-1.5 h-1.5 rounded-full", s.dot)} />{s.label}
                  </div>
                  <div className="h-2 rounded-full bg-paper-2 overflow-hidden">
                    <div className={cn("h-full rounded-full transition-all", s.color)} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="text-right tabular-nums text-sm text-ink-2">{value > 0 ? rupee(value, { compact: true }) : "—"}</div>
                  <div className="text-right tabular-nums text-xs text-ink-3">{stageLeads.length}</div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    ),
    chase: (
      <Card title="Chase the cash" sub="Money owed + what's overdue" className="border-amber/40 bg-amber-soft/20">
        <div className="space-y-1">
          {toCollect > 0 && (
            <ChaseRow icon="rupee" tone="emerald" title={`${rupee(toCollect, { compact: true })} to collect`}
              note={projectReceivable > 0 ? `subscription dues + ${rupee(projectReceivable, { compact: true })} project` : "subscription dues + project invoices"}
              onClick={() => router.push("/accounting/aging" as any)} />
          )}
          {overdueFollowups > 0 && (
            <ChaseRow icon="phone" tone="rose" title={`${overdueFollowups} follow-up${overdueFollowups === 1 ? "" : "s"} overdue`}
              note="Call / message before the deal cools" onClick={() => router.push("/leads" as any)} />
          )}
          {overdueTaskCount > 0 && (
            <ChaseRow icon="alert" tone="rose" title={`${overdueTaskCount} task${overdueTaskCount === 1 ? "" : "s"} overdue`}
              note="Clear these first" onClick={() => router.push("/tasks" as any)} />
          )}
        </div>
      </Card>
    ),
    leaderboard: (
      <Card title="Sales Leaderboard" sub="This month">
        <div className="space-y-3">
          {leaderboard.map((p) => (
            <div key={p.rank} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
              <div className={cn("w-7 h-7 rounded-full grid place-items-center font-serif text-sm",
                p.rank === 1 ? "bg-amber text-white" : "bg-paper-2 text-ink-2")}>{p.rank}</div>
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-[11px] text-ink-3">{p.deals} deal{p.deals === 1 ? "" : "s"} closed</div>
              </div>
              <div className="font-serif tabular-nums text-lg">{rupee(p.amount, { compact: true })}</div>
            </div>
          ))}
          {leaderboard.length === 0 && <div className="text-center text-sm text-ink-3 py-2">No closed deals yet</div>}
        </div>
      </Card>
    ),
    renewals: (
      <Card title="Renewals coming up"
        sub={enrichedRenewals.length === 0
          ? "No subscriptions renewing in 30 days"
          : `${enrichedRenewals.length} sub${enrichedRenewals.length === 1 ? "" : "s"} · ${rupee(renewalsRevAtRisk, { compact: true })} ARR`}
        actions={enrichedRenewals.length > 0 ? (
          <Button asChild size="sm" variant="ghost" iconRight="arrow_right"><Link href={"/renewals" as any}>View all</Link></Button>
        ) : undefined}>
        {enrichedRenewals.length === 0 ? (
          <div className="py-3 text-center text-xs text-ink-3">Once you have active subscriptions, those nearing renewal will surface here.</div>
        ) : (
          <div className="space-y-2.5">
            {enrichedRenewals.slice(0, 5).map(({ sub, daysUntil }) => (
              <div key={sub.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
                <div className={cn("w-8 h-8 rounded-md border border-hairline grid place-items-center",
                  daysUntil <= 7 ? "text-rose" : daysUntil <= 14 ? "text-amber-ink" : "text-ink-3")}>
                  <Icon name="refresh" size={14} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{sub.customer_name}</div>
                  <div className="flex items-center gap-2 text-[11px] text-ink-3 mt-0.5">
                    <span>{sub.renewal_date ? formatDate(sub.renewal_date) : "—"}</span><span>·</span>
                    <span className="font-mono">{sub.seats} seats · {rupee(sub.mrr)}/mo</span>
                  </div>
                  {sub.renewal_state !== "pending" && (
                    <div className="mt-1"><Badge kind={renewalStateTone(sub.renewal_state)} dot>{renewalStateLabel(sub.renewal_state)}</Badge></div>
                  )}
                </div>
                <div className={cn("text-right text-xs font-medium tabular-nums",
                  daysUntil <= 0 ? "text-rose" : daysUntil <= 7 ? "text-rose" : daysUntil <= 14 ? "text-amber-ink" : "text-ink-3")}>
                  {daysUntil < 0 ? `${Math.abs(daysUntil)}d grace` : daysUntil === 0 ? "today" : `${daysUntil}d`}
                </div>
              </div>
            ))}
            {enrichedRenewals.length > 5 && (
              <p className="text-[11px] text-ink-3 pt-2 border-t border-hairline">+ {enrichedRenewals.length - 5} more renewing soon</p>
            )}
          </div>
        )}
      </Card>
    ),
    trials: <TrialsExpiringCard />,
    comingup: (
      <Card title="Coming Up"
        sub={upcoming.some((u) => u.time.includes("overdue")) ? "⚠ Overdue first, then next 7 days" : "Next 7 days · scheduled follow-ups"}>
        {upcoming.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-sm text-ink-3 mb-2">No follow-ups scheduled.</p>
            <Link href={"/leads" as any} className="inline-flex items-center gap-1 text-xs text-amber-ink hover:underline">Schedule one from a lead →</Link>
          </div>
        ) : (
          <div className="space-y-3">
            {upcoming.map((u, i) => (
              <button key={i} onClick={() => router.push(u.href as any)}
                className="w-full grid grid-cols-[auto_1fr_auto] items-center gap-3 text-left hover:bg-paper-2 -mx-2 px-2 py-1.5 rounded-md transition-colors">
                <div className={cn("w-8 h-8 rounded-md border border-hairline grid place-items-center",
                  u.tone === "indigo" && "text-indigo", u.tone === "amber" && "text-amber-ink", u.tone === "rose" && "text-rose")}>
                  <Icon name={u.icon} size={14} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{u.type}: <span className="font-normal">{u.who}</span></div>
                  <div className={cn("text-[11px]", u.tone === "rose" ? "text-rose font-medium" : "text-ink-3")}>{u.time}</div>
                </div>
                <Icon name="arrow_right" size={14} className="text-ink-3" />
              </button>
            ))}
          </div>
        )}
      </Card>
    ),
    health: (
      <Card title="Health" sub="System & integrations">
        <div className="space-y-2">
          {integrations.map((s) => (
            <div key={s.name} className="flex justify-between items-center text-xs">
              <div className="flex items-center gap-2">
                <span className={cn("w-1.5 h-1.5 rounded-full", s.tone === "ok" ? "bg-emerald" : "bg-amber")} />
                <span>{s.name}</span>
              </div>
              <span className={cn(s.tone === "ok" ? "text-emerald" : "text-amber-ink")}>{s.status}</span>
            </div>
          ))}
        </div>
      </Card>
    ),
  };

  // Effective visible order = saved order (minus unavailable) + any new widgets.
  const availIds = (all: string[]) => all.filter((id) => (id !== "chase" || hasChase) && widgets[id]);
  const mergeOrder = (saved: string[], all: string[]) => {
    const a = availIds(all);
    return [...saved.filter((id) => a.includes(id)), ...a.filter((id) => !saved.includes(id))];
  };
  const leftIds  = mergeOrder(leftOrder, DASH_LEFT);
  const rightIds = mergeOrder(rightOrder, DASH_RIGHT);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            {dateLabel}
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">
            {greeting}{firstName ? `, ${firstName}` : ""}.
          </h1>
          {/* Money one-liner — the greeting row also carries business signal so
              the seller sees "how am I doing" before scanning anything. */}
          <p className="text-sm text-ink-3 mt-1">
            <b className="text-emerald tabular-nums">{rupee(closedThisMonthValue, { compact: true })}</b> closed this month
            <span className="mx-1.5">·</span>
            <b className="text-ink tabular-nums">{rupee(totalPipeline, { compact: true })}</b> in pipeline
            <span className="hidden sm:inline"> · {workspaceName}</span>
          </p>
        </div>
        <div className="flex gap-2">
          {/* Re-run setup — only when wizard was completed once. Wizard
              entry is hidden from sidebar after completion, so this
              keeps it reachable for a re-run / re-tour. */}
          {currentUser?.tenantSetupCompletedAt && (
            <Button asChild variant="ghost" icon="rocket">
              <Link href={"/setup" as any}>Re-run setup</Link>
            </Button>
          )}
          <Button asChild variant="primary" icon="plus">
            <Link href={"/quotes/new" as any}>Quick add quote</Link>
          </Button>
        </div>
      </div>

      {/* First-run onboarding — guides a new reseller to their first quote, then
          retires itself once they're set up (all steps derived from real data). */}
      <GettingStartedCard
        setupDone={Boolean(currentUser?.tenantSetupCompletedAt)}
        hasCustomer={(customers?.length ?? 0) > 0}
        hasQuote={(quotes?.length ?? 0) > 0}
        hasSale={(subscriptions?.length ?? 0) > 0}
        workspaceName={currentUser?.tenantName ?? ""}
      />

      {/* Priority Action Hub for actionable alerts */}
      <PriorityActionHub
        expiringRenewalsCount={urgentRenewals.length}
        expiringRenewalsValue={urgentRenewals.reduce((s, r) => s + (r.sub.mrr ?? 0) * 12, 0)}
        draftQuotesCount={draftQuotes}
        pendingCollectValue={toCollect}
      />

      {/* KPI — money-first, 2-tier. The three ₹ metrics get big coloured tiles
          (a seller's eye should hit money first, F-pattern top-left); the plain
          counts drop to a compact secondary strip so zeros don't shout. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
        <KPI
          label="Closed this month"
          value={rupee(closedThisMonthValue, { compact: true })}
          accent="emerald"
          trend={`${closedThisMonth.length} quote${closedThisMonth.length === 1 ? "" : "s"} accepted`}
          trendKind="up"
          trendIcon="check"
          icon="check_circle"
        />
        <KPI
          label="Pipeline"
          value={rupee(totalPipeline, { compact: true })}
          trend={`${activeLeads.length} active deals`}
          trendKind="up"
          trendIcon="trending_up"
          icon="target"
        />
        <KPI
          label="Monthly revenue"
          value={subscriptions ? rupee(activeMRR, { compact: true }) : "—"}
          accent={activeMRR > 0 ? "emerald" : "ink"}
          trend={
            activeSubs.length === 0
              ? "No subs yet"
              : `${activeSubs.length} active sub${activeSubs.length === 1 ? "" : "s"}`
          }
          trendKind={activeMRR > 0 ? "up" : "neutral"}
          trendIcon={activeMRR > 0 ? "trending_up" : undefined}
          icon="rupee"
        />
      </div>
      <StatStrip
        className="mb-6"
        items={[
          { label: "Customers", value: totalCustomers },
          { label: "Drafts to send", value: draftQuotes },
          {
            label: "Renewals · 30d",
            value: enrichedRenewals.length,
            tone: urgentRenewals.length > 0 ? "rose" : undefined,
          },
        ]}
      />

      {/* Partner renewals alert — distributor tenants only, Slice 4.
          Aggregates across all sub-resellers via get_partner_metrics RPC. */}
      <PartnerRenewalAlertCard />

      {/* Drag hint */}
      <p className="text-[11px] text-ink-3 mb-2 hidden md:flex items-center gap-1">
        <Icon name="more_h" size={11} className="rotate-90" />
        Drag any card by its handle to rearrange — your layout is saved on this device.
      </p>

      {/* Main 2-col grid — each column's cards are drag-to-reorder (framer-motion). */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.55fr_1fr] gap-4 items-start">
        <DashColumn ids={leftIds} widgets={widgets}
          onReorder={(o) => { setLeftOrder(o); persistOrder(LS_LEFT, o); }} />
        <DashColumn ids={rightIds} widgets={widgets}
          onReorder={(o) => { setRightOrder(o); persistOrder(LS_RIGHT, o); }} />
      </div>
    </div>
  );
}

// ============================================================
// FocusRow — matches prototype's focus-row pattern
// ============================================================
function FocusRow({
  icon, tone, title, note, action, onClick, isLast,
}: {
  icon: string; tone: string; title: string; note: string; action: string; onClick: () => void; isLast: boolean;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-[32px_1fr_auto] items-center gap-3 py-2.5",
        !isLast && "border-b border-hairline"
      )}
    >
      <div
        className={cn(
          "w-7 h-7 rounded-md grid place-items-center",
          tone === "indigo"  && "bg-indigo-soft text-indigo",
          tone === "amber"   && "bg-amber-soft text-amber-ink",
          tone === "emerald" && "bg-emerald-soft text-emerald",
          tone === "rose"    && "bg-rose-soft text-rose",
        )}
      >
        <Icon name={icon} size={14} />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-medium leading-tight">{title}</div>
        <div className="text-[11px] text-ink-3 mt-0.5">{note}</div>
      </div>
      <Button size="sm" variant="outline" iconRight="arrow_right" onClick={onClick}>
        {action}
      </Button>
    </div>
  );
}

// ============================================================
// ChaseRow — a single "chase the cash" action line.
// ============================================================
function ChaseRow({
  icon, tone, title, note, onClick,
}: {
  icon: string; tone: "emerald" | "rose" | "amber"; title: string; note: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full grid grid-cols-[32px_1fr_auto] items-center gap-3 py-2 text-left hover:bg-paper-2/60 -mx-2 px-2 rounded-md transition-colors"
    >
      <div className={cn(
        "w-7 h-7 rounded-md grid place-items-center",
        tone === "emerald" && "bg-emerald-soft text-emerald",
        tone === "amber"   && "bg-amber-soft text-amber-ink",
        tone === "rose"    && "bg-rose-soft text-rose",
      )}>
        <Icon name={icon} size={14} />
      </div>
      <div className="min-w-0">
        <div className={cn("text-sm font-semibold leading-tight", tone === "emerald" ? "text-emerald" : tone === "rose" ? "text-rose" : "text-ink")}>{title}</div>
        <div className="text-[11px] text-ink-3 mt-0.5">{note}</div>
      </div>
      <Icon name="arrow_right" size={14} className="text-ink-3" />
    </button>
  );
}

// ============================================================
// ActivityRow — matches prototype's activity pattern
// ============================================================
function ActivityRow({ icon, tone, title, time }: { icon: string; tone: string; title: string; time: string }) {
  return (
    <div className="grid grid-cols-[28px_1fr_auto] items-center gap-3">
      <div className={cn(
        "w-6 h-6 rounded-full grid place-items-center",
        tone === "indigo"  && "bg-indigo-soft text-indigo",
        tone === "amber"   && "bg-amber-soft text-amber-ink",
        tone === "emerald" && "bg-emerald-soft text-emerald",
        tone === "rose"    && "bg-rose-soft text-rose",
        tone === "slate"   && "bg-slate-soft text-slate",
      )}>
        <Icon name={icon} size={12} />
      </div>
      <div className="text-sm">{title}</div>
      <div className="text-[11px] text-ink-3">{time}</div>
    </div>
  );
}

// ============================================================
// DashColumn / DashWidget — drag-to-reorder cards (framer-motion Reorder).
// A per-card grip handle triggers the drag (dragListener={false}) so buttons
// and links inside the card still work normally.
// ============================================================
function DashColumn({
  ids, widgets, onReorder,
}: {
  ids: string[]; widgets: Record<string, React.ReactNode>; onReorder: (order: string[]) => void;
}) {
  return (
    <Reorder.Group axis="y" values={ids} onReorder={onReorder} className="space-y-4">
      {ids.map((id) => (
        <DashWidget key={id} id={id}>{widgets[id]}</DashWidget>
      ))}
    </Reorder.Group>
  );
}

function DashWidget({ id, children }: { id: string; children: React.ReactNode }) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={id}
      dragListener={false}
      dragControls={controls}
      className="relative group/drag"
    >
      {/* Grip handle — appears on hover; only this starts the drag. */}
      <button
        type="button"
        aria-label="Drag to rearrange"
        onPointerDown={(e) => controls.start(e)}
        className="absolute left-1 top-3.5 z-10 hidden md:flex h-6 w-5 touch-none cursor-grab items-center justify-center rounded text-ink-3/40 opacity-0 transition-opacity hover:text-ink-2 group-hover/drag:opacity-100 active:cursor-grabbing"
      >
        <Icon name="more_h" size={14} className="rotate-90" />
      </button>
      {children}
    </Reorder.Item>
  );
}

// ============================================================
// PartnerRenewalAlertCard (Slice 4 — distributor inventory alerts)
// ============================================================

/**
 * Banner-style card shown on a distributor tenant's dashboard summarising
 * upcoming renewals across all sub-resellers. Lets Excel Tech see "Anutech
 * has X seats renewing this month — confirm Google Workspace inventory"
 * at a glance, without having to navigate to /partners.
 *
 * Only renders when:
 *   • caller's tenant tier = 'distributor'
 *   • at least one partner has renewals_due_30d > 0
 *
 * Re-uses get_partner_metrics() RPC from Slice 3 — no extra schema needed.
 */
function PartnerRenewalAlertCard() {
  const { data: hierarchy } = useQuery({
    queryKey: ["tenant", "hierarchy", "dashboard-partner-alert"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const isDistributor = hierarchy?.tier === "distributor";

  const { data: metrics } = useQuery({
    enabled: isDistributor,
    queryKey: ["partner-metrics", "dashboard-summary"],
    queryFn: async (): Promise<PartnerMetricsRow[]> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_partner_metrics");
      return (data ?? []) as PartnerMetricsRow[];
    },
  });

  const totals = React.useMemo(() => {
    if (!metrics) return null;
    return metrics.reduce(
      (acc, m) => ({
        renewals:        acc.renewals + m.renewals_due_30d,
        renewal_value:   acc.renewal_value + m.renewal_revenue_30d,
        partners_w_due:  acc.partners_w_due + (m.renewals_due_30d > 0 ? 1 : 0),
      }),
      { renewals: 0, renewal_value: 0, partners_w_due: 0 },
    );
  }, [metrics]);

  if (!isDistributor) return null;
  if (!totals || totals.renewals === 0) return null;

  return (
    <Card className="p-4 mb-6 bg-amber-soft/40 border-amber-soft">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="h-9 w-9 rounded-lg bg-amber/15 text-amber-ink flex items-center justify-center shrink-0">
          <Icon name="alert" size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            <b className="text-amber-ink">{totals.renewals}</b> partner renewal
            {totals.renewals === 1 ? "" : "s"} due in 30 days
            <span className="text-ink-3 font-normal"> ·</span>
            <span className="text-ink-2 font-mono font-medium ml-1.5">{rupee(totals.renewal_value)}</span>
            <span className="text-ink-3 font-normal text-xs ml-1">projected annual</span>
          </p>
          <p className="text-[11px] text-ink-3">
            {totals.partners_w_due} of your sub-reseller{totals.partners_w_due === 1 ? "" : "s"} have customer renewals coming up. Confirm inventory + cash flow.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" icon="link">
          <Link href={"/partners" as any}>View partners →</Link>
        </Button>
      </div>
    </Card>
  );
}
