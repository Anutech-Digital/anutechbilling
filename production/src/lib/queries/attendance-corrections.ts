"use client";

/**
 * R-439 — the owner's corrections for one employee-day (public.attendance_corrections),
 * shown as "History for this day" in the Fix attendance dialog. Read-only: the table is
 * written only by correct_attendance() (migration 20261011003000). Lives under
 * ["attendance"] so every attendance save (which invalidates ["attendance"]) refreshes it.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { sortTrail, type CorrectionRow } from "@/lib/attendance/correction-trail";

export const correctionsKey = (employeeId: string, workDate: string) =>
  ["attendance", "corrections", employeeId, workDate] as const;

export function useAttendanceCorrections(employeeId: string, workDate: string) {
  return useQuery({
    queryKey: correctionsKey(employeeId, workDate),
    queryFn: async (): Promise<CorrectionRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("attendance_corrections")
        .select("id, changed_at, changed_by, old_status, new_status, old_check_in, old_check_out, new_check_in, new_check_out, reason")
        .eq("employee_id", employeeId)
        .eq("work_date", workDate)
        .order("changed_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return sortTrail((data ?? []) as CorrectionRow[]);
    },
    staleTime: 15_000,
  });
}
