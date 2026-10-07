/**
 * What happened when someone pressed "Connect" for Gmail — as a plain sentence on screen.
 *
 * ─── WHY (R-160, 7 Oct 2026) ────────────────────────────────────────────────
 * A second tenant (Excel Technologies) reported "error while connecting Google for email".
 * The callback already knew the reason — it redirects to `?gmail=denied|badstate|noscope|…`
 * — but no screen read `gmail=`, so every failure looked like nothing happened. And Google's
 * own error code (`admin_policy_enforced`, `redirect_uri_mismatch`, `invalid_grant`) was
 * flattened to "denied"/"error", so even the URL could not say whose move it was.
 *
 * Outcomes are split by WHO must act: the user (connect again, tick the box), their Google
 * Workspace admin (app blocked by policy), or the ResellerOS admin (keys / redirect URI in
 * Google Cloud). Texts never carry Google's raw JSON or any key.
 */

export const GMAIL_CONNECT_OUTCOMES = [
  "connected",
  "connected_scopelost",
  "denied",
  "admin_blocked",
  "google_error",
  "badstate",
  "noscope",
  "notconfigured",
  "vault_missing",
  "notenant",
  "redirect_mismatch",
  "client_rejected",
  "code_expired",
  "save_failed",
  "error",
] as const;

export type GmailConnectOutcome = (typeof GMAIL_CONNECT_OUTCOMES)[number];

export interface GmailConnectMessage {
  kind: "ok" | "warn" | "error";
  text: string;
}

const MESSAGES: Record<GmailConnectOutcome, GmailConnectMessage> = {
  connected: { kind: "ok", text: "Google account connected. Choose Gmail as the provider to send from it." },
  connected_scopelost: {
    kind: "warn",
    text: "Gmail connected, but Google removed another permission (Contacts). Reconnect Google Contacts to restore sync.",
  },
  denied: {
    kind: "error",
    text: "Google sign-in was cancelled or Allow was not pressed. Click Connect again and press Allow.",
  },
  admin_blocked: {
    kind: "error",
    text: "Your Google Workspace admin blocks this app. Ask them to allow ResellerOS in Google Admin (Security, API controls), then connect again.",
  },
  google_error: {
    kind: "error",
    text: "Google refused the sign-in. Click Connect again; if it repeats, tell the ResellerOS admin.",
  },
  badstate: {
    kind: "error",
    text: "The Google sign-in expired or was opened in another tab. Connect again and finish within 10 minutes.",
  },
  noscope: {
    kind: "error",
    text: "The 'Send email on your behalf' permission was not ticked. Connect again and keep the Gmail boxes ticked.",
  },
  notconfigured: {
    kind: "error",
    text: "Google sign-in is not set up on this server (app keys missing). Ask the ResellerOS admin.",
  },
  vault_missing: {
    kind: "error",
    text: "This server has no encryption key, so the Google connection was not saved. Ask the ResellerOS admin to set it, then connect again.",
  },
  notenant: {
    kind: "error",
    text: "Your login is not linked to a workspace, so the Google account could not be saved. Ask your workspace owner.",
  },
  redirect_mismatch: {
    kind: "error",
    text: "Google does not accept this web address for sign-in. The ResellerOS admin must register it in Google Cloud.",
  },
  client_rejected: {
    kind: "error",
    text: "Google rejected this app's sign-in keys. The ResellerOS admin must check the Google OAuth client.",
  },
  code_expired: {
    kind: "error",
    text: "The Google sign-in code expired or was already used. Connect again.",
  },
  save_failed: {
    kind: "error",
    text: "Google allowed access, but saving the connection failed. Connect again; if it repeats, tell support.",
  },
  error: {
    kind: "error",
    text: "Google connection failed for an unknown reason. Connect again; if it repeats, tell support with the time.",
  },
};

export function gmailConnectMessage(outcome: GmailConnectOutcome): GmailConnectMessage {
  return MESSAGES[outcome];
}

/** `?gmail=` comes from the URL — anything unknown is ignored, never echoed. */
export function parseGmailConnectOutcome(v: string | null | undefined): GmailConnectOutcome | null {
  return v && (GMAIL_CONNECT_OUTCOMES as readonly string[]).includes(v) ? (v as GmailConnectOutcome) : null;
}

/** The `error` param Google adds when it sends the user back without a code. */
export function outcomeFromGoogleError(code: string): GmailConnectOutcome {
  if (code === "access_denied") return "denied";
  if (code === "admin_policy_enforced" || code === "org_internal") return "admin_blocked";
  return "google_error";
}

/** `exchangeCode` throws with Google's body in the message; pick out the OAuth error code. */
export function outcomeFromExchangeError(e: unknown): GmailConnectOutcome {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("redirect_uri_mismatch")) return "redirect_mismatch";
  if (msg.includes("invalid_client") || msg.includes("unauthorized_client")) return "client_rejected";
  if (msg.includes("invalid_grant")) return "code_expired";
  return "error";
}
