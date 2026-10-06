/**
 * Self check-in attendance for logged-in app users (migration 0216).
 *
 * The login IS the identity proof, so — unlike the shared kiosk — no PIN or
 * selfie is needed. A user marks their OWN attendance via mark_self_attendance
 * (toggles check-in → check-out for IST today). If the user isn't yet linked to
 * an employee row, set_my_employee links them one time.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { isWorkingDay, SIX_DAY_WEEK_SUNDAY_OFF } from "@/lib/attendance/working-day";
import { localDateISO } from "@/lib/leads/outcomes";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { Database } from "@/lib/supabase/database.types";

export type MyAttendanceToday =
  | { linked: false }
  | {
      linked: true;
      employee_name: string;
      work_date: string;
      check_in: string | null;
      check_out: string | null;
      consent_at: string | null;
      retention_days: number;
      face_enrolled: boolean;
    };

export function useMyAttendanceToday() {
  return useQuery({
    queryKey: ["my-attendance-today"],
    queryFn: async (): Promise<MyAttendanceToday> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("my_attendance_today");
      if (error) throw error;
      return data as unknown as MyAttendanceToday;
    },
  });
}

export type MyAttendanceDay = {
  work_date: string;
  check_in: string | null;
  check_out: string | null;
  source: string;
};

export function useMyAttendanceHistory(days = 14) {
  return useQuery({
    queryKey: ["my-attendance-history", days],
    queryFn: async (): Promise<MyAttendanceDay[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("my_attendance_history", { p_days: days });
      if (error) throw error;
      return (data ?? []) as unknown as MyAttendanceDay[];
    },
  });
}

export function useRecordConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/attendance/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "record" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not record consent");
    },
    onSuccess: () => {
      toast.success("Consent recorded.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not save your consent." }),
  });
}

/** Owner clears an anomaly-flagged punch after reviewing it. */
export function useMarkAttendanceReviewed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await supabase.from("attendance")
        .update({ reviewed_at: new Date().toISOString(), reviewed_by: auth?.user?.id ?? null })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { toast.success("Reviewed ✓"); void qc.invalidateQueries({ queryKey: ["attendance"] }); },
    onError: (err: unknown) => toastError(err, { fallback: "Could not mark this as reviewed." }),
  });
}

/** Owner records/clears attendance consent for an employee (enrollment). */
export function useOwnerSetConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; value: boolean }) => {
      const res = await fetch("/api/attendance/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "owner_set", employeeId: input.employeeId, value: input.value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Consent update fail");
    },
    onSuccess: (_d, v) => {
      toast.success(v.value ? "Consent recorded." : "Consent withdrawn and selfies deleted.");
      void qc.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not update your consent." }),
  });
}

/** Enrol the caller's own reference face (Phase 4). */
export function useEnrollMyFace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (photo: string) => {
      const res = await fetch("/api/attendance/face/enroll", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ photo }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Face enroll fail");
    },
    onSuccess: () => {
      toast.success("Face enrolled ✅");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not enrol your face." }),
  });
}

export function useWithdrawConsent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/attendance/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "withdraw" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Withdraw fail");
    },
    onSuccess: () => {
      toast.success("Consent withdrawn and your selfies deleted.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not withdraw your consent." }),
  });
}

export function useMarkSelfAttendance() {
  const qc = useQueryClient();
  return useMutation({
    // Goes through the API route so the selfie + presence code + geo are handled
    // and enforced server-side (client-only checks would be bypassable).
    mutationFn: async (input?: {
      photo?: string | null; code?: string; lat?: number | null; lng?: number | null; accuracy?: number | null; device?: string;
    }): Promise<string> => {
      const res = await fetch("/api/attendance/self", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          photo: input?.photo ?? null,
          code: input?.code ?? "",
          lat: input?.lat ?? null,
          lng: input?.lng ?? null,
          accuracy: input?.accuracy ?? null,
          device: input?.device ?? "",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 428 || json?.needsConsent) {
        throw new Error("Give consent for attendance first (screen above).");
      }
      if (!res.ok) throw new Error(json.error ?? "Could not mark attendance");
      return json.action as string;
    },
    onSuccess: (result) => {
      if (result === "checked_in") toast.success("Checked in ✅");
      else if (result === "checked_out") toast.success("Checked out 👋");
      else if (result === "too_soon") toast.info("You just checked in — this tap was ignored (double tap).");
      else toast.info("Today's attendance is already complete.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not mark attendance." });
    },
  });
}

/** Undo the caller's last punch within 15 min (clear a wrong check-out / check-in). */
export function useUndoLastPunch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (): Promise<string> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("undo_my_last_punch");
      if (error) throw error;
      return data as unknown as string;
    },
    onSuccess: (result) => {
      toast.success(result === "undo_checkout" ? "Check-out undone — you are checked in again." : "Check-in undone.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
      void qc.invalidateQueries({ queryKey: ["my-attendance-history"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not undo the last punch." }),
  });
}

export function useSetMyEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (employeeId: string): Promise<void> => {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_my_employee", { p_employee_id: employeeId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Your employee profile is linked.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not link your employee profile." });
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Reminder preferences (migration 20260819150000)
//
// Read straight off the caller's own `users` row. Deliberately NOT folded into
// `useCurrentUser`: that hook is consumed by the sidebar, the topbar and a long tail of
// screens, and widening it means every one of them refetches when somebody changes a
// reminder time. This is two columns that matter on two screens.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReminderPrefs {
  enabled: boolean;
  /** Postgres `time`, e.g. "18:00:00". Parsed by lib/attendance/reminders.ts. */
  checkoutAt: string;
}

export function useMyReminderPrefs() {
  return useQuery({
    queryKey: ["my-reminder-prefs"],
    queryFn: async (): Promise<ReminderPrefs | null> => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) return null;

      const { data, error } = await supabase
        .from("users")
        .select("attendance_reminders_enabled, attendance_checkout_reminder_at")
        .eq("id", auth.user.id)
        .maybeSingle();

      /* A missing column (migration not applied yet) must not take the whole attendance
         screen down with it. Returning null reads downstream as "no preference known",
         and `decideAttendanceReminder` shows nothing rather than guessing. */
      if (error) return null;
      if (!data) return null;

      return {
        enabled: data.attendance_reminders_enabled ?? true,
        checkoutAt: data.attendance_checkout_reminder_at ?? "18:00:00",
      };
    },
    staleTime: 60_000,
  });
}

export function useSetMyReminderPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<ReminderPrefs>): Promise<void> => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth.user) throw new Error("You are not signed in.");

      const update: Database["public"]["Tables"]["users"]["Update"] = {};
      if (patch.enabled !== undefined) update.attendance_reminders_enabled = patch.enabled;
      if (patch.checkoutAt !== undefined) update.attendance_checkout_reminder_at = patch.checkoutAt;
      if (Object.keys(update).length === 0) return;

      /* Own row only. `users_self_update` (id = auth.uid()) allows this, and the
         privileged-column trigger from 20260818160000 returns early because neither
         column is role / manager_id / can_view_deals / tenant_id / is_active. */
      const { error } = await supabase.from("users").update(update).eq("id", auth.user.id);
      if (error) throw error;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["my-reminder-prefs"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not save the reminder setting." });
    },
  });
}

/**
 * Is today a day this tenant works?
 *
 * Reported 23 Aug 2026, a Sunday: the reminder had no notion of a working day and fired
 * anyway. The CRON now resolves this server-side per tenant; the popup needs the same
 * answer or the two disagree about the same day — which is exactly what the cron's own
 * header warns about ("the phone and the screen would start disagreeing").
 *
 * RLS scopes `holidays` to the caller's tenant, so no tenant filter is written here — and
 * unlike `document_series`, this table IS in the generated types, so the query is checked.
 *
 * Saturday is a working day at ANUTECH (operator-confirmed), hence the six-day constant.
 * When this becomes a tenant setting, this is the one place to read it from.
 */
export function useTodayWorkingDay() {
  return useQuery({
    queryKey: ["working-day-today"],
    queryFn: async (): Promise<{ working: boolean; reason: string | null }> => {
      const supabase = createClient();
      const date = localDateISO(new Date());
      const { data, error } = await supabase
        .from("holidays").select("holiday_date").eq("holiday_date", date);
      /* On error the weekday rule still applies — a failed holiday lookup must not
         resurrect the Sunday nudge, and must not silence a real Monday either. */
      const holidayDates = error ? [] : (data ?? []).map((h) => h.holiday_date);
      return isWorkingDay({ date, weeklyOffDows: SIX_DAY_WEEK_SUNDAY_OFF, holidayDates });
    },
    /* The answer changes at most once a day. */
    staleTime: 60 * 60 * 1000,
  });
}
