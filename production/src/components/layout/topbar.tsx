"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { NotificationPanel } from "./notification-panel";
import { QuickActionsPanel } from "./quick-actions-panel";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";
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
  const [feedbackOpen, setFeedbackOpen] = React.useState(false);

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
        type="button"
        onClick={onMobileMenuClick}
        className="md:hidden p-1.5 -ml-1 text-ink-3 hover:text-ink rounded-md focus:outline-none focus:ring-1 focus:ring-primary"
        aria-label="Open menu"
      >
        <Icon name="menu" size={20} />
      </button>

      {/* Back chevron on detail pages on phone (since breadcrumbs hidden on mobile) */}
      {isDetailPage && (
        <button
          type="button"
          onClick={() => {
            if (typeof window !== "undefined" && window.history.length > 1) {
              router.back();
            } else {
              const primary = getSectionPrimaryHref(pathname);
              router.push(primary as Route);
            }
          }}
          className="md:hidden p-1.5 -ml-1 text-ink-3 hover:text-ink rounded-md focus:outline-none focus:ring-1 focus:ring-primary flex items-center gap-1 text-xs font-medium"
          aria-label="Go back"
        >
          <Icon name="chevron-left" size={18} />
          <span>Back</span>
        </button>
      )}

      {/* Breadcrumb — hidden on phone */}
      <nav aria-label="Breadcrumb" className="hidden md:flex items-center gap-1.5 text-xs text-ink-3 overflow-hidden">
        {crumb.map((c, i) => (
          <React.Fragment key={c}>
            {i > 0 && <Icon name="chevron-right" size={12} className="text-ink-4 flex-shrink-0" />}
            <span className={i === crumb.length - 1 ? "font-semibold text-ink truncate" : "truncate"}>
              {c}
            </span>
          </React.Fragment>
        ))}
      </nav>

      <div className="flex-1" />

      {/* Team Testing & Feedback / Bug Report Trigger */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setFeedbackOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-rose-soft/80 border border-rose/30 hover:bg-rose-soft text-rose-ink text-xs font-semibold transition-all shadow-sm"
          >
            <Icon name="bug" size={14} className="text-rose-ink" />
            <span className="hidden sm:inline">Report Bug</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Report a bug or suggest a new feature</TooltipContent>
      </Tooltip>

      {/* Search button (triggers ⌘K) */}
      <button
        type="button"
        onClick={() => cmdk.setOpen(true)}
        className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-hairline bg-paper-2 hover:bg-paper-3 text-xs text-ink-3 transition-colors"
        aria-label="Search dashboard (Cmd+K)"
      >
        <Icon name="search" size={14} />
        <span className="hidden lg:inline">Search...</span>
        <kbd className="hidden sm:inline-flex items-center gap-0.5 text-[10px] font-mono px-1 rounded bg-paper border border-hairline text-ink-3">
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
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}
