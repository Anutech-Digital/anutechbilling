/**
 * GettingStartedCard — R-1931 (G-ONBOARD OB-10): the ONE onboarding list, "Get to your first
 * quote", on the Dashboard. The /setup Done screen renders the same rows (FirstQuoteRows).
 *
 * The items, their order and every tick live in setup-checklist.ts (pure, unit-tested): State /
 * GSTIN, Price list, First quote, Send link, Turn on customer messages, then Bank/UPI and Team.
 * Each open item has its own button to the page that does it; the next open item is the one
 * primary button. Ticks come from saved data and real counts only. The card retires itself once
 * every item it shows is done.
 *
 * Roles (kept from R-253 / R-1129): owner-only items (company save, the messages switch, bank,
 * invites) are shown to the owner only — a manager gets one "ask the owner" line instead; an
 * item on a page the role cannot open (billing: /quotes, /items) is left out.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "./route-access";
import { buildFirstQuoteSteps, firstQuoteLoading, type FirstQuoteFacts, type FirstQuoteStep } from "./setup-checklist";
import { DEFAULT_SELL_MODE, type SellMode } from "@/lib/sell-mode";

const GROUP_TITLE: Record<FirstQuoteStep["group"], string> = {
  first: "To your first quote",
  after: "After that",
};

/** The items this role can act on, plus whether the owner still has items to finish. */
function useVisibleSteps(facts: FirstQuoteFacts, sellMode: SellMode) {
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;
  const all = buildFirstQuoteSteps(facts, sellMode);
  /* While the role loads, keep the owner view (R-134). */
  const isOwnerView = role === null || role === "owner";
  const steps = all
    .filter((s) => isOwnerView || !s.ownerOnly)
    .filter((s) => canOpenRoute(role, s.href));
  const askOwner = role === "manager" && all.some((s) => s.ownerOnly && !s.done);
  return { steps, askOwner };
}

function StepRows({ steps }: { steps: FirstQuoteStep[] }) {
  // The next open item gets the one primary button; the rest are quiet.
  const nextId = steps.find((s) => !s.done)?.id;
  const groups = (["first", "after"] as const)
    .map((g) => ({ g, rows: steps.filter((s) => s.group === g) }))
    .filter((x) => x.rows.length > 0);
  return (
    <div className="space-y-4">
      {groups.map(({ g, rows }) => (
        <section key={g} aria-label={GROUP_TITLE[g]}>
          {groups.length > 1 && (
            <p className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1.5">{GROUP_TITLE[g]}</p>
          )}
          <ul className="space-y-2">
            {rows.map((s) => {
              const isNext = s.id === nextId;
              return (
                <li
                  key={s.id}
                  className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                    s.done ? "border-hairline bg-paper/60" : isNext ? "border-amber/40 bg-paper" : "border-hairline bg-paper"
                  }`}
                >
                  <span
                    className={`grid place-items-center h-6 w-6 rounded-full shrink-0 ${
                      s.done ? "bg-emerald text-white" : "border-2 border-hairline-strong text-transparent"
                    }`}
                    aria-label={s.done ? "Done" : "Not done"}
                  >
                    {s.done && <Icon name="check" size={13} />}
                  </span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className={`block text-sm font-medium ${s.done ? "text-ink-3 line-through" : "text-ink"}`}>{s.label}</span>
                    {!s.done && <span className="block text-2xs text-ink-3">{s.hint}</span>}
                  </span>
                  {!s.done && (
                    <Link
                      href={s.href as Route}
                      className={`shrink-0 text-xs font-semibold px-3 py-2 min-h-[36px] inline-flex items-center rounded-md transition-colors ${
                        isNext ? "bg-amber text-white hover:bg-amber-ink" : "border border-hairline text-ink-2 hover:bg-paper-2"
                      }`}
                    >
                      {s.cta}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AskOwnerNote() {
  return (
    <p className="mb-3 flex items-start gap-2 rounded-lg border border-hairline bg-paper px-3 py-2.5 text-xs text-ink-2 text-left">
      <Icon name="info" size={14} className="mt-0.5 shrink-0 text-ink-3" />
      <span>Only the owner can finish the company details, customer messages, bank and team. Ask the workspace owner to do them from their dashboard.</span>
    </p>
  );
}

/** The same rows, for the /setup Done screen. Renders nothing while a fact is loading. */
export function FirstQuoteRows({ facts, sellMode = DEFAULT_SELL_MODE }: { facts: FirstQuoteFacts; sellMode?: SellMode }) {
  const { steps, askOwner } = useVisibleSteps(facts, sellMode);
  if (firstQuoteLoading(facts) || steps.length === 0) return null;
  return (
    <>
      {askOwner && <AskOwnerNote />}
      <StepRows steps={steps} />
    </>
  );
}

export function GettingStartedCard({
  facts, sellMode = DEFAULT_SELL_MODE,
}: {
  /** From useFirstQuoteFacts() — see setup-checklist.ts. */
  facts: FirstQuoteFacts;
  /** R-1862: "What do you sell?" — decides where the price-list step opens. Default Both. */
  sellMode?: SellMode;
}) {
  const { steps, askOwner } = useVisibleSteps(facts, sellMode);
  /* Judged on half-loaded data the card showed every step open for a second and then vanished
     (R-134) — so nothing renders until every fact is in. */
  if (firstQuoteLoading(facts) || steps.length === 0) return null;

  const doneCount = steps.filter((s) => s.done).length;
  // Once everything is done, the card retires itself — no clutter for an active user.
  if (doneCount === steps.length) return null;
  const pct = Math.round((doneCount / steps.length) * 100);

  return (
    <Card id="setup-checklist" className="mb-3 border-amber/30 bg-amber-soft/20 scroll-mt-20">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="font-serif text-xl text-ink leading-tight flex items-center gap-2">
            <Icon name="rocket" size={18} className="text-amber shrink-0" />
            <span>Get to your first quote</span>
          </h2>
          <p className="text-[12px] text-ink-3 mt-0.5">{doneCount} of {steps.length} done.</p>
        </div>
        <span className="font-serif text-2xl text-amber tabular-nums shrink-0">{pct}%</span>
      </div>

      <div className="h-1.5 w-full rounded-full bg-paper-2 overflow-hidden mb-4">
        <div className="h-full bg-amber transition-all" style={{ width: `${pct}%` }} />
      </div>

      {askOwner && <AskOwnerNote />}
      <StepRows steps={steps} />
    </Card>
  );
}
