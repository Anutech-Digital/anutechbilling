"use client";

import { DemoDataButton } from "@/components/layout/demo-data-button";
import * as React from "react";
import { Kbd } from "@/components/ui/kbd";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";

import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { AiHelpButton } from "@/components/shared/ai-help";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import { CommandPalette, useCommandPalette } from "./command-palette";
import { NotificationPanel } from "./notification-panel";
import { useNotifications } from "@/lib/queries/notifications";
import { QuickActionsPanel } from "./quick-actions-panel";
import { FeedbackDialog } from "@/components/shared/feedback-dialog";
import { getCrumb, getParentListHref } from "@/lib/nav";
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
  /* + asli events (payment/quote/lead/ticket) jinka read_at DB me null hai (audit B4). */
  const { data: dbNotifs } = useNotifications();
  const unreadCount = (taskCount ?? 0) + (dbNotifs ?? []).filter((n) => !n.read_at).length;

  // Mount-only flag to avoid theme hydration mismatch
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  return (
    <header className="sticky top-0 z-30 h-14 border-b border-hairline bg-paper/95 backdrop-blur-sm flex items-center gap-2 px-3 md:px-4">
      {/* STAGING banner — so a screenshot can never be mistaken for production (docs/STAGING.md). */}
      {process.env.NEXT_PUBLIC_APP_ENV === "staging" && (
        <span className="shrink-0 rounded bg-amber text-ink text-3xs font-bold uppercase tracking-wider px-2 py-0.5" title="Ye staging hai — demo data, koi customer nahi">Staging</span>
      )}
      {/* LOCAL — `npm run dev:local` (S8): local database, live integrations band. */}
      {process.env.NEXT_PUBLIC_APP_ENV === "local" && (
        <span className="shrink-0 rounded bg-amber text-ink text-3xs font-bold uppercase tracking-wider px-2 py-0.5" title="Local database — production nahi, koi email/payment/WhatsApp bahar nahi jaata">Local</span>
      )}
      {/* R-201: test data on staging/local only (renders nothing in production). */}
      <DemoDataButton />
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
              // No history to pop — the user deep-linked into this detail page
              // (quote/invoice link from WhatsApp or email). Go to its list page.
              // Was getSectionPrimaryHref(pathname), which takes a SECTION NAME,
              // so it always returned null → router.push(null) → Back dead-ended.
              router.push(getParentListHref(pathname) as Route);
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
        <TooltipContent shortcut="report-bug">Report a bug or suggest a new feature</TooltipContent>
      </Tooltip>

      {/* Search button (triggers ⌘K) */}
      <button
        type="button"
        onClick={() => cmdk.setOpen(true)}
        className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-hairline bg-paper-2 hover:bg-paper-3 text-xs text-ink-3 transition-colors"
        aria-label="Search customers, leads, quotes, invoices and domains"
      >
        <Icon name="search" size={14} />
        <span className="hidden lg:inline">Search...</span>
        {/* Was a hardcoded "⌘K", which is an instruction a Windows operator cannot follow —
            and they conclude the shortcut is broken rather than that the label is. <Kbd>
            draws ⌘ on a Mac and Ctrl everywhere else. */}
        <Kbd keys={["Ctrl", "K"]} className="hidden sm:inline-flex" />
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

      {/* AI Help (R-158/R-162) — a small icon, not a floating button over the page. */}
      <AiHelpButton />

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
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose text-white text-3xs font-bold grid place-items-center ring-2 ring-paper pointer-events-none tabular-nums"
            aria-hidden="true"
          >
            {unreadCount}
          </span>
        )}
      </div>

      {/* Mounted panels */}
      {/* Mounted only while open. Both panels run ~14 unbounded table reads (leads, customers,
         quotes, invoices, subscriptions, payments, contacts, tasks) the moment they mount, and
         they used to mount on every page — closed. Deep study, 27 Sep 2026. */}
      {cmdk.isOpen && <CommandPalette open onOpenChange={cmdk.setOpen} />}
      {notifOpen && <NotificationPanel open onOpenChange={setNotifOpen} />}
      <QuickActionsPanel open={actionsOpen} onOpenChange={setActionsOpen} />
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </header>
  );
}
