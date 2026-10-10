"use client";

/**
 * R-608 — "Changes by staff": every attendance add / edit / delete made by someone other than
 * the employee (owner, manager, accountant, billing, or "Fix attendance"), newest first, with
 * before → after. Written by the trigger in 20261010050000_attendance_change_log.sql; the
 * employee's own check-ins, kiosk punches and the biometric machine are not in it.
 */
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";
import { describeAttendanceChange } from "@/lib/attendance/change-log";
import { formatDate } from "@/lib/utils";
import type { Json } from "@/lib/supabase/database.types";

interface Row {
  id: number;
  user_id: string | null;
  actor_label: string | null;
  action: string;
  label: string | null;
  created_at: string;
  changes: Json | null;
}

const ACTION_WORD: Record<string, string> = { insert: "added", update: "changed", delete: "removed" };

export function AttendanceChanges() {
  const teamQ = useTeamMembers();
  const q = useQuery({
    queryKey: ["attendance-changes"],
    queryFn: async (): Promise<Row[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("activity_log")
        .select("id, user_id, actor_label, action, label, created_at, changes")
        .eq("entity", "attendance")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    staleTime: 30_000,
  });

  const who = (r: Row) =>
    r.actor_label ?? memberLabel((teamQ.data ?? []).find((m) => m.id === r.user_id));

  return (
    <Card className="mt-4 p-4">
      <div className="text-3xs font-semibold uppercase tracking-wider text-ink-3">Changes by staff</div>
      <p className="mt-0.5 text-xs text-ink-3">
        Every attendance day added, edited or removed by someone other than the employee — newest first.
        Employees&apos; own check-ins, the kiosk and the biometric machine are not listed here.
      </p>
      {q.isLoading ? (
        <p className="mt-3 text-sm text-ink-3">Loading…</p>
      ) : q.isError ? (
        <p className="mt-3 text-sm text-rose">Could not load the change history. Refresh the page to try again.</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="mt-3 text-sm text-ink-3">No changes by staff yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-hairline">
          {(q.data ?? []).map((r) => {
            const lines = describeAttendanceChange(r.action, r.changes);
            return (
              <li key={r.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-ink">
                    <b>{who(r)}</b> {ACTION_WORD[r.action] ?? r.action} <b>{r.label ?? "a day"}</b>
                  </span>
                  <span className="text-xs text-ink-3" title={new Date(r.created_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}>
                    {formatDate(r.created_at, "relative")}
                  </span>
                </div>
                {lines.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-ink-2">
                    {lines.map((l) => (
                      <span key={l.field}>
                        {l.field}: <span className="text-ink-3">{l.before}</span> → <b>{l.after}</b>
                      </span>
                    ))}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
