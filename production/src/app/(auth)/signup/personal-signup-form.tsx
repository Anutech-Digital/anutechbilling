"use client";

/**
 * R-2396 (G-PERSONAL, GP-06): the free personal account form. Name, email, password and ONE
 * required consent tick (Terms + Privacy + processing my financial records — the DPDP proof the
 * API records, R-2119), plus an optional marketing tick. No company name, no GSTIN.
 *
 * Posts kind 'personal' to /api/auth/signup. The login is created UNCONFIRMED; the link in the
 * email confirms it and verify-email makes the personal workspace, then lands on /money.
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";

import { isSupabaseConfigured } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { describeError } from "@/lib/errors/toast-error";
import { checkNewPassword } from "@/lib/auth/password-rules";
import { useTurnstile } from "@/components/shared/turnstile";
import { CheckEmailCard } from "./check-email-card";

const schema = z.object({
  fullName: z.string().trim().min(2, "Your name is required"),
  email: z.string().email("Enter a valid email"),
  password: z.string().superRefine((v, ctx) => {
    const problem = checkNewPassword(v);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem.message });
  }),
});
type FormData = z.infer<typeof schema>;

export function PersonalSignupForm({ onBack }: { onBack?: () => void }) {
  const [showPassword, setShowPassword] = React.useState(false);
  const [consent, setConsent] = React.useState(false);
  const [marketing, setMarketing] = React.useState(false);
  const [verifyEmail, setVerifyEmail] = React.useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const configured = isSupabaseConfigured();
  const ts = useTurnstile();

  async function onSubmit(values: FormData) {
    if (!consent) return; // the button is disabled until the tick; the API refuses without it too
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...ts.headers },
      body: JSON.stringify({
        kind: "personal",
        email: values.email,
        password: values.password,
        fullName: values.fullName.trim(),
        consent: true,
        marketing,
      }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string; needsVerification?: boolean };
    if (!res.ok || json.error) {
      ts.reset();
      const d = describeError(json.error ? { message: json.error } : null, "Signup failed.");
      toast.error(d.message, {
        description: d.description ?? "Nothing was created. Check the details above and press Create free account again — or sign in if you already have an account.",
        action: { label: "Sign in instead", onClick: () => { window.location.href = "/login"; } },
      });
      return;
    }
    setVerifyEmail(values.email);
  }

  if (verifyEmail) return <CheckEmailCard email={verifyEmail} />;

  return (
    <Card>
      {onBack && (
        <button type="button" onClick={onBack} className="mb-3 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
          <Icon name="arrow_left" size={13} /> Back
        </button>
      )}
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Create your free personal account</h1>
        <p className="text-sm text-ink-3">Your money, in one private place. Free — no card needed.</p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" aria-label="Personal account">
        <FormField label="Full name" required htmlFor="p-fullName">
          <Input id="p-fullName" autoComplete="name" placeholder="e.g. Ravi Kumar" error={errors.fullName?.message} disabled={!configured} {...register("fullName")} />
        </FormField>

        <FormField label="Email" required htmlFor="p-email">
          <Input id="p-email" type="email" autoComplete="email" placeholder="e.g. you@gmail.com" error={errors.email?.message} disabled={!configured} {...register("email")} />
        </FormField>

        <FormField label="Password" required htmlFor="p-password">
          <div className="relative">
            <Input
              id="p-password"
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

        <div className="space-y-3 rounded-md border border-hairline bg-paper-2 p-3">
          <div className="flex items-start gap-2.5">
            <Checkbox id="p-consent" checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" aria-required="true" />
            <label htmlFor="p-consent" className="text-xs text-ink-2 leading-relaxed">
              I agree to the{" "}
              <a href="/terms" target="_blank" rel="noopener" className="underline">Terms</a> and{" "}
              <a href="/privacy" target="_blank" rel="noopener" className="underline">Privacy Policy</a>, and I allow
              ResellerOS to store and process my financial records (bank, cash, income, expenses, loans) to run my account.{" "}
              <span className="text-rose">(required)</span>
            </label>
          </div>
          <div className="flex items-start gap-2.5">
            <Checkbox id="p-marketing" checked={marketing} onCheckedChange={(v) => setMarketing(v === true)} className="mt-0.5" />
            <label htmlFor="p-marketing" className="text-xs text-ink-3 leading-relaxed">
              Send me tips and offers by email (optional — you can stop them any time).
            </label>
          </div>
        </div>

        {ts.widget}
        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={isSubmitting}
          disabled={!configured || !consent}
        >
          Create free account
        </Button>
        {!consent && <p className="text-2xs text-ink-3 text-center">Tick the first box to continue.</p>}
      </form>
    </Card>
  );
}
