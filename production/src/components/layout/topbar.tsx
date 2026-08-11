/**
 * TopBar — sticky header with breadcrumb, ⌘K search, theme toggle, bell.
 *
 * Mounted by the (app) layout group.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { NotificationPanel } from "./notification-panel";
import { QuickActionsPanel } from "./quick-actions-panel";
import { getCrumb, getSectionPrimaryHref } from "@/lib/nav";
import type { Route } from "next";
import { useTaskCountDueOrOverdue } from "@/lib/queries/tasks";
import { logLoginOnce } from "@/lib/queries/activity";

interface TopBarProps {
  /** Open the mobile sidebar */
  onMobileMenuClick: () => void;
  /** Override breadcrumb (otherwise auto from pathname) */
  crumb?: string[];
}

export function TopBar({ onMobileMenuClick, crumb: crumbOverride }: TopBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  // Record a login once per browser session (fire-and-forget) for the activity log.
  React.useEffect(() => { void logLoginOnce(); }, []);
  const crumb = crumbOverride ?? getCrumb(pathname);
  // On phones the breadcrumb is hidden (no room), so detail/sub pages (≥2 path
  // segments, e.g. /quotes/Q-123 or /customers/abc/edit) get a Back chevron so
  // users aren't stranded relying on the OS back gesture.
  const isDetailPage = pathname.split("/").filter(Boolean).length >= 2;
  const { setTheme, resolvedTheme } = useTheme();
  const cmdk = useCommandPalette();
  const [notifOpen,   setNotifOpen]   = React.useState(false);
  const [actionsOpen, setActionsOpen] = React.useState(false);

  // Bell badge = open tasks due by end of today (today + overdue). When push
  // notifications + WhatsApp reminders arrive in Phase 2 they'll feed the
  // same number (any unread notification becomes a virtual task surface).
  const { data: taskCount } = useTaskCountDueOrOverdue();
  const unreadCount = taskCount ?? 0;

  // Mount-only flag to avoid theme hydration mismatch
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-hairline bg-paper/95 backdrop-blur-sm flex items-center gap-2 px-3 md:px-4">
      {/* Mobile hamburger */}
      <button
        className="md:hidden p-2 -ml-2 rounded-md hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
        onClick={onMobileMenuClick}
        aria-label="Open menu"
      >
        <Icon name="list" size={18} />
      </button>

      {/* Mobile-only Back affordance on detail pages (breadcrumb is hidden
          < sm, and each detail/form page already renders its own H1 title, so
          we only need the way *up* here — not a duplicate title). */}
      {isDetailPage && (
        <button
          onClick={() => router.back()}
          className="sm:hidden p-2 -ml-1 rounded-md hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber shrink-0"
          aria-label="Go back"
        >
          <Icon name="arrow_left" size={18} />
        </button>
      )}

      {/* Breadcrumb — every item navigable except the current page (last).
          The home icon goes to /dashboard. Section names (Workspace, Revenue,
          Accounting, etc.) link to that section's primary page so power users
          can jump up the tree. The final crumb stays as bold text — it
          represents the current page, by convention non-clickable. */}
      <nav aria-label="Breadcrumb" className="hidden sm:flex items-center gap-1.5 text-xs text-ink-3">
        <Link href="/dashboard" className="hover:text-ink transition-colors" aria-label="Home">
          <Icon name="home" size={13} />
        </Link>
        {crumb.map((label, i) => {
          const isLast = i === crumb.length - 1;
          // First crumb is the section name — link to that section's primary
          // page. Intermediate crumbs (rare, e.g., GST > Output) may not map
          // to a section; in that case we render plain text.
          const sectionHref = !isLast ? getSectionPrimaryHref(label) : null;
          return (
            <React.Fragment key={i}>
              <span className="text-ink-3" aria-hidden>/</span>
              {sectionHref ? (
                <Link
                  href={sectionHref as Route}
                  className="text-ink-3 hover:text-ink hover:underline underline-offset-2 transition-colors"
                >
                  {label}
                </Link>
              ) : (
                <span
                  className={isLast ? "font-semibold text-ink" : "text-ink-3"}
                  aria-current={isLast ? "page" : undefined}
                >
                  {label}
                </span>
              )}
            </React.Fragment>
          );
        })}
      </nav>

      <div className="flex-1" />

      {/* ⌘K Search trigger */}
      <button
        onClick={cmdk.open}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-hairline hover:border-hairline-strong bg-paper-2 text-ink-3 text-xs min-w-0 shrink lg:min-w-[240px] xl:min-w-[280px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2"
      >
        <Icon name="search" size={13} className="shrink-0" />
        <span className="flex-1 text-left truncate">Search customers, leads, quotes…</span>
        <kbd className="hidden md:inline-block text-[10px] px-1.5 py-0.5 rounded bg-paper border border-hairline text-ink-3 font-mono">
          ⌘K
        </kbd>
      </button>

      {/* Theme toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            icon={mounted && resolvedTheme === "dark" ? "sun" : "moon"}
            aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
          />
        </TooltipTrigger>
        <TooltipContent>Toggle theme</TooltipContent>
      </Tooltip>

      {/* Quick actions — page-aware "what should I do now" panel.
          Sits just left of the bell so the order reads as:
          info (search) → do (sparkles) → alert (bell). */}
      <Tooltip>
        <TooltipTrigger asChild>
          <IconButton
            icon="sparkles"
            aria-label="Quick actions for this page"
            onClick={() => setActionsOpen(true)}
          />
        </TooltipTrigger>
        <TooltipContent>Quick actions</TooltipContent>
      </Tooltip>

      {/* Notifications */}
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <IconButton
              icon="bell"
              aria-label={`${unreadCount} unread notifications`}
              onClick={() => setNotifOpen(true)}
            />
          </TooltipTrigger>
          <TooltipContent>Notifications</TooltipContent>
        </Tooltip>
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose text-white text-[9px] font-bold grid place-items-center ring-2 ring-paper pointer-events-none tabular-nums"
            aria-hidden="true"
          >
            {unreadCount}
          </span>
        )}
      </div>

      {/* Mounted panels */}
      <CommandPalette open={cmdk.isOpen} onOpenChange={cmdk.setOpen} />
      <NotificationPanel open={notifOpen} onOpenChange={setNotifOpen} />
      <QuickActionsPanel open={actionsOpen} onOpenChange={setActionsOpen} />
    </header>
  );
}
