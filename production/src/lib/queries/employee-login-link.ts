/**
 * R-1436 — the owner's "Logins for attendance" panel on /accounting/employees.
 *
 * Reads the workspace's logins and writes users.employee_id. Tenant scoping is layered:
 * RLS (users_tenant_select / users_tenant_update) keeps both to the caller's workspace, the
 * explicit .eq("tenant_id") repeats it here, and guard_privileged_user_columns (R-712) refuses
 * any non-owner and any employee outside the workspace. A write that touched no row (RLS
 * filtered it away) is treated as a failure — never reported as linked.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import type { LoginLinkWrite, TenantLogin } from "@/lib/attendance/login-link";

export const TENANT_LOGINS_KEY = ["employee-login-link", "logins"] as const;

export function useTenantLogins(enabled: boolean) {
  const tenantId = useCurrentUser().data?.tenantId ?? null;
  return useQuery({
    queryKey: [...TENANT_LOGINS_KEY, tenantId],
    enabled: enabled && !!tenantId,
    queryFn: async (): Promise<TenantLogin[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("users")
        .select("id, full_name, email, role, employee_id, is_active")
        .eq("tenant_id", tenantId!)
        .order("full_name", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((u) => ({
        id: u.id,
        full_name: u.full_name,
        email: u.email,
        role: u.role,
        employee_id: u.employee_id,
        is_active: u.is_active,
      }));
    },
    staleTime: 30_000,
  });
}

export function useLinkLogin() {
  const qc = useQueryClient();
  const tenantId = useCurrentUser().data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (input: { employeeName: string; writes: LoginLinkWrite[] }): Promise<boolean> => {
      if (!tenantId) throw new Error("Your workspace is not loaded yet — reload the page and try again.");
      const supabase = createClient();
      // In order: the old login is cleared before the new one is set (see planLoginLink).
      for (const w of input.writes) {
        const { data, error } = await supabase
          .from("users")
          .update({ employee_id: w.employeeId })
          .eq("id", w.userId)
          .eq("tenant_id", tenantId)
          .select("id");
        if (error) throw error;
        if (!data || data.length === 0) {
          throw new Error(
            "That login was not changed — it is not in your workspace, or only an owner can link logins. " +
              "Reload the page and try again.",
          );
        }
      }
      return input.writes.some((w) => w.employeeId !== null);
    },
    onSuccess: (linked, input) => {
      toast.success(
        linked
          ? `${input.employeeName} is linked — they can now check in at My attendance.`
          : `${input.employeeName}'s login is unlinked.`,
      );
    },
    onError: (err: unknown) => {
      toastError(err, { fallback: "Could not change the login link." });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: TENANT_LOGINS_KEY });
      void qc.invalidateQueries({ queryKey: ["team"] });
    },
  });
}
