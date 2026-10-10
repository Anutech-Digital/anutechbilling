"use client";

import * as React from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { createClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { isValidGstin } from "@/lib/utils";
import { useTurnstile } from "@/components/shared/turnstile";
import { GoogleAuthButton } from "@/components/features/auth/google-button";
import { ResendVerification } from "@/components/features/auth/resend-verification";
import { PRICING_LINE } from "@/site/lib/data/reselleros-home";

const schema = z.object({
  companyName: z.string().min(2, "Company name is required"),
  gstin: z.string().optional().refine(
    (v) => !v || isValidGstin(v),
    "Invalid GSTIN format"
  ),
  fullName: z.string().min(2, "Your name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters"),
});
type FormData = z.infer<typeof schema>;

export default function SignupPage() {
  const [showPassword, setShowPassword] = React.useState(false);
  const [gstLoading, setGstLoading] = React.useState(false);
  /** Set when the signup matched an existing workspace's verified domain. */
  const [pending, setPending] = React.useState<string | null>(null);
  /** R-048: the address a confirmation link went to; the form is replaced by "check your inbox". */
  const [verifyEmail, setVerifyEmail] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const configured = isSupabaseConfigured();
  /* R-020: bot check on signup (renders nothing until the Turnstile site key exists). */
  const ts = useTurnstile();

  const handleGstinBlur = async (e: React.FocusEvent<HTMLInputElement>) => {
    const val = e.target.value.trim().toUpperCase();
    if (val && isValidGstin(val)) {
      setGstLoading(true);
      try {
        const res = await fetch(`/api/gst/verify?gstin=${encodeURIComponent(val)}`);
        const data = await res.json();
        if (res.ok && (data.tradeName || data.legalName)) {
          const name = data.tradeName || data.legalName;
          if (!getValues("companyName")) {
            setValue("companyName", name);
            toast.success(`✨ Verified GSTIN: Auto-filled "${name}"`);
          }
        }
      } catch {
        // Silent catch for invalid/mock failures
      } finally {
        setGstLoading(false);
      }
    }
  };

  async function onSubmit(values: FormData) {
    // Server-side signup: uses service role key to create the auth user
    // (unconfirmed unless invited — R-048) + tenant + user record atomically.
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ts.headers },
      body: JSON.stringify({
        email:       values.email,
        password:    values.password,
        fullName:    values.fullName,
        companyName: values.companyName,
        gstin:       values.gstin ?? null,
        // Invite-email ke link se aata hai (/signup?invite=…). Iske bina
        // pending-invite wale email par password-signup 409 deta hai —
        // by design (mailbox ka saboot token hi hai).
        inviteToken: new URLSearchParams(window.location.search).get("invite") ?? undefined,
      }),
    });

    const json = await res.json() as {
      success?: boolean;
      error?: string;
      status?: "joined" | "pending_approval" | "created";
      tenantName?: string;
      needsVerification?: boolean;
    };

    if (!res.ok || json.error) {
      ts.reset();
      toast.error(json.error ?? "Signup failed. Please try again.");
      return;
    }

    // Their email domain belongs to a workspace that already exists. They have
    // NO access yet and signing them in would drop them into an app with no
    // tenant — the stranded state. Show the wait instead; it is not a failure.
    if (json.status === "pending_approval") {
      setPending(json.tenantName ?? "your company's workspace");
      if (json.needsVerification) setVerifyEmail(values.email);
      return;
    }

    /* R-048: a password signup must confirm its email before it can sign in — signing in
       now would only fail with "Email not confirmed". An invited signup is already confirmed. */
    if (json.needsVerification) {
      setVerifyEmail(values.email);
      return;
    }

    // Now sign in with the newly created credentials to get a session
    const supabase = createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email:    values.email,
      password: values.password,
    });

    if (signInError) {
      toast.success("Account created! Please sign in.");
      window.location.href = "/login";
      return;
    }

    toast.success("Welcome to ResellerOS! 🎉");
    // Hard navigation — guarantees fresh auth cookies reach the next request
    // (see comment in login/page.tsx for the Firebase Hosting proxy reason).
    window.location.href = "/dashboard";
  }

  // Waiting on an owner. Deliberately a full replacement of the form rather than
  // a toast: the single most useful thing here is that nothing is broken and no
  // second account is needed, and a toast that disappears cannot say that.
  if (pending) {
    return (
      <Card>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
            <Icon name="clock" size={22} className="text-amber-ink" />
          </div>
          <h1 className="font-serif text-2xl mb-2">Almost there</h1>
          <p className="text-sm text-ink-2 leading-relaxed">
            Your company already uses ResellerOS, so we did not make a new workspace.
            {verifyEmail
              ? " Confirm your email and we'll ask the owner to add you."
              : " We've asked the owner to add you."}
          </p>
          <div className="mt-4 rounded-md border border-hairline bg-paper-2 p-3 text-left text-xs text-ink-3 leading-relaxed">
            We did <b>not</b> create a separate company for you — that is on purpose. Joining the
            existing workspace is what lets you see your team&apos;s customers, quotes and invoices.
          </div>
          <p className="mt-4 text-xs text-ink-3">
            {verifyEmail
              ? <>Two steps before you can sign in: open the link we sent to <b>{verifyEmail}</b>, then the owner approves you.</>
              : <>You&apos;ll be able to sign in as soon as they approve. Nothing else is needed from you.</>}
          </p>
          <Link
            href="/login"
            className="mt-5 inline-block text-sm text-amber font-medium hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </Card>
    );
  }

  if (verifyEmail) {
    return (
      <Card>
        <div className="text-center mb-5">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
            <Icon name="mail" size={22} className="text-amber-ink" />
          </div>
          <h1 className="font-serif text-2xl mb-2">Check your inbox</h1>
          <p className="text-sm text-ink-2 leading-relaxed">
            We sent a confirmation link to <b className="text-ink">{verifyEmail}</b>. Open it to finish
            creating your account — then sign in. The link works for 48 hours.
          </p>
        </div>
        <details className="text-sm">
          <summary className="cursor-pointer text-ink-3 text-center">Didn&apos;t get it?</summary>
          <div className="mt-3"><ResendVerification initialEmail={verifyEmail} /></div>
        </details>
        <Link href="/login" className="mt-5 block text-center text-sm text-amber font-medium hover:underline">Back to sign in</Link>
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Create your ResellerOS workspace</h1>
        {/* R-463: one pricing line for the whole product site — site/lib/data/reselleros-home.ts */}
        <p className="text-sm text-ink-3">{PRICING_LINE}</p>
      </div>

      {!configured && (
        <div className="mb-4 p-3 bg-amber-soft border border-amber rounded-md text-xs">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
            <div className="text-amber-ink">
              <b>Supabase not configured.</b> Open <span className="font-mono">SETUP.md</span> to configure. Sign-up won't work until then.
            </div>
          </div>
        </div>
      )}

      {/* R-102: same OAuth path as login. A new Google user has no company yet, so the
          callback sends them to /welcome to create one — the fields below are for the
          email route only. */}
      <GoogleAuthButton label="Sign up with Google" nextPath="/dashboard" disabled={!configured} />

      <div className="my-5 flex items-center gap-3 text-xs text-ink-3">
        <div className="flex-1 h-px bg-hairline" />
        <span>or sign up with email</span>
        <div className="flex-1 h-px bg-hairline" />
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormField label="Company name" required htmlFor="companyName">
          {/* Placeholder SIGN UP karne wale ki apni company ke liye hai, hamari nahi.
              Isliye yahan "ANUTECH DIGITAL" likhna bhi galat hota — naya user ANUTECH nahi
              hai. Ek aam-sa naam hi theek hai. */}
          <Input
            id="companyName"
            placeholder="e.g. Sharma Cloud Solutions Pvt Ltd"
            error={errors.companyName?.message}
            disabled={!configured}
            {...register("companyName")}
          />
        </FormField>

        <FormField label="GSTIN (optional)" htmlFor="gstin">
          <Input
            id="gstin"
            placeholder="e.g. 27AABCE9876D1Z3"
            className="font-mono uppercase"
            helper={gstLoading ? "Verifying GSTIN details..." : "Auto-fills company name when typed"}
            error={errors.gstin?.message}
            disabled={!configured || gstLoading}
            {...register("gstin", { onBlur: handleGstinBlur })}
          />
        </FormField>

        <div className="h-px bg-hairline my-2" />

        <FormField label="Your name" required htmlFor="fullName">
          <Input
            id="fullName"
            autoComplete="name"
            placeholder="e.g. Pardeep A"
            error={errors.fullName?.message}
            disabled={!configured}
            {...register("fullName")}
          />
        </FormField>

        <FormField label="Work email" required htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="e.g. you@yourcompany.in"
            error={errors.email?.message}
            disabled={!configured}
            {...register("email")}
          />
        </FormField>

        <FormField label="Password" required htmlFor="password">
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              placeholder="At least 8 characters"
              error={errors.password?.message}
              disabled={!configured}
              className="pr-10"
              {...register("password")}
            />
            <button
              type="button"
              tabIndex={-1}
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink transition-colors"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              <Icon name={showPassword ? "eye_off" : "eye"} size={16} />
            </button>
          </div>
        </FormField>

        {ts.widget}
        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={isSubmitting}
          disabled={!configured}
        >
          Create account
        </Button>

        <p className="text-2xs text-ink-3 text-center leading-relaxed">
          By signing up you agree to our{" "}
          {/* Were href="#" until 1 Oct 2026 (R-047). ResellerOS's own documents: a reseller
              signing up agrees to the software's terms, not the Anutech shop's. A new tab, so
              the half-filled form is kept. */}
          <a href="/terms" target="_blank" rel="noopener" className="underline">Terms</a> and{" "}
          <a href="/privacy" target="_blank" rel="noopener" className="underline">Privacy Policy</a>. DPDP Act 2023 compliant.
        </p>
      </form>

      <p className="mt-5 text-center text-xs text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="text-amber font-medium hover:underline">
          Sign in
        </Link>
      </p>
    </Card>
  );
}
