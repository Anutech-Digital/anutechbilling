"use client";

/**
 * Dashboard "Health" card — System & integrations (moved out of dashboard/page.tsx, R-1451).
 *
 * R-1451 (Pawan, staging AI Help, 15 Oct): a "Not set up" row was plain text, a dead end.
 * Now each one that has a real setup screen links to it (Settings → Integrations). Only a role
 * that can open /settings (nav.ts, the middleware rule) AND connect company-wide integrations
 * (action-roles "integration.company" — owner, manager) gets the link; anyone else is told to
 * ask the owner instead of being sent to a screen where they cannot change anything.
 *
 * GST e-Invoice has no setup screen in the app yet, so it stays plain text — never a link to
 * a page that cannot set it up.
 */
import Link from "next/link";
import type { Route } from "next";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";
import { mayDo } from "@/lib/auth/action-roles";
import { SETUP_HREF } from "@/lib/onboarding/setup-links";

export type HealthItem = {
  name: string;
  status: "Live" | "Not set up";
  tone: "ok" | "warn";
  /** Where this is set up. null = no setup screen exists in the app. */
  setupHref: string | null;
};

export const HEALTH_ITEMS: readonly HealthItem[] = [
  { name: "Supabase Auth + DB",          status: "Live",       tone: "ok",   setupHref: null },
  { name: "Razorpay",                    status: "Not set up", tone: "warn", setupHref: SETUP_HREF.integrations },
  { name: "GST e-Invoice (NIC/IRP)",     status: "Not set up", tone: "warn", setupHref: null },
  { name: "Google CSP Reseller API",     status: "Not set up", tone: "warn", setupHref: SETUP_HREF.integrations },
  { name: "WhatsApp Business (Gupshup)", status: "Not set up", tone: "warn", setupHref: SETUP_HREF.integrations },
];

/** May this role open the setup screen and actually connect the integration there? */
export function canSetUpIntegration(role: string | null | undefined, href: string): boolean {
  /* Role still loading: no link yet, so nobody presses one that turns out to be closed. */
  if (!role) return false;
  return canOpenRoute(role, href) && mayDo(role, "integration.company");
}

export function HealthCard() {
  const { data: me } = useCurrentUser();
  const role = me?.role ?? null;

  return (
    <Card title="Health" sub="System & integrations">
      <div className="space-y-2">
        {HEALTH_ITEMS.map((s) => {
          const needsSetup = s.status === "Not set up" && s.setupHref !== null;
          return (
            <div key={s.name} data-health-row className="flex justify-between items-center gap-2 text-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", s.tone === "ok" ? "bg-emerald" : "bg-amber")} />
                <span>{s.name}</span>
              </div>
              {needsSetup && s.setupHref && canSetUpIntegration(role, s.setupHref) ? (
                <Link
                  href={s.setupHref as Route}
                  aria-label={`Set up ${s.name} in Settings`}
                  className="inline-flex items-center gap-1 shrink-0 text-amber-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded"
                >
                  {s.status} · Set up
                  <Icon name="arrow_right" size={12} />
                </Link>
              ) : (
                <span className={cn("shrink-0", s.tone === "ok" ? "text-emerald" : "text-amber-ink")}>
                  {s.status}
                  {needsSetup && role ? " · ask the owner" : ""}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
