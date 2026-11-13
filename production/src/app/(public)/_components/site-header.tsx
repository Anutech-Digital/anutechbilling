/**
 * Public website header ("Warm & approachable", design: SiteHeader artboard).
 *
 * Layout by width, following the design's rules scaled to the pages that exist
 * today (the design's full dropdown menu is for pages not built yet — Domains,
 * Hosting, Email…; linking them would only produce 404s):
 *   - md and up    nav links inline, Sign in + Start free, theme switch
 *   - below md     links move into a drawer behind the menu button
 *   - below sm     Sign in and Start free move into the drawer too
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SiteThemeToggle } from "./site-theme-toggle";

const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/pricing", label: "Pricing" },
  { href: "/about", label: "About" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  // Close the drawer on navigation, and when the window grows past it.
  React.useEffect(() => setOpen(false), [pathname]);
  React.useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const onChange = () => { if (mq.matches) setOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return (
    <header className="site-header sticky top-0 z-50">
      <div className="mx-auto flex max-w-[1320px] items-center gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link href="/" aria-label="ResellerOS — home" className="flex flex-none items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-amber text-white">
            <Icon name="layout" className="h-[18px] w-[18px]" />
          </span>
          <span className="font-serif text-xl text-ink">ResellerOS</span>
        </Link>

        <nav aria-label="Main" className="hidden flex-1 items-center justify-center gap-1 md:flex">
          {NAV.map((n) => (
            <Link
              key={n.href}
              href={n.href as never}
              className="site-navlink"
              aria-current={pathname === n.href ? "page" : undefined}
            >
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="flex-1 md:hidden" />

        <Link href="/login" className="site-btn-outline hidden justify-center sm:inline-flex">
          Sign in
        </Link>
        <Button asChild variant="cta" className="hidden h-11 px-5 text-[15px] sm:inline-flex">
          <Link href="/signup">Start free</Link>
        </Button>
        <SiteThemeToggle />
        <button
          type="button"
          className="site-menu-btn md:hidden"
          aria-expanded={open}
          aria-controls="site-mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((v) => !v)}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </div>

      {open && (
        <div id="site-mobile-menu" className="site-drawer absolute inset-x-0 top-full max-h-[calc(100vh-66px)] overflow-y-auto md:hidden">
          <nav aria-label="Main" className="mx-auto flex max-w-[760px] flex-col px-4 pb-5 pt-2">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href as never}
                className="site-drawer-link"
                aria-current={pathname === n.href ? "page" : undefined}
              >
                {n.label}
              </Link>
            ))}
            <div className="flex flex-wrap gap-2.5 pt-4 sm:hidden">
              <Link href="/login" className="site-btn-outline flex min-h-[50px] flex-[1_1_200px] justify-center">
                Sign in
              </Link>
              <Button asChild variant="cta" className="h-[50px] flex-[1_1_200px] text-base">
                <Link href="/signup">Start free</Link>
              </Button>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
