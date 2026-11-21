/**
 * Activation queue — seats a customer has paid for and nobody has turned on.
 *
 * ─── WHY THIS PAGE EXISTS ────────────────────────────────────────────────────
 * `provisioning_requests` has been written by the payment webhook since
 * 20260825220000, and NOTHING has ever opened it. Its own migration comment
 * calls itself "the only list anybody opens"; no screen read it, no nav entry
 * pointed at it, and no query selected from it outside the cron. So a customer
 * whose payment could not be auto-activated waited, and the queue recording
 * that fact was invisible.
 *
 * Nothing drains it automatically and that is deliberate: there is no Google
 * reseller API adapter yet, and a test-mode payment must never auto-activate.
 * The workflow is "activate the seats in the vendor's console, then tick the
 * row off", which needs the queue to be legible before it needs to be clever.
 *
 * ─── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It does not offer a way to edit payment_mode, blocker, seats, amount_paid,
 * vendor or quote. Those are the record of what was paid for, and migration
 * 20260921100000 makes them unwritable by a tenant member at the DATABASE, not
 * just here — so the gate that stops a test payment activating real seats is
 * two independent layers rather than one wearing the shape of two. A button
 * here would be the third, and the weakest.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { FocusBanner } from "@/components/shared/focus-banner";
import { useUrlChoice } from "@/lib/hooks/use-url-choice";
import { PROVISIONING_FOCUS } from "@/lib/navigation/drilldown";
import { activationWaiting } from "@/lib/company/summary";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";

interface QueueRow {
  id: string;
  quote_id: string;
  vendor: string;
  seats: number;
  domain: string | null;
  plan: string | null;
  amount_paid: number;
  payment_mode: "live" | "test";
  status: string;
  blocker: string | null;
  note: string | null;
  vendor_ref: string | null;
  created_at: string;
}

interface QueueResponse {
  rows: QueueRow[];
  counts: { total: number; waiting: number; blocked: number; testMode: number };
}

/**
 * Why a row is still sitting there, in words the operator can act on.
 *
 * Each says what to DO, not just what is wrong (CLAUDE.md §24). "Vendor API not
 * configured" is a status; "nobody has connected the reseller API yet, so every
 * one of these waits for a human" is a decision.
 */
function explainBlocker(blocker: string | null): { label: string; detail: string } {
  switch (blocker) {
    case "test_mode_payment":
      return {
        label: "Test payment",
        detail:
          "This settled zero rupees — it is a test-mode Razorpay payment that looks identical " +
          "to a real one everywhere else. Do not activate seats against it. If the customer " +
          "meant to pay for real, take the payment again on the live key.",
      };
    case "vendor_api_not_configured":
      return {
        label: "Vendor not connected",
        detail:
          "There is no reseller API credential for this vendor, so nothing can activate it " +
          "automatically. Provision the seats in the vendor's own console, then mark this done.",
      };
    case "dial_not_auto":
      return {
        label: "Automation held",
        detail:
          "Automation for this action is set to hold, so it was queued rather than run. " +
          "Either activate it by hand, or change the dial on the Automation page.",
      };
    case "vendor_unsupported":
      return {
        label: "Vendor unsupported",
        detail:
          "Nothing here knows how to provision this vendor. It has to be done by hand in " +
          "their console.",
      };
    case "engine_not_connected":
      return {
        label: "Engine unreachable",
        detail:
          "This is hosting or a domain, which DMS provisions — and DMS is not reachable from " +
          "here. Check Hosting & Domains, then come back.",
      };
    default:
      return {
        label: "Waiting",
        detail: "Nothing is blocking this; it has not been picked up yet.",
      };
  }
}

function useQueue() {
  return useQuery<QueueResponse>({
    queryKey: ["provisioning", "queue"],
    queryFn: async () => {
      const res = await fetch("/api/provisioning/queue");
      if (!res.ok) throw new Error(`Could not load the queue (HTTP ${res.status})`);
      return res.json();
    },
    /**
     * Short, and refetch on focus. The commonest motion is activating seats in
     * the vendor's console in another tab and coming back — a stale list there
     * shows work as still outstanding that somebody has just finished.
     */
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}

function waitingSince(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day";
  return `${days} days`;
}

export default function ProvisioningQueuePage() {
  const { data, isLoading, error } = useQueue();
  /* R-2969: ?focus=waiting — the dashboard's "Waiting to activate": only the queued rows
     (summary.ts#activationWaiting, the test the API's `waiting` count uses). */
  const [focus, setFocus] = useUrlChoice<(typeof PROVISIONING_FOCUS)[number]>("focus", PROVISIONING_FOCUS, "");
  const rows = React.useMemo(
    () => (focus === "waiting" ? (data?.rows ?? []).filter(activationWaiting) : data?.rows ?? []),
    [data, focus],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">Activation queue</h1>
        <p className="mt-1 text-sm text-ink-3">
          Seats a customer has paid for that nobody has turned on yet. Nothing here activates
          automatically — activate in the vendor&apos;s console, then mark the row done.
        </p>
      </div>

      {isLoading && (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      )}

      {error && (
        <Card className="border-rose bg-rose-soft p-4">
          <p className="text-sm text-rose-ink">
            {error instanceof Error ? error.message : "Could not load the queue."}
          </p>
        </Card>
      )}

      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Card className="p-4">
              <p className="text-3xs uppercase tracking-wider text-ink-3">Waiting</p>
              <p className="mt-1 text-2xl text-ink">{data.counts.waiting}</p>
            </Card>
            <Card className="p-4">
              <p className="text-3xs uppercase tracking-wider text-ink-3">Needs a decision</p>
              <p className="mt-1 text-2xl text-ink">{data.counts.blocked}</p>
            </Card>
            <Card className="p-4">
              <p className="text-3xs uppercase tracking-wider text-ink-3">Test payments</p>
              <p className="mt-1 text-2xl text-ink">{data.counts.testMode}</p>
            </Card>
            <Card className="p-4">
              <p className="text-3xs uppercase tracking-wider text-ink-3">All rows</p>
              <p className="mt-1 text-2xl text-ink">{data.counts.total}</p>
            </Card>
          </div>

          {focus === "waiting" && (
            <FocusBanner label="Waiting to activate — paid, not turned on yet" count={rows.length} onClear={() => setFocus("")} />
          )}

          {rows.length === 0 ? (
            <Card className="p-8 text-center">
              <Icon name="check" size={20} className="mx-auto text-emerald-ink" />
              <p className="mt-2 text-sm font-medium text-ink">Nothing waiting</p>
              <p className="mt-1 text-sm text-ink-3">
                Every paid activation has been dealt with. New ones appear here as payments
                are recorded.
              </p>
            </Card>
          ) : (
            <div className="space-y-3">
              {rows.map((row) => {
                const why = explainBlocker(row.blocker);
                const done = row.status !== "queued";
                return (
                  <Card key={row.id} className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-ink">{row.quote_id}</span>
                          <Badge className="bg-paper-2 text-ink-2">{row.vendor}</Badge>
                          <Badge className="bg-paper-2 text-ink-2">
                            {row.seats} seat{row.seats === 1 ? "" : "s"}
                          </Badge>
                          {/* The one fact that decides whether these seats may be
                              given away. Loud, because a test row that reads as
                              live is the whole failure this queue guards. */}
                          {row.payment_mode === "test" && (
                            <Badge className="bg-rose-soft text-rose-ink">TEST PAYMENT</Badge>
                          )}
                          {done && (
                            <Badge className="bg-emerald-soft text-emerald-ink">{row.status}</Badge>
                          )}
                        </div>
                        <p className="mt-1 text-sm text-ink-3">
                          {row.domain ?? "no domain recorded"}
                          {row.plan ? ` · ${row.plan}` : ""} · {rupee(row.amount_paid)} paid ·
                          waiting {waitingSince(row.created_at)}
                        </p>
                      </div>
                      {!done && (
                        <Badge className="bg-amber-soft text-amber-ink">{why.label}</Badge>
                      )}
                    </div>

                    {!done && (
                      <p className="mt-3 border-t border-hairline pt-3 text-sm text-ink-2">
                        {why.detail}
                      </p>
                    )}
                    {row.note && (
                      <p className="mt-2 text-xs text-ink-3">Note: {row.note}</p>
                    )}
                    {row.vendor_ref && (
                      <p className="mt-2 text-xs text-ink-3">Vendor reference: {row.vendor_ref}</p>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
