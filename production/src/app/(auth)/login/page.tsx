"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
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

const schema = z.object({
  email: z.string().email("Enter a valid email"),
  password: z.string().min(6, "At least 6 characters"),
});
type FormData = z.infer<typeof schema>;

// Demo accounts shown only in development. Kept in sync with the actual
// tenants in Supabase — when a tenant is added/removed or its password
// rotated, update this list. Hidden in production builds.
const DEMO_USERS: Array<{ label: string; email: string; password: string }> = [
  { label: "Anutech Digital",                email: "pardeep@anutech.in",            password: "ResellerOS@2026" },
  { label: "Excel Technologies · Owner",     email: "pardeep@exceltechnologies.in",  password: "ExcelTech@2026"  },
  { label: "Excel Technologies · Darshan (sales)", email: "darshan@exceltechnologies.in", password: "ExcelSales@2026" },
];

function LoginPageInner() {
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/dashboard";
  const [showPassword, setShowPassword] = React.useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({ resolver: zodResolver(schema) });

  // Quick-fill from demo banner — only used in dev
  const fillDemo = (email: string, password: string) => {
    setValue("email", email, { shouldValidate: true });
    setValue("password", password, { shouldValidate: true });
    setShowPassword(true);
  };

  const showDemoHint = process.env.NODE_ENV !== "production";

  const configured = isSupabaseConfigured();

  async function onSubmit(values: FormData) {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithPassword(values);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Welcome back");
    // Hard navigation — guarantees the fresh auth cookies are sent on the
    // next request (router.push uses soft nav which can race the cookie
    // write when the app is behind a Firebase Hosting → Cloud Run proxy).
    window.location.href = nextPath;
  }

  async function onGoogleSignIn() {
    const supabase = createClient();
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/callback?next=${encodeURIComponent(nextPath)}`,
      },
    });
    if (error) toast.error(error.message);
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

      {/* Dev-only demo credentials — hidden in production builds */}
      {showDemoHint && configured && (
        <div className="mb-4 p-3 bg-indigo-50 border border-indigo/30 rounded-md text-xs">
          <div className="flex items-start gap-2 mb-2">
            <Icon name="info" size={14} className="text-indigo flex-shrink-0 mt-0.5" />
            <div className="text-indigo flex-1">
              <b>Dev mode — demo accounts</b>
              <span className="text-ink-3 ml-1">· click to autofill</span>
            </div>
          </div>
          <ul className="space-y-1.5">
            {DEMO_USERS.map((u) => (
              <li key={u.email}>
                <button
                  type="button"
                  onClick={() => fillDemo(u.email, u.password)}
                  className="w-full text-left rounded px-2 py-1.5 hover:bg-indigo/10 transition-colors"
                >
                  <div className="font-medium text-ink">{u.label}</div>
                  <div className="text-[11px] text-ink-3 font-mono">
                    {u.email} · <span className="text-amber-ink">{u.password}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Google OAuth */}
      <Button
        variant="outline"
        className="w-full justify-center"
        onClick={onGoogleSignIn}
        disabled={!configured}
      >
        <GoogleLogo />
        Sign in with Google
      </Button>

      <div className="my-5 flex items-center gap-3 text-xs text-ink-3">
        <div className="flex-1 h-px bg-hairline" />
        <span>or use email</span>
        <div className="flex-1 h-px bg-hairline" />
      </div>

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

        <FormField label="Password" required htmlFor="password">
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
    </Card>
  );
}

function GoogleLogo() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC04" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
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
