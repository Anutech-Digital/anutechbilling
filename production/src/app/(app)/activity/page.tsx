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
import { activityActorInitials, activityActorName } from "@/lib/queries/activity-actor";

/* The columns worth reading in a feed line — money and dates. Everything else in
   `changes` is still there for an export; a feed that prints every jsonb key is noise. */
const SHOWN_FIELDS = ["amount", "gst_paid", "tds_amount", "net", "gross", "paid_amount", "expense_date", "pay_date", "paid_on", "invoice_date", "status", "category", "vendor_name", "kind", "period", "channel", "bank_account_id", "auto_renew"];
function fmtVal(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return v.toLocaleString("en-IN");
  return String(v);
}
function ChangeLine({ changes, action }: { changes: Record<string, unknown> | null; action: string }) {
  if (!changes) return null;
  if (action === "delete") {
    const old = changes.old as Record<string, unknown> | undefined;
    if (!old) return null;
    const bits = SHOWN_FIELDS.filter((k) => old[k] !== undefined && old[k] !== null).slice(0, 4).map((k) => `${k} ${fmtVal(old[k])}`);
    return bits.length ? <span className="block text-2xs text-ink-3 mt-0.5 font-mono">was: {bits.join(" · ")}</span> : null;
  }
  const keys = Object.keys(changes);
  const shown = keys.filter((k) => SHOWN_FIELDS.includes(k));
  const rest = keys.length - shown.length;
  if (!shown.length && !rest) return null;
  return (
    <span className="block text-2xs text-ink-3 mt-0.5 font-mono">
      {shown.map((k) => { const c = changes[k] as { old?: unknown; new?: unknown }; return `${k}: ${fmtVal(c?.old)} → ${fmtVal(c?.new)}`; }).join(" · ")}
      {rest > 0 ? `${shown.length ? " · " : ""}+${rest} more field${rest === 1 ? "" : "s"}` : ""}
    </span>
  );
}

const ENTITY_LABEL: Record<string, string> = {
  leads: "lead", customers: "customer", contacts: "contact", quotes: "quote",
  invoices: "invoice", payments: "payment", expenses: "expense",
  subscriptions: "subscription", employees: "employee", vendor_bills: "vendor bill",
  project_sales: "project", bank_transactions: "bank entry", session: "",
};
const ACTION_VERB: Record<string, string> = {
  insert: "created", update: "updated", delete: "deleted", login: "logged in",
  // AI decisions (lib/ai/audit.ts). Phrased so it's obvious these are the app's
  // own safety checks, not something a person did — the raw slug would otherwise
  // render as "ai_blocked" in the middle of a sentence.
  ai_blocked:        "— AI draft was blocked",
  ai_fallback:       "— AI did not run, standard draft sent",
  ai_low_confidence: "— AI was not confident, needs review",
};
/** English word order: "created lead", but "lead — AI draft was blocked" for the AI checks. */
function activityPhrase(action: string, entity: string): string {
  const noun = entity !== "session" ? (ENTITY_LABEL[entity] ?? entity) : "";
  const verb = ACTION_VERB[action] ?? action;
  if (!noun) return verb;
  return action.startsWith("ai_") ? `${noun} ${verb}` : `${verb} ${noun}`;
}
const ACTION_TONE: Record<string, string> = {
  insert: "text-emerald", update: "text-amber-ink", delete: "text-rose", login: "text-indigo",
  // Rose for a block: it means the AI tried to state a wrong amount, which is
  // worth a second look even though nothing wrong actually went out.
  ai_blocked: "text-rose", ai_fallback: "text-ink-3", ai_low_confidence: "text-amber-ink",
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
        <p className="text-sm text-ink-3 mt-1">Who did what in the app — created, updated, deleted, logged in. (Only actions inside the app; no computer monitoring.)</p>
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
        <EmptyState icon="alert" title="Could not load activity" body={(error as Error).message} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="clock" title="No activity yet" body="When someone creates or changes a record in the app, it shows here." />
      ) : (
        <div className="space-y-6">
          {groups.map(([day, items]) => (
            <div key={day}>
              <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-2">{day}</div>
              <Card flush>
                <ul className="divide-y divide-hairline">
                  {items.map((r) => (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                      <span
                        className="shrink-0 h-7 w-7 rounded-full flex items-center justify-center text-2xs font-semibold text-paper"
                        style={{ background: r.actor?.color ?? "var(--ink-3, #787c84)" }}
                      >
                        {activityActorInitials(r)}
                      </span>
                      <div className="min-w-0 flex-1 text-sm">
                        <span className="font-medium text-ink">{activityActorName(r)}</span>
                        {" "}
                        <span className={cn("font-medium", ACTION_TONE[r.action] ?? "text-ink-2")}>
                          {activityPhrase(r.action, r.entity)}
                        </span>
                        {r.label ? <span className="text-ink-2"> — {r.label}</span> : null}
                        <ChangeLine changes={r.changes} action={r.action} />
                      </div>
                      <span className="shrink-0 text-2xs text-ink-3 tabular-nums">{timeOf(r.created_at)}</span>
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
