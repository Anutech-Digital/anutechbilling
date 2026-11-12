"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { getModulesForRoute } from "@/lib/modules/registry";
import { useModules } from "@/lib/modules/useModules";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export function ModuleGate({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { isLoaded, isModuleActive, toggleModule } = useModules();

  // While loading module state from storage/server, render a skeleton
  // NEVER mount children early, otherwise children (e.g. /leads) will fire database queries before the gate locks!
  if (!isLoaded) {
    return (
      <div className="p-8 max-w-4xl mx-auto my-12 animate-pulse">
        <div className="h-8 bg-paper-2 rounded w-1/3 mb-4" />
        <div className="h-32 bg-paper-2 rounded w-full" />
      </div>
    );
  }

  // Exempt settings, dashboard, help, today from module lock
  const EXEMPT_PREFIXES = [
    "/dashboard",
    "/settings",
    "/setup",
    "/today",
    "/help",
    "/activity",
    "/compliance",
    "/ux-insights",
    "/ui-insights",
    "/quality",
  ];

  if (EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return <>{children}</>;
  }

  const matchingModules = getModulesForRoute(pathname);

  // If route is not governed by any specific commercial module, allow
  if (matchingModules.length === 0) {
    return <>{children}</>;
  }

  // If any matching module is active (e.g. solo_free or invoicing for /invoices), allow access!
  const isAllowed = matchingModules.some((m) => isModuleActive(m.id));
  if (isAllowed) {
    return <>{children}</>;
  }

  const currentModule = matchingModules[0];

  // Route belongs to a module that is currently DISABLED for this tenant:
  return (
    <div className="p-8 max-w-4xl mx-auto my-12">
      <Card className="p-8 border-2 border-dashed border-amber-300 bg-gradient-to-b from-amber-50/40 via-paper to-paper shadow-sm">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="space-y-2 max-w-xl">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-amber-100 text-amber-900 border-amber-300 font-semibold">
                🔒 Locked Plugin
              </Badge>
              <span className="text-xs font-mono text-ink-3 uppercase tracking-wider">{currentModule.badge}</span>
            </div>

            <h2 className="font-serif text-2xl font-bold text-ink mt-2">
              Unlock {currentModule.name}
            </h2>

            <p className="text-sm text-ink-2 leading-relaxed">
              {currentModule.tagline}
            </p>
            <p className="text-xs text-ink-3">
              {currentModule.description}
            </p>
          </div>

          <div className="p-4 bg-paper-2 rounded-xl border border-hairline min-w-[200px] text-center md:text-right">
            <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3 block">Plugin Price</span>
            <div className="text-2xl font-serif font-bold text-ink mt-1">
              ₹{currentModule.priceMonthlyRupees}
              <span className="text-xs font-sans text-ink-3 font-normal"> / month</span>
            </div>
            <span className="text-3xs text-emerald-600 font-medium block mt-1">14-Day Free Trial Available</span>
          </div>
        </div>

        {/* Feature List */}
        <div className="mt-6 pt-6 border-t border-hairline">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-3 mb-3">
            What is included in this plugin:
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs text-ink-2">
            {currentModule.features.map((feature, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-emerald-600 font-bold">✓</span>
                <span>{feature}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Actions */}
        <div className="mt-8 pt-6 border-t border-hairline flex flex-col sm:flex-row items-center justify-between gap-4">
          <Link href="/settings/modules" className="text-xs text-indigo-600 hover:underline font-medium">
            ← View All 5 Modules in Plugin Marketplace
          </Link>

          <div className="flex items-center gap-3 w-full sm:w-auto">
            <Link href="/dashboard" className="w-full sm:w-auto">
              <Button variant="ghost" size="sm" className="w-full">
                Back to Dashboard
              </Button>
            </Link>

            <Button
              variant="primary"
              size="sm"
              className="w-full sm:w-auto bg-amber-600 hover:bg-amber-700 text-white font-medium"
              onClick={() => {
                toggleModule(currentModule.id);
                toast.success(`🎉 ${currentModule.name} activated on your workspace!`);
              }}
            >
              ⚡ Activate 14-Day Free Trial
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}
