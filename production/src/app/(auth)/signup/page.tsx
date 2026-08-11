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
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  const configured = isSupabaseConfigured();

  async function onSubmit(values: FormData) {
    // Server-side signup: uses service role key to create auth user
    // (auto-confirmed) + tenant + user record atomically.
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email:       values.email,
        password:    values.password,
        fullName:    values.fullName,
        companyName: values.companyName,
        gstin:       values.gstin ?? null,
      }),
    });

    const json = await res.json() as { success?: boolean; error?: string };

    if (!res.ok || json.error) {
      toast.error(json.error ?? "Signup failed. Please try again.");
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

  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Start your reseller business</h1>
        <p className="text-sm text-ink-3">Free 14-day trial · No credit card</p>
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

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <FormField label="Company name" required htmlFor="companyName">
          <Input
            id="companyName"
            placeholder="e.g. Excel Technologies Pvt Ltd"
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
            helper="You can add this later in Settings"
            error={errors.gstin?.message}
            disabled={!configured}
            {...register("gstin")}
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

        <Button
          type="submit"
          variant="primary"
          className="w-full justify-center"
          loading={isSubmitting}
          disabled={!configured}
        >
          Create account
        </Button>

        <p className="text-[11px] text-ink-3 text-center leading-relaxed">
          By signing up you agree to our{" "}
          <a href="#" className="underline">Terms</a> and{" "}
          <a href="#" className="underline">Privacy Policy</a>. DPDP Act 2023 compliant.
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
