"use client";

/**
 * R-2396 (G-PERSONAL, owner 3 Nov: "individual ka interface kaisa hoga aur free mein kya milega"):
 * the personal home — what a new personal login sees first after the email link.
 *
 * Verify lands a personal login on /money → /vault/personal (verify-landing.ts, nav.ts ROLE_HOME).
 * The Money layout shows this panel above the Overview, for role 'personal' only (a business
 * owner's Private Vault never shows it). Two parts:
 *   1. Get started — 3 steps, each ticked from the person's own rows (RLS: only their rows):
 *      a bank/cash account · income or expenses · people or loans.
 *   2. Free in your account — every free feature with a link; ones not built yet say
 *      "Coming soon" and have no button that does nothing.
 * "Hide" keeps it away on this browser (a convenience only — the menu has every page).
 * It goes away by itself once all three steps are done.
 */
import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { usePersonalAccounts, usePersonalTransactions } from "@/lib/queries/personal-vault";
import { usePersonalContacts } from "@/lib/queries/personal-contacts";
import { usePersonalLoans } from "@/lib/queries/personal-loans";
import { cn } from "@/lib/utils";

export type WelcomeStep = { id: string; title: string; body: string; href: string; cta: string; done: boolean };

export function personalWelcomeSteps(have: { account: boolean; entries: boolean; peopleOrLoans: boolean }): WelcomeStep[] {
  return [
    {
      id: "account",
      title: "Add a bank or cash account",
      body: "Your savings account, cash in hand or a credit card — with its opening balance.",
      href: "/vault/personal/banking",
      cta: "Add account",
      done: have.account,
    },
    {
      id: "entries",
      title: "Add income and expenses",
      body: "Salary, rent, bills, shopping — type them in. Bank statement import is coming soon.",
      href: "/vault/personal/expenses",
      cta: "Add an entry",
      done: have.entries,
    },
    {
      id: "people",
      title: "Add people and loans",
      body: "Who owes you, whom you owe, and loans with their EMIs.",
      href: "/vault/personal/people",
      cta: "Add a person",
      done: have.peopleOrLoans,
    },
  ];
}

export type FreeFeature = { label: string; href?: string; soon?: boolean };
export type FreeGroup = { title: string; icon: string; items: FreeFeature[] };

/** Everything the free personal account includes. No prices anywhere (the owner decides them). */
export const PERSONAL_FREE_FEATURES: FreeGroup[] = [
  {
    title: "Money",
    icon: "wallet",
    items: [
      { label: "Bank, cash and card accounts", href: "/vault/personal/banking" },
      { label: "Income and expenses", href: "/vault/personal/expenses" },
      { label: "Bank statement import", soon: true },
      { label: "Loans and EMIs", href: "/vault/personal/loans" },
      { label: "Money I owe or hold for others", href: "/vault/personal/banking#owe-hold-title" },
      { label: "People", href: "/vault/personal/people" },
      { label: "Wealth and net worth", href: "/vault/personal/wealth" },
    ],
  },
  {
    title: "Digital assets",
    icon: "globe",
    items: [{ label: "Domains, hosting and subscriptions with renewal dates", soon: true }],
  },
  {
    title: "Free support",
    icon: "ticket",
    items: [{ label: "Ask our team for help and follow your requests", href: "/support/my" }],
  },
];

const HIDE_KEY = "r2396.personal-welcome-hidden";

function readHidden(): boolean {
  try { return window.localStorage.getItem(HIDE_KEY) === "1"; } catch { return false; }
}

export function PersonalWelcome() {
  const accountsQ = usePersonalAccounts();
  const txQ = usePersonalTransactions(500); // same key as the Overview — one fetch
  const contactsQ = usePersonalContacts();
  const loansQ = usePersonalLoans();
  const [hidden, setHidden] = React.useState(false);
  React.useEffect(() => { setHidden(readHidden()); }, []);

  const loading = accountsQ.isLoading || txQ.isLoading || contactsQ.isLoading || loansQ.isLoading;
  const steps = personalWelcomeSteps({
    account: (accountsQ.data?.length ?? 0) > 0,
    entries: (txQ.data?.length ?? 0) > 0,
    peopleOrLoans: (contactsQ.data?.length ?? 0) > 0 || (loansQ.data?.length ?? 0) > 0,
  });
  const doneCount = steps.filter((s) => s.done).length;

  if (hidden || loading || doneCount === steps.length) return null;

  const hide = () => {
    try { window.localStorage.setItem(HIDE_KEY, "1"); } catch { /* private window — hidden for now only */ }
    setHidden(true);
  };

  return (
    <Card className="p-5 md:p-6 space-y-5" aria-labelledby="personal-welcome-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="personal-welcome-title" className="text-lg font-serif text-ink">Welcome — let&apos;s set up your money</h2>
          <p className="text-sm text-ink-3 mt-0.5">Three short steps. {doneCount} of {steps.length} done.</p>
        </div>
        <Button variant="ghost" size="sm" onClick={hide}>Hide</Button>
      </div>

      <ol className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s, i) => (
          <li key={s.id} className={cn("rounded-lg border p-4 flex flex-col gap-2", s.done ? "border-emerald/30" : "border-hairline")}>
            <div className="flex items-center gap-2">
              <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium", s.done ? "bg-emerald text-white" : "bg-paper-2 text-ink-2")}>
                {s.done ? <Icon name="check" size={13} /> : i + 1}
              </span>
              <span className="text-sm font-medium text-ink">{s.title}</span>
            </div>
            <p className="text-xs text-ink-3 leading-relaxed flex-1">{s.body}</p>
            {s.done ? (
              <span className="text-xs text-emerald">Done</span>
            ) : (
              <Link href={s.href} className="text-sm text-primary font-medium hover:underline">{s.cta}</Link>
            )}
          </li>
        ))}
      </ol>

      <div className="pt-4 border-t border-hairline">
        <h3 className="text-sm font-medium text-ink">Free in your account</h3>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4">
          {PERSONAL_FREE_FEATURES.map((g) => (
            <div key={g.title}>
              <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-ink-3 font-medium">
                <Icon name={g.icon} size={13} /> {g.title}
              </p>
              <ul className="mt-2 space-y-1.5">
                {g.items.map((f) => (
                  <li key={f.label} className="flex items-start gap-1.5 text-sm text-ink">
                    <Icon name="check" size={14} className="text-emerald mt-0.5 shrink-0" />
                    <span>
                      {f.href && !f.soon ? <Link href={f.href} className="hover:underline">{f.label}</Link> : f.label}
                      {f.soon && <span className="ml-1.5 rounded bg-paper-2 px-1.5 py-0.5 text-3xs text-ink-3">Coming soon</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-ink-3">
          Run a business too? <Link href="/upgrade" className="text-primary hover:underline">See what a business account adds</Link>.
        </p>
      </div>
    </Card>
  );
}
