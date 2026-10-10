/**
 * R-606 — "This device" on My Attendance, and the check-in signature step.
 *
 * A passkey made here lives in this device's own secure hardware (fingerprint, face or Windows
 * Hello PIN) and never leaves it, so once the owner approves it a check-in under this login can
 * only be signed from here (or from the employee's own synced Google/Apple account) — not from a
 * colleague's laptop that knows the password.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  canRegisterAnother,
  DEVICE_MESSAGES,
  defaultDeviceLabel,
  MAX_DEVICES_PER_EMPLOYEE,
} from "@/lib/attendance/webauthn";
import {
  getLocalCredentialId,
  signCheckInWithDevice,
  useDeviceSettings,
  useMyDevices,
  useRegisterDevice,
  type AttendanceDevice,
} from "@/lib/queries/attendance-devices";

const CARD_ID = "this-device";

function scrollToCard() {
  document.getElementById(CARD_ID)?.scrollIntoView({ behavior: "smooth", block: "start" });
  (document.getElementById(`${CARD_ID}-action`) as HTMLElement | null)?.focus();
}

function browserLabel(): string {
  if (typeof navigator === "undefined") return "My device";
  const nav = navigator as Navigator & { userAgentData?: { platform?: string; mobile?: boolean } };
  return defaultDeviceLabel({
    platform: nav.userAgentData?.platform ?? navigator.platform,
    mobile: nav.userAgentData?.mobile ?? null,
    userAgent: navigator.userAgent,
  });
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

/**
 * Check-in press helper. `sign()` returns undefined when no device is required, the passkey
 * assertion when it is, or `false` when the check failed (the hint below the button says why).
 */
export function useDeviceSignature() {
  const settingsQ = useDeviceSettings();
  const required = settingsQ.data?.requireDevice ?? false;
  const [signing, setSigning] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  const sign = React.useCallback(async (): Promise<unknown> => {
    if (!required) return undefined;
    setErr(null);
    setSigning(true);
    try {
      return await signCheckInWithDevice();
    } catch (e) {
      const msg = e instanceof Error && e.message ? e.message : DEVICE_MESSAGES.DEVICE_CHECK_FAILED;
      setErr(msg);
      toast.error("Device check needed", {
        description: msg,
        action: { label: "This device", onClick: scrollToCard },
      });
      return false;
    } finally {
      setSigning(false);
    }
  }, [required]);

  const hint = err ? (
    <p role="alert" className="mt-3 text-xs text-rose-ink">
      {err}{" "}
      <Button variant="link" size="sm" className="text-xs" onClick={scrollToCard}>
        Go to This device
      </Button>
    </p>
  ) : required ? (
    <p className="mt-3 text-xs text-ink-3">Check-in asks for your fingerprint, face or Windows Hello PIN.</p>
  ) : null;

  return { required, signing, sign, hint };
}

function StatusBadge({ d }: { d: AttendanceDevice }) {
  return d.status === "approved" ? (
    <Badge kind="success" dot>Approved</Badge>
  ) : (
    <Badge kind="warning" dot>Waiting for owner</Badge>
  );
}

export function ThisDeviceCard() {
  const devicesQ = useMyDevices();
  const register = useRegisterDevice();
  const [label, setLabel] = React.useState("");
  const [localId, setLocalId] = React.useState<string | null>(null);
  const [supported, setSupported] = React.useState(true);

  React.useEffect(() => {
    setLabel(browserLabel());
    setLocalId(getLocalCredentialId());
    setSupported(typeof window !== "undefined" && typeof window.PublicKeyCredential !== "undefined");
  }, [register.isSuccess]);

  const devices = devicesQ.data ?? [];
  // The browser cannot tell us which passkey it holds without a prompt; the id saved at
  // registration is the hint. Anything else shows as "not registered here".
  const here = localId ? devices.find((d) => d.credential_id === localId) : undefined;
  const hereStatus = here?.status ?? "none";
  const roomForMore = canRegisterAnother(devices);

  return (
    <Card id={CARD_ID} className="mt-4 p-4 scroll-mt-4">
      <div className="flex items-center gap-2 text-sm font-medium text-ink">
        <Icon name="laptop" size={15} className="text-ink-3" />
        This device
      </div>

      {devicesQ.isLoading ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : (
        <>
          <div className="mt-2 text-sm">
            {hereStatus === "approved" ? (
              <p className="text-emerald">Registered ✓ — attendance from this device only.</p>
            ) : hereStatus === "pending" ? (
              <p className="text-amber-ink">Registered — waiting for owner approval.</p>
            ) : (
              <p className="text-ink-2">
                Not registered. Register it so your attendance can only be marked from your own device
                (fingerprint, face or Windows Hello PIN — nothing leaves this device).
              </p>
            )}
          </div>

          {hereStatus !== "approved" && hereStatus !== "pending" && (
            !supported ? (
              <p className="mt-3 text-xs text-rose-ink">
                This browser cannot register a passkey. Open the site in Chrome, Edge or Safari and set a screen lock (PIN / fingerprint) on the device.
              </p>
            ) : !roomForMore ? (
              <p className="mt-3 text-xs text-amber-ink">{DEVICE_MESSAGES.DEVICE_LIMIT}</p>
            ) : (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label htmlFor="device-label" className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                    Device name
                  </label>
                  <Input
                    id="device-label"
                    value={label}
                    maxLength={40}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Windows laptop"
                  />
                </div>
                <Button
                  id={`${CARD_ID}-action`}
                  variant="primary"
                  icon="check"
                  loading={register.isPending}
                  onClick={() => register.mutate({ label })}
                >
                  Register this device
                </Button>
              </div>
            )
          )}

          {devices.length > 0 && (
            <ul className="mt-4 divide-y divide-hairline border-t border-hairline" aria-label="Your registered devices">
              {devices.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <div className="min-w-0">
                    <div className="text-ink">{d.label}</div>
                    <div className="text-xs text-ink-3">
                      Registered {fmtDate(d.created_at)}
                      {d.backed_up ? " · synced passkey (your Google / Apple account)" : ""}
                    </div>
                  </div>
                  <StatusBadge d={d} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink-3">
            Up to {MAX_DEVICES_PER_EMPLOYEE} devices. A new device needs the owner&apos;s approval; ask the owner to remove an old one.
          </p>
        </>
      )}
    </Card>
  );
}
