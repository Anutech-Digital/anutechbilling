"use client";

/**
 * R-2396 (G-PERSONAL, GP-06): the first question on /signup when the personal account is open —
 * "Business account" or "Personal account (free)". Shown only when PERSONAL_SIGNUP_ENABLED is on
 * (signup-flag-context.tsx); off, /signup is the business form as before.
 */
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";

export type SignupKind = "business" | "personal";

const CHOICES: { kind: SignupKind; title: string; body: string; icon: string }[] = [
  {
    kind: "business",
    title: "Business account",
    body: "GST invoices, quotes, customers, payments and accounts for your company.",
    icon: "building",
  },
  {
    kind: "personal",
    title: "Personal account (free)",
    body: "Your own money — bank and cash, income and expenses, loans and people. Free support too.",
    icon: "wallet",
  },
];

export function SignupChoice({ onChoose }: { onChoose: (kind: SignupKind) => void }) {
  return (
    <Card>
      <div className="text-center mb-6">
        <h1 className="font-serif text-3xl mb-2">Create your account</h1>
        <p className="text-sm text-ink-3">Who is this account for?</p>
      </div>
      <ul className="space-y-3">
        {CHOICES.map((c) => (
          <li key={c.kind}>
          <button
            type="button"
            onClick={() => onChoose(c.kind)}
            className="w-full flex items-start gap-3 rounded-lg border border-hairline bg-paper p-4 text-left transition-colors hover:border-amber hover:bg-amber-soft/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
          >
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-paper-2">
              <Icon name={c.icon} size={18} className="text-ink-2" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-ink">{c.title}</span>
              <span className="mt-0.5 block text-xs text-ink-3 leading-relaxed">{c.body}</span>
            </span>
            <Icon name="chevron_right" size={16} className="mt-2 shrink-0 text-ink-3" />
          </button>
          </li>
        ))}
      </ul>
      <p className="mt-5 text-center text-xs text-ink-3">
        Already have an account?{" "}
        <Link href="/login" className="text-amber font-medium hover:underline">Sign in</Link>
      </p>
    </Card>
  );
}
