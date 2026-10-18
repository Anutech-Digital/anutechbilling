/**
 * R-1523 (§24) — tells the owner, in one line, why this quote's PDF will carry no scan-to-pay QR
 * and where to fix it. Shared by the quote page and the Send dialog so the two never disagree.
 * Renders nothing when a QR will be printed.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Icon } from "@/components/ui/icon";
import { payQrNotice } from "@/lib/pdf/quote-template";

export function PayQrNotice({ upiVpa, currency, className = "" }: {
  upiVpa:    string | null | undefined;
  currency:  string | null | undefined;
  className?: string;
}) {
  const n = payQrNotice({ upiVpa, currency });
  if (!n) return null;
  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-2 rounded-md border border-amber/60 bg-amber-soft px-3 py-2 text-xs text-amber-ink ${className}`}
    >
      <Icon name="info" size={14} className="shrink-0" />
      <span className="flex-1 min-w-[12rem]">{n.text}</span>
      {n.action && (
        <Link
          href={n.action.href as Route}
          className="shrink-0 rounded-md border border-amber/60 bg-paper px-2.5 py-1 font-semibold text-amber-ink hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        >
          {n.action.label}
        </Link>
      )}
    </div>
  );
}
