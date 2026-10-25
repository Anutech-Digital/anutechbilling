/**
 * R-1922 (G-ONBOARD OB-1): the ONE toast for a quote email that did not go — used by the
 * builder's "Save & send" and by the quote page's "Send via email" sheet, so both offer the
 * same fix. The buttons come from failedSendButtons (lib/quotes/send-quote-email.ts):
 * owner + customer messages off → "Turn on customer messages" (the switch on /automation)
 * and "Copy link instead"; anyone else → "Copy link instead" / "Open quote" plus "ask the
 * owner"; any other failure → "Try again" (when the caller can retry) and "Copy link instead".
 */
"use client";

import { toast } from "sonner";
import {
  failedSendButtons, type FailedSendButton, type Outcome, type SendQuoteEmailResult,
} from "@/lib/quotes/send-quote-email";

export function copyCustomerLink(link: string): void {
  const done = () => toast.success("Customer link copied · share via email or WhatsApp");
  const failed = () => toast.error("Could not copy the link", { description: link, duration: 15000 });
  if (!navigator.clipboard) { failed(); return; }
  navigator.clipboard.writeText(link).then(done, failed);
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
}): void {
  const b = failedSendButtons(args.res, { role: args.role, quoteId: args.quoteId, onQuotePage: args.onQuotePage });
  const press = (btn: FailedSendButton) => () => {
    if (btn.kind === "copy-link") copyCustomerLink(btn.link);
    else if (btn.kind === "retry") args.onRetry?.();
    else args.navigate(btn.href);
  };
  const usable = (btn: FailedSendButton | undefined) =>
    btn && (btn.kind !== "retry" || args.onRetry) ? btn : undefined;
  const [first, second] = [usable(b.primary), usable(b.secondary)].filter(Boolean) as FailedSendButton[];
  toast.error(args.out.title, {
    description: [args.out.description, b.note].filter(Boolean).join(" "),
    duration: 20000,
    ...(first ? { action: { label: first.label, onClick: press(first) } } : {}),
    ...(second ? { cancel: { label: second.label, onClick: press(second) } } : {}),
  });
}
