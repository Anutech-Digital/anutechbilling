"use client";

/**
 * /portal/login — customer sign-in via 6-digit EMAIL OTP CODE (not a magic link).
 *
 * Why a code, not a link:
 *   Gmail / Google Workspace mail scanners pre-fetch links in email for safety
 *   checks. A Supabase magic link's token is single-use, so the scanner's GET to
 *   /verify burns it before the customer ever clicks — the real click then hits
 *   "link invalid or expired" (seen in prod: /verify 303 then 403 "One-time token
 *   not found" from a Google IP). Most of our customers are on Gmail/Workspace,
 *   so links broke login broadly. A 6-digit code has no URL for a scanner to
 *   consume, and works across devices (no PKCE code_verifier cookie needed).
 *
 * Flow:
 *   1. Email step  — verify the email belongs to a customer (portal_customer_exists),
 *                    then signInWithOtp WITHOUT emailRedirectTo → Supabase emails a code.
 *   2. Code step   — verifyOtp({type:'email'}) sets the session client-side, then
 *                    portal_ensure_customer_link() (service-role RPC) links the
 *                    auth user → their customer row. Redirect to /portal/dashboard.
 */
import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { FormField } from "@/components/ui/label";
import { createClient } from "@/lib/supabase/client";

const emailSchema = z.object({ email: z.string().email("Valid email required") });
type EmailForm = z.infer<typeof emailSchema>;

// Supabase's email-OTP length is project-configurable (6–10). Accept that
// range instead of hardcoding 6, so the box matches whatever length the
// dashboard is set to (this project currently sends 8).
const codeSchema = z.object({
  code: z.string().trim().regex(/^\d{6,10}$/, "Enter the code from your email"),
});
type CodeForm = z.infer<typeof codeSchema>;

function PortalLoginInner() {
  const params = useSearchParams();
  const error = params.get("error");

  const [step, setStep] = React.useState<"email" | "code">("email");
  const [email, setEmail] = React.useState("");
  const [preNoCustomer, setPreNoCustomer] = React.useState(false);
  const [resending, setResending] = React.useState(false);

  const emailForm = useForm<EmailForm>({ resolver: zodResolver(emailSchema) });
  const codeForm = useForm<CodeForm>({ resolver: zodResolver(codeSchema) });

  /** Check the email is a customer, then send a 6-digit code. Returns success. */
  async function sendCode(addr: string): Promise<boolean> {
    const supabase = createClient();
    // Up-front check: only send to a real customer. Saves a non-customer the
    // wasted email + avoids creating an orphan auth.users row (shouldCreateUser).
    const { data: exists, error: chkErr } = await supabase.rpc("portal_customer_exists", {
      p_email: addr,
    });
    if (chkErr) {
      toast.error(chkErr.message);
      return false;
    }
    if (!exists) {
      setPreNoCustomer(true);
      return false;
    }
    // No emailRedirectTo → Supabase emails a 6-digit code instead of a link.
    const { error: otpErr } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { shouldCreateUser: true },
    });
    if (otpErr) {
      toast.error(otpErr.message);
      return false;
    }
    return true;
  }

  async function onEmailSubmit({ email: addr }: EmailForm) {
    setPreNoCustomer(false);
    const ok = await sendCode(addr);
    if (ok) {
      setEmail(addr);
      setStep("code");
      codeForm.reset();
    }
  }

  async function onCodeSubmit({ code }: CodeForm) {
    const supabase = createClient();
    const { error: vErr } = await supabase.auth.verifyOtp({
      email,
      token: code.trim(),
      type: "email",
    });
    if (vErr) {
      toast.error("That code is wrong or expired. Check the email, or resend a new code.");
      return;
    }
    // Session is set. Link auth user → customer (idempotent, service-role RPC).
    const { data: linkResult, error: linkErr } = await supabase.rpc(
      "portal_ensure_customer_link",
    );
    if (linkErr) {
      toast.error(linkErr.message);
      return;
    }
    if (linkResult === "no_customer" || linkResult === "no_auth") {
      await supabase.auth.signOut();
      setStep("email");
      setPreNoCustomer(true);
      return;
    }
    window.location.href = "/portal/dashboard";
  }

  async function resend() {
    setResending(true);
    try {
      const ok = await sendCode(email);
      if (ok) toast.success("New code sent.");
    } finally {
      setResending(false);
    }
  }

  function useDifferentEmail() {
    setStep("email");
    setPreNoCustomer(false);
    codeForm.reset();
  }

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4 py-12">
      <Card className="max-w-md w-full p-8">
        <div className="text-center mb-6">
          <h1 className="font-serif text-3xl mb-2">Customer sign-in</h1>
          <p className="text-sm text-ink-3">Access your orders, invoices and subscription</p>
        </div>

        {(error === "no_customer" || preNoCustomer) && (
          <div className="mb-4 p-3 bg-rose-soft border border-rose/30 rounded-md text-xs text-rose">
            We couldn&apos;t find a customer account with that email. Please use the
            same email address you provided when ordering. If you&apos;re sure it&apos;s
            right, contact the business you purchased from.
          </div>
        )}
        {error === "auth_failed" && step === "email" && (
          <div className="mb-4 p-3 bg-rose-soft border border-rose/30 rounded-md text-xs text-rose">
            Your sign-in session expired. Please request a new code below.
          </div>
        )}

        {step === "email" ? (
          <form onSubmit={emailForm.handleSubmit(onEmailSubmit)} className="space-y-4">
            <FormField label="Your work email" required htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="email"
                placeholder="e.g. you@yourcompany.in"
                error={emailForm.formState.errors.email?.message}
                {...emailForm.register("email")}
              />
            </FormField>

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={emailForm.formState.isSubmitting}
            >
              <Icon name="mail" size={14} className="mr-1.5" />
              Email me a sign-in code
            </Button>

            <p className="text-[11px] text-ink-3 text-center leading-relaxed">
              No passwords. We email you a one-time code that signs you in.
            </p>
          </form>
        ) : (
          <form onSubmit={codeForm.handleSubmit(onCodeSubmit)} className="space-y-4">
            <p className="text-sm text-ink-3 text-center leading-relaxed">
              We&apos;ve emailed a sign-in code to <b className="text-ink">{email}</b>.
              Enter it below. Check spam if you don&apos;t see it.
            </p>

            <FormField label="Sign-in code" required htmlFor="code">
              <Input
                id="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={10}
                placeholder="12345678"
                className="text-center text-lg tracking-[0.3em] font-mono"
                error={codeForm.formState.errors.code?.message}
                {...codeForm.register("code")}
              />
            </FormField>

            <Button
              type="submit"
              variant="primary"
              className="w-full justify-center"
              loading={codeForm.formState.isSubmitting}
            >
              <Icon name="lock" size={14} className="mr-1.5" />
              Verify &amp; sign in
            </Button>

            <div className="flex items-center justify-between text-[11px] text-ink-3">
              <button
                type="button"
                onClick={resend}
                disabled={resending}
                className="text-amber-ink underline disabled:opacity-50"
              >
                {resending ? "Sending…" : "Resend code"}
              </button>
              <button
                type="button"
                onClick={useDifferentEmail}
                className="text-amber-ink underline"
              >
                Use a different email
              </button>
            </div>
          </form>
        )}

        <div className="mt-6 pt-5 border-t border-hairline text-center text-xs text-ink-3">
          Need help? Contact the business you purchased from.
        </div>
      </Card>
    </div>
  );
}

export default function PortalLoginPage() {
  return (
    <React.Suspense fallback={null}>
      <PortalLoginInner />
    </React.Suspense>
  );
}
