/**
 * ThemeProvider — wraps next-themes for dark/light/system mode.
 * No-flash dark mode supported via the `class` strategy.
 *
 * R-2187: inside the signed-in app the default is "system" — until the user picks Light or Dark in
 * the header (components/layout/theme-menu.tsx), the app follows the OS prefers-color-scheme, live.
 * A stored Light/Dark choice wins. Every other page (website, buy/checkout, login, public links)
 * is designed light only (hard-coded white panels) and has no theme control, so it is forced light
 * — an OS in dark mode must never turn a checkout into light text on white.
 */
"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes";

/** First path segments of the signed-in app — the folders of src/app/(app) (a test keeps them equal). */
export const APP_SHELL_SEGMENTS: ReadonlySet<string> = new Set([
  "aa", "academy", "account", "accounting", "activity", "admin", "ai-entry", "assessments",
  "assets", "attendance", "automation", "campaigns", "collections", "compliance", "contacts",
  "coupons", "customers", "dashboard", "deals", "documents", "enquiries", "help",
  "hosting-domains", "invoices", "items", "lead-gen", "leads", "marketing", "mobile", "money",
  "my-expenses", "online-orders", "online-promos", "partners", "payments", "performance",
  "platform", "products", "projects", "provisioning", "purchase-orders", "purchases", "quality",
  "quotes", "referrals", "renewals", "reports", "scorecard", "settings", "setup",
  "subscriptions", "support", "tasks", "team", "team-chat", "today", "ui-insights", "upgrade",
  "ux-insights", "vault", "whatsapp",
]);

/** True when `pathname` is a page of the signed-in app (the one with the header theme menu). */
export function isAppShellPath(pathname: string | null | undefined): boolean {
  const first = (pathname ?? "").split("/").filter(Boolean)[0];
  return !!first && APP_SHELL_SEGMENTS.has(first);
}

export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  const pathname = usePathname();
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      forcedTheme={isAppShellPath(pathname) ? undefined : "light"}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
