/**
 * R-363 — how the Enquiries list loads, and what a failed load is allowed to do to it.
 *
 * Staging report (6 Oct): "folder badalne par GET /api/inbound-emails network error".
 * Folders are filtered on the client and never call the API, so the folder click was not
 * the cause — it was where the user noticed. Two things were:
 *
 *   1. The inbox fetch ignored React Query's `signal`. A poll that was superseded (Refresh,
 *      window focus) or left behind when the page went away could not be cancelled, so it
 *      ended as a bare `TypeError: Failed to fetch` — recorded by AI Help as
 *      "GET /api/inbound-emails → network error" — instead of a quiet AbortError.
 *   2. The page showed "Could not load your enquiries" whenever `error` was set, even with
 *      a full list already on screen. The inbox polls every 20s, so ONE failed poll replaced
 *      every folder with an error box until the next good poll.
 *
 * So: abort is passed through and stays an abort; a real network failure gets a sentence a
 * person can act on; and a failed refresh keeps the mail that is already loaded.
 */
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import {
  INBOX_NEXT_CURSOR_HEADER, inboxCursorQuery, readInboxNextCursor, type InboxCursor,
} from "@/lib/queries/keyset";

export const INBOX_NETWORK_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

export function isAbortError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError";
}

export interface InboxPage {
  rows: InboundEmailRow[];
  next: InboxCursor | null;
}

/** One keyset page of the inbox. `signal` is React Query's — pass it through. */
export async function fetchInboxPage(
  cursor: InboxCursor | null,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<InboxPage> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/inbound-emails${inboxCursorQuery(cursor)}`, { signal });
  } catch (err) {
    /* Cancelled on purpose: rethrow untouched so React Query reads it as a cancel. */
    if (isAbortError(err) || signal?.aborted) throw err;
    throw new Error(INBOX_NETWORK_MESSAGE);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Could not fetch inbound emails");
  }
  const rows = (await res.json()) as InboundEmailRow[];
  return { rows, next: readInboxNextCursor(res.headers.get(INBOX_NEXT_CURSOR_HEADER)) };
}

/**
 * What the list pane shows. The full error state is only for "nothing has ever loaded";
 * a failed refresh over loaded mail keeps the list and raises `refreshFailed` instead.
 */
export function inboxListView(s: { isLoading: boolean; error: unknown; hasData: boolean }): {
  view: "loading" | "error" | "list";
  refreshFailed: boolean;
} {
  if (s.hasData) return { view: "list", refreshFailed: Boolean(s.error) };
  if (s.isLoading) return { view: "loading", refreshFailed: false };
  if (s.error) return { view: "error", refreshFailed: false };
  return { view: "list", refreshFailed: false };
}
