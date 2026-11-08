"use client";

/**
 * Send a teammate a password-reset link, from the Team page.
 *
 * ─── WHY THIS IS SAFE, AND WHY IT IS ONLY CONVENIENCE ───────────────────────
 * `resetPasswordForEmail` is a PUBLIC Supabase call — anyone can trigger one for any
 * address, which is why the confirmation never says whether an account exists. So this
 * button grants an owner nothing they did not already have. What it removes is the trip to
 * the Supabase dashboard, which the app never mentioned to anybody.
 *
 * The owner never learns or sets the password. The link goes to the teammate's own mailbox
 * and only they can complete it. That distinction is why this is a "send link" button and
 * not a "set password" field: an owner who can type a colleague's password can also read
 * their private vault by signing in as them.
 *
 * Asked for on 22 Aug 2026 while trying to get sales@anutech.in signed in — there was no way
 * to reset a teammate's password from anywhere in the app.
 */

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { authRedirectUrl } from "@/lib/app-url";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export function SendResetLinkButton({ email }: { email: string | null }) {
  const [sentAt, setSentAt] = React.useState<number | null>(null);

  const send = useMutation({
    mutationFn: async () => {
      if (!email) throw new Error("This teammate has no email address on their account.");
      const { error } = await createClient().auth.resetPasswordForEmail(email, {
        /* Through /callback, the same path the login flow uses: it exchanges the code for a
           session server-side and, for an existing user, redirects straight to ?next=. One
           code-exchange path in the app instead of two that can drift. */
        // R-2600: an allowlisted host (same rule as the server), never just the browser's host.
        redirectTo: authRedirectUrl(`/callback?next=${encodeURIComponent("/reset-password")}`),
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      setSentAt(Date.now());
      toast.success(`Reset link sent to ${email}. Only they can open it.`);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  /* Sent-state is per-button and deliberately not persisted. It stops a double-tap from
     firing two links a second apart; it is not a claim about whether the mail arrived, and
     a reload showing the button again is the honest default. */
  const justSent = sentAt !== null && Date.now() - sentAt < 60_000;

  if (!email) {
    return <span className="text-2xs text-ink-3">no email</span>;
  }

  return (
    <Button
      variant="outline"
      size="sm"
      loading={send.isPending}
      disabled={justSent || send.isPending}
      onClick={() => send.mutate()}
      title={`Email a password-reset link to ${email}`}
    >
      {justSent ? "Link sent" : "Send reset link"}
    </Button>
  );
}
