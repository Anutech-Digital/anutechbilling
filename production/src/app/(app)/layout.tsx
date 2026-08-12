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
import { GlobalBugReporter } from "@/components/shared/global-bug-reporter";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen bg-paper-2/50">
      {/* Desktop sidebar (sticky 240px) */}
      <Sidebar />

      {/* Mobile sidebar (slide-in drawer — opened from TopBar hamburger AND MobileBottomNav "More") */}
      <MobileSidebar open={mobileNavOpen} onOpenChange={setMobileNavOpen} />

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        <TopBar onMobileMenuClick={() => setMobileNavOpen(true)} />
        {/* pb-16 on mobile so content doesn't hide behind the bottom tab bar */}
        <main className="flex-1 min-w-0 pb-16 md:pb-0">{children}</main>
      </div>

      {/* Sticky mobile bottom tab bar (phone only) */}
      <MobileBottomNav onMoreClick={() => setMobileNavOpen(true)} />

      {/* Always-on-top Global Floating Bug Reporter (z-[9999]) */}
      <GlobalBugReporter />
    </div>
  );
}
