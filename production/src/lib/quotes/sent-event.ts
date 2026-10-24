/**
 * R-1718 — the "sent" line of a quote's activity timeline says only what really happened.
 *
 * The quote page wrote "Sent to customer — Quote shared with <customer>" for EVERY quote past
 * draft. Q-F588-27-0034 / -0037 were accepted without any email going out (quote_send_log has
 * no row for them), and the timeline still claimed one did.
 *
 * Now:
 *   an email really went (quote_send_log status "sent")  → "Sent to customer", to whom, when
 *   status sent/viewed without one ("Mark as sent")      → "Marked as sent" — the words that
 *                                                          button and its toast already use
 *   anything else (accepted / rejected without a send)   → no sent line at all
 * A "failed" send did not reach anyone, and "stubbed" means no email provider was set up —
 * neither is "sent".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export interface QuoteSendRow {
  status: string;
  sent_at: string;
  recipient_email: string;
}

export interface QuoteSentEvent {
  title: "Sent to customer" | "Marked as sent";
  body: string;
  /** When it was sent; null = not known (the caller shows the quote's last change). */
  at: string | null;
}

export function quoteSentEvent(
  quote: { status: string; customer_name?: string | null },
  sends: readonly QuoteSendRow[] | undefined,
): QuoteSentEvent | null {
  if (quote.status === "draft") return null;
  const sent = (sends ?? [])
    .filter((s) => s.status === "sent")
    .sort((a, b) => a.sent_at.localeCompare(b.sent_at));
  const last = sent[sent.length - 1];
  if (last) return { title: "Sent to customer", body: `Quote emailed to ${last.recipient_email}`, at: last.sent_at };
  if (quote.status === "sent" || quote.status === "viewed") {
    return { title: "Marked as sent", body: "Status set by hand — no email went from the app", at: null };
  }
  return null;
}

/** This quote's email sends (quote_send_log), oldest first. */
export function useQuoteSends(quoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["quotes", quoteId, "send-log"],
    enabled: !!quoteId,
    queryFn: async (): Promise<QuoteSendRow[]> => {
      const { data, error } = await createClient()
        .from("quote_send_log")
        .select("status, sent_at, recipient_email")
        .eq("quote_id", quoteId!)
        .order("sent_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as QuoteSendRow[];
    },
  });
}
