"use client";

/**
 * R-391 — owner sets a temporary password for a teammate, from the Team page.
 *
 * The server decides everything that matters (owner re-read from the DB, same workspace, not
 * an owner, not yourself, rate limit, audit row): /api/team/members/[id]/temp-password. This
 * component only asks "make one, or type your own?" and shows the answer ONCE.
 *
 * The password lives in this component's state only while the dialog is open. It is never
 * written to the query cache, a toast, the URL or the console, and is wiped when the dialog
 * closes — closing it is the "I have copied it" step.
 */
import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { TEMP_PASSWORD_MIN_LENGTH, checkTypedTempPassword } from "@/lib/auth/temp-password";

export function SetTempPasswordButton({ memberId, name }: { memberId: string; name: string }) {
  const [open, setOpen] = React.useState(false);
  const [typed, setTyped] = React.useState("");
  const [result, setResult] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const close = (v: boolean) => {
    setOpen(v);
    if (!v) { setTyped(""); setResult(null); setCopied(false); }
  };

  const typedProblem = typed ? checkTypedTempPassword(typed) : null;

  const save = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/team/members/${encodeURIComponent(memberId)}/temp-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(typed ? { password: typed } : {}),
        cache: "no-store",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; password?: string; error?: string };
      if (!res.ok || !json.password) throw new Error(json.error ?? "Could not set the temporary password.");
      return json.password;
    },
    onSuccess: (pw) => { setTyped(""); setResult(pw); },
    onError: (e) => toast.error((e as Error).message),
  });

  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
    } catch {
      toast.error("Could not copy — select the password and copy it by hand.");
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} title={`Set a temporary password for ${name}`}>
        Set temporary password
      </Button>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent className="md:!max-w-md">
          <DialogHeader>
            <DialogTitle className="inline-flex items-center gap-2">
              <Icon name="lock" size={18} className="text-amber" /> Temporary password for {name}
            </DialogTitle>
            <DialogDescription>
              They sign in with it once, then must choose their own. This is recorded in the activity log.
            </DialogDescription>
          </DialogHeader>

          {result ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Input readOnly value={result} aria-label="Temporary password" className="font-mono" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={copy} aria-label="Copy temporary password">
                  <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-2xs leading-relaxed text-ink-3">
                Shown only now — it is not saved anywhere. Give it to {name} directly, not in a group chat.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              <label htmlFor="tmp-pw" className="block text-xs font-medium text-ink-2">
                Your own (optional)
              </label>
              <Input
                id="tmp-pw"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={`Leave empty for a random one · min ${TEMP_PASSWORD_MIN_LENGTH} characters`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                error={typedProblem?.message}
              />
            </div>
          )}

          <DialogFooter>
            {result ? (
              <Button type="button" variant="primary" onClick={() => close(false)}>Done</Button>
            ) : (
              <>
                <Button type="button" variant="ghost" onClick={() => close(false)} disabled={save.isPending}>Cancel</Button>
                <Button
                  type="button"
                  variant="primary"
                  loading={save.isPending}
                  disabled={save.isPending || typedProblem !== null}
                  onClick={() => save.mutate()}
                >
                  {typed ? "Set this password" : "Make one"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
