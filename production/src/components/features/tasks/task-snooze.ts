/**
 * R-471 (via R-486) — Snooze with choices instead of a blind "+1 day".
 *
 * The clock button used to push the task exactly 24 h from its OLD due time (a task due
 * 3 days ago stayed overdue after a snooze) and toasted "Snoozed to 10/10/2026, 3:00:00 pm".
 * Now the menu offers: In 1 hour · This evening 6 PM (only before 5 PM) · Tomorrow 10 AM ·
 * Monday 10 AM · Pick a date (opens Edit). Every choice is measured from NOW, in IST, and
 * the toast reads "Snoozed to 10 Oct 2026, 10:00 am".
 *
 * R-490: the old useSnoozeTask (lib/queries/tasks.ts) now uses the same rule and toast.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { snoozedMessage } from "@/lib/tasks/snooze";

/* The pure menu + message live in lib/tasks/snooze.ts (shared with lib/queries/tasks.ts). */
export { snoozeChoices, snoozedMessage, type SnoozeChoice } from "@/lib/tasks/snooze";

/** Move a task to an exact time and count the snooze. */
export function useSnoozeTaskTo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, at, snoozeCount }: { id: string; at: Date; snoozeCount: number }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("tasks")
        .update({ due_at: at.toISOString(), snooze_count: snoozeCount + 1 })
        .eq("id", id)
        .select("id, due_at")
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["tasks"] });
      toast(snoozedMessage(data.due_at));
    },
    onError: (err) => toastError(err),
  });
}
