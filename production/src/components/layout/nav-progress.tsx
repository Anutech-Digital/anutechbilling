/**
 * R-2186 — instant feedback for a menu click.
 *
 * In dev a click on a sidebar row left the old page frozen for 6–12 s (route compile + data)
 * with nothing to show the click landed, so people clicked again. loading.tsx (R-052) only
 * appears once the new route's code is in. This store is set SYNCHRONOUSLY in the click
 * handler, so the clicked row highlights and a thin bar runs along the top of the window in the
 * same frame; the bar ends when the pathname changes (the new page is painting).
 *
 * One small module store (not React context) so the sidebar, the phone drawer (which unmounts
 * on click) and the bar in the app layout all read the same value.
 */
"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

type Pending = { href: string; from: string } | null;

let pending: Pending = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** A safety stop: a navigation that never lands (offline, blocked) must not leave the bar running. */
export const NAV_PENDING_MAX_MS = 15_000;
let safety: ReturnType<typeof setTimeout> | null = null;

const pathOf = (href: string) => href.split(/[?#]/)[0] || "/";

/** Start a pending navigation from `from` (the current pathname) to `href`. Same page → nothing. */
export function startNavPending(href: string, from: string): void {
  if (pathOf(href) === from) return;
  pending = { href, from };
  if (safety) clearTimeout(safety);
  safety = setTimeout(clearNavPending, NAV_PENDING_MAX_MS);
  emit();
}

export function clearNavPending(): void {
  if (safety) { clearTimeout(safety); safety = null; }
  if (pending === null) return;
  pending = null;
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** The href being navigated to, or null. Only while still on the page the click came from. */
export function useNavPending(): string | null {
  const p = React.useSyncExternalStore(subscribe, () => pending, () => null);
  const pathname = usePathname();
  return p && p.from === pathname ? p.href : null;
}

/** A plain left click that the router handles in this tab (not Ctrl/Cmd/Shift/Alt, not middle). */
export function isSameTabClick(e: React.MouseEvent): boolean {
  return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;
}

/**
 * Click handler for a menu link: marks it pending (same-tab clicks only), then runs `then`
 * (the phone drawer's close). External links never pend — they open a new tab.
 */
export function pendOnClick(href: string, from: string, then?: () => void, external?: boolean) {
  return (e: React.MouseEvent) => {
    if (!external && isSameTabClick(e)) startNavPending(href, from);
    then?.();
  };
}

/** The thin bar along the top of the window while a menu navigation is pending. Mount once. */
export function NavProgressBar() {
  const pathname = usePathname();
  const href = useNavPending();
  // The route changed → the new page is painting; the click's wait is over.
  React.useEffect(() => { clearNavPending(); }, [pathname]);

  // Grow from a visible start toward (never reaching) the end, so a long wait still moves.
  const [grown, setGrown] = React.useState(false);
  React.useEffect(() => {
    if (!href) { setGrown(false); return; }
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, [href]);

  if (!href) return null;
  return (
    <div
      data-testid="nav-progress"
      role="progressbar"
      aria-label="Opening page"
      aria-busy="true"
      className="fixed top-0 inset-x-0 z-[10000] h-0.5 pointer-events-none"
    >
      <div
        className="h-full bg-amber transition-[width] ease-out motion-reduce:transition-none"
        style={{ width: grown ? "85%" : "15%", transitionDuration: grown ? "8s" : "0s" }}
      />
    </div>
  );
}
