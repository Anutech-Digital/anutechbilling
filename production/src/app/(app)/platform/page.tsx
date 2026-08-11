/**
 * Platform › Signups — FOUNDER-ONLY view of every reseller that signed up for
 * ResellerOS. Cross-tenant, so it reads through /api/platform/signups (which
 * re-checks the founder allowlist server-side before using the admin client).
 * A non-founder never sees the nav link and, if they hit the URL, gets a clear
 * "not authorized" panel + a 403 from the API.
 */
"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { formatDate } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";

type SignupRow = {
  id: string; name: string; owner: string; signedUp: string;
  tier: string | null; gstin: string | null; state: string | null;
  activated: boolean; users: number; customers: number;
};

export default function PlatformSignupsPage() {
  const { data: me, isLoading: meLoading } = useCurrentUser();

  const q = useQuery({
    queryKey: ["platform-signups"],
    enabled: Boolean(me?.isPlatformAdmin),
    queryFn: async (): Promise<{ count: number; tenants: SignupRow[] }> => {
      const res = await fetch("/api/platform/signups");
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? "Failed to load");
      return res.json();
    },
  });

  if (meLoading) return <div className="p-4 md:p-6 lg:p-8"><Skeleton className="h-40 w-full" /></div>;

  if (!me?.isPlatformAdmin) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
        <Card className="py-2">
          <EmptyState icon="lock" title="Not authorized" body="This founder view is limited to the ResellerOS platform owner." />
        </Card>
      </div>
    );
  }

  const rows = q.data?.tenants ?? [];
  const activated = rows.filter((r) => r.activated).length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-3">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Platform</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Signups</h1>
        <p className="text-sm text-ink-3 mt-1">Every reseller that has registered for ResellerOS. Founder-only.</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4">
        <Card className="p-2.5"><div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Total signups</div><div className="font-serif text-xl">{q.data ? q.data.count : "—"}</div></Card>
        <Card className="p-2.5"><div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Activated</div><div className="font-serif text-xl text-emerald">{q.data ? activated : "—"}</div></Card>
        <Card className="p-2.5"><div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Not yet set up</div><div className="font-serif text-xl text-amber-ink">{q.data ? q.data.count - activated : "—"}</div></Card>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : q.isError ? (
        <Card className="py-2"><EmptyState icon="alert" title="Could not load signups" body={(q.error as Error)?.message ?? "Try again."} /></Card>
      ) : rows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No signups yet" body="New resellers who register for ResellerOS will appear here." /></Card>
      ) : (
        <Card className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-3 py-3">Business</th>
                <th className="text-left px-3 py-3">Owner</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Signed up</th>
                <th className="text-left px-3 py-3">Tier</th>
                <th className="text-right px-3 py-3">Users</th>
                <th className="text-right px-3 py-3">Customers</th>
                <th className="text-left px-3 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((t) => (
                <tr key={t.id} className="hover:bg-paper-2/40">
                  <td className="px-3 py-3">
                    <div className="font-medium text-ink">{t.name}</div>
                    {t.gstin && <div className="font-mono text-[10px] text-ink-3">{t.gstin}{t.state ? ` · ${t.state}` : ""}</div>}
                  </td>
                  <td className="px-3 py-3 text-ink-2">{t.owner}</td>
                  <td className="px-3 py-3 text-ink-2 whitespace-nowrap">{formatDate(t.signedUp)}</td>
                  <td className="px-3 py-3"><Badge kind={t.tier === "distributor" ? "info" : "muted"} size="sm">{t.tier ?? "reseller"}</Badge></td>
                  <td className="px-3 py-3 text-right tabular-nums">{t.users}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{t.customers}</td>
                  <td className="px-3 py-3">
                    {t.activated
                      ? <Badge kind="success" size="sm" dot>Activated</Badge>
                      : <Badge kind="warning" size="sm" dot>Setup pending</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
