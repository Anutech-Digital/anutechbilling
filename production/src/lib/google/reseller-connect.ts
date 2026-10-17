/**
 * R-824 — "Connect Google Reseller": where the OAuth round-trip lands, what it says there, and
 * what the Settings card says for each probe answer. Shared by the API routes and the UI, so the
 * words in a toast and on the card cannot drift apart. Plain English, no scope URLs.
 */

/** The query param the callback sets; the Settings card turns it into one toast and removes it. */
export const RESELLER_STATUS_PARAM = "greseller";

export const CONNECT_GOOGLE_RESELLER_PATH = "/api/integrations/google-reseller/connect";

/** Every outcome lands on Settings → Integrations, where the card shows the new state. */
export function resellerReturnPath(status: string): string {
  return `/settings?tab=integrations&${RESELLER_STATUS_PARAM}=${encodeURIComponent(status)}`;
}

/**
 * R-1425 — a server with no Google OAuth client is a setup state, not something that went
 * wrong (Pawan, staging 12 Oct: "Google sign-in is not set up on this server yet" arrived as
 * an error toast on Settings). Said once, in the words the card and the toast share.
 */
export const NOT_AVAILABLE_TEXT =
  "Google connect is not available on this server yet · the ResellerOS admin turns on Google sign-in";

/** `tone` picks the toast: ok → success, error → error, calm → a plain notice. */
export type ResellerOAuthTone = "ok" | "error" | "calm";

export const RESELLER_OAUTH_MESSAGES: Record<string, { ok: boolean; tone: ResellerOAuthTone; text: string }> = {
  connected: { ok: true, tone: "ok", text: "Google Reseller connected." },
  connected_scopelost: { ok: false, tone: "error", text: "Google Reseller connected, but an earlier Google permission was left unticked. Check the other Google cards below." },
  denied: { ok: false, tone: "error", text: "Google Reseller was not connected: permission was denied on Google." },
  noscope: { ok: false, tone: "error", text: "Google Reseller was not connected: the reseller permission was not ticked. Connect again and leave that box ticked." },
  badstate: { ok: false, tone: "error", text: "The Google sign-in expired. Connect again." },
  role: { ok: false, tone: "error", text: "Only an owner or manager can connect Google Reseller." },
  notconfigured: { ok: false, tone: "calm", text: NOT_AVAILABLE_TEXT },
  error: { ok: false, tone: "error", text: "Could not connect Google Reseller. Try again." },
};

/** Codes GET /api/integrations/google-reseller/subscriptions?probe=1 can answer with. */
export type ResellerProbeCode = "not_connected" | "missing_scope" | "needs_reauth" | "api_disabled" | "not_configured";

export interface ResellerCardState {
  connected: boolean;
  /** the one line under the title */
  text: string;
  /** show the Connect Google Reseller button */
  showConnect: boolean;
  connectLabel: string;
  /** R-1425: the server cannot run Google connect at all — nobody on this workspace can fix it. */
  notAvailable?: boolean;
}

export function resellerCardState(
  probe: { connected?: boolean; code?: string; connectAvailable?: boolean } | null | undefined,
): ResellerCardState {
  if (probe?.connected) return { connected: true, text: "Connected · live sync ready", showConnect: false, connectLabel: "Connect Google Reseller" };
  /* The probe can say not_connected on a server with no OAuth client (not_connected outranks
     not_configured in google-token-core). A Connect button there only leads to the
     notconfigured landing, so the probe also says whether connect can work. */
  if (probe?.code === "not_configured" || (probe?.code && probe.connectAvailable === false && probe.code !== "api_disabled")) {
    return { connected: false, text: NOT_AVAILABLE_TEXT, showConnect: false, connectLabel: "Connect Google Reseller", notAvailable: true };
  }
  switch (probe?.code as ResellerProbeCode | undefined) {
    case "needs_reauth":
      return { connected: false, text: "Google needs you to sign in again", showConnect: true, connectLabel: "Reconnect" };
    case "api_disabled":
      return { connected: false, text: "The Reseller API is turned off in Google Cloud", showConnect: false, connectLabel: "Connect Google Reseller" };
    default:
      return { connected: false, text: "Connect Google Reseller to see subscriptions", showConnect: true, connectLabel: "Connect Google Reseller" };
  }
}
