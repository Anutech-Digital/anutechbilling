"use client";

/**
 * R-439 — "History for this day": every owner correction of one employee-day, newest first —
 * who, when, what changed (before → after) and the reason. Data: attendance_corrections.
 */
import { useAttendanceCorrections } from "@/lib/queries/attendance-corrections";
import { describeCorrection } from "@/lib/attendance/correction-trail";
import { useTeamMembers, memberLabel } from "@/lib/queries/team";

const whenFmt = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
});

export function CorrectionTrail({ employeeId, workDate }: { employeeId: string; workDate: string }) {
  const q = useAttendanceCorrections(employeeId, workDate);
  const teamQ = useTeamMembers();
  const who = (id: string | null) => {
    const m = (teamQ.data ?? []).find((t) => t.id === id);
    return m ? memberLabel(m) : "Owner";
  };

  return (
    <section aria-labelledby="att-trail-h" className="rounded-md border border-hairline px-3 py-2">
      <h3 id="att-trail-h" className="text-3xs font-semibold uppercase tracking-wider text-ink-3">History for this day</h3>
      {q.isLoading ? (
        <p className="mt-1 text-xs text-ink-3">Loading…</p>
      ) : q.isError ? (
        <p className="mt-1 text-xs text-rose-ink">Could not load the history.</p>
      ) : (q.data ?? []).length === 0 ? (
        <p className="mt-1 text-xs text-ink-3">No corrections yet.</p>
      ) : (
        <ul className="mt-1 max-h-48 space-y-2 overflow-y-auto">
          {(q.data ?? []).map((r) => {
            const lines = describeCorrection(r);
            return (
              <li key={r.id} className="text-xs">
                <div className="text-ink-2">
                  <span className="font-medium text-ink">{who(r.changed_by)}</span> · {whenFmt.format(new Date(r.changed_at))}
                </div>
                {lines.length > 0 ? (
                  <div className="text-ink-2">
                    {lines.map((l) => `${l.field} ${l.before} → ${l.after}`).join(" · ")}
                  </div>
                ) : (
                  <div className="text-ink-3">No time changed</div>
                )}
                <div className="text-ink-3">Reason: {r.reason}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
