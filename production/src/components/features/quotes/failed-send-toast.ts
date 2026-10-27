/**
 * R-1922 (G-ONBOARD OB-1): the ONE toast for a quote email that did not go — used by the
 * builder's "Save & send" and by the quote page's "Send via email" sheet, so both offer the
 * same fix. The buttons come from failedSendButtons (lib/quotes/send-quote-email.ts):
 * owner + customer messages off → "Turn on customer messages" (the switch on /automation)
 * and "Copy link instead"; anyone else → "Copy link instead" / "Open quote" plus "ask the
 * owner"; any other failure → "Try again" (when the caller can retry) and "Copy link instead".
 *
 * R-1956 (coordinator's localhost check, 26 Oct): (1) sonner lays a toast out as ONE flex row
 * — icon, text, cancel, action — with `overflow-wrap: anywhere` and buttons that never shrink.
 * Two long button labels left the text ~0px wide: one character per line, the buttons pushed
 * below the viewport, and the toast timed out before anyone could reach them.
 * ACTION_TOAST_CLASSNAMES wraps the row (text on its own full-width line, buttons in a row
 * under it, wrapping by word) and a toast with buttons stays until dismissed. (2) A refused
 * send leaves the quote a DRAFT and the accept page hides drafts, so "Copy link instead"
 * copied a dead link — it now marks the quote sent first (POST /api/quotes/[id]/mark-sent,
 * the same path as "Mark as sent", approval gate included) and copies only when that worked.
 */
"use client";

import { toast } from "sonner";
import {
  failedSendButtons, type FailedSendButton, type Outcome, type SendQuoteEmailResult,
} from "@/lib/quotes/send-quote-email";
import { markSentBeforeShare } from "./share-marking-sent";

/**
 * Per-toast sonner classNames for a toast that carries buttons. Sonner's own layout rules are
 * zero-specificity `:where(...)`, so these utility classes win.
 *  - toast: let the row wrap; a little more room between the text line and the button line.
 *  - content: take the whole first line beside the 16px icon (+ its margins and the 6px gap),
 *    so the buttons wrap below it; break at words, not at any character.
 */
export const ACTION_TOAST_CLASSNAMES = {
  toast: "flex-wrap gap-y-3",
  content: "min-w-0 basis-[calc(100%-24px)] grow [overflow-wrap:break-word]",
} as const;

/** Sonner's "never time out" — a toast whose buttons are the next step waits for a click. */
export const STAY_UNTIL_DISMISSED = Infinity;

export function copyCustomerLink(link: string, opts: { markedSent?: boolean } = {}): void {
  const done = () => toast.success(
    opts.markedSent ? "Quote marked as sent · customer link copied" : "Customer link copied · share via email or WhatsApp",
    opts.markedSent ? { description: "Share it via email or WhatsApp." } : undefined,
  );
  const failed = () => toast.error("Could not copy the link", { description: link, duration: 15000 });
  if (!navigator.clipboard) { failed(); return; }
  navigator.clipboard.writeText(link).then(done, failed);
}

/**
 * Copy the customer's accept link — marking a DRAFT as sent first, because the accept page
 * shows nothing for a draft. If marking it sent is refused (approval gate, role, a stale
 * page) the reason is shown and nothing is copied. Resolves true when the quote was marked sent.
 */
export async function copyLinkMarkingSent(args: {
  quoteId: string;
  link: string;
  quoteStatus: string | null | undefined;
  /** Refresh the caller's cached quote / leads after the status changed. */
  onMarkedSent?: () => void;
}): Promise<boolean> {
  /* R-1961: the same mark-sent step as both WhatsApp shares (share-marking-sent.ts). */
  const r = await markSentBeforeShare({
    quoteId: args.quoteId, quoteStatus: args.quoteStatus, channel: "copy", onMarkedSent: args.onMarkedSent,
  });
  if (!r.ok) return false;
  copyCustomerLink(args.link, { markedSent: r.markedSent });
  return r.markedSent;
}

export function showFailedSendToast(args: {
  out: Outcome;
  /** The route's answer; null when the request itself failed. */
  res: SendQuoteEmailResult | null;
  role: string | null | undefined;
  quoteId: string;
  /** The Send sheet on the quote page — no "Open quote" button there. */
  onQuotePage?: boolean;
  navigate: (href: string) => void;
  /** Omit where the caller's own form is the retry (the Send sheet stays open). */
  onRetry?: () => void;
  /** R-1956: "Copy link instead" marked the draft sent — refresh the caller's cache. */
  onMarkedSent?: () => void;
}): void {
  const b = failedSendButtons(args.res, { role: args.role, quoteId: args.quoteId, onQuotePage: args.onQuotePage });
  const press = (btn: FailedSendButton) => () => {
    if (btn.kind === "copy-link") {
      void copyLinkMarkingSent({
        quoteId: args.quoteId, link: btn.link,
        quoteStatus: args.res?.quoteStatus, onMarkedSent: args.onMarkedSent,
      });
    } else if (btn.kind === "retry") args.onRetry?.();
    else args.navigate(btn.href);
  };
  const usable = (btn: FailedSendButton | undefined) =>
    btn && (btn.kind !== "retry" || args.onRetry) ? btn : undefined;
  const [first, second] = [usable(b.primary), usable(b.secondary)].filter(Boolean) as FailedSendButton[];
  toast.error(args.out.title, {
    description: [args.out.description, b.note].filter(Boolean).join(" "),
    ...(first
      ? { duration: STAY_UNTIL_DISMISSED, classNames: ACTION_TOAST_CLASSNAMES }
      : { duration: 20000 }),
    ...(first ? { action: { label: first.label, onClick: press(first) } } : {}),
    ...(second ? { cancel: { label: second.label, onClick: press(second) } } : {}),
  });
}
