/**
 * Biometric machine setup — shown on the Attendance Register (owner/manager).
 * Shows the ingest URL + per-tenant key for the office "bridge", and lets the
 * owner map each employee to their fingerprint-machine user number.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toast } from "sonner";
import { toTitleCase } from "@/lib/utils";
import { useAttendanceIngest, useRegenerateIngestKey, useSetEmployeeBiometricId } from "@/lib/queries/attendance-biometric";

type Emp = { id: string; name: string; biometric_id: string | null; designation?: string | null };

export function BiometricSetupCard({ employees }: { employees: Emp[] }) {
  const [open, setOpen] = React.useState(false);
  const ingest = useAttendanceIngest();
  const regen = useRegenerateIngestKey();
  const setBio = useSetEmployeeBiometricId();
  const confirm = useConfirm();
  const [showKey, setShowKey] = React.useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const punchUrl = `${origin}/api/attendance/punch`;
  const key = ingest.data?.key ?? "";
  const mappedCount = employees.filter((e) => e.biometric_id).length;

  const copy = (text: string, label: string) =>
    navigator.clipboard?.writeText(text).then(() => toast.success(`${label} copied`)).catch(() => toast.error("Copy failed"));

  return (
    <Card className="mb-4 p-3 md:p-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon name="check_circle" size={16} className="text-indigo shrink-0" />
          <span className="text-sm font-medium text-ink">Biometric machine (fingerprint)</span>
          <span className="text-[11px] text-ink-3">· {mappedCount}/{employees.length} mapped</span>
        </div>
        <Icon name={open ? "chevron_up" : "chevron_down"} size={16} className="text-ink-3 shrink-0" />
      </button>

      {open && (
        <div className="mt-3 space-y-4">
          <p className="text-[12px] text-ink-2">
            Aapki Hikvision jaisi LAN fingerprint machine ka data yahan laane ke liye office ke computer par ek chhota
            <b> bridge</b> chalega jo machine se punches padh ke neeche wale URL par bhejta rahega. Neeche har employee ko
            uska machine user-number map karo.
          </p>

          {/* Connection details for the bridge */}
          <div className="rounded-lg border border-hairline bg-paper-2/40 p-3 space-y-2">
            <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Bridge connection</div>
            <Field label="Punch URL" value={punchUrl} onCopy={() => copy(punchUrl, "URL")} mono />
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-ink-3 mb-0.5">Ingest key (secret)</div>
                <div className="font-mono text-[12px] bg-paper rounded border border-hairline px-2 py-1.5 truncate">
                  {ingest.isLoading ? "…" : showKey ? key : key ? "•".repeat(20) : "—"}
                </div>
              </div>
              <Button variant="default" className="h-8 px-2 text-[11px]" icon={showKey ? "eye_off" : "eye"} onClick={() => setShowKey((s) => !s)}>{showKey ? "Hide" : "Show"}</Button>
              <Button variant="default" className="h-8 px-2 text-[11px]" icon="copy" onClick={() => copy(key, "Key")} disabled={!key}>Copy</Button>
              <Button variant="ghost" className="h-8 px-2 text-[11px]" icon="refresh" loading={regen.isPending}
                onClick={async () => {
                  if (await confirm({ title: "Generate a new key?", body: "Purani key band ho jaayegi — bridge me nayi key daalni padegi.", danger: true, confirmLabel: "Regenerate" }))
                    regen.mutate(ingest.data?.tenantId ?? "");
                }}>New</Button>
            </div>
            <p className="text-[10px] text-ink-3">Ye key secret hai — sirf bridge me daalo, kisi ko share mat karo.</p>
          </div>

          {/* Employee → device user number mapping */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold mb-1.5">Employee → machine user number</div>
            <ul className="rounded-lg border border-hairline divide-y divide-hairline">
              {employees.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] text-ink truncate">{toTitleCase(e.name)}</div>
                    {e.designation && <div className="text-[10px] text-ink-3 truncate">{e.designation}</div>}
                  </div>
                  <Input
                    defaultValue={e.biometric_id ?? ""}
                    placeholder="e.g. 1"
                    className="w-28 h-8 text-sm"
                    onBlur={(ev) => {
                      const v = ev.target.value.trim();
                      if (v !== (e.biometric_id ?? "")) setBio.mutate({ employeeId: e.id, biometricId: v || null });
                    }}
                  />
                </li>
              ))}
              {employees.length === 0 && <li className="px-3 py-4 text-[12px] text-ink-3 text-center">No active employees.</li>}
            </ul>
            <p className="text-[10px] text-ink-3 mt-1">Machine me har employee ka jo user-ID (number) hai wahi yahan daalo. Blur/tab par apne aap save ho jaata hai.</p>
          </div>
        </div>
      )}
    </Card>
  );
}

function Field({ label, value, onCopy, mono }: { label: string; value: string; onCopy: () => void; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-ink-3 mb-0.5">{label}</div>
      <div className="flex items-center gap-2">
        <div className={`flex-1 min-w-0 bg-paper rounded border border-hairline px-2 py-1.5 truncate text-[12px] ${mono ? "font-mono" : ""}`}>{value}</div>
        <Button variant="default" className="h-8 px-2 text-[11px]" icon="copy" onClick={onCopy}>Copy</Button>
      </div>
    </div>
  );
}
