"use client";

/**
 * R-2652 — one notice for "Zoho's daily limit is reached", shown by every Zoho read dialog
 * (Expenses → FY from Zoho, Invoices → FY sales from Zoho, Banking → Reconcile from Zoho) after
 * the read stopped retrying. Words come from zoho-limit.ts so the three dialogs say the same thing.
 */
import * as React from "react";
import { Button } from "@/components/ui/button";
import { zohoBusyText, zohoLimitText, type ZohoLimitHit } from "@/lib/integrations/zoho-books/zoho-limit";

export function ZohoLimitNotice({ hit, onTryAgain, disabled }: { hit: ZohoLimitHit; onTryAgain: () => void; disabled?: boolean }) {
  const t = zohoLimitText(hit);
  return (
    <div role="alert" data-testid="zoho-limit-notice" className="rounded-md border border-amber/50 bg-amber-soft/40 px-3 py-2 text-xs space-y-1.5">
      <p className="font-medium text-ink">{t.title}</p>
      <p className="text-ink-2">{t.body}</p>
      <Button type="button" size="sm" variant="default" disabled={disabled} onClick={onTryAgain}>Try again</Button>
    </div>
  );
}

/** The quiet line while a busy answer is being retried (1 of 3, 2 of 3) — never silent. */
export function ZohoBusyLine({ streak }: { streak: number }) {
  if (streak <= 0) return null;
  return <p role="status" data-testid="zoho-busy-line" className="text-xs text-amber-ink">{zohoBusyText(streak)}</p>;
}
