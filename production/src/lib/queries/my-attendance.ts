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
import { toast } from "sonner";

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
      if (!res.ok) throw new Error(json.error ?? "Consent record nahi hua");
    },
    onSuccess: () => {
      toast.success("Consent record ho gaya.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Consent fail"),
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
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Review fail"),
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
      toast.success(v.value ? "Consent record ho gaya." : "Consent hata diya + selfies delete.");
      void qc.invalidateQueries({ queryKey: ["employees"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Consent update fail"),
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
      toast.success("Face enroll ho gaya ✅");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Face enroll fail"),
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
      toast.success("Consent withdraw + aapki selfies delete ho gayi.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Withdraw fail"),
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
        throw new Error("Pehle attendance ke liye consent do (upar wali screen).");
      }
      if (!res.ok) throw new Error(json.error ?? "Attendance mark nahi hui");
      return json.action as string;
    },
    onSuccess: (result) => {
      if (result === "checked_in") toast.success("Check-in ho gaya ✅");
      else if (result === "checked_out") toast.success("Check-out ho gaya 👋");
      else if (result === "too_soon") toast.info("Abhi to check-in hua — ye tap ignore kiya (galti se double-tap).");
      else toast.info("Aaj ki attendance already complete hai.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Attendance mark nahi hui");
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
      toast.success(result === "undo_checkout" ? "Check-out undo — aap fir se checked-in ho." : "Check-in undo ho gaya.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
      void qc.invalidateQueries({ queryKey: ["my-attendance-history"] });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => toast.error(err instanceof Error ? err.message : "Undo fail"),
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
      toast.success("Aapka employee profile link ho gaya.");
      void qc.invalidateQueries({ queryKey: ["my-attendance-today"] });
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : "Link nahi ho paya");
    },
  });
}
