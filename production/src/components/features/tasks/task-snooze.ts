/**
 * R-471 (via R-486) — Snooze with choices instead of a blind "+1 day".
 *
 * The clock button used to push the task exactly 24 h from its OLD due time (a task due
 * 3 days ago stayed overdue after a snooze) and toasted "Snoozed to 10/10/2026, 3:00:00 pm".
 * Now the menu offers: In 1 hour · This evening 6 PM (only before 5 PM) · Tomorrow 10 AM ·
 * Monday 10 AM · Pick a date (opens Edit). Every choice is measured from NOW, in IST, and
 * the toast reads "Snoozed to 10 Oct 2026, 10:00 am".
 *
 * Kept here (not in lib/queries/tasks.ts) so the old useSnoozeTask there stays untouched.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { addDaysISO, formatIstDate, formatIstTime, istDayStartUtc, istParts } from "@/lib/dates/ist";

export interface SnoozeChoice {
  key: "1h" | "evening" | "tomorrow" | "monday";
  label: string;
  at: Date;
}

/** An IST wall-clock time on an IST date, as an instant. */
function istAt(dateISO: string, minutesOfDay: number): Date {
  return new Date(istDayStartUtc(dateISO).getTime() + minutesOfDay * 60_000);
}

/** The menu, for this moment. Pure — `now` is passed in. */
export function snoozeChoices(now: Date = new Date()): SnoozeChoice[] {
  const p = istParts(now);
  const out: SnoozeChoice[] = [
    { key: "1h", label: "In 1 hour", at: new Date(now.getTime() + 60 * 60_000) },
  ];
  if (p.minutesOfDay < 17 * 60) {
    out.push({ key: "evening", label: "This evening, 6 PM", at: istAt(p.date, 18 * 60) });
  }
  out.push({ key: "tomorrow", label: "Tomorrow, 10 AM", at: istAt(addDaysISO(p.date, 1), 10 * 60) });
  // Next Monday (never today, never tomorrow — that is the row above).
  const dow = new Date(`${p.date}T00:00:00Z`).getUTCDay(); // 0 Sun … 6 Sat, of the IST date
  const toMonday = ((8 - dow) % 7) || 7;
  if (toMonday > 1) {
    out.push({ key: "monday", label: "Monday, 10 AM", at: istAt(addDaysISO(p.date, toMonday), 10 * 60) });
  }
  return out;
}

/** "Snoozed to 10 Oct 2026, 10:00 am" — the app's date format, IST. */
export function snoozedMessage(at: Date | string): string {
  return `Snoozed to ${formatIstDate(at)}, ${formatIstTime(at)}`;
}

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
