/**
 * Set / change / remove the vault PIN.
 *
 * Every path here goes through /api/vault/personal/pin, so the hash never reaches the
 * browser and the attempt counter is not a variable the person being locked out owns.
 * Changing or removing a PIN requires the current one — otherwise anybody at an unlocked
 * desk can replace the lock and keep the door open.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { usePinStatus, useSetPin, useRemovePin } from "@/lib/queries/personal-vault";
import { PIN_LENGTH, validateNewPin } from "@/lib/vault/personal/pin-rules";

function PinInput({
  value, onChange, label, disabled, id,
}: { value: string; onChange: (v: string) => void; label: string; disabled?: boolean; id: string }) {
  return (
    <div>
      <label htmlFor={id} className="block text-2xs uppercase tracking-wide text-ink-4 mb-1">{label}</label>
      <input
        id={id}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={PIN_LENGTH}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
        className="w-32 text-center text-xl tracking-[0.4em] font-mono py-2 rounded-lg border border-hairline bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
      />
    </div>
  );
}

export function VaultPinSettings() {
  const { data: status } = usePinStatus();
  const setPin = useSetPin();
  const removePin = useRemovePin();

  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");

  const configured = status?.configured ?? false;

  const reset = () => { setCurrent(""); setNext(""); setOpen(false); };

  const handleSave = async () => {
    // Checked here as well as on the server so the reason arrives instantly and in the
    // same words. The server check is the one that counts.
    const check = validateNewPin(next);
    if (!check.ok) { toast.error(check.error as string, { description: "Choose a different PIN and save again." }); return; }
    try {
      await setPin.mutateAsync({ pin: next, currentPin: configured ? current : undefined });
      toast.success(configured ? "PIN changed." : "PIN set.");
      reset();
    } catch (e) {
      toastError(e, { fallback: "Could not set the PIN.", description: "Nothing was changed. Check the current PIN and try again." });
    }
  };

  const handleRemove = async () => {
    try {
      await removePin.mutateAsync(current);
      toast.success("PIN removed. The vault will now open without a PIN.");
      reset();
    } catch (e) {
      toastError(e, { fallback: "Could not remove the PIN.", description: "The vault is still PIN-locked. Check the current PIN and try again." });
    }
  };

  const busy = setPin.isPending || removePin.isPending;

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-ink flex items-center gap-1.5">
            <Icon name="lock" size={14} className="text-ink-3" />
            Screen lock (PIN)
          </h2>
          <p className="mt-1 text-xs text-ink-3">
            {configured
              ? `A ${PIN_LENGTH}-digit PIN is set. It will be asked when you open the vault.`
              : "No PIN set. You can add one if you like — it is optional."}
          </p>
          <p className="mt-2 text-2xs text-ink-4 leading-relaxed">
            This PIN is <b>only a screen lock</b>; it does not encrypt data. It helps when
            your laptop is left open. The real protection for your rows is the database rule, which
            gives them only to your login — with or without a PIN.
          </p>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} className="flex-shrink-0">
            {configured ? "Change PIN" : "Set PIN"}
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-4 pt-4 border-t border-hairline space-y-3">
          <div className="flex gap-4 flex-wrap">
            {configured && (
              <PinInput id="vault-pin-current" label="Current PIN" value={current} onChange={setCurrent} disabled={busy} />
            )}
            <PinInput id="vault-pin-new" label={configured ? "New PIN" : "PIN"} value={next} onChange={setNext} disabled={busy} />
          </div>

          <p className="text-2xs text-ink-4">
            PINs like 1234, 0000 or 1212 are not allowed — anyone can guess them on the first try.
          </p>

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="primary"
              size="sm"
              onClick={handleSave}
              disabled={busy || next.length !== PIN_LENGTH || (configured && current.length !== PIN_LENGTH)}
            >
              {configured ? "Change PIN" : "Set PIN"}
            </Button>
            <Button size="sm" variant="ghost" onClick={reset} disabled={busy}>Cancel</Button>
            {configured && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleRemove}
                disabled={busy || current.length !== PIN_LENGTH}
                className="text-rose ml-auto"
              >
                Remove PIN
              </Button>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
