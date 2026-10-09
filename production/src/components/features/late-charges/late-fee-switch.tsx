/**
 * R-530 — the small Default / On / Off switch for late charges on a customer, subscription or
 * invoice, with the line that says what actually applies and where it comes from:
 * "Late fee: On (from customer)". Owner and manager can change it; every change is audited by
 * set_late_fee_mode.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/errors/toast-error";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadError } from "@/components/shared/load-error";
import { useLateFeeLevel, useSetLateFeeMode } from "@/lib/late-charges/queries";
import { lateFeeLabel, mayToggleLateFee, type LateFeeLevel, type LateFeeMode } from "@/lib/late-charges/rules";

const MODES: { mode: LateFeeMode; label: string }[] = [
  { mode: "default", label: "Default" },
  { mode: "on", label: "On" },
  { mode: "off", label: "Off" },
];

const LEVEL_NAME: Record<Exclude<LateFeeLevel, "company">, string> = {
  customer: "this customer",
  subscription: "this subscription",
  invoice: "this invoice",
};

export function LateFeeSwitch({ level, id, className }: {
  level: Exclude<LateFeeLevel, "company">;
  id: string;
  className?: string;
}) {
  const { data: me } = useCurrentUser();
  const q = useLateFeeLevel(me?.tenantId, level, id);
  const set = useSetLateFeeMode();
  const canChange = mayToggleLateFee(me?.role);

  if (q.isLoading) return <Skeleton className={cn("h-8 w-64", className)} />;
  if (q.isError) return <LoadError what="Late fee switch" onRetry={() => void q.refetch()} />;
  if (!q.data) return null;
  const s = q.data;

  const choose = (mode: LateFeeMode) => {
    if (mode === s.mode && !s.waived) return;
    set.mutate({ level, id, mode }, {
      onSuccess: () => toast.success(`Late fee for ${LEVEL_NAME[level]}: ${mode === "default" ? "Default" : mode === "on" ? "On" : "Off"}`),
      onError: (e) => toastError(e, { fallback: "Late fee switch not saved.", description: "Nothing changed. Only the owner or a manager can change it." }),
    });
  };

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <span className={cn("text-xs font-medium", s.effective.on ? "text-rose-ink" : "text-ink-2")}>
        {lateFeeLabel(s.effective)}
      </span>
      <div role="group" aria-label={`Late fee for ${LEVEL_NAME[level]}`} className="inline-flex rounded-md border border-hairline overflow-hidden">
        {MODES.map((m) => {
          const active = s.mode === m.mode && !(s.waived && m.mode !== "off");
          return (
            <button
              key={m.mode}
              type="button"
              aria-pressed={active}
              disabled={!canChange || set.isPending}
              onClick={() => choose(m.mode)}
              className={cn(
                "px-2.5 h-8 text-xs border-l border-hairline first:border-l-0 transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber",
                "[@media(pointer:coarse)]:min-h-10",
                active ? "bg-ink text-paper font-semibold" : "bg-paper text-ink-2 hover:bg-paper-2",
                !canChange && "cursor-not-allowed opacity-70",
              )}
            >
              {m.label}
            </button>
          );
        })}
      </div>
      {s.waived && s.waiveReason && <span className="text-xs text-ink-3">Waived: {s.waiveReason}</span>}
      {!canChange && <span className="text-xs text-ink-3">Only the owner or a manager can change this.</span>}
    </div>
  );
}
