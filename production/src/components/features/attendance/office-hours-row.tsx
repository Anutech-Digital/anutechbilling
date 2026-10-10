"use client";

/**
 * Office hours (R-604) — the row in the attendance settings card where the owner sets
 * when the day starts and ends, how late is "late", and how short is a half-day.
 *
 * Pardeep, 9 Oct 2026: 10:00–18:00, late after 15 minutes, under 4 hours is a half-day —
 * the same for every employee. Late is shown only; a half-day counts 0.5 in payroll's
 * loss-of-pay suggestion, so the row says that in words.
 *
 * R-438: the Office location row (geofence) renders right below it.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useSetShiftRules, useShiftRules } from "@/lib/queries/attendance-shift";
import { DEFAULT_SHIFT, type ShiftRules } from "@/lib/attendance/shift";
import { OfficeLocationRow } from "./office-location-row";

export function OfficeHoursRow() {
  const rulesQ = useShiftRules();
  const save = useSetShiftRules();
  const role = useCurrentUser().data?.role;
  const isOwner = role === "owner";
  const saved = rulesQ.data ?? DEFAULT_SHIFT;
  const [draft, setDraft] = React.useState<ShiftRules>(saved);

  // Load the saved values once they arrive (and after a save), unless the owner is mid-edit.
  const savedKey = `${saved.shiftStart}|${saved.shiftEnd}|${saved.lateGraceMinutes}|${saved.halfDayUnderHours}`;
  React.useEffect(() => { setDraft(saved); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = `${draft.shiftStart}|${draft.shiftEnd}|${draft.lateGraceMinutes}|${draft.halfDayUnderHours}` !== savedKey;

  return (
    <>
    <div className="mt-3 border-t border-hairline pt-3">
      <div className="text-sm font-medium text-ink flex items-center gap-2">
        <Icon name="clock" size={14} className="text-ink-3" />
        Office hours · {saved.shiftStart}–{saved.shiftEnd}
      </div>
      <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
        Check-in after {saved.shiftStart} + {saved.lateGraceMinutes} min shows as <b>Late</b> (shown only, never deducted).
        Under {saved.halfDayUnderHours} hours between check-in and check-out is a <b>Half day</b> — payroll counts it as half a day present.
        Same for every employee.
      </p>
      {isOwner ? (
        <form
          className="mt-2 flex flex-wrap items-end gap-3"
          onSubmit={(e) => { e.preventDefault(); save.mutate(draft); }}
        >
          <label className="text-xs text-ink-2">
            Starts
            <Input type="time" required value={draft.shiftStart} className="mt-1 w-28"
              onChange={(e) => setDraft({ ...draft, shiftStart: e.target.value })} />
          </label>
          <label className="text-xs text-ink-2">
            Ends
            <Input type="time" required value={draft.shiftEnd} className="mt-1 w-28"
              onChange={(e) => setDraft({ ...draft, shiftEnd: e.target.value })} />
          </label>
          <label className="text-xs text-ink-2">
            Late after (min)
            <Input type="number" required min={0} max={240} step={1} value={draft.lateGraceMinutes} className="mt-1 w-24"
              onChange={(e) => setDraft({ ...draft, lateGraceMinutes: Number(e.target.value) })} />
          </label>
          <label className="text-xs text-ink-2">
            Half day under (hours)
            <Input type="number" required min={0.5} max={12} step={0.5} value={draft.halfDayUnderHours} className="mt-1 w-24"
              onChange={(e) => setDraft({ ...draft, halfDayUnderHours: Number(e.target.value) })} />
          </label>
          <Button type="submit" size="sm" loading={save.isPending} disabled={!dirty}>Save hours</Button>
        </form>
      ) : (
        <p className="mt-1 text-xs text-ink-3">Only the owner can change office hours.</p>
      )}
    </div>
    {/* R-438: office location sits under office hours in the same settings card. */}
    <OfficeLocationRow />
    </>
  );
}
