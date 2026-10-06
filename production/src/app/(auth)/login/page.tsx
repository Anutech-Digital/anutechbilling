"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { appPathOr } from "@/lib/safe-path";
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
import { DevDemoPanel } from "@/components/shared/dev-demo-panel";
import { GoogleAuthButton } from "@/components/features/auth/google-button";
import { ResendVerification } from "@/components/features/auth/resend-verification";
import { MfaCodeForm } from "@/components/features/auth/mfa-code-form";
import { LocalTestLogin } from "./local-test-login";

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(6, "At least 6 characters"),
});
type FormData = z.infer<typeof schema>;

// Demo accounts shown only in development. Kept in sync with the actual
// tenants in Supabase — when a tenant is added/removed or its password
// rotated, update this list. Hidden in production builds.
/**
 * DMS's own sign-in, derived from the portal URL rather than a second env var
 * so the two can never point at different deployments.
 *
 * `new URL("/login", …)` replaces the whole path, so the configured
 * ".../dashboard" becomes ".../login" — the sign-in screen, not a page that
 * bounces there. Empty when unconfigured, which hides the row: a hard-coded
 * fallback would send staff to a host that may not be this deployment's engine.
 */
const DMS_LOGIN_URL = (() => {
  const base = (process.env.NEXT_PUBLIC_DMS_PORTAL_URL ?? "").trim();
  if (!base) return "";
  try {
    return new URL("/login", base).toString();
  } catch {
    return "";
  }
})();

/* 1 Oct 2026 (R-059): this list used to carry two REAL owner passwords in source — and so in
   GitHub and in every dev bundle. Now it holds no password at all, and no email in code either:
   a local developer lists their own test logins in .env.local as
   NEXT_PUBLIC_DEV_DEMO_LOGINS="Label|email,Label|email" and types the password themselves.
   Unset (the default, and always in production) → the panel shows nothing. */
const DEMO_USERS: Array<{ label: string; email: string }> = String(process.env.NEXT_PUBLIC_DEV_DEMO_LOGINS ?? "")
  .split(",")
  .map((pair) => pair.split("|").map((x) => x.trim()))
  .filter(([label, email]) => !!label && !!email && email.includes("@"))
  .map(([label, email]) => ({ label, email }));

function LoginPageInner() {
  const searchParams = useSearchParams();
  /* VALIDATED, not trusted. This value is assigned to window.location.href below, so
     an unchecked ?next=https://evil.com walked the operator off-site the instant they
     signed in — on the one page where they have just typed a password. It also travels
     into the OAuth redirectTo, so the same string reaches the provider. */
  const nextPath = appPathOr(searchParams.get("next"));
  const [showPassword, setShowPassword] = React.useState(false);
  /** R-048: GoTrue refuses an unconfirmed email; say why and offer a fresh link. */
  const [unconfirmed, setUnconfirmed] = React.useState<string | null>(null);
  /** R-048 part 2: password accepted, authenticator code still needed. */
  const [mfaStep, setMfaStep] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema), defaultValues: { email: searchParams.get("email") ?? "" } as Partial<FormData> });

  // Quick-fill from the dev panel — email only; the password is never in code (R-059)
  const fillDemo = (email: string) => {
    setValue("email", email, { shouldValidate: true });
  };

  const showDemoHint = process.env.NODE_ENV !== "production";

  const configured = isSupabaseConfigured();

  async function onSubmit(values: FormData) {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      if (/not confirmed/i.test(error.message)) {
        setUnconfirmed(values.email);
        return;
      }
      toast.error(error.message);
      return;
    }
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      setMfaStep(true);
      return;
    }
    toast.success("Welcome back");
    // Hard navigation — guarantees the fresh auth cookies are sent on the
    // next request (router.push uses soft nav which can race the cookie
    // write when the app is behind a Firebase Hosting → Cloud Run proxy).
    window.location.href = nextPath;
  }

  if (mfaStep) {
    return (
      <Card>
        <div className="text-center mb-6">
          <h1 className="font-serif text-3xl mb-2">Two-step sign-in</h1>
          <p className="text-sm text-ink-3">Enter the 6-digit code from your authenticator app.</p>
        </div>
        <MfaCodeForm onDone={() => { window.location.href = nextPath; }} />
      </Card>
    );
  }

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Welcome back</h1>
        <p className="text-sm text-ink-3">Sign in to your reseller workspace</p>
      </div>

      {!configured && (
        <div className="mb-4 p-3 bg-amber-soft border border-amber rounded-md text-xs">
          <div className="flex items-start gap-2">
            <Icon name="alert" size={14} className="text-amber-ink flex-shrink-0 mt-0.5" />
            <div className="text-amber-ink">
              <b>Supabase not configured.</b> Open <span className="font-mono">SETUP.md</span> to create a project and paste env vars. Sign-in won't work until then.
            </div>
          </div>
        </div>
      )}

      {/* R-281: localhost-only sign-in as a seeded test role — no password in this page. */}
      {configured && <LocalTestLogin nextPath={nextPath} />}

      {/* Dev-only demo credentials — hidden in production builds */}
      {showDemoHint && configured && DEMO_USERS.length > 0 && (
        <DevDemoPanel
          title="demo accounts"
          entries={DEMO_USERS.map((u) => ({
            label: u.label,
            mono: (
              <>
                {u.email}
              </>
            ),
            onClick: () => fillDemo(u.email),
          }))}
          /* A LINK, not a third autofill row. A hosting/domains customer cannot
             be a credential here: this form is signInWithPassword against a
             `users` row, and that customer has neither a password nor a row —
             autofilling one would give a button that always fails. This file
             already carries a note about exactly that (the `darshan@` entry
             above), and the fix then was to remove it, not to lengthen the list.

             It points at DMS rather than this app's own /portal/login because
             hosting and domains are DMS's, and so is the account that opens
             them. Sending someone to a ResellerOS portal they cannot use those
             services from is a longer way round to the same dead end. */
          footer={
            DMS_LOGIN_URL
              ? [
                  {
                    /* Deliberately NOT `external: true`. That flag opens a new tab and
                       appends the ↗ arrow together — the component couples them because
                       the arrow is a promise about what the click does. Signing in to
                       hosting and domains is the task, not a side trip, so it navigates
                       in place; a second tab left the half-finished ResellerOS login
                       sitting behind it. Re-adding the flag has to mean re-adding the
                       new tab, not just the arrow. */
                    label: "Hosting & domains sign-in",
                    href: DMS_LOGIN_URL,
                    note: (
                      <>
                        Opens the DMS sign-in directly. It is a separate account from this
                        one.
                      </>
                    ),
                  },
                ]
              : undefined
          }
        />
      )}

      {/* Google OAuth */}
      <GoogleAuthButton label="Sign in with Google" nextPath={nextPath} disabled={!configured} />

      <div className="my-5 flex items-center gap-3 text-xs text-ink-3">
        <div className="flex-1 h-px bg-hairline" />
        <span>or use email</span>
        <div className="flex-1 h-px bg-hairline" />
      </div>

      {unconfirmed && (
        <div className="mb-4 rounded-md border border-amber bg-amber-soft p-3 text-sm" role="alert">
          <p className="mb-3 text-amber-ink">
            <b>Please confirm your email first.</b> We sent a link to {unconfirmed} when you signed up.
          </p>
          <ResendVerification initialEmail={unconfirmed} />
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

        {/* The label carries the recovery link, because that is where somebody looks when the
            password will not work — not at the bottom of the page after the sign-up line.
            Until 22 Aug 2026 there was no such page at all: Settings → Reset data demanded a
            password the app gave nobody any way to recover (AGENTS.md L15). */}
        <FormField
          label="Password"
          required
          htmlFor="password"
          hint={
            <Link href="/forgot-password" className="text-amber font-medium hover:underline">
              Forgot?
            </Link>
          }
        >
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              placeholder="••••••••"
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

        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={isSubmitting}
          disabled={!configured}
        >
          Sign in
        </Button>
      </form>

      <p className="mt-5 text-center text-xs text-ink-3">
        Don't have an account?{" "}
        <Link href="/signup" className="text-amber font-medium hover:underline">
          Sign up
        </Link>
      </p>

      {/* This page is also the site's "Client login", so a customer of Anutech Digital lands
          here too: the documents they bought under are one click away (30 Sep 2026). */}
      <p className="mt-3 text-center text-xs text-ink-3">
        <Link href={"/terms-and-conditions" as never} className="hover:text-ink hover:underline">Terms and conditions</Link>
        {" · "}
        <Link href={"/refund" as never} className="hover:text-ink hover:underline">Refund policy</Link>
        {" · "}
        <Link href={"/privacy-policy" as never} className="hover:text-ink hover:underline">Privacy policy</Link>
      </p>
    </Card>
  );
}

// LoginPageInner uses useSearchParams() (?next= redirect target) — Next.js
// requires that to live under a Suspense boundary for static prerender.
export default function LoginPage() {
  return (
    <React.Suspense fallback={null}>
      <LoginPageInner />
    </React.Suspense>
  );
}
