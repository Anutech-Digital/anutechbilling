/**
 * R-1425 — "Gmail" as the email sender when Google is not ready.
 *
 * Pawan (staging, 12 Oct 2026) pressed Gmail on a workspace with no Google connection and
 * got a raw 409 toast. The server was right to refuse — Gmail cannot send without a
 * connected account — but a refusal is a setup state, not an error. This decides the calm
 * notice the card shows instead: what is missing and the one next step. The card checks it
 * BEFORE sending the PATCH, and maps the server's 409 `code` to the same notice, so both
 * paths say the same words.
 */

export const GMAIL_CONNECT_PATH = "/api/integrations/google-gmail/connect";

/** Codes PATCH /api/integrations/email-provider answers its 409s with. */
export type GmailSaveCode = "google_not_configured" | "google_not_connected" | "google_send_scope_missing";

export interface GmailNotice {
  kind: "not_available" | "connect_first" | "reconnect";
  text: string;
  /** Where the Connect button goes; null when connecting cannot work on this server. */
  connectHref: string | null;
}

const NOTICES: Record<GmailNotice["kind"], GmailNotice> = {
  not_available: {
    kind: "not_available",
    text: "Gmail sending is not available on this server yet — Google sign-in has not been turned on here. The ResellerOS admin sets it up; until then Resend sends your mail.",
    connectHref: null,
  },
  connect_first: {
    kind: "connect_first",
    text: "Connect Google first. The sending account has not connected a Google account yet — press Connect, allow “Send email on your behalf”, then choose Gmail again.",
    connectHref: GMAIL_CONNECT_PATH,
  },
  reconnect: {
    kind: "reconnect",
    text: "The Google account is connected but without permission to send. Press Connect again and keep “Send email on your behalf” ticked, then choose Gmail.",
    connectHref: GMAIL_CONNECT_PATH,
  },
};

export interface GmailChoiceInput {
  /** From GET /api/integrations/email-provider; absent on an older server → assume configured. */
  googleConfigured?: boolean;
  gmail: { canSend: boolean; email: string | null };
}

/** Null when Gmail can be chosen right now. */
export function gmailChoiceBlocker(d: GmailChoiceInput): GmailNotice | null {
  if (d.gmail.canSend) return null;
  if (d.googleConfigured === false) return NOTICES.not_available;
  return d.gmail.email ? NOTICES.reconnect : NOTICES.connect_first;
}

/** The PATCH's 409 as the same notice; null for anything that is not a Google setup state. */
export function gmailNoticeForSaveError(status: number, body: unknown): GmailNotice | null {
  if (status !== 409) return null;
  const code = typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
  switch (code as GmailSaveCode | undefined) {
    case "google_not_configured": return NOTICES.not_available;
    case "google_send_scope_missing": return NOTICES.reconnect;
    default: return NOTICES.connect_first;
  }
}
