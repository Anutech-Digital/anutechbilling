/**
 * R-1427 — what the "Import from Google" dialog on /leads makes of an answer from
 * /api/contacts/google-fetch.
 *
 * That endpoint was retired on 10 Sep 2026 (lib/contacts/retired.ts) and answers 410
 * Gone. The dialog used to print the raw code `contact_import_retired` beside a
 * "Try again" button that can only ever get the same 410 back, and on staging the page
 * felt frozen. A 410 is FINAL: it becomes a calm "switched off" note with the way
 * forward (§24) and no retry. Kept pure so the decision is tested without a browser.
 */

export interface FetchedGoogleContact {
  resourceName: string;
  fullName:     string;
  email:        string | null;
  phone:        string | null;
  company:      string | null;
  title:        string | null;
  notes:        string | null;
}

export type GoogleFetchOutcome =
  | { kind: "preview"; contacts: FetchedGoogleContact[] }
  | { kind: "needs-connect"; message: string }
  /** Final — the feature is off. No retry, nothing to reconnect. */
  | { kind: "unavailable"; message: string }
  /** Something went wrong this time; trying again may help. */
  | { kind: "error"; message: string };

export const GOOGLE_IMPORT_OFF_MESSAGE =
  "Import from Google is switched off. Add leads with Quick add or Add lead at the top, or "
  + "export your Google contacts as a CSV file and use More → Import CSV on this page.";

const GENERIC_ERROR = "Google contacts could not be fetched right now. Try again in a minute.";

/** A body that is not JSON (an HTML error page, an empty 410) is `null`, never a throw. */
export function parseJsonBody(text: string): unknown {
  if (!text) return null;
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

function field(body: unknown, key: string): unknown {
  return body !== null && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function toContact(raw: unknown): FetchedGoogleContact | null {
  const resourceName = str(field(raw, "resourceName"));
  const fullName = str(field(raw, "fullName"));
  if (!resourceName || !fullName) return null;
  return {
    resourceName,
    fullName,
    email:   str(field(raw, "email")),
    phone:   str(field(raw, "phone")),
    company: str(field(raw, "company")),
    title:   str(field(raw, "title")),
    notes:   str(field(raw, "notes")),
  };
}

export function classifyGoogleFetch(status: number, body: unknown): GoogleFetchOutcome {
  if (status === 410) return { kind: "unavailable", message: GOOGLE_IMPORT_OFF_MESSAGE };

  if (status < 200 || status >= 300) {
    const message = str(field(body, "error"));
    if (field(body, "code") === "needs_reauth") {
      return { kind: "needs-connect", message: message ?? "Connect Google to import" };
    }
    /* A snake_case code is not a sentence a person can act on. */
    const readable = message && !/^[a-z0-9_]+$/.test(message) ? message : null;
    return { kind: "error", message: readable ?? GENERIC_ERROR };
  }

  const list = field(body, "contacts");
  const contacts = Array.isArray(list)
    ? list.map(toContact).filter((c): c is FetchedGoogleContact => c !== null)
    : [];
  return { kind: "preview", contacts };
}
