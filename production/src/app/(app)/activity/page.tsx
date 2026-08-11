/**
 * Activity Log — owner/manager view of "who did what" (migration 0222).
 * Read-only; rows come from DB triggers (human actions) + login events.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { cn } from "@/lib/utils";
import { useActivityLog, type ActivityRow } from "@/lib/queries/activity";

const ENTITY_LABEL: Record<string, string> = {
  leads: "lead", customers: "customer", contacts: "contact", quotes: "quote",
  invoices: "invoice", payments: "payment", expenses: "expense",
  subscriptions: "subscription", employees: "employee", vendor_bills: "vendor bill",
  project_sales: "project", bank_transactions: "bank entry", session: "",
};
const ACTION_VERB: Record<string, string> = {
  insert: "banaya", update: "badla", delete: "delete kiya", login: "login kiya",
};
const ACTION_TONE: Record<string, string> = {
  insert: "text-emerald", update: "text-amber-ink", delete: "text-rose", login: "text-indigo",
};

function dayKey(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
}
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

export default function ActivityLogPage() {
  const { data, isLoading, error } = useActivityLog({ limit: 300 });
  const [userId, setUserId] = React.useState<string>("");

  const rows = data ?? [];
  const actors = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.user_id) m.set(r.user_id, r.actor?.full_name ?? "Someone");
    return Array.from(m, ([id, name]) => ({ id, name }));
  }, [rows]);
  const filtered = userId ? rows.filter((r) => r.user_id === userId) : rows;

  // Group by day.
  const groups = React.useMemo(() => {
    const g = new Map<string, ActivityRow[]>();
    for (const r of filtered) {
      const k = dayKey(r.created_at);
      (g.get(k) ?? g.set(k, []).get(k)!).push(r);
    }
    return Array.from(g);
  }, [filtered]);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[900px] mx-auto">
      <div className="mb-5">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Team</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Activity Log</h1>
        <p className="text-sm text-ink-3 mt-1">App me kisne kya kiya — bana, badla, delete, login. (Sirf app ke andar ke actions; computer nigraani nahi.)</p>
      </div>

      {actors.length > 1 && (
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          <button onClick={() => setUserId("")}
            className={cn("text-xs font-medium px-3 py-1.5 rounded-full border transition-colors", !userId ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}>
            Sab
          </button>
          {actors.map((a) => (
            <button key={a.id} onClick={() => setUserId(a.id)}
              className={cn("text-xs font-medium px-3 py-1.5 rounded-full border transition-colors", userId === a.id ? "bg-ink text-paper border-ink" : "border-hairline text-ink-2 hover:bg-paper-2")}>
              {a.name}
            </button>
          ))}
        </div>
      )}

      {isLoading ? (
        <Card className="p-4 space-y-3">{[1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-8 w-full" />)}</Card>
      ) : error ? (
        <EmptyState icon="alert" title="Load nahi ho paya" body={(error as Error).message} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="clock" title="Abhi koi activity nahi" body="App me koi record banega/badlega to yahan dikhega." />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, items]) => (
            <div key={day}>
              <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-2">{day}</div>
              <Card flush>
                <ul className="divide-y divide-hairline">
                  {items.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span
                        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-[11px] font-semibold text-paper"
                        style={{ background: r.actor?.color ?? "var(--ink-3, #787c84)" }}
                      >
                        {r.actor?.initials ?? "?"}
                      </span>
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium text-ink">{r.actor?.full_name ?? "Someone"}</span>
                        {" ne "}
                        <span className={cn("font-medium", ACTION_TONE[r.action] ?? "text-ink-2")}>
                          {r.entity !== "session" ? `${ENTITY_LABEL[r.entity] ?? r.entity} ` : ""}{ACTION_VERB[r.action] ?? r.action}
                        </span>
                        {r.label ? <span className="text-ink-2"> — {r.label}</span> : null}
                      </div>
                      <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">{timeOf(r.created_at)}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
