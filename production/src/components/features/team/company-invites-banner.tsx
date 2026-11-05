"use client";

/**
 * R-2477 independent review: "Invite from <company>" — shown at the top of the app to a login that
 * already works in another company and was invited to one more. Nothing changes until the person
 * presses Accept (a sign-in alone is never agreement). Accept runs accept_company_invite through
 * /api/team/invites/:id/accept. When that also made the new company the selected one, the app is
 * loaded fresh (same as a company switch), otherwise the switcher list is refreshed.
 * "Not now" hides the invite for this browser session only; it stays open on the server until it
 * expires (7 days) or the company withdraws it. Logic: lib/auth/company-invites.ts.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { finishCompanySwitch } from "@/lib/auth/company-switch";
import {
  acceptInvite, acceptedMessage, fetchMyInvites, type CompanyInvitesClient,
} from "@/lib/auth/company-invites";

/** A full page load after the accept switched company — an object so tests can replace it. */
export const invitesNav = {
  go(href: string) {
    window.location.assign(href);
  },
};

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
  const queryClient = useQueryClient();
  const [hidden, setHidden] = React.useState<string[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);

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

  const accept = async (inviteId: string) => {
    setBusyId(inviteId);
    try {
      const r = await acceptInvite(inviteId);
      toast.success(acceptedMessage(r), { duration: 10_000 });
      if (r.selected) {
        await finishCompanySwitch({
          queryClient,
          storage: typeof window !== "undefined" ? window.sessionStorage : null,
          go: (href) => invitesNav.go(href),
        });
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ["my-company-invites"] });
      void queryClient.invalidateQueries({ queryKey: ["my-companies"] });
    } catch (e) {
      toastError(e, { fallback: "Couldn't accept the invite. Refresh the page and try again.", duration: 10_000 });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div role="region" aria-label="Invites from other companies" className="border-b border-hairline bg-amber-soft/40 px-4 py-2 md:px-6">
      <ul className="space-y-1.5">
        {shown.map((inv) => (
          <li key={inv.inviteId} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink">
            <Icon name="building" size={15} className="shrink-0 text-amber-ink" />
            <span className="min-w-0 flex-1">
              Invite from <span className="font-medium">{inv.companyName}</span> to join as {inv.roleLabel}.
              <span className="text-ink-3"> You keep your current company.</span>
            </span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="primary" loading={busyId === inv.inviteId}
                onClick={() => void accept(inv.inviteId)}
                aria-label={`Accept the invite from ${inv.companyName}`}>
                Accept
              </Button>
              <Button size="sm" variant="ghost" disabled={busyId === inv.inviteId} onClick={() => hide(inv.inviteId)}
                aria-label={`Not now — hide the invite from ${inv.companyName} for now`}>
                Not now
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
