/**
 * Renewals Dashboard — matches prototype screen C8.
 *
 * Layout:
 *   - Page header (eyebrow/title/subtitle + Export / Bulk-reminder)
 *   - 5 KPIs: Urgent / Upcoming / Future / High-Risk / Renewal rate
 *   - GeminiCard: next-best-actions
 *   - RenewalBucket × 3 (Urgent rose / Upcoming amber / Future emerald)
 *
 * Risk model — REAL signals only (see renewalRisk):
 *   - Seat utilisation (used/seats)
 *   - Unpaid balance on the current term
 *   - Plan tier (starter churns a little more)
 *   (Fabricated login/tickets/NPS signals were removed — misleading on a money screen.)
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useSubscriptions } from "@/lib/queries/subscriptions";
import { toast } from "sonner";
import { GeminiCard } from "@/components/shared/gemini-card";
import { AiDraftButton } from "@/components/shared/ai-draft-button";
import { VoiceNoteButton } from "@/components/shared/voice-note-button";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { rupee, formatDate, daysBetween } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { downloadCSV } from "@/lib/csv";
import type { Subscription } from "@/lib/supabase/database.types";
import { renewalStateLabel, renewalStateTone } from "@/lib/renewals/cadence";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useQueryClient } from "@tanstack/react-query";

// ─── Risk model ──────────────────────────────────────────────────────────────

interface RiskResult {
  score: number;
  level: "high" | "medium" | "low";
  /** Badge `kind` prop value */
  badgeKind: "danger" | "warning" | "success";
  label: string;
  reasons: string[];
}

/**
 * Renewal-risk score (0–100) for a subscription, from REAL data only.
 *
 * Was previously inflated with fabricated signals (admin-login / support-tickets /
 * NPS derived from an id hash) that looked like real churn intelligence to the
 * owner — removed, because showing invented reasons on a money screen is
 * misleading. This now scores on what we actually know: how many seats are
 * unused, whether there's an unpaid balance, and the plan tier. When live
 * product-usage / NPS signals exist, add them here.
 */
function renewalRisk(sub: Subscription): RiskResult {
  let score = 0;
  const reasons: string[] = [];

  // Signal 1: Seat utilisation — unused seats are the strongest real churn tell.
  const utilisation = sub.used / Math.max(1, sub.seats);
  if (utilisation < 0.7) {
    score += 40;
    reasons.push(`Low seat usage (${Math.round(utilisation * 100)}%)`);
  } else if (utilisation < 0.85) {
    score += 20;
    reasons.push(`Moderate seat usage (${Math.round(utilisation * 100)}%)`);
  }

  // Signal 2: Unpaid balance on the current term — a customer already behind on
  // payment is far more likely to lapse at renewal.
  if (sub.outstanding_amount > 0) {
    score += 35;
    reasons.push(`Unpaid balance (${rupee(sub.outstanding_amount, { compact: true })})`);
  }

  // Signal 3: Plan tier — lower tiers churn a little more.
  const plan = sub.plan.toLowerCase();
  if (plan.includes("starter")) {
    score += 15;
    reasons.push("Lower-tier plan (Starter)");
  }

  score = Math.min(100, score);

  const level: RiskResult["level"] =
    score >= 55 ? "high" : score >= 25 ? "medium" : "low";
  const badgeKind: RiskResult["badgeKind"] =
    level === "high" ? "danger" : level === "medium" ? "warning" : "success";
  const label =
    level === "high" ? "HIGH RISK" : level === "medium" ? "Medium" : "Healthy";

  return { score, level, badgeKind, label, reasons };
}

// ─── Vendor logo pill ─────────────────────────────────────────────────────────

function VendorPill({ vendor }: { vendor: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    google:    { label: "Google",    cls: "bg-blue-50 text-blue-700" },
    microsoft: { label: "Microsoft", cls: "bg-indigo-50 text-indigo-700" },
    zoho:      { label: "Zoho",      cls: "bg-amber-50 text-amber-700" },
    other:     { label: "Other",     cls: "bg-muted text-muted-foreground" },
  };
  const v = map[vendor] ?? map.other;
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        v.cls,
      )}
    >
      {v.label}
    </span>
  );
}

// ─── RenewalBucket ────────────────────────────────────────────────────────────

interface RenewalBucketProps {
  kind: "rose" | "amber" | "emerald";
  title: string;
  subtitle: string;
  rows: Array<{ sub: Subscription; daysUntil: number }>;
  graceDays: number;
  defaultOpen?: boolean;
  /** Rendered inside a tab — always open, no Show/Hide toggle. */
  embedded?: boolean;
}

function RenewalBucket({
  kind,
  title,
  subtitle,
  rows,
  graceDays,
  defaultOpen = true,
  embedded = false,
}: RenewalBucketProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  const isOpen = embedded || open;
  const [sending, setSending] = React.useState<string | null>(null);
  const [generating, setGenerating] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const router = useRouter();

  async function handleGenerateQuote(sub: Subscription) {
    setGenerating(sub.id);
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/generate-renewal-quote`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not generate renewal quote");
        return;
      }
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      const msg = json.alreadyExisted
        ? `Opening existing renewal quote for ${sub.customer_name}`
        : `Renewal quote ${json.quoteId} created for ${sub.customer_name}`;
      toast.success(msg, { duration: 3500 });
      // Navigate so the operator can edit before sending
      router.push(`/quotes/${json.quoteId}` as never);
    } catch (err) {
      toast.error(`Failed: ${(err as Error).message}`);
    } finally {
      setGenerating(null);
    }
  }

  async function handleSendNow(sub: Subscription) {
    setSending(sub.id);
    try {
      const res = await fetch("/api/renewals/send-now", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subscription_id: sub.id }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Send failed");
        return;
      }
      const mode = json.email_mode === "stub" ? " (stub mode — no real email)" : "";
      toast.success(`${json.status === "sent" ? "Sent" : "Logged"} ${json.step} to ${sub.customer_name}${mode}`);
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
    } catch (err) {
      toast.error(`Send failed: ${(err as Error).message}`);
    } finally {
      setSending(null);
    }
  }

  const dotCls =
    kind === "rose"
      ? "bg-rose-500"
      : kind === "amber"
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <Card className="overflow-hidden">
      {/* Bucket header */}
      <div
        className={cn(
          "flex items-center justify-between px-5 py-4",
          isOpen && "border-b border-hairline",
        )}
      >
        <div className="flex items-center gap-3">
          <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", dotCls)} />
          <div>
            <p className="text-sm font-semibold text-ink">{title}</p>
            <p className="text-xs text-ink-3">
              {subtitle} ·{" "}
              <span className="tabular-nums">{rows.length}</span>{" "}
              {rows.length === 1 ? "subscription" : "subscriptions"}
            </p>
          </div>
        </div>
        {!embedded && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(!open)}
            className="gap-1 text-xs"
          >
            {open ? "Hide" : "Show"}
            <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
          </Button>
        )}
      </div>

      {/* Mobile card list — phones only */}
      {isOpen && rows.length > 0 && (
        <ul className="md:hidden p-3 space-y-2">
          {rows.map(({ sub, daysUntil: days }) => {
            const risk = renewalRisk(sub);
            return (
              <li
                key={sub.id}
                className="bg-paper border border-hairline rounded-lg p-3"
              >
                {/* Top row: name + amount */}
                <div className="flex items-start justify-between gap-3 mb-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink truncate">{sub.customer_name}</p>
                    <p className="text-[11px] text-ink-3 truncate mt-0.5">
                      {sub.plan} · {sub.seats} seats
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(sub.mrr)}</p>
                    <p className="text-[10px] text-ink-3">/mo</p>
                  </div>
                </div>

                {/* Mid row: renewal date + days-until + cadence */}
                <div className="flex items-center flex-wrap gap-1.5 mb-2">
                  <span className="text-xs text-ink-2">
                    {sub.renewal_date ? formatDate(sub.renewal_date) : "—"}
                  </span>
                  {days < 0 ? (
                    <Badge kind="danger" size="sm" dot>Expired {Math.abs(days)}d</Badge>
                  ) : days <= 7 ? (
                    <Badge kind="danger" size="sm" dot>{days}d</Badge>
                  ) : days <= 30 ? (
                    <Badge kind="warning" size="sm" dot>{days}d</Badge>
                  ) : (
                    <Badge kind="muted" size="sm">{days}d</Badge>
                  )}
                  <Badge kind={renewalStateTone(sub.renewal_state)} size="sm" dot>
                    {renewalStateLabel(sub.renewal_state)}
                  </Badge>
                  {risk.level === "high" && (
                    <Badge kind="danger" size="sm">HIGH RISK</Badge>
                  )}
                </div>

                {/* Bottom row: actions */}
                <div className="flex items-center gap-1.5 pt-2 border-t border-hairline/60">
                  {sub.renewal_quote_id ? (
                    <Button
                      asChild
                      variant="default"
                      size="sm"
                      className="flex-1"
                    >
                      <Link href={`/quotes/${sub.renewal_quote_id}` as never}>
                        <Icon name="file" size={12} />
                        Open quote
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      variant={kind === "rose" ? "primary" : "default"}
                      size="sm"
                      className="flex-1"
                      loading={generating === sub.id}
                      disabled={sub.renewal_state === "suspended" || sub.renewal_state === "renewed"}
                      onClick={() => handleGenerateQuote(sub)}
                    >
                      <Icon name="plus" size={12} />
                      Generate
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex-1"
                    loading={sending === sub.id}
                    disabled={sub.renewal_state === "suspended" || sub.renewal_state === "renewed"}
                    onClick={() => handleSendNow(sub)}
                  >
                    <Icon name="mail" size={12} />
                    Send now
                  </Button>
                  {sub.customer_id && (
                    <AiDraftButton customerId={sub.customer_id} channel="whatsapp" purpose="renewal" label="✨ Nudge" variant="ghost" />
                  )}
                  {sub.customer_id && (
                    <VoiceNoteButton customerId={sub.customer_id} purpose="renewal" customerName={sub.customer_name} label="🔊 Voice" variant="ghost" />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Empty bucket — shown on ALL viewports (was previously inside
          `hidden md:block`, so an empty bucket rendered fully blank on phones). */}
      {isOpen && rows.length === 0 && (
        <div className="py-10 text-center text-sm text-ink-3">
          No subscriptions in this window.
        </div>
      )}

      {/* Desktop table */}
      {isOpen && rows.length > 0 && (
        <div className="hidden md:block">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-hairline bg-muted/30">
                    <th className="px-5 py-2.5 text-left text-xs font-medium text-ink-3">
                      Customer
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Plan
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Vendor
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-3">
                      Seats
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Renewal date
                    </th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-ink-3">
                      Monthly
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Reminders
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Renewal risk
                    </th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-3">
                      Action
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ sub, daysUntil: days }) => {
                    const risk = renewalRisk(sub);
                    return (
                      <tr
                        key={sub.id}
                        className="border-b border-hairline last:border-0 hover:bg-muted/20"
                      >
                        {/* Customer + Domain */}
                        <td className="px-5 py-3">
                          <p className="font-semibold text-ink leading-tight">
                            {sub.customer_name}
                          </p>
                          {sub.domain && (
                            <p className="mt-0.5 font-mono text-xs text-ink-3">
                              {sub.domain}
                            </p>
                          )}
                        </td>

                        {/* Plan */}
                        <td className="px-4 py-3 text-ink">{sub.plan}</td>

                        {/* Vendor */}
                        <td className="px-4 py-3">
                          <VendorPill vendor={sub.vendor} />
                        </td>

                        {/* Seats */}
                        <td className="px-4 py-3 text-right tabular-nums text-ink">
                          {sub.seats}
                        </td>

                        {/* Renewal date + urgency badge + last reminder */}
                        <td className="px-4 py-3">
                          <p className="text-ink">
                            {sub.renewal_date ? formatDate(sub.renewal_date) : "—"}
                          </p>
                          <div className="mt-0.5">
                            {days < 0 ? (
                              <Badge kind="danger" dot>
                                Expired {Math.abs(days)}d ago
                              </Badge>
                            ) : days <= 7 ? (
                              <Badge kind="danger" dot>
                                {days}d
                              </Badge>
                            ) : days <= 30 ? (
                              <Badge kind="warning" dot>
                                {days}d
                              </Badge>
                            ) : (
                              <Badge kind="muted">
                                {days}d
                              </Badge>
                            )}
                          </div>
                          {sub.last_reminder_sent_at_v2 && (
                            <p className="mt-1 text-[11px] text-ink-3">
                              Last reminder: {formatDate(sub.last_reminder_sent_at_v2)}
                            </p>
                          )}
                        </td>

                        {/* MRR */}
                        <td className="px-4 py-3 text-right tabular-nums font-medium text-ink">
                          {rupee(sub.mrr)}
                        </td>

                        {/* Cadence (renewal_state from automation) */}
                        <td className="px-4 py-3">
                          <Badge kind={renewalStateTone(sub.renewal_state)} dot>
                            {renewalStateLabel(sub.renewal_state)}
                          </Badge>
                          {sub.reminder_count > 0 && (
                            <p className="mt-1 text-[11px] text-ink-3 tabular-nums">
                              {sub.reminder_count} email{sub.reminder_count === 1 ? "" : "s"} sent
                            </p>
                          )}
                          {days < 0 && sub.renewal_state !== "suspended" && (
                            <p className="mt-1 text-[11px] font-medium text-rose-600">
                              Suspends in {Math.max(0, graceDays - Math.abs(days))}d
                            </p>
                          )}
                        </td>

                        {/* Churn risk */}
                        <td className="px-4 py-3">
                          <Badge kind={risk.badgeKind} dot>
                            {risk.label}
                          </Badge>
                          {risk.reasons.length > 0 && (
                            <p className="mt-1 max-w-[200px] text-xs leading-snug text-ink-3">
                              {risk.reasons[0]}
                              {risk.reasons.length > 1 && (
                                <span
                                  className={cn(
                                    "ml-1",
                                    risk.level === "high"
                                      ? "text-rose-600"
                                      : "text-amber-600",
                                  )}
                                >
                                  · +{risk.reasons.length - 1} more
                                </span>
                              )}
                            </p>
                          )}
                        </td>

                        {/* Action */}
                        <td className="px-4 py-3">
                          <div className="flex flex-col items-start gap-1.5">
                            <div className="flex items-center gap-1.5">
                              {sub.renewal_quote_id ? (
                                <Button
                                  asChild
                                  variant="default"
                                  size="sm"
                                  title="Open the existing renewal quote — edit seats/plan or send"
                                >
                                  <Link href={`/quotes/${sub.renewal_quote_id}` as never}>
                                    <Icon name="file" size={12} />
                                    Open quote
                                  </Link>
                                </Button>
                              ) : (
                                <Button
                                  variant={kind === "rose" ? "primary" : "default"}
                                  size="sm"
                                  loading={generating === sub.id}
                                  disabled={
                                    sub.renewal_state === "suspended" ||
                                    sub.renewal_state === "renewed"
                                  }
                                  onClick={() => handleGenerateQuote(sub)}
                                  title="Create the renewal quote now (early, e.g. customer asked 60 days ahead) — same logic as the T-15 cron auto-create"
                                >
                                  <Icon name="plus" size={12} />
                                  Generate quote
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                loading={sending === sub.id}
                                disabled={
                                  sub.renewal_state === "suspended" ||
                                  sub.renewal_state === "renewed"
                                }
                                onClick={() => handleSendNow(sub)}
                                title="Send the appropriate renewal email immediately (overrides daily cron)"
                              >
                                <Icon name="mail" size={12} />
                                Send now
                              </Button>
                              {sub.customer_id && (
                                <AiDraftButton customerId={sub.customer_id} channel="whatsapp" purpose="renewal" label="✨ Nudge" variant="ghost" />
                              )}
                              {sub.customer_id && (
                                <VoiceNoteButton customerId={sub.customer_id} purpose="renewal" customerName={sub.customer_name} label="🔊 Voice" variant="ghost" />
                              )}
                            </div>
                            {sub.renewal_quote_id && (
                              <p className="text-[11px] text-ink-3 font-mono">
                                Quote: {sub.renewal_quote_id}
                              </p>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
        </div>
      )}
    </Card>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function RenewalsPage() {
  const { data: subs, isLoading, error, refetch } = useSubscriptions();
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();
  const router = useRouter();
  const [bucketTab, setBucketTab] = React.useState("urgent");
  const [bulkSending, setBulkSending] = React.useState(false);
  const graceDays = me?.tenantGracePeriodDays ?? 0;
  const today = new Date();

  if (isLoading) {
    return (
      <div className="p-8 space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-5 gap-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error) {
    return (
      <EmptyState
        icon="alert"
        title="Could not load renewals"
        body={error.message}
        action={
          <Button variant="default" icon="refresh" onClick={() => void refetch()}>
            Retry
          </Button>
        }
      />
    );
  }

  const all = subs ?? [];

  // Top-level empty state — a tenant with zero subscriptions saw an all-zeros
  // StatStrip + three empty buckets (and on mobile, fully blank buckets). Give
  // them a single clear "nothing to renew yet" state that points at how
  // subscriptions get created (a paid quote converts a lead into a subscription).
  if (all.length === 0) {
    return (
      <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
        <div className="mb-6">
          <h1 className="font-serif text-2xl md:text-3xl text-ink">Renewals</h1>
          <p className="text-sm text-ink-3 mt-1">Stay ahead of every subscription renewal — before service lapses.</p>
        </div>
        <Card>
          <EmptyState
            icon="refresh"
            title="No subscriptions to renew yet"
            body="Renewals show up here automatically once you have active subscriptions. A subscription is created when a customer pays for a recurring quote — so send a quote and record the payment to get started."
            action={<Button variant="primary" icon="send" onClick={() => router.push("/quotes/new" as never)}>Create a quote</Button>}
            secondary={<Button variant="default" icon="users" onClick={() => router.push("/customers" as never)}>View customers</Button>}
          />
        </Card>
      </div>
    );
  }

  // Enrich with days-until-renewal (skip cancelled / no-date)
  const enriched = all
    .filter((s) => s.renewal_date !== null && s.status !== "cancelled")
    .map((s) => ({
      sub: s,
      daysUntil: daysBetween(today, s.renewal_date!),
    }));

  // Urgency buckets. Urgent INCLUDES already-lapsed subs (daysUntil < 0, in grace
  // before auto-suspend) — otherwise the very rows about to suspend vanished from
  // every bucket. The row UI already renders the "Expired Nd ago" state.
  const urgent   = enriched.filter((r) => r.daysUntil <= 7);
  const upcoming = enriched.filter((r) => r.daysUntil > 7  && r.daysUntil <= 30);
  const future   = enriched.filter((r) => r.daysUntil > 30 && r.daysUntil <= 90);

  // KPI aggregates
  const urgentMrr   = urgent.reduce((s, r)   => s + r.sub.mrr, 0);
  const upcomingMrr = upcoming.reduce((s, r) => s + r.sub.mrr, 0);
  const futureMrr   = future.reduce((s, r)   => s + r.sub.mrr, 0);
  const arrAtRisk   = [...urgent, ...upcoming, ...future].reduce(
    (s, r) => s + r.sub.mrr * 12,
    0,
  );

  const upcoming90   = enriched.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 90);
  const highRiskSubs = upcoming90.filter((r) => renewalRisk(r.sub).level === "high");
  const highRiskArr  = highRiskSubs.reduce((s, r) => s + r.sub.mrr * 12, 0);

  const activeSubs    = all.filter((s) => s.status === "active").length;
  const topHighRisk   = highRiskSubs[0]?.sub.customer_name ?? "a key customer";
  // Real, computed reasons for the top high-risk sub — never fabricate signals
  // (NPS/logins) we don't collect on a money screen.
  const topReasons    = highRiskSubs[0] ? renewalRisk(highRiskSubs[0].sub).reasons : [];
  const firstUpcoming = upcoming[0];

  // Real CSV export of the renewals pipeline (next 90 days) — raw integer ₹ so
  // Excel/Tally treat amounts as numbers. Replaces the old "coming soon" stub.
  const handleExport = () => {
    if (upcoming90.length === 0) {
      toast.info("No renewals to export in the next 90 days");
      return;
    }
    const rows = upcoming90
      .slice()
      .sort((a, b) => a.daysUntil - b.daysUntil)
      .map(({ sub, daysUntil }) => {
        const risk = renewalRisk(sub);
        return [
          sub.customer_name,
          sub.plan,
          sub.vendor,
          sub.seats,
          sub.used,
          sub.mrr,
          sub.mrr * 12,
          sub.renewal_date ? formatDate(sub.renewal_date) : "",
          daysUntil,
          sub.outstanding_amount,
          risk.label,
        ];
      });
    downloadCSV(
      "renewals-next-90-days.csv",
      ["Customer", "Plan", "Vendor", "Seats", "Used", "MRR (₹)", "ARR (₹)", "Renewal date", "Days until", "Outstanding (₹)", "Risk"],
      rows,
    );
    toast.success(`Exported ${rows.length} renewal${rows.length === 1 ? "" : "s"}`);
  };

  // Real bulk reminder — actually calls the per-sub send-now endpoint for every
  // subscription renewing within 30 days, then reports the true count (and
  // honestly flags stub email-mode). No fake "sent" toast.
  async function handleBulkReminder() {
    const targets = enriched.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 30);
    if (targets.length === 0) { toast.info("No renewals due in the next 30 days"); return; }
    setBulkSending(true);
    let sent = 0, failed = 0, stub = false;
    for (const r of targets) {
      try {
        const res = await fetch("/api/renewals/send-now", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription_id: r.sub.id }),
        });
        const json = await res.json();
        if (!res.ok) { failed++; continue; }
        sent++;
        if (json.email_mode === "stub") stub = true;
      } catch { failed++; }
    }
    setBulkSending(false);
    qc.invalidateQueries({ queryKey: ["subscriptions"] });
    if (sent > 0) {
      toast.success(`Reminder logged for ${sent} renewal${sent === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""}${stub ? " · stub mode (no real email yet)" : ""}`);
    } else {
      toast.error(`Could not send any reminders${failed ? ` (${failed} failed)` : ""}`);
    }
  }

  return (
    <div className="mx-auto max-w-[1800px] px-4 md:px-8 pb-20 pt-7">
      {/* ── Page header ── */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <p className="mb-0.5 text-xs font-medium uppercase tracking-widest text-ink-3">
            Revenue
          </p>
          <h1 className="font-serif text-3xl text-ink">Renewals</h1>
          <p className="mt-1 text-sm text-ink-3">
            {activeSubs} active subscription{activeSubs !== 1 ? "s" : ""}
            {arrAtRisk > 0 && (
              <>
                {" · "}
                <span className="font-medium text-rose-600">
                  {rupee(arrAtRisk, { compact: true })} yearly value at risk
                </span>
              </>
            )}
          </p>
        </div>

        {/* Header actions — hidden on mobile (replaced by FAB) to avoid overflow */}
        <div className="hidden md:flex shrink-0 items-center gap-2">
          <Button
            variant="default"
            size="sm"
            onClick={handleExport}
          >
            <Icon name="download" size={14} />
            Export
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={bulkSending}
            onClick={handleBulkReminder}
          >
            <Icon name="mail" size={14} />
            {bulkSending ? "Sending…" : "Bulk reminder"}
          </Button>
        </div>
      </div>

      {/* Compact metric strip (replaces the big KPI-card grid).
          Note: the old hardcoded "Renewal rate 87%" was a placeholder, not a
          real figure — dropped rather than surface a fabricated number. */}
      <StatStrip
        className="mb-6"
        items={[
          { label: "Urgent · ≤7d",       value: `${urgent.length} · ${rupee(urgentMrr, { compact: true })}`, tone: "rose" },
          { label: "Upcoming · 30d",     value: `${upcoming.length} · ${rupee(upcomingMrr, { compact: true })}` },
          { label: "Future · 31–90d",    value: `${future.length} · ${rupee(futureMrr, { compact: true })}`, tone: "emerald" },
          { label: "High-risk · yearly", value: `${highRiskSubs.length} · ${rupee(highRiskArr, { compact: true })}`, tone: "rose" },
        ]}
      />

      {/* ── Gemini AI next-best-actions ── */}
      {highRiskSubs.length > 0 && (
        <div className="mb-6">
          <GeminiCard
            title="Renewal AI · Next best actions"
            actions={
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const cid = highRiskSubs[0]?.sub.customer_id;
                    router.push((cid ? `/customers/${cid}` : "/customers") as never);
                  }}
                >
                  <Icon name="user" size={12} />
                  Open {topHighRisk}
                </Button>
              </div>
            }
          >
            <strong className="text-ink">
              {highRiskSubs.length} high-risk renewal
              {highRiskSubs.length !== 1 ? "s" : ""} worth{" "}
              {rupee(highRiskArr, { compact: true })} ARR detected.
            </strong>{" "}
            Top priority: <strong>{topHighRisk}</strong>
            {topReasons.length > 0 ? <> — {topReasons.join(" · ").toLowerCase()}</> : null}.
            Call or WhatsApp this week to secure the renewal.
            {firstUpcoming && (
              <>
                {" "}
                <strong>{firstUpcoming.sub.customer_name}</strong> renews in{" "}
                {firstUpcoming.daysUntil} days.
              </>
            )}
          </GeminiCard>
        </div>
      )}

      {/* ── Renewal buckets — tabbed (Urgent / Upcoming / Future) ── */}
      <Card flush>
        <div className="px-3 pt-3 sm:px-4">
          <TabBar
            value={bucketTab}
            onChange={setBucketTab}
            items={[
              { id: "urgent",   label: "Urgent · ≤7d",      count: urgent.length   || undefined },
              { id: "upcoming", label: "Upcoming · 30d",    count: upcoming.length || undefined },
              { id: "future",   label: "Future · 31–90d",   count: future.length   || undefined },
            ] satisfies TabBarItem[]}
          />
        </div>
        {bucketTab === "urgent" && (
          <RenewalBucket embedded kind="rose"
            title="Urgent · Next 7 days"
            subtitle="Call within 24 hours — every day of delay risks revenue"
            rows={urgent} graceDays={graceDays} />
        )}
        {bucketTab === "upcoming" && (
          <RenewalBucket embedded kind="amber"
            title="Upcoming · Next 30 days"
            subtitle="Send personalised email + one follow-up call"
            rows={upcoming} graceDays={graceDays} />
        )}
        {bucketTab === "future" && (
          <RenewalBucket embedded kind="emerald"
            title="Future · 31–90 days"
            subtitle="Drip campaign + value-prop content"
            rows={future} graceDays={graceDays} />
        )}
      </Card>

      {/* Mobile FAB — Bulk reminder action (header buttons hidden on phone) */}
      <FAB
        icon="mail"
        label={bulkSending ? "Sending…" : "Bulk reminder"}
        onClick={handleBulkReminder}
      />
    </div>
  );
}
