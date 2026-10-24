"use client";

/**
 * R-1621 — "Grace over — your call": renewals whose grace has ended unpaid. The renewals
 * cron no longer pauses them by itself; it raises ONE "Stop service" task for the owner, and
 * this is where the owner (or a manager) acts on it:
 *
 *   Stop service   → renewal_grace_decide 'stop' — the same pause the cron used to make
 *                    (paused + suspended), the reason in the activity log, the task closed.
 *   Give N days    → renewal_grace_decide 'extend' — grace_until moves on, the task follows.
 *
 * The task's notes link here (/renewals?view=grace). Before the migration the columns do not
 * exist and the card renders nothing (the list read fails with 42703).
 */
import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import { isMissingColumn } from "@/lib/renewals/grace-overrides";
import { formatIstDate } from "@/lib/dates/ist";
import {
  canDecideGrace,
  extendedToast,
  graceOverRows,
  parseExtraDays,
  stopServiceConfirm,
  stoppedToast,
  type GraceOverRow,
} from "./grace-over";

export const GRACE_OVER_KEY = ["renewals", "grace-over"] as const;

/* The columns are newer than the generated types (database.types.ts is shared). */
type LooseSubs = {
  from: (t: "subscriptions") => {
    select: (c: string) => {
      eq: (c: string, v: string) => {
        not: (c: string, op: string, v: null) => {
          order: (c: string, o: { ascending: boolean }) => { range: (a: number, b: number) => PageQuery<GraceOverRow> };
        };
      };
    };
  };
};
type DecideRpc = (
  fn: "renewal_grace_decide",
  args: { p_subscription_id: string; p_action: "stop" | "extend"; p_days: number | null },
) => PromiseLike<{ data: { grace_until?: string | null } | null; error: { message: string } | null }>;

function useGraceOver() {
  return useQuery({
    queryKey: GRACE_OVER_KEY,
    queryFn: async (): Promise<GraceOverRow[]> => {
      const db = createClient() as unknown as LooseSubs;
      try {
        const rows = await fetchAllRows((from, to) => db
          .from("subscriptions")
          .select("id, customer_id, customer_name, plan, vendor, status, renewal_state, renewal_date, grace_until, grace_task_for")
          .eq("status", "active")
          .not("grace_task_for", "is", null)
          .order("renewal_date", { ascending: true })
          .range(from, to));
        return graceOverRows(rows);
      } catch (e) {
        if (isMissingColumn(e)) return [];
        throw e;
      }
    },
  });
}

export function GraceOverCard() {
  const { data: rows } = useGraceOver();
  const { data: me } = useCurrentUser();
  const canDecide = canDecideGrace(me?.role);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [daysText, setDaysText] = React.useState<Record<string, string>>({});
  const ref = React.useRef<HTMLDivElement>(null);
  const list = rows ?? [];

  /* The task links here with ?view=grace — bring the list into view. */
  React.useEffect(() => {
    if (list.length === 0 || typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("view") === "grace") {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [list.length]);

  if (list.length === 0) return null;

  async function decide(row: GraceOverRow, action: "stop" | "extend", days: number | null) {
    setBusy(row.id);
    try {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as DecideRpc;
      const { data, error } = await rpc.call(supabase, "renewal_grace_decide", {
        p_subscription_id: row.id, p_action: action, p_days: days,
      });
      if (error) throw error;
      if (action === "stop") {
        const t = stoppedToast(row);
        toast.success(t.title, { description: t.description, duration: 12000 });
      } else {
        toast.success(extendedToast(row, data?.grace_until, days ?? 0));
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: GRACE_OVER_KEY }),
        qc.invalidateQueries({ queryKey: ["subscriptions"] }),
        qc.invalidateQueries({ queryKey: ["tasks"] }),
      ]);
    } catch (err) {
      toastError(err, {
        fallback: action === "stop" ? "Could not stop the service." : "Could not give more days.",
        description: "Refresh the Renewals page and try again. If it says only the owner or a manager can do this, ask them — the task is on their Tasks list.",
      });
    } finally {
      setBusy(null);
    }
  }

  async function onStop(row: GraceOverRow) {
    const ok = await confirm({ ...stopServiceConfirm(row), confirmLabel: "Stop service", danger: true, icon: "lock" });
    if (ok) await decide(row, "stop", null);
  }

  return (
    <div ref={ref} id="grace-over" className="mb-6 scroll-mt-20">
      <Card
        title={`Grace over — your call (${list.length})`}
        sub="Renewal not paid and the grace has ended. Stop the service, or give the customer more days. Nothing is stopped until you choose."
        actions={<Link href={"/tasks" as never} className="text-xs font-medium text-amber hover:underline">Open Tasks</Link>}
      >
        <ul className="divide-y divide-hairline">
          {list.map((row) => {
            const raw = daysText[row.id] ?? "7";
            const days = parseExtraDays(raw);
            const rowBusy = busy === row.id;
            return (
              <li key={row.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink truncate">
                    {row.customer_id
                      ? <Link href={`/customers/${row.customer_id}` as never} className="hover:underline">{row.customer_name}</Link>
                      : row.customer_name}
                    <span className="text-ink-3 font-normal"> · {row.plan ?? "Subscription"}</span>
                  </p>
                  <p className="text-2xs text-ink-3">
                    Renewal due {row.renewal_date ? formatIstDate(row.renewal_date) : "—"}
                    {row.grace_until && row.renewal_date && row.grace_until > row.renewal_date
                      ? ` · extra days given until ${formatIstDate(row.grace_until)}` : ""}
                  </p>
                </div>
                {canDecide ? (
                  <div className="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="danger" icon="lock" loading={rowBusy} disabled={rowBusy} onClick={() => void onStop(row)}>
                      Stop service
                    </Button>
                    <Input
                      aria-label={`More grace days for ${row.customer_name}`}
                      inputMode="numeric"
                      className="h-8 w-14 text-center font-mono"
                      value={raw}
                      onChange={(e) => setDaysText((m) => ({ ...m, [row.id]: e.target.value }))}
                      aria-invalid={days === null}
                      disabled={rowBusy}
                    />
                    <Button size="sm" variant="default" disabled={rowBusy || days === null}
                      title={days === null ? "Enter 1 to 30 days" : undefined}
                      onClick={() => days !== null && void decide(row, "extend", days)}>
                      Give {days ?? "…"} more day{days === 1 ? "" : "s"}
                    </Button>
                  </div>
                ) : (
                  <p className="text-2xs text-ink-3 shrink-0">The owner or a manager decides — it is on their Tasks list.</p>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}
