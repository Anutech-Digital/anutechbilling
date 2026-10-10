/**
 * The workspace's office hours (R-604) — late / left early / half-day rules.
 *
 * Read through GET /api/attendance/network, which already returns the attendance
 * settings every member may see. Defaults (10:00–18:00, late after 15 min, half-day under
 * 4 h) come back when the workspace has no settings row, so a caller never has to guess.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { DEFAULT_SHIFT, parseShiftRules, type ShiftRules } from "@/lib/attendance/shift";

export const SHIFT_QUERY_KEY = ["attendance-shift"] as const;

export function useShiftRules() {
  return useQuery({
    queryKey: SHIFT_QUERY_KEY,
    queryFn: async (): Promise<ShiftRules> => {
      const res = await fetch("/api/attendance/network");
      if (!res.ok) return DEFAULT_SHIFT;
      const json = (await res.json()) as { shift?: Partial<ShiftRules> };
      const s = json.shift;
      /* The route already sends parsed rules; re-parse through the same function so a
         half-shaped response falls back field by field instead of breaking the page. */
      return parseShiftRules(s ? {
        shift_start: s.shiftStart ?? null,
        shift_end: s.shiftEnd ?? null,
        late_grace_minutes: s.lateGraceMinutes ?? null,
        half_day_under_hours: s.halfDayUnderHours ?? null,
      } : null);
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** Owner/manager: save office hours. The route refuses bad input with a sentence. */
export function useSetShiftRules() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rules: ShiftRules) => {
      const res = await fetch("/api/attendance/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_shift", value: rules }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not save office hours");
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: SHIFT_QUERY_KEY });
      qc.invalidateQueries({ queryKey: ["attendance-network"] });
      toast.success("Office hours saved");
    },
    onError: (e: Error) => {
      toast.error(e.message, { description: "Nothing was changed. Fix the hours and save again." });
    },
  });
}
