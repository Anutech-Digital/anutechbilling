/**
 * R-2928 — the "Remind" button on a teammate's task row: when it shows, the "Last reminded …"
 * line, and the call to POST /api/tasks/remind (bell + email to the task's owner; the server
 * allows one reminder per task per hour and says so in plain words).
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { IST_TZ } from "@/lib/dates/ist";
import { toastError } from "@/lib/errors/toast-error";

/** Only someone else's open task can be reminded — never my own, an unassigned or a finished one. */
export function canRemind(
  task: { status: string; owner_id: string | null },
  meId: string | null | undefined,
): boolean {
  if (!meId || !task.owner_id || task.owner_id === meId) return false;
  return task.status !== "done" && task.status !== "cancelled";
}

const DAY_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: IST_TZ, day: "numeric", month: "short" });
const TIME_FMT = new Intl.DateTimeFormat("en-IN", { timeZone: IST_TZ, hour: "numeric", minute: "2-digit", hour12: true });

/** "Last reminded 18 Nov, 4:10 pm" (IST) — null when the task was never reminded. */
export function lastRemindedLabel(lastFollowupAt: string | null | undefined): string | null {
  if (!lastFollowupAt) return null;
  const at = new Date(lastFollowupAt);
  if (Number.isNaN(at.getTime())) return null;
  return `Last reminded ${DAY_FMT.format(at)}, ${TIME_FMT.format(at).toLowerCase()}`;
}

const REMIND_FAILED = "Could not send the reminder — check your internet and try again.";

/** Send the reminder. The answer is said in a toast; the row re-reads its "Last reminded" time. */
export function useRemindTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (taskId: string): Promise<{ ok: boolean; message?: string }> => {
      const res = await fetch("/api/tasks/remind", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && body?.ok) return { ok: true };
      return { ok: false, message: body?.error || REMIND_FAILED };
    },
    onSuccess: (r) => {
      if (r.ok) toast.success("Reminder sent");
      else toast.warning(r.message ?? REMIND_FAILED);
      void qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err) => toastError(err, { fallback: REMIND_FAILED }),
  });
}
