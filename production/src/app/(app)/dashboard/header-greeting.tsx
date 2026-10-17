"use client";
/**
 * Dashboard header — "Friday, 16 October 2026" + "Good morning, Pawan." (R-1472).
 *
 * /dashboard is a "use client" page with no request-time data, so `next build` prerenders it
 * to static HTML ONCE. A `new Date()` read during render therefore put the BUILD day into that
 * HTML, and because the line had suppressHydrationWarning React kept the server text on
 * hydration — staging showed "Monday, 12 October" (its build day) all week.
 *
 * The clock is now read only in the browser, after mount: the server HTML holds a blank line
 * of the same height, the first client effect fills in today's IST date and greeting, and a
 * one-minute tick keeps both right on a tab left open past midnight or noon. No server/client
 * text to mismatch, so no suppressHydrationWarning is needed (R-178's reason is gone too).
 */
import * as React from "react";
import { istGreeting } from "@/lib/dates/ist";

const TICK_MS = 60_000;

/** The browser's clock — null during the server/prerender pass and the hydrating render. */
function useClientNow(): Date | null {
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = window.setInterval(() => setNow(new Date()), TICK_MS);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** "Friday, 16 October 2026" — the IST calendar day of `now`. */
export function dashboardDateLabel(now: Date): string {
  return now.toLocaleString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata",
  });
}

export function DashboardGreeting({ firstName }: { firstName: string | null }) {
  const now = useClientNow();
  return (
    <>
      <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
        {now ? dashboardDateLabel(now) : " "}
      </p>
      <h1 className="font-serif text-3xl md:text-4xl leading-tight">
        {now ? `${istGreeting(now)}${firstName ? `, ${firstName}` : ""}.` : " "}
      </h1>
    </>
  );
}
