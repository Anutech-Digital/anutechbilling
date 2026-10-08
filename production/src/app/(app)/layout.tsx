/**
 * (app) layout — authenticated app shell with Sidebar + TopBar.
 * Wraps all internal app routes: /dashboard, /leads, /customers, etc.
 *
 * Mobile: sidebar collapses behind hamburger.
 * Desktop: 240px sidebar + main content.
 */
"use client";

import * as React from "react";
import { Sidebar, MobileSidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/topbar";
import { MobileBottomNav } from "@/components/layout/MobileBottomNav";
import { WorkspaceTabBar } from "@/components/layout/workspace-tab-bar";
import { GlobalBugReporter } from "@/components/shared/global-bug-reporter";
import { AiHelp } from "@/components/shared/ai-help";
import { AttendanceReminder } from "@/components/features/attendance/attendance-reminder";
import { ShortcutsSheet } from "@/components/shared/shortcuts-sheet";
import { useGlobalKeys } from "@/lib/hooks/useKeyboard";
import { MustChangePasswordGate } from "@/components/shared/must-change-password-gate";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  /* ─── THE GLOBAL KEYS LIVE HERE, ONCE ──────────────────────────────────────
     `g l` and `?` are mounted in the shell rather than per page. Mounting them per page
     would stack a listener for every route the operator has visited and fire one keypress
     several times — a double navigation that looks like the app skipping a screen.

     Both refuse to fire while a field has focus; that rule and the `g` timing live in
     lib/keyboard/shortcuts.ts with tests, because a shortcut that eats a keystroke out of
     somebody's typing is the way this feature fails. */
  const [helpOpen, setHelpOpen] = React.useState(false);
  useGlobalKeys(() => setHelpOpen(true));

  return (
    <div
      className="flex min-h-screen bg-paper-2/50"
      /* R-268: the phone bottom tab bar's height, ONCE. MobileBottomNav is min-h 56px plus
         the home-indicator inset; the bulk bar, the FAB and main's bottom padding all read
         this instead of each guessing (bottom-6 / bottom-20 / pb-16 had drifted apart). */
      style={{ "--bottom-nav-h": "calc(56px + env(safe-area-inset-bottom))" } as React.CSSProperties}
    >
      {/* Desktop sidebar (sticky 240px) */}
      <Sidebar />

      {/* Mobile sidebar (slide-in drawer — opened from TopBar hamburger AND MobileBottomNav "More") */}
      <MobileSidebar open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onMobileMenuClick={() => setMobileNavOpen(true)} />
        {/* Renders nothing until a second tab is open — a one-tab strip is
            decoration that costs vertical space on every screen. */}
        <WorkspaceTabBar />
        {/* Phone: pad past the bottom tab bar AND the home indicator (pb-16 alone hid ~34px
            of the last rows on iPhone), plus room for the bulk bar / FAB above it. */}
        <main className="flex-1 min-w-0 pb-[calc(var(--bottom-nav-h,56px)+1rem)] md:pb-0">{children}</main>
      </div>

      {/* Sticky mobile bottom tab bar (phone only) */}
      <MobileBottomNav onMoreClick={() => setMobileNavOpen(true)} />

      {/* Always-on-top Global Floating Bug Reporter (z-[9999]) */}
      <GlobalBugReporter />

      {/* R-158: AI Help — ask about the app while testing; it drafts bug reports. */}
      <AiHelp />

      {/* Check-in / check-out nudge. Here rather than on /attendance/me, because the
          people who miss a punch are precisely the ones not looking at that page. It
          renders nothing unless a punch is actually outstanding, and never on
          /attendance itself. */}
      <AttendanceReminder />

      {/* The ? cheat sheet. Rendered from the same registry the handlers read, so it cannot
          list a shortcut nobody implemented — or omit one that works. */}
      <ShortcutsSheet open={helpOpen} onOpenChange={setHelpOpen} />

      {/* R-391: owner-set temporary password → /change-password first. Renders nothing. */}
      <MustChangePasswordGate />
    </div>
  );
}
