/**
 * R-1810 (R-1648 leftover, 24 Oct 2026) — "why did I land here?"
 *
 * When a role types a URL its menu does not give it, middleware.ts sends it to its home page
 * with `?denied=<the refused path>`. This reads that param once, says in plain words what
 * happened and what to do next (CLAUDE.md §24), then removes the param from the URL so a
 * reload or a shared link does not show the message again.
 */
"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { getCrumb } from "@/lib/nav";

/** The page's menu name for a refused path, or "that page" when the path is not a known screen. */
export function deniedPageName(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.length > 200) return "that page";
  const crumb = getCrumb(path);
  const isFallback = crumb.length === 2 && crumb[0] === "Home" && crumb[1] === "Dashboard" && path !== "/dashboard";
  return isFallback ? "that page" : crumb[crumb.length - 1];
}

export function deniedMessage(path: string): string {
  return `You don't have access to ${deniedPageName(path)}. Ask the owner for access.`;
}

export function DeniedRouteToast() {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const denied = params?.get("denied") ?? null;

  React.useEffect(() => {
    if (!denied) return;
    toast.info(deniedMessage(denied), {
      id: "route-denied",
      duration: 10_000,
      cancel: { label: "Dismiss", onClick: () => toast.dismiss("route-denied") },
    });
    const rest = new URLSearchParams(params?.toString() ?? "");
    rest.delete("denied");
    const qs = rest.toString();
    router.replace((qs ? `${pathname}?${qs}` : pathname) as never, { scroll: false });
  }, [denied, params, pathname, router]);

  return null;
}
