"use client";

/**
 * /reset-password — set a new password, landed on from the recovery email.
 *
 * The recovery link goes to `/callback?next=/reset-password`, so by the time this page renders
 * the code has already been traded for a session and the cookies are written. That means
 * `updateUser({ password })` is all this page has to do — and it also means the page is
 * useless without that session, which is the case worth handling well: a link that has
 * expired, been used once already, or been opened by hand.
 *
 * See AGENTS.md L15 for why none of this existed until 22 Aug 2026.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { checkNewPassword, PASSWORD_MIN_LENGTH } from "@/lib/auth/password-rules";

type SessionState = "checking" | "ready" | "no-session";

export default function ResetPasswordPage() {
  const configured = isSupabaseConfigured();
  const [state, setState]     = React.useState<SessionState>(configured ? "checking" : "no-session");
  const [email, setEmail]     = React.useState<string | null>(null);
  const [password, setPass]   = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [show, setShow]       = React.useState(false);
  const [busy, setBusy]       = React.useState(false);
  const [done, setDone]       = React.useState(false);

  /* Asked once, on mount. The session was established by /callback before this page loaded,
     so there is nothing to wait for beyond reading it. */
  React.useEffect(() => {
    if (!configured) return;
    let alive = true;
    void (async () => {
      const { data } = await createClient().auth.getUser();
      if (!alive) return;
      if (data?.user) {
        setEmail(data.user.email ?? null);
        setState("ready");
      } else {
        setState("no-session");
      }
    })();
    return () => { alive = false; };
  }, [configured]);

  /* Only shown once the operator has typed something in both boxes — complaining about a
     mismatch while they are still typing the second one is noise. */
  const problem = password || confirm ? checkNewPassword(password, confirm || undefined) : null;
  const canSubmit = !busy && password.length > 0 && confirm.length > 0 && problem === null;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const blocking = checkNewPassword(password, confirm);
    if (blocking) {
      const { message: problem } = blocking;   // our own copy from checkNewPassword, not a raw error
      toast.error(problem, { description: "Fix the password above and press Save again." });
      return;
    }

    setBusy(true);
    const { error } = await createClient().auth.updateUser({ password });
    setBusy(false);

    if (error) {
      /* Surfaced as-is via toastError (only raw plumbing is translated). Supabase says things like "New password should be different from the
         old password", which is more useful than anything paraphrased. */
      toastError(error, { fallback: "Could not change the password.", description: "Your old password still works. Try again — if the reset link has expired, ask for a new one from the sign-in page." });
      return;
    }
    setDone(true);
  }

  if (state === "checking") {
    return (
      <Card>
        <p className="text-center text-sm text-ink-3 py-6">Checking your link…</p>
      </Card>
    );
  }

  if (state === "no-session") {
    /* §24 — what happened, why, and the way out, with the link to it. */
    return (
      <Card>
        <div className="text-center mb-5">
          <Icon name="alert" size={28} className="text-amber mx-auto mb-3" />
          <h1 className="font-serif text-2xl mb-2">This link can&apos;t be used</h1>
          <p className="text-sm text-ink-3">
            Reset links work once and expire after an hour. This one has been used already, has
            expired, or was opened without the email.
          </p>
        </div>
        <Link href="/forgot-password" className="block">
          <Button variant="primary" className="w-full justify-center">Send a new link</Button>
        </Link>
        <p className="mt-4 text-center text-xs text-ink-3">
          <Link href="/login" className="text-amber font-medium hover:underline">Back to sign in</Link>
        </p>
      </Card>
    );
  }

  if (done) {
    return (
      <Card>
        <div className="text-center mb-5">
          <Icon name="check" size={28} className="text-emerald mx-auto mb-3" />
          <h1 className="font-serif text-2xl mb-2">Password changed</h1>
          <p className="text-sm text-ink-3">
            You&apos;re signed in on this device. Save the new password somewhere before you
            close this tab.
          </p>
        </div>
        <Link href="/dashboard" className="block">
          <Button variant="primary" className="w-full justify-center">Go to dashboard</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Set a new password</h1>
        <p className="text-sm text-ink-3">
          {email ? <>For <span className="font-medium text-ink">{email}</span></> : "Choose something only you would think of."}
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <FormField label="New password" required htmlFor="new-password">
          <div className="relative">
            <Input
              id="new-password"
              type={show ? "text" : "password"}
              autoComplete="new-password"
              placeholder={"•".repeat(PASSWORD_MIN_LENGTH)}
              value={password}
              onChange={(e) => setPass(e.target.value)}
              className="pr-10"
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShow((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors"
              aria-label={show ? "Hide password" : "Show password"}
            >
              <Icon name={show ? "eye_off" : "eye"} size={16} />
            </button>
          </div>
        </FormField>

        <FormField label="Type it again" required htmlFor="confirm-password">
          <Input
            id="confirm-password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            placeholder={"•".repeat(PASSWORD_MIN_LENGTH)}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            error={problem?.message}
          />
        </FormField>

        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={busy}
          disabled={!canSubmit}
        >
          Save new password
        </Button>
      </form>
    </Card>
  );
}
