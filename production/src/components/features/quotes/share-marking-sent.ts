/**
 * R-1961 — the ONE "share the customer's accept link" step for a quote: Copy customer link /
 * Copy link instead (R-1956), the quote page's "Send on WhatsApp" (free wa.me / web.whatsapp
 * share) and the WhatsApp dialog (Cloud API) all go through markSentBeforeShare.
 *
 * Why: the accept page shows nothing for a DRAFT (app/(public)/quote/[id]/accept/visibility.ts),
 * so a link shared from a draft is dead. A draft is first marked sent through
 * POST /api/quotes/[id]/mark-sent — the same path as "Mark as sent", approval gate included — and
 * the link leaves the app only when that worked. A refusal shows the server's reason (for the
 * approval gate it names the next step) and shares nothing.
 */
"use client";

import { toast } from "sonner";
import { markQuoteSent, copyNeedsMarkSent, type MarkQuoteSentResult } from "@/lib/quotes/mark-quote-sent";

export type ShareChannel = "copy" | "whatsapp-link" | "whatsapp-dialog";

/** What happened, per channel — the reason (and its next step) goes in the description. */
export const SHARE_REFUSED_TITLE: Record<ShareChannel, string> = {
  "copy": "Link not copied — the quote is still a draft",
  "whatsapp-link": "WhatsApp not opened — the quote is still a draft",
  "whatsapp-dialog": "WhatsApp not sent — the quote is still a draft",
};

export type MarkSentBeforeShareResult = { ok: true; markedSent: boolean } | { ok: false; markedSent: false };

/**
 * Make the quote's link openable before it is shared: a draft is marked sent (mark-sent route);
 * any other status needs nothing. `ok: false` = refused — the reason is already on screen and
 * the caller must not share the link.
 */
export async function markSentBeforeShare(args: {
  quoteId: string;
  quoteStatus: string | null | undefined;
  channel: ShareChannel;
  /** Refresh the caller's cached quote / leads after the status changed. */
  onMarkedSent?: () => void;
  markSent?: (quoteId: string) => Promise<MarkQuoteSentResult>;
}): Promise<MarkSentBeforeShareResult> {
  if (!copyNeedsMarkSent(args.quoteStatus)) return { ok: true, markedSent: false };
  try {
    const r = await (args.markSent ?? ((id: string) => markQuoteSent(id)))(args.quoteId);
    args.onMarkedSent?.();
    return { ok: true, markedSent: r.changed };
  } catch (err) {
    toast.error(SHARE_REFUSED_TITLE[args.channel], {
      description: err instanceof Error ? err.message : String(err),
      duration: 15000,
    });
    return { ok: false, markedSent: false };
  }
}

/**
 * Open a WhatsApp share link (wa.me / web.whatsapp.com) for a quote, marking a draft sent first.
 *
 * Pop-up blockers only allow a window opened inside the click itself, and mark-sent is a network
 * round trip — so for a draft the tab is opened at once (about:blank), and pointed at WhatsApp
 * once mark-sent said yes; a refusal closes it. A quote that is already sent opens directly.
 * Call it synchronously from the click handler (no await before it).
 */
export async function openWhatsAppMarkingSent(args: {
  quoteId: string;
  quoteStatus: string | null | undefined;
  url: string;
  onMarkedSent?: () => void;
}): Promise<{ refused: boolean; opened: boolean; markedSent: boolean }> {
  if (!copyNeedsMarkSent(args.quoteStatus)) {
    window.open(args.url, "_blank", "noopener,noreferrer");
    return { refused: false, opened: true, markedSent: false };
  }
  // Not "noopener" here: with it window.open returns null and the tab could not be pointed later.
  const tab = window.open("about:blank", "_blank");
  const r = await markSentBeforeShare({
    quoteId: args.quoteId, quoteStatus: args.quoteStatus, channel: "whatsapp-link", onMarkedSent: args.onMarkedSent,
  });
  if (!r.ok) {
    tab?.close();
    return { refused: true, opened: false, markedSent: false };
  }
  if (tab && !tab.closed) {
    try { tab.opener = null; } catch { /* cross-origin already — nothing to cut */ }
    tab.location.href = args.url;
    return { refused: false, opened: true, markedSent: r.markedSent };
  }
  // The blank tab was blocked or closed: the quote IS sent now — offer the link on a fresh click.
  toast.success(r.markedSent ? "Quote marked as sent" : "Quote is sent", {
    description: "Your browser blocked the WhatsApp tab. Press Open WhatsApp to continue.",
    duration: 30000,
    action: { label: "Open WhatsApp", onClick: () => { window.open(args.url, "_blank", "noopener,noreferrer"); } },
  });
  return { refused: false, opened: false, markedSent: r.markedSent };
}
