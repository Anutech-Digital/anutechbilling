"use client";

/**
 * R-2517 — /invites/accept#token=…  The link in the email that invites a login which already works
 * in another company. Opening it from the invited MAILBOX is the proof; the signed-in login must be
 * the invited one too. Two clicks for the real person: the email link → Accept.
 *
 * Signed out → Sign in (comes back here; the token waits in this tab's sessionStorage, never in a
 * URL a server sees). Two-step pending → /mfa, back here. Wrong login / used / expired / replaced /
 * blocked link → the reason and the next step, no Accept button. After Accept: if the new company
 * became the selected one, the app loads fresh there; otherwise "Switch to <company> now" (the right
 * next step) or stay. Logic: lib/auth/company-invites.ts.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { roleLabel } from "@/lib/auth/roles";
import { GENERIC_HOME } from "@/lib/nav";
import { COMPANY_SWITCH_CHANNEL, describeSwitchRefusal, finishCompanySwitch, switchCompany } from "@/lib/auth/company-switch";
import { INVITE_LINK_BROKEN_MESSAGE, inviteTokenShapeOk } from "@/lib/auth/invite-link-request";
import {
  acceptInviteLink, acceptedMessage, INVITE_TOKEN_KEY, inviteLinkStateMessage, InviteLinkError, lookupInviteLink,
  type AcceptResult, type InviteLinkInfo, type InviteLinkState,
} from "@/lib/auth/company-invites";

/** Full page loads — an object so tests can replace it. */
export const inviteAcceptNav = {
  go(href: string) {
    window.location.assign(href);
  },
};

/** Where Sign in / two-step sign-in come back to — no token in it (sessionStorage holds it). */
export const INVITE_ACCEPT_PATH = "/invites/accept";

const TITLES: Record<Exclude<InviteLinkState, "open">, string> = {
  blocked: "This invite cannot be accepted",
  other_login: "Signed in as someone else",
  used: "Invite already used",
  expired: "Invite expired",
  not_found: "Link not valid any more",
};

type View =
  | { kind: "loading" }
  | { kind: "broken" }
  | { kind: "signed_out" }
  | { kind: "error"; message: string; mfa: boolean }
  | { kind: "info"; info: InviteLinkInfo }
  | { kind: "accepted"; result: AcceptResult };

function forgetToken() {
  try { window.sessionStorage.removeItem(INVITE_TOKEN_KEY); } catch { /* storage blocked: nothing kept */ }
}

/** Tell this login's other tabs to load fresh (same as the top-bar switcher). */
function announceSwitch() {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const ch = new BroadcastChannel(COMPANY_SWITCH_CHANNEL);
    ch.postMessage({ type: "switched" });
    ch.close();
  } catch {
    // no channel: the other tabs follow on their next full load
  }
}

export function InviteAcceptPanel({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [view, setView] = React.useState<View>(() => (inviteTokenShapeOk(token) ? { kind: "loading" } : { kind: "broken" }));
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const back = encodeURIComponent(INVITE_ACCEPT_PATH);

  React.useEffect(() => {
    if (!inviteTokenShapeOk(token)) { setView({ kind: "broken" }); return; }
    let live = true;
    setView({ kind: "loading" });
    lookupInviteLink(token)
      .then((info) => { if (live) setView({ kind: "info", info }); })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof InviteLinkError && e.signedOut) { setView({ kind: "signed_out" }); return; }
        const message = e instanceof Error ? e.message : "Couldn't open the invite. Refresh the page and try again.";
        setView({ kind: "error", message, mfa: e instanceof InviteLinkError && e.needsMfa });
      });
    return () => { live = false; };
  }, [token]);

  const goFresh = async () => {
    announceSwitch();
    await finishCompanySwitch({
      queryClient,
      storage: typeof window !== "undefined" ? window.sessionStorage : null,
      go: (href) => inviteAcceptNav.go(href),
    });
  };

  const accept = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await acceptInviteLink(token);
      forgetToken();
      setView({ kind: "accepted", result });
      if (result.selected) {
        await goFresh();
        return;
      }
      /* the banner and the switcher must show the new company at once (they cache for a minute) */
      void queryClient.invalidateQueries({ queryKey: ["my-company-invites"] });
      void queryClient.invalidateQueries({ queryKey: ["my-companies"] });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Couldn't accept the invite. Refresh the page and try again.");
    } finally {
      setBusy(false);
    }
  };

  const switchNow = async (tenantId: string) => {
    setBusy(true);
    setActionError(null);
    try {
      await switchCompany(tenantId);
      await goFresh();
    } catch (e) {
      const r = describeSwitchRefusal(e);
      setActionError(`${r.message} ${r.description}`);
      setBusy(false);
    }
  };

  if (view.kind === "loading") {
    return <Card><p className="text-sm text-ink-3" role="status">Opening your invite…</p></Card>;
  }

  if (view.kind === "broken") {
    return (
      <Card>
        <h1 className="font-serif text-3xl mb-2 text-center">Link not complete</h1>
        <p className="text-sm text-ink-3 text-center">{INVITE_LINK_BROKEN_MESSAGE}</p>
      </Card>
    );
  }

  if (view.kind === "signed_out") {
    return (
      <Card>
        <div className="text-center">
          <h1 className="font-serif text-3xl mb-2">Sign in to see your invite</h1>
          <p className="text-sm text-ink-3 mb-6">
            Sign in with the email address this invite was sent to, the way you always do. You will come straight back here to accept it.
          </p>
          <Button asChild variant="primary" className="w-full">
            <Link href={`/login?next=${back}` as Route}>Sign in</Link>
          </Button>
        </div>
      </Card>
    );
  }

  if (view.kind === "error") {
    return (
      <Card>
        <div className="text-center">
          <h1 className="font-serif text-3xl mb-2">Could not open the invite</h1>
          <p className="text-sm text-ink-3 mb-6" role="alert">{view.message}</p>
          {view.mfa && (
            <Button asChild variant="primary" className="w-full">
              <Link href={`/mfa?next=${back}` as Route}>Open two-step sign-in</Link>
            </Button>
          )}
        </div>
      </Card>
    );
  }

  if (view.kind === "accepted") {
    const { result } = view;
    return (
      <Card>
        <div className="text-center">
          <Icon name="check_circle" size={36} className="text-emerald mx-auto mb-3" />
          <h1 className="font-serif text-3xl mb-2">Invite accepted</h1>
          <p className="text-sm text-ink-2 mb-6" role="status">
            {acceptedMessage(result)}{result.selected ? " Opening it…" : ""}
          </p>
          {!result.selected && (
            <div className="space-y-2">
              {result.tenantId && (
                <Button variant="primary" className="w-full" loading={busy} onClick={() => void switchNow(result.tenantId!)}>
                  Switch to {result.companyName} now
                </Button>
              )}
              <Button asChild variant="ghost" className="w-full">
                <Link href={GENERIC_HOME as Route}>Stay in my current company</Link>
              </Button>
            </div>
          )}
          {actionError && <p className="mt-3 text-sm text-rose-ink" role="alert">{actionError}</p>}
        </div>
      </Card>
    );
  }

  const { info } = view;
  if (info.state !== "open") {
    return (
      <Card>
        <div className="text-center">
          <h1 className="font-serif text-3xl mb-2">{TITLES[info.state]}</h1>
          <p className="text-sm text-ink-3 mb-6">{inviteLinkStateMessage(info)}</p>
          <Button asChild variant="ghost" className="w-full">
            <Link href={GENERIC_HOME as Route}>Go to the app</Link>
          </Button>
        </div>
      </Card>
    );
  }

  const company = info.companyName ?? "A company";
  return (
    <Card>
      <div className="text-center">
        <Icon name="building" size={32} className="text-ink-2 mx-auto mb-3" />
        <h1 className="font-serif text-3xl mb-2">Join {company}?</h1>
        <p className="text-sm text-ink-2">
          <b className="text-ink">{company}</b> invited you to join them as <b className="text-ink">{roleLabel(info.role)}</b>.
        </p>
        <p className="mt-2 text-xs text-ink-3 mb-6">
          Signed in as {info.signedInAs ?? info.email}. You keep your current company — after joining you can switch between them from the top bar.
        </p>
        <div className="space-y-2">
          <Button variant="primary" className="w-full" loading={busy} onClick={() => void accept()}>
            Accept and join {company}
          </Button>
          <Button asChild variant="ghost" className="w-full">
            <Link href={GENERIC_HOME as Route}>Not now</Link>
          </Button>
        </div>
        {actionError && <p className="mt-3 text-sm text-rose-ink" role="alert">{actionError}</p>}
      </div>
    </Card>
  );
}
