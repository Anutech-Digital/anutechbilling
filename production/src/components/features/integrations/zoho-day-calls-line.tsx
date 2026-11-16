"use client";

/**
 * R-2661 — "Zoho calls today: 612 of 900" on every Zoho read dialog (FY sales / purchases / receipts,
 * Reconcile from Zoho), so the owner sees how much of Zoho's daily limit the company has used before
 * pressing Read. Read from GET /api/integrations/zoho-books/day-calls (the company's own row; the
 * budget comes from the server, one place). Shown only once it is known — a failed read shows nothing
 * (never a wrong number). `refreshKey` changing (a read finished) reads it again.
 */
import * as React from "react";
import { IST_TZ } from "@/lib/dates/ist";
import { zohoDayCallsLabel } from "@/lib/integrations/zoho-books/zoho-day-budget";

export const DAY_CALLS_URL = "/api/integrations/zoho-books/day-calls";

export interface DayCallsAnswer { ok: true; day: string; calls: number; budget: number; limitHitAt: string | null; spent: boolean; retryAt: number }

function isAnswer(v: unknown): v is DayCallsAnswer {
  const a = v as Partial<DayCallsAnswer> | null;
  return !!a && a.ok === true && typeof a.calls === "number" && typeof a.budget === "number" && Number.isFinite(a.calls) && Number.isFinite(a.budget);
}

/** "Zoho refused (daily limit) at 9:54 am IST" */
export function limitHitLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "Zoho refused (daily limit) today";
  const time = new Date(t).toLocaleTimeString("en-IN", { timeZone: IST_TZ, hour: "numeric", minute: "2-digit" });
  return `Zoho refused (daily limit) at ${time} IST`;
}

export function dayCallsText(a: Pick<DayCallsAnswer, "calls" | "budget" | "limitHitAt">): string {
  return a.limitHitAt ? `${zohoDayCallsLabel(a)} · ${limitHitLabel(a.limitHitAt)}` : zohoDayCallsLabel(a);
}

export function ZohoDayCallsLine({ refreshKey }: { refreshKey?: unknown }) {
  const [answer, setAnswer] = React.useState<DayCallsAnswer | null>(null);
  React.useEffect(() => {
    let gone = false;
    void (async () => {
      try {
        const res = await fetch(DAY_CALLS_URL, { method: "GET", headers: { accept: "application/json" } });
        if (!res.ok) return;
        const body: unknown = await res.json();
        if (!gone && isAnswer(body)) setAnswer(body);
      } catch { /* shown only when known */ }
    })();
    return () => { gone = true; };
  }, [refreshKey]);
  if (!answer) return null;
  return (
    <p data-testid="zoho-day-calls" role="status" className={`text-xs ${answer.spent ? "text-amber-ink" : "text-ink-2"}`}>
      {dayCallsText(answer)}
    </p>
  );
}
