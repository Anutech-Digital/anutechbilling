/**
 * MobileBottomNav — sticky bottom tab bar for phone-sized screens.
 *
 * Why: on mobile, the sidebar lives behind a hamburger menu — fine for
 * occasional navigation, terrible for the 5 most-used sections. A bottom
 * tab bar in the thumb zone (matches WhatsApp, Gmail, every banking app
 * in India) makes those one-tap navigations a thumb flick away.
 *
 * Layout:
 *   - hidden md:hidden (mobile only, < 768px)
 *   - fixed bottom-0 inset-x-0 (full-width bar at viewport bottom)
 *   - safe-area-padding-bottom for iPhone notch / Android gesture bar
 *   - bg-paper with top border
 *   - 3–5 equal-width slots (depending on role + permissions)
 *
 * Role-aware tab set:
 *   • Owner / Manager  →  Home · Payments · Customers · Renewals · More (5 tabs)
 *       (money-first — an owner checking the business from their phone cares
 *        about cash-in / who owes / renewals, not the rep's pipeline. Leads &
 *        Deals stay one tap away in More.)
 *   • Sales (+deals)   →  Leads · Deals · Tasks · More           (4 tabs)
 *   • Sales (no deals) →  Leads · Tasks · More                   (3 tabs)
 *
 * Sales doesn't see Home (dashboard isn't accessible to them per RLS +
 * middleware) or Quotes (sales role hidden from Revenue section in
 * APP_NAV). Showing tabs that route to redirects was confusing.
 *
 * Active state matches current pathname start (so /quotes/Q-2026-27-0001
 * still highlights the Quotes tab).
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { cn } from "@/lib/utils";

interface BottomNavItem {
  id:     string;
  href:   string;
  label:  string;
  icon:   string;
  /** When set, clicking opens a sheet rather than navigating. */
  action?: "menu";
}

// Tab templates. We pick a subset of these based on role + permissions.
const TAB_HOME:      BottomNavItem = { id: "home",      href: "/dashboard",     label: "Home",      icon: "home"   };
const TAB_LEADS:     BottomNavItem = { id: "leads",     href: "/leads",         label: "Leads",     icon: "inbox"  };
const TAB_DEALS:     BottomNavItem = { id: "deals",     href: "/deals",         label: "Deals",     icon: "target" };
const TAB_TASKS:     BottomNavItem = { id: "tasks",     href: "/tasks",         label: "Tasks",     icon: "clock"  };
// Owner/manager money-first tabs
const TAB_PAYMENTS:  BottomNavItem = { id: "payments",  href: "/payments",      label: "Payments",  icon: "rupee"  };
const TAB_CUSTOMERS: BottomNavItem = { id: "customers", href: "/customers",     label: "Customers", icon: "users"  };
const TAB_RENEWALS:  BottomNavItem = { id: "renewals",  href: "/renewals",      label: "Renewals",  icon: "refresh"};
const TAB_MORE:      BottomNavItem = { id: "more",      href: "#",              label: "More",      icon: "more_h", action: "menu" };

interface Props {
  /** Called when the "More" tab is tapped — opens the MobileSidebar drawer. */
  onMoreClick: () => void;
}

export function MobileBottomNav({ onMoreClick }: Props) {
  const pathname = usePathname();
  const { data: me } = useCurrentUser();

  // Compute role-appropriate tabs. We start blank + push to keep the
  // intent explicit (vs filter on a master array). Sales explicitly
  // excludes Home (dashboard route is locked down) — showing it would
  // open the sidebar drawer redirect dance and confuse the rep.
  const tabs: BottomNavItem[] = [];
  if (me?.role === "sales" || me?.role === "sales_senior") {
    tabs.push(TAB_LEADS);
    // Sales Senior always handles deals; plain sales only if granted.
    if (me.role === "sales_senior" || me.canViewDeals) tabs.push(TAB_DEALS);
    tabs.push(TAB_TASKS);
    tabs.push(TAB_MORE);
  } else {
    // owner / manager (default for unknown / loading state too — safest
    // surface while useCurrentUser settles). Money-first: an owner on their
    // phone wants cash-in / who-owes / renewals, not the rep pipeline.
    // Leads & Deals stay reachable from the More drawer.
    tabs.push(TAB_HOME);
    tabs.push(TAB_PAYMENTS);
    tabs.push(TAB_CUSTOMERS);
    tabs.push(TAB_RENEWALS);
    tabs.push(TAB_MORE);
  }

  // grid-cols-N — Tailwind needs an explicit class per N so JIT picks it up.
  const gridClass =
    tabs.length === 5 ? "grid-cols-5" :
    tabs.length === 4 ? "grid-cols-4" :
    "grid-cols-3";

  return (
    <nav
      className={cn(
        // visibility — phones only
        "md:hidden",
        // positioning
        "fixed inset-x-0 bottom-0 z-40",
        // appearance
        "bg-paper border-t border-hairline shadow-[0_-1px_3px_rgba(0,0,0,0.04)]",
        // safe-area for notched / gesture-bar devices
        "pb-[env(safe-area-inset-bottom)]",
      )}
      aria-label="Primary navigation"
    >
      <ul className={cn("grid", gridClass)}>
        {tabs.map((item) => {
          // For /leads vs /deals — both share the same root URL prefix
          // dynamics, so prefix-match would highlight Deals when on /leads.
          // Use strict equality OR strict-prefix-plus-slash to avoid that.
          const active = item.action === "menu"
            ? false
            : pathname === item.href || pathname.startsWith(`${item.href}/`);

          const inner = (
            <span
              className={cn(
                "flex flex-col items-center justify-center gap-0.5 py-2 transition-colors",
                "min-h-[56px]", // touch-target floor (≥44px + label)
                active ? "text-amber-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              <Icon name={item.icon} size={20} />
              <span className="text-[10px] font-medium leading-tight">
                {item.label}
              </span>
            </span>
          );

          if (item.action === "menu") {
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={onMoreClick}
                  className="w-full"
                  aria-label="Open full menu"
                >
                  {inner}
                </button>
              </li>
            );
          }
          return (
            <li key={item.id}>
              <Link
                href={item.href as never}
                className="block"
                aria-current={active ? "page" : undefined}
              >
                {inner}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
