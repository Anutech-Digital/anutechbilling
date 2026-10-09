/**
 * R-606 — attendance passkey devices: the employee's own list + register flow, the owner's
 * approval list, the "Require registered device" setting, and the check-in signature helper.
 *
 * Reads go through the signed-in client (RLS: own devices, or every device for the owner).
 * Every write goes through /api/attendance/device/* — authenticated has no write grant.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { cleanLabel, type DeviceErrorCode, type DeviceStatus } from "@/lib/attendance/webauthn";

export type AttendanceDevice = {
  id: string;
  employee_id: string;
  credential_id: string;
  label: string;
  status: DeviceStatus;
  backed_up: boolean;
  created_at: string;
  approved_at: string | null;
  last_used_at: string | null;
  employee_name?: string | null;
};

const LOCAL_KEY = "ros_att_passkey";

/** Credential id registered from THIS browser (a hint only — the server decides). */
export function getLocalCredentialId(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(LOCAL_KEY);
  } catch {
    return null;
  }
}
function setLocalCredentialId(id: string) {
  try { window.localStorage.setItem(LOCAL_KEY, id); } catch { /* private window — fine */ }
}

/** An API refusal carrying the server's next-step message and its machine code. */
export class DeviceApiError extends Error {
  code: DeviceErrorCode | null;
  constructor(message: string, code: DeviceErrorCode | null) {
    super(message);
    this.code = code;
  }
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new DeviceApiError(json?.error ?? "Something went wrong. Try again.", json?.code ?? null);
  return json as T;
}

/** Browser refused / cancelled the passkey prompt → a message with the fix. */
function browserPasskeyError(e: unknown, purpose: "register" | "auth"): Error {
  const name = (e as Error)?.name ?? "";
  if (name === "NotAllowedError" || name === "AbortError") {
    return new Error(
      purpose === "auth"
        ? "The fingerprint / Windows Hello check was cancelled or this browser has no passkey for you. Press the button again, or register this device below."
        : "Registration was cancelled. Press Register this device again and confirm with your fingerprint, face or Windows Hello PIN.",
    );
  }
  if (name === "InvalidStateError") return new Error("This device is already registered for you. See the list under This device.");
  if (name === "NotSupportedError" || name === "SecurityError") {
    return new Error("This browser cannot use passkeys here. Open the site in Chrome, Edge or Safari over https and set up a screen lock (PIN / fingerprint).");
  }
  return e instanceof Error ? e : new Error("The device check failed. Try again.");
}

/** The caller's own devices (their linked employee only). */
export function useMyDevices() {
  return useQuery({
    queryKey: ["attendance-devices", "mine"],
    queryFn: async (): Promise<AttendanceDevice[]> => {
      const supabase = createClient();
      const { data: auth } = await supabase.auth.getUser();
      if (!auth?.user) return [];
      const { data: me } = await supabase.from("users").select("employee_id").eq("id", auth.user.id).maybeSingle();
      if (!me?.employee_id) return [];
      const { data, error } = await supabase
        .from("attendance_devices")
        .select("id, employee_id, credential_id, label, status, backed_up, created_at, approved_at, last_used_at")
        .eq("employee_id", me.employee_id)
        .neq("status", "revoked")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as AttendanceDevice[];
    },
    staleTime: 15_000,
  });
}

/** Owner: every live device in the workspace, pending first. */
export function useTenantDevices(enabled: boolean) {
  return useQuery({
    queryKey: ["attendance-devices", "tenant"],
    enabled,
    queryFn: async (): Promise<AttendanceDevice[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("attendance_devices")
        .select("id, employee_id, credential_id, label, status, backed_up, created_at, approved_at, last_used_at, employees(name)")
        .neq("status", "revoked")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? [])
        .map((d) => {
          const { employees, ...rest } = d as typeof d & { employees: { name: string | null } | null };
          return { ...rest, employee_name: employees?.name ?? null } as AttendanceDevice;
        })
        .sort((a, b) => (a.status === b.status ? 0 : a.status === "pending" ? -1 : 1));
    },
    staleTime: 10_000,
  });
}

/** "Register this device": server options → browser passkey prompt → server verify. */
export function useRegisterDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { label: string }) => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const optionsJSON = await postJson<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/api/attendance/device/register/options",
      );
      let response;
      try {
        response = await startRegistration({ optionsJSON });
      } catch (e) {
        throw browserPasskeyError(e, "register");
      }
      const out = await postJson<{ device: { status: DeviceStatus }; credentialId: string }>(
        "/api/attendance/device/register/verify",
        { response, label: cleanLabel(input.label, "My device") },
      );
      setLocalCredentialId(out.credentialId);
      return out.device;
    },
    onSuccess: (device) => {
      if (device.status === "approved") toast.success("Device registered ✓", { description: "Attendance from this device only." });
      else toast.success("Device registered", { description: "Waiting for owner approval. You can check in once the owner approves." });
      void qc.invalidateQueries({ queryKey: ["attendance-devices"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not register this device.", description: (err as Error)?.message });
    },
  });
}

/** Owner: approve or remove a device. */
export function useDeviceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { deviceId: string; action: "approve" | "revoke" }) =>
      postJson<{ id: string; status: DeviceStatus }>("/api/attendance/device/approve", input),
    onSuccess: (r) => {
      toast.success(r.status === "approved" ? "Device approved" : "Device removed");
      void qc.invalidateQueries({ queryKey: ["attendance-devices"] });
      void qc.invalidateQueries({ queryKey: ["attendance-network"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not update the device.", description: (err as Error)?.message });
    },
  });
}

export type DeviceSettings = { requireDevice: boolean; employeesWithoutDevice: number | null };

/** Same endpoint (and cache key) as useAttendanceNetwork — only the device fields are read here. */
export function useDeviceSettings() {
  return useQuery({
    queryKey: ["attendance-network"],
    queryFn: async () => {
      const res = await fetch("/api/attendance/network");
      if (!res.ok) throw new Error("Failed to load attendance settings");
      return res.json() as Promise<Record<string, unknown>>;
    },
    select: (d): DeviceSettings => ({
      requireDevice: d.requireDevice === true,
      employeesWithoutDevice: typeof d.employeesWithoutDevice === "number" ? d.employeesWithoutDevice : null,
    }),
    staleTime: 10_000,
  });
}

/** Owner: turn "Require registered device" on / off. */
export function useSetRequireDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (value: boolean) =>
      postJson<{ requireDevice: boolean; employeesWithoutDevice: number }>("/api/attendance/network", {
        action: "require_device",
        value,
      }),
    onSuccess: (r) => {
      if (r.requireDevice && r.employeesWithoutDevice > 0) {
        toast.warning("Registered device now required", {
          description: `${r.employeesWithoutDevice} ${r.employeesWithoutDevice === 1 ? "person has" : "people have"} no approved device — their check-in is blocked until they register and you approve.`,
        });
      } else {
        toast.success(r.requireDevice ? "Registered device now required" : "Registered device no longer required");
      }
      void qc.invalidateQueries({ queryKey: ["attendance-network"] });
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not change the setting.", description: (err as Error)?.message });
    },
  });
}

/**
 * Sign a check-in with this device's passkey. Returns the assertion to send as
 * `deviceAssertion` to /api/attendance/self, or throws an Error whose message says the fix.
 */
export async function signCheckInWithDevice(): Promise<unknown> {
  const { startAuthentication } = await import("@simplewebauthn/browser");
  const optionsJSON = await postJson<Parameters<typeof startAuthentication>[0]["optionsJSON"]>(
    "/api/attendance/device/auth/options",
  );
  try {
    return await startAuthentication({ optionsJSON });
  } catch (e) {
    throw browserPasskeyError(e, "auth");
  }
}
