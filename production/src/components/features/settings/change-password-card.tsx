"use client";

/**
 * Change your own password, from inside the app.
 *
 * Asked for on 22 Aug 2026 while looking at the Team page: there was nowhere to change a
 * password, so rotating one meant an owner opening the Supabase dashboard — which the app
 * never mentions. The recovery email route existed only from that morning (AGENTS.md L15).
 *
 * The current password is required and re-checked server-side. `updateUser({ password })`
 * needs only a session, so without that check a borrowed browser tab could lock the real
 * owner out of their own workspace.
 */

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { checkNewPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password-rules";

/**
 * `forced` (R-391): shown on /change-password after an owner set a temporary password — the
 * "current" password is that temporary one, and `onChanged` moves the member on.
 */
export default function ChangePasswordCard({ forced = false, onChanged }: { forced?: boolean; onChanged?: () => void } = {}) {
  const [current, setCurrent] = React.useState("");
  const [next, setNext]       = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow]       = React.useState(false);

  /* Only once both new-password boxes have something in them — complaining about a mismatch
     while the second is still being typed is noise. */
  const problem = next || confirm ? checkNewPassword(next, confirm || undefined) : null;

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/settings/change-password", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; note?: string };
      /* The server's message names the actual problem — "that current password is not
         correct", "that is the password you already have". Replacing it with a generic
         failure would throw away the only part that tells you what to do. */
      if (!res.ok || json.error) throw new Error(json.error ?? "Could not change the password.");
      return json;
    },
    onSuccess: (r) => {
      setCurrent(""); setNext(""); setConfirm(""); setShow(false);
      toast.success(r.note ?? "Password changed.");
      onChanged?.();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const canSave = !save.isPending
    && current.length > 0 && next.length > 0 && confirm.length > 0
    && problem === null;

  return (
    <Card className="p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-ink">{forced ? "Choose your own password" : "Change your password"}</h3>
        <p className="mt-0.5 text-2xs leading-relaxed text-ink-3">
          {forced ? (
            <>Your owner set a temporary password for you. Pick your own to continue — after this, only you know it.</>
          ) : (
            <>Only yours. To reset a teammate&apos;s, use <b>Send reset link</b> or <b>Set temporary password</b> on the Team page.</>
          )}
        </p>
      </div>

      <div className="space-y-3">
        <FormField label={forced ? "Temporary password" : "Current password"} required htmlFor="cp-current">
          <Input
            id="cp-current"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </FormField>

        <FormField
          label="New password"
          required
          htmlFor="cp-new"
          hint={
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              className="inline-flex items-center gap-1 text-ink-3 hover:text-ink transition-colors cursor-pointer"
            >
              <Icon name={show ? "eye_off" : "eye"} size={12} />
              {show ? "Hide" : "Show"}
            </button>
          }
        >
          <Input
            id="cp-new"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            placeholder={"•".repeat(PASSWORD_MIN_LENGTH)}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </FormField>

        <FormField label="Type the new one again" required htmlFor="cp-confirm">
          <Input
            id="cp-confirm"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            placeholder={"•".repeat(PASSWORD_MIN_LENGTH)}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={problem?.message}
          />
        </FormField>

        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!canSave}
          onClick={() => save.mutate()}
        >
          Change password
        </Button>

        <p className="text-2xs leading-relaxed text-ink-3">
          Devices already signed in stay signed in — a password change does not sign them
          out. Sign out from each one if that is what you need.
        </p>
      </div>
    </Card>
  );
}
