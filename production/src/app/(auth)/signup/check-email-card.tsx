"use client";

/**
 * R-048 / R-2396: the one "Check your inbox" screen after a password signup — business and
 * personal show the same card (one way per task), so the next step reads the same for both.
 */
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { ResendVerification } from "@/components/features/auth/resend-verification";

export function CheckEmailCard({ email }: { email: string }) {
  return (
    <Card>
      <div className="text-center mb-5">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-soft">
          <Icon name="mail" size={22} className="text-amber-ink" />
        </div>
        <h1 className="font-serif text-2xl mb-2">Check your inbox</h1>
        <p className="text-sm text-ink-2 leading-relaxed">
          We sent a confirmation link to <b className="text-ink">{email}</b>. Open it to finish
          creating your account — then sign in. The link works for 48 hours.
        </p>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-ink-3 text-center">Didn&apos;t get it?</summary>
        <div className="mt-3"><ResendVerification initialEmail={email} /></div>
      </details>
      <Link href="/login" className="mt-5 block text-center text-sm text-amber font-medium hover:underline">Back to sign in</Link>
    </Card>
  );
}
