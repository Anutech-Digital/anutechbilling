/**
 * The owner's private vault — shell, owner gate, and PIN lock.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * WHERE THE ACTUAL SECURITY IS — READ THIS BEFORE TRUSTING THIS FILE
 * ═══════════════════════════════════════════════════════════════════════════════
 * Nothing on this page protects the data. Not the role check below, not the PIN.
 *
 * The protection is the RLS policy on `personal_accounts`, `personal_transactions`,
 * `personal_holdings` and `personal_vault_pin`: `owner_user_id = auth.uid()`. Postgres
 * refuses to return another person's rows to any query, from any client, with or
 * without this component. Somebody who bypasses everything here still gets an empty
 * result set, and `supabase/tests/personal_vault_owner_isolation.test.sql` proves it
 * against the live database.
 *
 * This file exists for two lesser but real jobs:
 *   1. Show a non-owner a clear refusal instead of an empty screen they will report as
 *      a bug. Middleware cannot do this — its role guard skips `owner` AND `manager`
 *      outright, so a manager reaches every protected route.
 *   2. Put a lock over the screen so a colleague at the owner's desk cannot read it.
 *
 * ─── GP-07a (R-2115): A PERSONAL LOGIN OPENS IT TOO ────────────────────────
 * For a personal login (role 'personal', its own workspace) these screens ARE its Money pages
 * (menu row "Money", /money redirects here). It is admitted here and in the PIN route, and
 * the words change: a personal login has no company, so no "company books" and no
 * "Drawings" tab. The company Password Vault at /vault stays closed to it (nav.ts).
 *
 * ─── WHY THIS IS NOT AT /vault ──────────────────────────────────────────────
 * `/vault` is already the customer console Password Vault — a live feature holding the
 * Google/M365 credentials this reseller administers, reachable by owner AND manager.
 * Replacing it would delete a working feature; re-gating it to owners only would cut
 * managers off from customer passwords they need. So the private vault lives beneath it
 * at `/vault/personal`, and the two never share a table prefix or a policy.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { VaultPinGate } from "@/components/features/vault/vault-pin-gate";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/vault/personal", label: "Overview", icon: "chart" },
  { href: "/vault/personal/banking", label: "Banking", icon: "wallet" },
  { href: "/vault/personal/expenses", label: "Drawings & Expenses", personalLabel: "Expenses", icon: "receipt" },
  { href: "/vault/personal/wealth", label: "Wealth", icon: "trending_up" },
] as const;

/** Who may open these screens: the business owner (Private Vault) and a personal login (Money). */
const VAULT_ROLES: readonly string[] = ["owner", "personal"];

export default function PersonalVaultLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: me, isLoading } = useCurrentUser();

  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-4">
        <Skeleton className="h-10 w-64 rounded" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  /* A refusal that says what happened, why, and what to do — §24. The alternative,
     an empty vault, is indistinguishable from a broken one and gets reported as a bug. */
  if (me && !VAULT_ROLES.includes(me.role ?? "")) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[720px] mx-auto">
        <Card className="p-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-rose-soft">
            <Icon name="lock" size={26} className="text-rose" />
          </div>
          <h1 className="text-xl font-serif text-ink">This area is for the owner only</h1>
          <p className="mt-2 text-sm text-ink-3">
            It holds no business data — these are the owner's own bank accounts, expenses and
            investments. That is why no other team member can see it.
          </p>
          <p className="mt-4 text-xs text-ink-3">
            Company customer passwords are in the <Link href="/vault" className="text-primary hover:underline">Password Vault</Link>.
          </p>
        </Card>
      </div>
    );
  }

  const personal = me?.role === "personal";

  return (
    <VaultPinGate>
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl md:text-3xl font-serif text-ink flex items-center gap-2">
              <Icon name="lock" size={22} className="text-ink-3" />
              {personal ? "Money" : "Private Vault"}
            </h1>
            <p className="text-sm text-ink-3 mt-1">
              {personal
                ? "Your bank accounts, cash, cards, spending and savings. Only you can see this."
                : "Your own money — fully separate from the company books. No one in your team can see this."}
            </p>
          </div>
        </div>

        <nav className="flex items-center gap-1 border-b border-hairline overflow-x-auto" aria-label={personal ? "Money sections" : "Private vault sections"}>
          {TABS.map((t) => {
            // Exact match for the index so it does not stay lit on every child route.
            const active = t.href === "/vault/personal" ? pathname === t.href : pathname?.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors",
                  active
                    ? "border-primary text-ink"
                    : "border-transparent text-ink-3 hover:text-ink hover:border-hairline-strong",
                )}
              >
                <Icon name={t.icon} size={14} />
                {personal && "personalLabel" in t ? t.personalLabel : t.label}
              </Link>
            );
          })}
        </nav>

        {children}
      </div>
    </VaultPinGate>
  );
}
