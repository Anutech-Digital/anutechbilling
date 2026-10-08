/**
 * Customer Groups / Parent Accounts — list page.
 *
 * Each group is an umbrella over several customer companies routed by one common
 * reseller/coordinator. Billing stays per-company; this is the relationship view.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { FAB } from "@/components/ui/fab";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError, LoadErrorBanner } from "@/components/shared/load-error";
import { GroupFormDialog } from "@/components/features/customers/group-form-dialog";
import { useCustomerGroups } from "@/lib/queries/customer-groups";
import { useGroupMemberCounts } from "./group-queries";
import { newestFirst } from "@/lib/sort/newest-first";

export default function CustomerGroupsPage() {
  const router = useRouter();
  const groupsQ = useCustomerGroups();
  const { data: groups, isLoading } = groupsQ;
  const [addOpen, setAddOpen] = React.useState(false);

  /* R-222: one slim read of grouped customers' group_id — not every customer row. */
  const countsQ = useGroupMemberCounts();
  const { data: countByGroup = new Map<string, number>() } = countsQ;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Parent accounts</h1>
          <p className="text-sm text-ink-3 mt-1">
            Group companies routed by one common reseller or coordinator. Each company still
            keeps its own GSTIN and gets its own invoices.
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>New group</Button>
      </div>

      {countsQ.isError && !groupsQ.isError && <LoadErrorBanner onRetry={() => void countsQ.refetch()} />}

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-28 w-full" />)}
        </div>
      ) : groupsQ.isError ? (
        <LoadError what="Parent accounts" onRetry={() => void groupsQ.refetch()} />
      ) : !groups || groups.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title="No parent accounts yet"
            body="Create a group when one reseller or contact sends you work for several different companies — each billed separately, but tracked together here."
            action={<Button variant="primary" icon="plus" onClick={() => setAddOpen(true)}>Create your first group</Button>}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Newest first, like every other table (Abhishek, 18 Sep 2026) — the group
              you just created is the one you are looking for. */}
          {newestFirst(groups).map((g) => {
            const count = countByGroup.get(g.id) ?? 0;
            return (
              <Card
                key={g.id}
                className="p-4 cursor-pointer hover:border-hairline-strong transition-colors"
                onClick={() => router.push(`/customers/groups/${g.id}` as never)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="font-semibold text-ink">{g.name}</div>
                  {g.is_partner && <Badge kind="info" dot>Partner</Badge>}
                </div>
                <div className="text-sm text-ink-3 mt-1">
                  {count} {count === 1 ? "company" : "companies"}
                  {g.contact_name && <> · {g.contact_name}</>}
                </div>
                <div className="mt-3 text-xs text-amber inline-flex items-center gap-1">
                  Open <Icon name="arrow_right" size={12} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <GroupFormDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={(g) => router.push(`/customers/groups/${g.id}` as never)}
      />
      <FAB icon="plus" label="New group" onClick={() => setAddOpen(true)} />
    </div>
  );
}
