import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { daysBetween } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import { listPayByPassed, type ListTabQuote } from "@/lib/quotes/list-tab";
import { PAY_BY_PASSED_LABEL } from "@/lib/billing/proforma";

/**
 * The "Valid until" cell of a /quotes row. R-2851: a payment request past its pay-by date, unpaid, is
 * amber "Pay-by date passed — still payable" (the words the quote page uses, R-2846) — never red
 * "Expired Nd". Every other quote reads exactly as before.
 */
export function QuoteValidityCell({ q, today = istToday() }: { q: ListTabQuote; today?: string }) {
  if (q.status === "accepted" || q.status === "rejected") return <span className="text-ink-3">—</span>;
  if (listPayByPassed(q, today)) return <Badge kind="warning" dot>{PAY_BY_PASSED_LABEL}</Badge>;
  const dl = q.expires_date ? daysBetween(`${today}T00:00:00+05:30`, q.expires_date) : null;
  if (dl === null) return <span className="text-ink-3">—</span>;
  if (dl < 0) return <Badge kind="danger" dot>Expired {Math.abs(dl)}d</Badge>;
  if (dl <= 7) return <Badge kind="warning" dot>{dl}d left</Badge>;
  return <span className="text-xs text-ink-3 tabular-nums">{dl}d left</span>;
}
