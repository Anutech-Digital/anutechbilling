"use client";

/**
 * R-2477 independent review + R-2517: "Invite from <company>" — shown at the top of the app to a
 * login that already works in another company and was invited to one more. R-2517: there is NO
 * Accept button here — signing in to the login is no proof of the invited MAILBOX (an owner of the
 * login's own company may know an old temporary password). The line says to open the link emailed
 * to <address>; that link (/invites/accept?token=…) is the only way to accept. An invite without a
 * link (made before R-2517) says to ask the company to invite again.
 * "Not now" hides the invite for this browser session only; it stays open on the server until it
 * expires (7 days) or the company withdraws it. Logic: lib/auth/company-invites.ts.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { fetchMyInvites, inviteNextStep, type CompanyInvitesClient } from "@/lib/auth/company-invites";

const HIDDEN_KEY = "ros.company-invites.hidden.v1";

function readHidden(): string[] {
  try {
    const v = JSON.parse(window.sessionStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function CompanyInvitesBanner() {
  const { data: me } = useCurrentUser();
  const [hidden, setHidden] = React.useState<string[]>([]);

  React.useEffect(() => { setHidden(readHidden()); }, []);

  const invitesQ = useQuery({
    queryKey: ["my-company-invites", me?.userId ?? null],
    queryFn: () => fetchMyInvites(createClient() as unknown as CompanyInvitesClient),
    /* every login, a personal account too (accepting a business invite moves it into the business) */
    enabled: !!me?.userId,
    staleTime: 60_000,
    retry: false,
  });

  const shown = (invitesQ.data ?? []).filter((i) => !hidden.includes(i.inviteId));
  if (shown.length === 0) return null;

  const hide = (inviteId: string) => {
    const next = [...hidden, inviteId];
    setHidden(next);
    try { window.sessionStorage.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* hidden for this render only */ }
  };

  return (
    <div role="region" aria-label="Invites from other companies" className="border-b border-hairline bg-amber-soft/40 px-4 py-2 md:px-6">
      <ul className="space-y-1.5">
        {shown.map((inv) => (
          <li key={inv.inviteId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink">
            <Icon name="building" size={15} className="shrink-0 text-amber-ink" />
            <span className="min-w-0 flex-1">
              Invite from <span className="font-medium">{inv.companyName}</span> to join as {inv.roleLabel}.{" "}
              <span>{inviteNextStep(inv)}</span>
              <span className="text-ink-3"> You keep your current company.</span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => hide(inv.inviteId)}
              aria-label={`Not now — hide the invite from ${inv.companyName} for now`}>
              Not now
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
