import * as React from "react";
import { cn } from "@/lib/utils";

export type StatusType =
  | "active"
  | "expiring"
  | "overdue"
  | "draft"
  | "paid"
  | "pending"
  | "accepted"
  | "sent"
  | "cancelled"
  | "completed";

interface StatusPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: StatusType | string;
  label?: string;
  showPulse?: boolean;
  size?: "sm" | "md";
}

const statusConfig: Record<
  string,
  { bg: string; text: string; border: string; dotBg: string; pulseBg: string; defaultLabel: string }
> = {
  active: {
    bg: "bg-emerald-500/10 dark:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300 font-medium",
    border: "border-emerald-500/20 dark:border-emerald-500/30",
    dotBg: "bg-emerald-500",
    pulseBg: "bg-emerald-400",
    defaultLabel: "Active",
  },
  paid: {
    bg: "bg-emerald-500/10 dark:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300 font-medium",
    border: "border-emerald-500/20 dark:border-emerald-500/30",
    dotBg: "bg-emerald-500",
    pulseBg: "bg-emerald-400",
    defaultLabel: "Paid",
  },
  completed: {
    bg: "bg-emerald-500/10 dark:bg-emerald-500/20",
    text: "text-emerald-700 dark:text-emerald-300 font-medium",
    border: "border-emerald-500/20 dark:border-emerald-500/30",
    dotBg: "bg-emerald-500",
    pulseBg: "bg-emerald-400",
    defaultLabel: "Completed",
  },
  expiring: {
    bg: "bg-amber-500/10 dark:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-300 font-medium",
    border: "border-amber-500/20 dark:border-amber-500/30",
    dotBg: "bg-amber-500",
    pulseBg: "bg-amber-400",
    defaultLabel: "Expiring Soon",
  },
  pending: {
    bg: "bg-amber-500/10 dark:bg-amber-500/20",
    text: "text-amber-700 dark:text-amber-300 font-medium",
    border: "border-amber-500/20 dark:border-amber-500/30",
    dotBg: "bg-amber-500",
    pulseBg: "bg-amber-400",
    defaultLabel: "Pending",
  },
  sent: {
    bg: "bg-blue-500/10 dark:bg-blue-500/20",
    text: "text-blue-700 dark:text-blue-300 font-medium",
    border: "border-blue-500/20 dark:border-blue-500/30",
    dotBg: "bg-blue-500",
    pulseBg: "bg-blue-400",
    defaultLabel: "Sent",
  },
  accepted: {
    bg: "bg-teal-500/10 dark:bg-teal-500/20",
    text: "text-teal-700 dark:text-teal-300 font-medium",
    border: "border-teal-500/20 dark:border-teal-500/30",
    dotBg: "bg-teal-500",
    pulseBg: "bg-teal-400",
    defaultLabel: "Accepted",
  },
  overdue: {
    bg: "bg-rose-500/10 dark:bg-rose-500/20",
    text: "text-rose-700 dark:text-rose-300 font-medium",
    border: "border-rose-500/20 dark:border-rose-500/30",
    dotBg: "bg-rose-500",
    pulseBg: "bg-rose-400",
    defaultLabel: "Overdue",
  },
  cancelled: {
    bg: "bg-slate-500/10 dark:bg-slate-500/20",
    text: "text-slate-600 dark:text-slate-400 font-medium",
    border: "border-slate-500/20 dark:border-slate-500/30",
    dotBg: "bg-slate-400",
    pulseBg: "bg-slate-300",
    defaultLabel: "Cancelled",
  },
  draft: {
    bg: "bg-slate-500/10 dark:bg-slate-500/20",
    text: "text-slate-600 dark:text-slate-400 font-medium",
    border: "border-slate-500/20 dark:border-slate-500/30",
    dotBg: "bg-slate-400",
    pulseBg: "bg-slate-300",
    defaultLabel: "Draft",
  },
};

export function StatusPill({
  status,
  label,
  showPulse = true,
  size = "md",
  className,
  ...props
}: StatusPillProps) {
  const normalizedKey = (status || "").toLowerCase();
  const config = statusConfig[normalizedKey] || {
    bg: "bg-slate-500/10 dark:bg-slate-500/20",
    text: "text-slate-700 dark:text-slate-300 font-medium",
    border: "border-slate-500/20",
    dotBg: "bg-slate-500",
    pulseBg: "bg-slate-400",
    defaultLabel: status || "Unknown",
  };

  const displayText = label || config.defaultLabel;
  const isPulsing = showPulse && (normalizedKey === "active" || normalizedKey === "expiring" || normalizedKey === "overdue");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 tracking-wide shadow-xs transition-colors",
        size === "sm" ? "text-[11px] px-2 py-0.25" : "text-xs px-2.5 py-0.5",
        config.bg,
        config.text,
        config.border,
        className
      )}
      {...props}
    >
      <span className="relative flex h-2 w-2 items-center justify-center">
        {isPulsing && (
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
              config.pulseBg
            )}
          />
        )}
        <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", config.dotBg)} />
      </span>
      <span>{displayText}</span>
    </span>
  );
}
