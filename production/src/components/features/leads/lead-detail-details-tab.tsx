"use client";
/**
 * The drawer's Details tab. In the old single file these were THREE separate
 * `drawerTab === "details"` blocks (facts, quote history, stage rail) interleaved with the
 * other tabs; only one tab renders at a time, so rendering them back to back here produces
 * the same children of the same scroll container (S35, 28 Sep 2026).
 */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { qualification } from "@/lib/leads/qualification";
import { dealMargin, marginBadge, type buildPlanCostIndex } from "@/lib/leads/deal-margin";
import type { dealHealth } from "@/lib/leads/deal-health";
import { DealHealthCard } from "@/components/features/leads/deal-health-card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import type { Lead, Quote } from "@/lib/supabase/database.types";
import { addedByLabel } from "@/lib/leads/added-by";
import type { useUserNames } from "@/lib/hooks/useUserNames";
import type { useLeadActivities } from "@/lib/queries/lead-activities";
import type { useChangeLeadStage } from "@/lib/leads/use-change-stage";
import { LEAD_STAGES } from "@/lib/leads/stage-meta";
import { ACTIVITY_META, Fact, fmtActTime } from "@/components/features/leads/lead-detail-format";
import { ExpectedCloseField } from "@/components/features/leads/expected-close-field";
import { BillingCycleField, CurrentProviderField } from "@/components/features/leads/billing-cycle-fields";

type DrawerTab = "email" | "details" | "followups" | "activity";

export interface LeadDetailsTabProps {
  lead: Lead;
  health: ReturnType<typeof dealHealth> | null;
  setAddTaskOpen: (open: boolean) => void;
  setCardsOpen: (open: boolean) => void;
  drawerPlanCosts: ReturnType<typeof buildPlanCostIndex>;
  userNames: ReturnType<typeof useUserNames>["data"];
  activities: NonNullable<ReturnType<typeof useLeadActivities>["data"]>;
  setDrawerTab: (t: DrawerTab) => void;
  hasQuotes: boolean;
  quotesForLead: Quote[];
  latestQuote: Quote | undefined;
  onClose: () => void;
  changeStage: ReturnType<typeof useChangeLeadStage>["changeStage"];
  handleSendQuote: () => void;
}

export function LeadDetailsTab({
  lead, health, setAddTaskOpen, setCardsOpen, drawerPlanCosts, userNames, activities,
  setDrawerTab, hasQuotes, quotesForLead, latestQuote, onClose, changeStage, handleSendQuote,
}: LeadDetailsTabProps) {
  const router = useRouter();
  return (
          <>
          {/* Is this deal being WORKED well? Sits above the facts because the facts
              describe the customer and this describes what the rep has (not) done —
              and only the second one is actionable this minute. */}
          {health && <DealHealthCard health={health} onBookFollowUp={() => setAddTaskOpen(true)} />}

          {/* Objection handling. Next to health rather than buried in a menu: the moment
              a rep needs these words is the moment they are looking at this drawer with
              the customer still on the line. */}
          <button
            type="button"
            onClick={() => setCardsOpen(true)}
            /* Explicit name: the label is two nested spans, and a screen reader that
               concatenates them reads the example objections as the button's own words. */
            aria-label="Open objection battlecards"
            className="flex w-full items-center gap-2.5 rounded-lg border border-hairline bg-paper-2/40 px-3 py-2.5 text-left hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
          >
            <Icon name="shield" size={15} className="shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">Objection battlecards</span>
              <span className="block text-xs text-ink-3">
                &ldquo;Microsoft is cheaper&rdquo;, &ldquo;nobody has heard of Zoho&rdquo; — what to say.
              </span>
            </span>
            <Icon name="chevron-right" size={14} className="shrink-0 text-ink-3" />
          </button>

          {lead.customer_id && (
            <Link href={`/customers/${lead.customer_id}` as never}
              className="flex items-center gap-2 rounded-lg border border-emerald/30 bg-emerald/5 px-3 py-2 text-sm text-ink hover:bg-emerald/10">
              <Icon name="users" size={14} className="text-emerald" />
              Existing customer — open customer
            </Link>
          )}

          {/* Grid of facts */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Fact label="Plan" value={lead.plan} />
            <Fact label="Seats" value={lead.seats?.toString()} mono />
            <Fact label="Deal value" value={lead.value ? rupee(lead.value) : "—"} big />
            {/* Gross margin, from the catalogue's real vendor cost. Shown even when it
                cannot be worked out, with the REASON — "unknown" is a fact the rep can
                act on ("this plan has no catalogue row"), whereas a hidden field is a
                question nobody knows to ask. */}
            {(() => {
              const m = dealMargin(lead, drawerPlanCosts);
              const b = marginBadge(m);
              return (
                <div>
                  <p className="text-2xs uppercase tracking-wider text-ink-3">Gross margin</p>
                  <p
                    title={b.title}
                    className={cn(
                      "mt-0.5 font-serif text-[17px] font-semibold",
                      b.kind === "danger"  && "text-rose",
                      b.kind === "warning" && "text-amber-ink",
                      b.kind === "success" && "text-emerald",
                      b.kind === "muted"   && "text-ink-3",
                    )}
                  >
                    {b.label}
                    {m.grossAnnual !== null && (
                      <span className="ml-1.5 font-sans text-xs font-normal text-ink-3">
                        {rupee(m.grossAnnual)}/yr
                      </span>
                    )}
                  </p>
                  {m.band === "loss" && (
                    <p className="mt-0.5 text-xs font-semibold leading-snug text-rose">
                      Below the vendor&apos;s own cost — reprice before quoting.
                    </p>
                  )}
                  {m.band === "unknown" && (
                    <p className="mt-0.5 text-xs leading-snug text-ink-3">{b.title}</p>
                  )}
                </div>
              );
            })()}
            <ExpectedCloseField lead={lead} />
            <Fact label="Source" value={lead.source} mono />
            <Fact label="New / switching" value={lead.subscription_type === "fresh" ? "Fresh subscription" : lead.subscription_type === "switch" ? "Switching vendor" : "—"} />
            {/* R-071 — licence deals only; a project has no cycle or provider. */}
            {lead.enquiry_type !== "project" && <BillingCycleField lead={lead} />}
            {lead.enquiry_type !== "project" && <CurrentProviderField lead={lead} />}
            <Fact label="Contact name" value={lead.contact_name} />
            <Fact label="Email" value={lead.contact_email} mono />
            <Fact label="Phone" value={lead.contact_phone} mono />
            <Fact label="Created" value={formatDate(lead.created_at)} />
            {/* ─── WHO ADDED IT, AND WHAT ADDED IT WHEN NOBODY DID ─────────────
                Beside Source and Created because all three answer "where did this come from".

                NULL is not a blank here. Measured when the column landed: 15 of 29 leads arrived
                through the inbound email webhook with no person involved, so `created_by` is
                correctly empty and `source` is the answer. Showing "—" would read as missing
                data; "Arrived by email" is the fact.

                Rows created before the column existed say so outright rather than implying
                nobody added them — the migration deliberately did not backfill, because both
                available inferences would have credited the wrong person. */}
            <Fact
              label="Added by"
              value={addedByLabel(
                { createdBy: lead.created_by, source: lead.source, createdAt: lead.created_at },
                userNames,
              )}
            />
          </div>

          {/* Recent communication — surfaced right here on the main Details view
              (not hidden in the Activity tab) so every call / WhatsApp / email /
              inbound reply is visible the moment you open the lead. Shows the
              latest 3; "See all" opens the full timeline. */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Recent communication</div>
              {activities.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDrawerTab("activity")}
                  className="text-xs font-medium text-amber-ink hover:text-amber focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                >
                  Open conversation ({activities.length})
                </button>
              )}
            </div>
            {activities.length === 0 ? (
              <div className="text-sm text-ink-3 italic p-3 bg-paper-2 rounded-md">
                No communication yet. Call / WhatsApp / Email from here — it logs automatically.
              </div>
            ) : (
              <ul className="space-y-2">
                {[...activities]
                  .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
                  .slice(0, 3)
                  .map((a) => {
                    const meta = ACTIVITY_META[a.kind] ?? { icon: "clock" as const, label: a.kind };
                    return (
                      <li key={a.id} className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-paper-2 text-ink-3">
                          <Icon name={meta.icon} size={12} />
                        </div>
                        <div className="min-w-0 flex-1">
                          {/* Same reason as the timeline entry below — a call's note lives
                              in `detail`, and one-line truncate hid exactly the part a
                              person wrote. Full text in `title` (a11y §4). */}
                          <div className="line-clamp-3 break-words text-sm text-ink" title={a.detail || meta.label}>
                            {a.detail || meta.label}
                          </div>
                          <div className="text-xs text-ink-3">
                            {meta.label} · {formatDate(a.created_at)} {fmtActTime(a.created_at)}
                          </div>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>

          {/* Notes */}
          <div>
            <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Notes</div>
            <div className="text-sm text-ink-2 whitespace-pre-wrap p-3 bg-paper-2 rounded-md min-h-[80px]">
              {lead.notes || <span className="italic text-ink-3">No notes yet.</span>}
            </div>
          </div>
          {/* ── Quotes history (only when this lead has received at least one quote) ── */}
          {hasQuotes && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                  Quotes ({quotesForLead.length})
                </div>
              </div>
              <div className="rounded-md border border-hairline divide-y divide-hairline overflow-hidden">
                {quotesForLead.map((q) => {
                  const statusKind: "muted" | "warning" | "success" | "info" | "danger" =
                    q.status === "draft"    ? "muted" :
                    q.status === "sent"     ? "warning" :
                    q.status === "viewed"   ? "info" :
                    q.status === "accepted" ? "success" :
                    "danger";
                  return (
                    <button
                      key={q.id}
                      type="button"
                      onClick={() => {
                        router.push(`/quotes/${q.id}` as never);
                      }}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-paper-2 transition-colors"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold text-ink truncate">
                            {q.id}
                          </span>
                          <Badge kind={statusKind} dot>{q.status}</Badge>
                        </div>
                        <div className="text-xs text-ink-3 mt-0.5">
                          {formatDate(q.created_at)} · {q.line_items && Array.isArray(q.line_items) ? q.line_items.length : 0} item
                          {Array.isArray(q.line_items) && q.line_items.length === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="font-serif text-sm tabular-nums text-ink">
                          {rupee(q.amount ?? 0)}
                        </div>
                        <Icon name="arrow_right" size={11} className="text-ink-3 ml-auto" />
                      </div>
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-ink-3 mt-1.5 flex items-center gap-1">
                <Icon name="info" size={11} />
                {lead.stage === "won"
                  ? "Click any quote to view · upsell with a new quote below"
                  : lead.stage === "lost"
                  ? "Click any quote to view · re-engage with a fresh quote below"
                  : latestQuote?.status === "draft"
                  ? "Click the draft to review & send it below"
                  : "Click any quote to view · or send a revised quote below"}
              </p>
            </div>
          )}
          {/* Quick stage change
              For a raw lead (no plan picked yet), only "new" / "contact" are
              logically valid — demo/trial/quote/won all require a plan to
              make sense. Show only the relevant chips + a hint to qualify
              first if the user wants to progress further. */}
          {(() => {
            // Quote-first funnel: pre-quote leads (new/contact) can only stay
            // pre-quote or be Lost — Demo/Trial/Won unlock only after a quote is
            // sent. Post-quote deals get the deal-stage chips (no going back to
            // the inbox stages).
            const isPreQuote = lead.stage === "new" || lead.stage === "contact";
            const visibleStages = isPreQuote
              ? LEAD_STAGES.filter((s) => s.id === "new" || s.id === "contact" || s.id === "lost")
              : LEAD_STAGES.filter((s) => s.id !== "new" && s.id !== "contact");
            return (
              <div>
                <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-2">Change stage</div>
                <div className="flex flex-wrap gap-1.5">
                  {visibleStages.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => {
                        if (s.id !== lead.stage) {
                          void changeStage(lead, s.id);
                          toast.success(`${lead.company} → ${s.label}`);
                          onClose();
                        }
                      }}
                      disabled={s.id === lead.stage}
                      aria-current={s.id === lead.stage ? "true" : undefined}
                      className={cn(
                        "text-xs px-2.5 py-1 rounded-full border transition-colors",
                        s.id === lead.stage
                          ? "bg-amber-soft border-amber text-amber-ink font-medium cursor-default"
                          : "border-hairline text-ink-2 hover:bg-paper-2"
                      )}
                    >
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1.5", s.dot)} />
                      {s.label}
                    </button>
                  ))}
                </div>
                {isPreQuote && (() => {
                  /* ── The three gates out of the raw inbox ──────────────────
                     Placed HERE, immediately above the button that sends the
                     quote, because that is the moment the answer matters. On a
                     tab of its own it would be a report; here it is the thing
                     the rep reads before deciding whether to spend an hour on
                     a proposal.

                     Derived from the row (lib/leads/qualification.ts, 19 tests),
                     never ticked — a checkbox that disagreed with the data under
                     it would be the one the rep believed. Nothing is BLOCKED: a
                     rep who knows better than the data can still send. Refusing
                     would just teach them to fake a phone number to get past it. */
                  const q = qualification(lead);
                  return (
                    <div className={cn(
                      "mt-3 rounded-md border px-3 py-2",
                      q.qualified ? "border-emerald/40 bg-emerald-soft" : "border-hairline bg-paper-2/60",
                    )}>
                      <p className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                        Ready to quote · {q.passedCount} of 3
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {q.checks.map((c) => (
                          <li key={c.id} className="flex items-start gap-1.5 text-xs leading-snug">
                            <span aria-hidden className={c.passed ? "text-emerald" : "text-ink-3"}>
                              {c.passed ? "✓" : "○"}
                            </span>
                            <span className={c.passed ? "text-ink-2" : "text-ink-3"}>
                              {c.passed ? c.label : c.missing}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
                {isPreQuote && (
                  // Quote-first funnel: the only way forward from a pre-quote
                  // lead is to send a quote — that moves it into Deals and
                  // unlocks Demo / Trial / Won. One click starts the quote.
                  <button
                    type="button"
                    onClick={handleSendQuote}
                    className={cn(
                      "mt-3 w-full text-left text-xs px-3 py-2 rounded-md",
                      "bg-amber-soft hover:bg-amber/15 border border-amber/40",
                      "text-amber-ink font-medium",
                      "inline-flex items-center justify-between gap-2 transition-colors",
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Icon name="send" size={13} />
                      Send a quote to move into Deals · unlocks Demo / Trial / Won
                    </span>
                    <Icon name="arrow_right" size={13} />
                  </button>
                )}
              </div>
            );
          })()}
          </>
  );
}
