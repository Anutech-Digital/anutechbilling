/**
 * R-606 — owner side of attendance passkey devices (Payroll → Attendance).
 *
 * Why: a colleague who knows someone's password could check them in from his own laptop. With
 * passkeys every employee's check-in is signed by a key that never leaves their own device, and
 * a NEW device counts only once the owner approves it here (Pardeep, 9 Oct 2026: owner only, max
 * 2 per employee). A "synced passkey" lives in the employee's own Google/Apple account.
 *
 *   <RequireDeviceRow />   the "Require registered device" switch, for the settings card.
 *   <DeviceApprovals />    pending devices first (Approve / Remove), then approved (Remove).
 * Both render nothing for anyone but the owner.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  useDeviceAction,
  useDeviceSettings,
  useSetRequireDevice,
  useTenantDevices,
  type AttendanceDevice,
} from "@/lib/queries/attendance-devices";

function useIsOwner(): boolean {
  return useCurrentUser().data?.role === "owner";
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** The settings-card row: "Require registered device" + how many people would be blocked. */
export function RequireDeviceRow() {
  const isOwner = useIsOwner();
  const settingsQ = useDeviceSettings();
  const setRequire = useSetRequireDevice();
  if (!isOwner) return null;

  const on = settingsQ.data?.requireDevice ?? false;
  const missing = settingsQ.data?.employeesWithoutDevice ?? null;

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
      <div>
        <div className="text-sm font-medium text-ink flex items-center gap-2">
          <Icon name="laptop" size={14} className={on ? "text-emerald" : "text-ink-3"} />
          Require registered device {on ? "· ON" : "· OFF"}
        </div>
        <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
          Self check-in only from a device you approved (fingerprint / face / Windows Hello). Turn on after
          everyone has registered — until then their check-in will be blocked.
        </p>
        {missing !== null && missing > 0 && (
          <p className="text-xs text-amber-ink mt-1">
            {missing} {missing === 1 ? "person has" : "people have"} no approved device yet.
          </p>
        )}
      </div>
      <Switch
        checked={on}
        disabled={setRequire.isPending || settingsQ.isLoading}
        onCheckedChange={(v) => setRequire.mutate(v)}
        aria-label="Require registered device for self check-in"
      />
    </div>
  );
}

function DeviceRow({ d, busy, onAction }: {
  d: AttendanceDevice;
  busy: boolean;
  onAction: (action: "approve" | "revoke") => void;
}) {
  const who = d.employee_name ?? "Employee";
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-ink">
          {who} <span className="text-ink-3">· {d.label}</span>
        </div>
        <div className="text-xs text-ink-3">
          Registered {fmtWhen(d.created_at)}
          {d.last_used_at ? ` · last used ${fmtWhen(d.last_used_at)}` : ""}
          {d.backed_up ? " · synced passkey (employee's own Google / Apple account)" : ""}
        </div>
      </div>
      <div className="flex items-center gap-2">
        {d.status === "pending" ? (
          <>
            <Badge kind="warning" dot>Pending</Badge>
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAction("approve")}
              aria-label={`Approve ${d.label} for ${who}`}>
              Approve
            </Button>
          </>
        ) : (
          <Badge kind="success" dot>Approved</Badge>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => onAction("revoke")}
          aria-label={`Remove ${d.label} for ${who}`}>
          Remove
        </Button>
      </div>
    </li>
  );
}

/** Devices section in the Attendance tab — owner only. */
export function DeviceApprovals() {
  const isOwner = useIsOwner();
  const devicesQ = useTenantDevices(isOwner);
  const act = useDeviceAction();
  if (!isOwner) return null;

  const devices = devicesQ.data ?? [];
  const pending = devices.filter((d) => d.status === "pending");
  const approved = devices.filter((d) => d.status === "approved");
  const onAction = (d: AttendanceDevice) => (action: "approve" | "revoke") => act.mutate({ deviceId: d.id, action });

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium text-ink flex items-center gap-2">
          <Icon name="laptop" size={14} className="text-ink-3" />
          Devices
          {pending.length > 0 && <Badge kind="warning" size="sm">{pending.length} waiting</Badge>}
        </div>
        <p className="text-xs text-ink-3">Max 2 per employee. Only you can approve.</p>
      </div>

      {devicesQ.isLoading ? (
        <Skeleton className="mt-3 h-12 w-full" />
      ) : devicesQ.error ? (
        <p className="mt-3 text-xs text-rose-ink">Could not load devices. Refresh the page and try again.</p>
      ) : devices.length === 0 ? (
        <p className="mt-3 text-xs text-ink-3">
          No devices yet. Ask each employee to open My Attendance and press Register this device.
        </p>
      ) : (
        <>
          {pending.length > 0 && (
            <ul className="mt-2 divide-y divide-hairline" aria-label="Devices waiting for approval">
              {pending.map((d) => <DeviceRow key={d.id} d={d} busy={act.isPending} onAction={onAction(d)} />)}
            </ul>
          )}
          {approved.length > 0 && (
            <>
              <div className="mt-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">Approved</div>
              <ul className="divide-y divide-hairline" aria-label="Approved devices">
                {approved.map((d) => <DeviceRow key={d.id} d={d} busy={act.isPending} onAction={onAction(d)} />)}
              </ul>
            </>
          )}
        </>
      )}
    </Card>
  );
}
