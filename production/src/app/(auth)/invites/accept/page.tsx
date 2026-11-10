"use client";

/**
 * /invites/accept#token=…  — R-2517: the link in the email that invites a login which already works
 * in another company. Not in middleware's AUTH_PREFIXES, so a signed-in person stays here; not in
 * PROTECTED_PREFIXES, so every role reaches it (the role guard would send most roles away) — the
 * API routes it calls need the session, and the database checks token + login + two-step sign-in.
 *
 * The token is in the link's FRAGMENT, which a browser never sends to a server (no request log,
 * proxy or error report holds it). The page moves it into this tab's sessionStorage and takes it
 * off the address bar, so Sign in / two-step sign-in can come back to plain /invites/accept.
 * ?token=… is still read (an older link). Logic: components/features/team/invite-accept-panel.tsx.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { INVITE_ACCEPT_PATH, InviteAcceptPanel } from "@/components/features/team/invite-accept-panel";
import { INVITE_LINK_SLOT, inviteTokenFromLocation } from "@/lib/auth/company-invites";

export default function InviteAcceptPage() {
  const [token, setToken] = React.useState<string | null>(null);

  React.useEffect(() => {
    const fromUrl = inviteTokenFromLocation(window.location.hash, window.location.search);
    let t = fromUrl;
    let kept = false;
    try {
      if (fromUrl) { window.sessionStorage.setItem(INVITE_LINK_SLOT, fromUrl); kept = true; }
      else t = window.sessionStorage.getItem(INVITE_LINK_SLOT) ?? "";
    } catch { /* storage blocked: the token stays in the address bar so a reload still works */ }
    if (kept) window.history.replaceState(null, "", INVITE_ACCEPT_PATH);
    setToken(t);
  }, []);

  if (token === null) {
    return <Card><p className="text-sm text-ink-3" role="status">Opening your invite…</p></Card>;
  }
  return <InviteAcceptPanel token={token} />;
}
