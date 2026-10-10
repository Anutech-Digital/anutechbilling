"use client";

/**
 * /verify-email?token=…  — the link in the signup confirmation email (R-048, 4 Oct 2026).
 * Confirms the address, then sends the person to sign in. Every outcome says what to do
 * next; an expired or used link offers a fresh one.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ResendVerification } from "@/components/features/auth/resend-verification";

type State = "checking" | "ok" | "expired" | "used" | "invalid" | "error";

export default function VerifyEmailPage() {
  return (
    <React.Suspense fallback={<Card><p className="text-sm text-ink-3">Checking your link…</p></Card>}>
      <VerifyEmail />
    </React.Suspense>
  );
}

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = React.useState<State>("checking");
  const [email, setEmail] = React.useState("");
  /** R-822: the workspace whose owner was asked to add this person, if any. */
  const [joinTo, setJoinTo] = React.useState<string | null>(null);
  const ran = React.useRef(false);

  React.useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) { setState("invalid"); return; }
    fetch("/api/auth/verify-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    })
      .then((r) => r.json())
      .then((j: { ok?: boolean; email?: string; reason?: string; joinRequestedTo?: string | null }) => {
        if (j.ok) { setEmail(j.email ?? ""); setJoinTo(j.joinRequestedTo ?? null); setState("ok"); return; }
        setState(j.reason === "expired" || j.reason === "used" || j.reason === "invalid" ? j.reason : "error");
      })
      .catch(() => setState("error"));
  }, [token]);

  if (state === "checking") {
    return <Card><p className="text-sm text-ink-3" role="status">Checking your link…</p></Card>;
  }

  if (state === "ok" && joinTo) {
    return (
      <Card>
        <div className="text-center">
          <Icon name="check_circle" size={36} className="text-emerald mx-auto mb-3" />
          <h1 className="font-serif text-3xl mb-2">Email confirmed</h1>
          <p className="text-sm text-ink-2 leading-relaxed">
            Your company already uses ResellerOS — we&apos;ve asked the owner of{" "}
            <b className="text-ink">{joinTo}</b> to add you.
          </p>
          <p className="mt-2 text-xs text-ink-3 mb-6">
            You&apos;ll be able to sign in as soon as they approve. Nothing else is needed from you.
          </p>
          <Button asChild variant="primary" className="w-full">
            <Link href="/login">Back to sign in</Link>
          </Button>
        </div>
      </Card>
    );
  }

  if (state === "ok") {
    return (
      <Card>
        <div className="text-center">
          <Icon name="check_circle" size={36} className="text-emerald mx-auto mb-3" />
          <h1 className="font-serif text-3xl mb-2">Email confirmed</h1>
          <p className="text-sm text-ink-3 mb-6">{email ? `${email} is confirmed.` : "Your email is confirmed."} You can sign in now.</p>
          <Button asChild variant="primary" className="w-full">
            <Link href={(email ? `/login?email=${encodeURIComponent(email)}` : "/login") as Route}>Sign in</Link>
          </Button>
        </div>
      </Card>
    );
  }

  const copy: Record<Exclude<State, "checking" | "ok">, { title: string; line: string }> = {
    used: { title: "Link already used", line: "This email is already confirmed. Sign in with your password." },
    expired: { title: "Link expired", line: "Confirmation links work for 48 hours. Get a new one below." },
    invalid: { title: "Link not recognised", line: "The link may be incomplete — open it straight from the email, or get a new one below." },
    error: { title: "Could not confirm right now", line: "Please try the link again in a minute, or get a new one below." },
  };
  const c = copy[state];
  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">{c.title}</h1>
        <p className="text-sm text-ink-3">{c.line}</p>
      </div>
      {state === "used" ? (
        <Button asChild variant="primary" className="w-full"><Link href="/login">Sign in</Link></Button>
      ) : (
        <ResendVerification />
      )}
    </Card>
  );
}
