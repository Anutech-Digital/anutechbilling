/**
 * R-2047 — the amber note on a TDS receivable entry whose TDS is not rate × gross, and the
 * "Effective" rate beside Rate. Read from lib/accounting/tds-mismatch (pure). The stored TDS is
 * never changed here: it is the real deduction (26AS shows it); the note only explains it.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { TdsMismatch } from "@/lib/accounting/tds-mismatch";

/** "11.80%" — TDS ÷ gross; render only when tdsMismatch found a difference. */
export function EffectiveRate({ pct, className = "" }: { pct: number; className?: string }) {
  return (
    <span className={`text-amber-ink text-xs ${className}`} data-testid="tds-effective-rate">
      Effective {pct.toFixed(2)}%
    </span>
  );
}

/**
 * The note. `withNextStep` adds the copyable "Ask the customer…" line (detail view); the list
 * shows the note alone so each fact is said once per row.
 */
export function TdsMismatchNote({ mismatch, withNextStep = false }: { mismatch: TdsMismatch; withNextStep?: boolean }) {
  const next = withNextStep ? mismatch.nextStep : null;
  return (
    <div className="rounded-md bg-amber-soft/60 px-2.5 py-2 text-xs text-amber-ink" data-testid="tds-mismatch-note">
      <div className="flex items-start gap-1.5">
        <Icon name="alert" size={12} className="mt-0.5 flex-shrink-0" />
        <span>{mismatch.note}</span>
      </div>
      {next && (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 pl-[18px]">
          <span><span className="font-semibold">Next step:</span> {next}</span>
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => { void navigator.clipboard?.writeText(next); toast.success("Copied"); }}
          >
            Copy
          </Button>
        </div>
      )}
    </div>
  );
}
