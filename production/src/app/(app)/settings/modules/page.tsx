"use client";

import * as React from "react";
import Link from "next/link";
import { useModules } from "@/lib/modules/useModules";
import { getTierCumulativePriceRupees } from "@/lib/modules/registry";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";

export default function ModulesManagerPage() {
  const {
    modules,
    isModuleActive,
    toggleModule,
    selectTier,
    currentTierLevel,
    currentTierModule,
    activateAll,
    activeCount,
    totalCount,
    totalMonthlyCostRupees,
    bundleSavingsRupees,
    isFreePlanOnly,
  } = useModules();

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-8">
      {/* Page Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-hairline">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-serif text-3xl font-semibold text-ink">Modular Plugin Marketplace</h1>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200">
              Live Architecture
            </Badge>
          </div>
          <p className="text-sm text-ink-3 mt-1.5 max-w-3xl">
            Break ResellerOS into independent, sellable SaaS plugins powered by a common core database (Auth, Multi-tenant Isolation, Customers & Audit Logs).
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => activateAll()}>
            Reset to All-in-One Suite
          </Button>
          <Link href="/dashboard">
            <Button variant="primary" size="sm">
              Go to Dashboard
            </Button>
          </Link>
        </div>
      </div>

      {/* Commercial Overview & Database Architecture Banner */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Card className="p-5 bg-gradient-to-br from-indigo-50/50 to-white border-indigo/20 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-indigo-700">Active Tenant Plan</span>
              <span className="text-xs font-mono bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded-full font-medium">
                {isFreePlanOnly
                  ? "Individual Free Plan"
                  : activeCount === totalCount
                  ? "Full Enterprise Suite"
                  : "Custom A-la-carte"}
              </span>
            </div>
            <div className="mt-3 flex items-baseline gap-2">
              <span className={`text-3xl font-serif font-bold ${isFreePlanOnly ? "text-emerald-600" : "text-ink"}`}>
                ₹{totalMonthlyCostRupees}
              </span>
              <span className="text-xs text-ink-3">
                {isFreePlanOnly ? "/ month (Free Forever)" : "/ month"}
              </span>
            </div>
            {bundleSavingsRupees > 0 && (
              <p className="text-xs text-emerald-600 font-medium mt-1">
                🎉 Full Bundle Discount Applied (Saving ₹{bundleSavingsRupees}/mo)
              </p>
            )}
          </div>
          <div className="mt-4 pt-3 border-t border-indigo/10 flex items-center justify-between text-xs text-ink-2">
            <span>Installed Modules:</span>
            <span className="font-semibold text-ink">{activeCount} of {totalCount} Active</span>
          </div>
        </Card>

        <Card className="p-5 bg-gradient-to-br from-emerald-50/50 to-white border-emerald/20 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-emerald-700">Central Core Engine</span>
              <span className="text-xs font-mono bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-medium">
                Connected
              </span>
            </div>
            <p className="text-xs text-ink-2 mt-2 leading-relaxed">
              Every plugin shares the same PostgreSQL schema: <b>tenants</b>, <b>users</b>, <b>customers</b>, and <b>audit_logs</b> with Row-Level Security (RLS).
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-emerald/10 flex items-center gap-2 text-xs text-emerald-700 font-medium">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>DPDP 2023 & Zero-Data-Leakage Isolation Active</span>
          </div>
        </Card>

        <Card className="p-5 bg-gradient-to-br from-amber-50/50 to-white border-amber/20 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-amber-800">Commercial Flexibility</span>
              <span className="text-xs font-mono bg-amber-100 text-amber-900 px-2 py-0.5 rounded-full font-medium">
                B2B & White-label
              </span>
            </div>
            <p className="text-xs text-ink-2 mt-2 leading-relaxed">
              Sell individual modules (e.g. only CRM to sales agencies, or only GST Invoicing to MSMEs) or unlock all modules for high-tier resellers.
            </p>
          </div>
          <div className="mt-4 pt-3 border-t border-amber/10 flex items-center justify-between text-xs text-amber-900 font-medium">
            <span>Multi-Tier Reselling:</span>
            <span>Supported</span>
          </div>
        </Card>
      </div>

      {/* Progressive Tier Selection Ladder */}
      <Card className="p-5 bg-gradient-to-r from-paper via-paper-2 to-paper border border-hairline space-y-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
          <div>
            <span className="text-2xs font-bold uppercase tracking-wider text-indigo-700">Progressive Tier Hierarchy</span>
            <h2 className="text-base font-serif font-semibold text-ink">
              Sequential Packaging (Tier 1 → Tier 7)
            </h2>
            <p className="text-xs text-ink-3">
              Higher versions automatically inherit all features of lower tiers. Selecting any higher tier automatically includes all tiers below it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-2 font-medium">Currently Active:</span>
            <Badge className="bg-indigo-100 text-indigo-800 border-indigo-200 font-semibold">
              {currentTierModule ? currentTierModule.tierLabel : `Tier ${currentTierLevel}`}
            </Badge>
          </div>
        </div>

        {/* Stepper buttons */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 pt-2">
          {modules.map((m) => {
            const isCurrent = m.tierLevel === currentTierLevel;
            const isIncluded = m.tierLevel <= currentTierLevel;
            const cumPrice = getTierCumulativePriceRupees(m.tierLevel);

            return (
              <button
                key={m.id}
                type="button"
                onClick={() => {
                  selectTier(m.tierLevel);
                  toast.success(`Switched to ${m.tierLabel}! All lower tiers (1 to ${m.tierLevel}) included automatically.`);
                }}
                className={`p-2.5 rounded-lg border text-left transition-all ${
                  isCurrent
                    ? "bg-indigo-50 border-indigo-500 shadow-sm ring-1 ring-indigo-500"
                    : isIncluded
                    ? "bg-emerald-50/60 border-emerald-300 hover:bg-emerald-50"
                    : "bg-paper border-hairline hover:border-ink/20 opacity-80"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-2xs font-bold font-mono text-ink-3">Tier {m.tierLevel}</span>
                  {isIncluded && <span className="text-emerald-600 text-xs font-bold">✓</span>}
                </div>
                <p className="text-xs font-semibold text-ink truncate mt-1">
                  {m.name.split("—")[0].split("&")[0].trim()}
                </p>
                <p className="text-2xs font-mono text-ink-3 mt-0.5">
                  {cumPrice === 0 ? "FREE" : `₹${cumPrice}/mo`}
                </p>
              </button>
            );
          })}
        </div>
      </Card>

      {/* Pluggable Modules Grid */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-ink">Modular Plugins & Tiers (Sequential Order)</h2>
          <span className="text-xs text-ink-3">Higher versions inherit all lower tier capabilities</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {modules.map((m) => {
            const active = isModuleActive(m.id);
            const isFreeTier = m.priceMonthlyRupees === 0 || m.isFreeTier;

            return (
              <Card
                key={m.id}
                className={`p-5 transition-all duration-200 border-2 flex flex-col justify-between ${
                  active
                    ? isFreeTier
                      ? "border-emerald-300 shadow-sm bg-gradient-to-br from-emerald-50/20 via-paper to-paper"
                      : "border-ink/20 shadow-sm bg-paper"
                    : "border-hairline bg-paper-2/40 opacity-75"
                }`}
              >
                <div>
                  {/* Top Bar of Card */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-2xs font-mono font-bold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800">
                          Tier {m.tierLevel} of 7
                        </span>
                        <span
                          className={`text-2xs px-1.5 py-0.5 rounded font-medium ${
                            active
                              ? isFreeTier
                                ? "bg-emerald-100 text-emerald-800 font-semibold"
                                : "bg-emerald-100 text-emerald-800"
                              : "bg-zinc-200 text-zinc-600"
                          }`}
                        >
                          {active ? (isFreeTier ? "Active (Free)" : "Active") : "Disabled"}
                        </span>
                      </div>
                      <h3 className="font-serif text-lg font-semibold text-ink leading-tight">{m.name}</h3>
                    </div>

                    <Switch
                      checked={active}
                      onCheckedChange={() => {
                        toggleModule(m.id);
                        toast.success(
                          active
                            ? `${m.name} deactivated (stepped down to lower tier)`
                            : `${m.name} activated! All lower tiers (1 to ${m.tierLevel}) included automatically.`,
                        );
                      }}
                      aria-label={`Toggle ${m.name}`}
                    />
                  </div>

                  <p className="text-xs text-ink-3 mt-2 line-clamp-2">{m.tagline}</p>

                  {/* Inherited capabilities callout */}
                  {m.inheritedFromSummary && (
                    <div className="mt-3 p-2 rounded-lg bg-emerald-50/70 border border-emerald-200/80 text-2xs text-emerald-800 flex items-start gap-1.5">
                      <span className="text-emerald-600 font-bold shrink-0 mt-0.5">✓</span>
                      <div>
                        <span className="font-semibold">Inherited by Default: </span>
                        <span className="text-emerald-700">{m.inheritedFromSummary}</span>
                      </div>
                    </div>
                  )}

                  {/* Price */}
                  <div
                    className={`mt-4 p-2.5 rounded-lg border flex items-baseline justify-between ${
                      isFreeTier ? "bg-emerald-50/60 border-emerald-200" : "bg-paper-2 border-hairline"
                    }`}
                  >
                    <span className="text-xs text-ink-3">{isFreeTier ? "Pricing Tier" : "Standalone Price"}</span>
                    {m.priceMonthlyRupees === 0 ? (
                      <div className="flex items-baseline gap-1">
                        <span className="text-base font-serif font-bold text-emerald-600">FREE FOREVER</span>
                        <span className="text-2xs text-emerald-700 font-medium">₹0/mo</span>
                      </div>
                    ) : (
                      <div className="flex items-baseline gap-1">
                        <span className="text-lg font-serif font-bold text-ink">₹{m.priceMonthlyRupees}</span>
                        <span className="text-2xs text-ink-3">/mo</span>
                      </div>
                    )}
                  </div>

                  {/* Key Features */}
                  <div className="mt-4 space-y-1.5">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3">
                      {m.tierLevel === 1 ? "Core Capabilities:" : `✨ Extra Features in Tier ${m.tierLevel}:`}
                    </span>
                    <ul className="space-y-1 text-xs text-ink-2">
                      {m.features.slice(0, 3).map((f, i) => (
                        <li key={i} className="flex items-center gap-1.5">
                          <span className="text-emerald-500 text-sm">✓</span>
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* Connected DB Tables */}
                  <div className="mt-4 pt-3 border-t border-hairline">
                    <span className="text-2xs font-semibold uppercase tracking-wider text-ink-3 block mb-1.5">
                      Connected DB Schema:
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {m.dbTables.map((tbl) => (
                        <span key={tbl} className="text-2xs font-mono bg-paper-2 px-1.5 py-0.5 rounded text-ink-2 border border-hairline">
                          {tbl}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Card Action & Core Routes */}
                <div className="mt-5 pt-3 border-t border-hairline flex items-center justify-between">
                  <div className="flex items-center gap-1 text-xs">
                    <span className="text-ink-3">Routes:</span>
                    <Link
                      href={m.coreRoutes[0]}
                      className="font-mono text-xs text-indigo hover:underline font-medium"
                    >
                      {m.coreRoutes[0]}
                    </Link>
                    {m.coreRoutes.length > 1 && (
                      <span className="text-2xs text-ink-3">+{m.coreRoutes.length - 1}</span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {active ? (
                      <Link href={m.coreRoutes[0]}>
                        <Button variant="ghost" size="sm" className="text-xs">
                          Open Module →
                        </Button>
                      </Link>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="text-xs border-indigo-300 text-indigo-800 bg-indigo-50 hover:bg-indigo-100"
                        onClick={() => {
                          selectTier(m.tierLevel);
                          toast.success(`Upgraded to Tier ${m.tierLevel}! All lower tiers (1 to ${m.tierLevel}) included automatically.`);
                        }}
                      >
                        ⚡ Select Tier {m.tierLevel}
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
              </Card>
            );
          })}
        </div>
      </div>

      {/* World-Class Security & DPDP Compliance Architecture Footer */}
      <Card className="p-6 bg-paper border border-hairline space-y-4">
        <h3 className="font-serif text-base font-semibold text-ink">Architectural Guidelines for Selling Modules</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-xs text-ink-2 leading-relaxed">
          <div>
            <h4 className="font-semibold text-ink mb-1">1. Common Shared Core</h4>
            <p>
              All modules authenticate against the single Supabase Auth & Multi-tenant DB. A customer created in CRM is immediately accessible in Invoicing when both plugins are active.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-ink mb-1">2. Dynamic Upsell & Route Guarding</h4>
            <p>
              When a client attempts to navigate to an unpurchased module (e.g. Host Provisioning), the system displays a native upgrade modal with 1-click Razorpay checkout.
            </p>
          </div>
          <div>
            <h4 className="font-semibold text-ink mb-1">3. Employee DLP & DPDP 2023</h4>
            <p>
              Bulk CSV export restrictions, PII data masking (phone/email), and tamper-proof audit trails ensure client data remains private within their tenant boundary.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}
