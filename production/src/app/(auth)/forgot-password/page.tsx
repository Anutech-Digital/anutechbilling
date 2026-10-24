"use client";

/**
 * /forgot-password — ask Supabase to email a recovery link.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * It did not, until 22 Aug 2026. `(auth)/` held login, signup, callback and welcome and
 * nothing else, so there was no way to recover a password from inside the app at all — while
 * Settings → Reset data requires the operator's password and re-checks it with
 * signInWithPassword. The owner of the business hit exactly that wall: his account carries
 * `providers = 'email, google'`, so he signs in with Google and had never needed the password
 * that exists on his row. The only way through was the Supabase dashboard, which the app
 * never mentions. AGENTS.md L15.
 *
 * The recovery link comes back through `/callback`, not through a bespoke exchange here: that
 * route already trades the code for a session and writes the cookies server-side, and for an
 * existing user its first branch redirects straight to `?next=` (line ~104). Reusing it means
 * one code-exchange path in the app instead of two that can drift.
 */

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { describeAuthError } from "@/lib/errors/auth-error";

const schema = z.object({ email: z.string().email("Enter a valid email") });
type FormData = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const configured = isSupabaseConfigured();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  async function onSubmit(values: FormData) {
    const supabase = createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(values.email, {
      redirectTo: `${window.location.origin}/callback?next=${encodeURIComponent("/reset-password")}`,
    });

    /* Supabase does not say whether the address exists, and neither do we. Telling an
       anonymous visitor "no account with that email" turns this box into a way to find out
       who banks with this reseller. So the screen says the same thing either way. */
    if (error) {
      // R-1137: §24 copy, never the raw auth/DB text.
      const d = describeAuthError(error, "reset");
      toast.error(d.message, {
        description: d.description,
        action: { label: "Try again", onClick: () => { void handleSubmit(onSubmit)(); } },
      });
      return;
    }
    setSentTo(values.email);
  }

  if (sentTo) {
    return (
      <Card>
        <div className="text-center mb-5">
          <Icon name="mail" size={28} className="text-amber mx-auto mb-3" />
          <h1 className="font-serif text-2xl mb-2">Check your email</h1>
          <p className="text-sm text-ink-3">
            If an account exists for <span className="font-medium text-ink">{sentTo}</span>, a
            reset link is on its way.
          </p>
        </div>

        <div className="p-3 bg-amber-soft border border-amber/40 rounded-md text-xs text-amber-ink space-y-1.5">
          <p><b>The link works once, and expires in an hour.</b></p>
          <p>
            Nothing arrived? Check spam, and make sure the address is the one you sign in with.
            A Google sign-in and an email sign-in can be the same account.
          </p>
        </div>

        <p className="mt-5 text-center text-xs text-ink-3">
          <Link href="/login" className="text-amber font-medium hover:underline">
            Back to sign in
          </Link>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Forgot your password?</h1>
        <p className="text-sm text-ink-3">
          Enter your email and we&apos;ll send you a link to set a new one.
        </p>
      </div>

      {!configured && (
        <div className="mb-4 p-3 bg-amber-soft border border-amber rounded-md text-xs">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
            <div className="text-amber-ink">
              <b>Supabase not configured.</b> Recovery emails cannot be sent until it is.
            </div>
          </div>
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormField label="Email" required htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="e.g. you@example.com"
            error={errors.email?.message}
            disabled={!configured}
            {...register("email")}
          />
        </FormField>

        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={isSubmitting}
          disabled={!configured}
        >
          Send reset link
        </Button>
      </form>

      <p className="mt-5 text-center text-xs text-ink-3">
        Remembered it?{" "}
        <Link href="/login" className="text-amber font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
