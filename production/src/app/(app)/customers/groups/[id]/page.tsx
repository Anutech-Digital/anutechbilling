/**
 * Customer Group / Parent Account — detail page.
 *
 * Shows every company routed by this reseller/coordinator (X): each keeps its own
 * GSTIN + invoices, and we roll up total outstanding + MRR across the group.
 * Billing is never here — this is the relationship + reporting view.
 */
"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { GroupFormDialog } from "@/components/features/customers/group-form-dialog";
import { useCustomerGroup, useDeleteCustomerGroup } from "@/lib/queries/customer-groups";
import { useGroupMembers, useMembersMrr } from "../group-queries";
import { useOutstandingReceivables } from "@/lib/queries/payments";
import { rupee } from "@/lib/utils";

export default function CustomerGroupDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();

  const { data: group, isLoading: groupLoading } = useCustomerGroup(id);
  /* R-222: this group's companies and their active MRR only — it used to read every
     customer and every subscription in the workspace to show these few rows. */
  const { data: memberRows } = useGroupMembers(id);
  const { data: outstanding } = useOutstandingReceivables();

  const [editOpen, setEditOpen] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const del = useDeleteCustomerGroup();

  // Members of this group + their money rollups.
  const members = React.useMemo(() => memberRows ?? [], [memberRows]);
  const memberIds = React.useMemo(() => (memberRows ? memberRows.map((c) => c.id) : undefined), [memberRows]);
  const { data: mrrByCustomer = new Map<string, number>() } = useMembersMrr(memberIds);

  const outstandingByCustomer = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const o of outstanding ?? []) {
      if (!o.customer_id) continue;
      map.set(o.customer_id, (map.get(o.customer_id) ?? 0) + o.outstanding_amount);
    }
    return map;
  }, [outstanding]);

  const totalOutstanding = members.reduce((sum, c) => sum + (outstandingByCustomer.get(c.id) ?? 0), 0);
  const totalMRR = members.reduce((sum, c) => sum + (mrrByCustomer.get(c.id) ?? 0), 0);

  if (groupLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!group) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
        <EmptyState
          icon="users"
          title="Group not found"
          body="This parent account may have been deleted."
          action={<Button variant="primary" icon="arrow_left" onClick={() => router.push("/customers/groups" as never)}>Back to groups</Button>}
        />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="mb-5 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link href={"/customers/groups" as never} className="text-xs text-ink-3 hover:text-ink inline-flex items-center gap-1 mb-1">
            <Icon name="arrow_left" size={13} /> Groups
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">{group.name}</h1>
            {group.is_partner && <Badge kind="info" dot>Commission partner</Badge>}
            {!group.is_active && <Badge kind="muted">Inactive</Badge>}
          </div>
          <p className="text-sm text-ink-3 mt-1">
            Parent account · {members.length} {members.length === 1 ? "company" : "companies"}
            {group.contact_name && <> · Contact: <b className="text-ink">{group.contact_name}</b></>}
            {group.contact_phone && <> · {group.contact_phone}</>}
          </p>
        </div>
        <div className="flex gap-2">
          <Button icon="edit" onClick={() => setEditOpen(true)}>Edit</Button>
          <Button icon="trash" variant="ghost" className="!text-rose hover:!bg-rose/10" onClick={() => setConfirmDelete(true)}>Delete</Button>
        </div>
      </div>

      {/* Rollup KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <Card className="p-4">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Companies</div>
          <div className="font-serif text-2xl mt-1 tabular-nums">{members.length}</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total outstanding</div>
          <div className={`font-serif text-2xl mt-1 tabular-nums ${totalOutstanding > 0 ? "text-rose" : "text-ink"}`}>{rupee(totalOutstanding)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Total MRR</div>
          <div className="font-serif text-2xl mt-1 tabular-nums">{rupee(totalMRR)}</div>
        </Card>
      </div>

      {group.is_partner && (
        <Card className="mb-6 bg-paper-2/40 p-3">
          <p className="text-2xs text-ink-3 leading-relaxed flex items-start gap-1.5">
            <Icon name="info" size={13} className="mt-0.5 shrink-0" />
            <span>This reseller earns a commission. Add the actual per-deal commission from each company&apos;s <Link href={"/referrals" as never} className="text-amber hover:underline">Referrals</Link> — it flows into your P&amp;L automatically.</span>
          </p>
        </Card>
      )}

      {/* Member companies */}
      <div className="mb-2 text-sm font-semibold text-ink">Companies in this group</div>
      {members.length === 0 ? (
        <Card>
          <EmptyState
            icon="users"
            title="No companies linked yet"
            body="Open a customer and set its “Parent account / group” to this group — each company still keeps its own GSTIN and invoices."
            action={<Button variant="primary" icon="users" onClick={() => router.push("/customers" as never)}>Go to customers</Button>}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-4 py-3">Company</th>
                    <th className="text-left px-4 py-3">GSTIN</th>
                    <th className="text-left px-4 py-3">State</th>
                    <th className="text-right px-4 py-3">Outstanding</th>
                    <th className="text-right px-4 py-3">MRR</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {members.map((c) => {
                    const out = outstandingByCustomer.get(c.id) ?? 0;
                    const mrr = mrrByCustomer.get(c.id) ?? 0;
                    return (
                      <tr key={c.id} className="hover:bg-paper-2/40 cursor-pointer" onClick={() => router.push(`/customers/${c.id}` as never)}>
                        <td className="px-4 py-3 font-medium text-ink">{c.name}</td>
                        <td className="px-4 py-3 font-mono text-xs text-ink-2">{c.gstin ?? "—"}</td>
                        <td className="px-4 py-3 text-ink-2">{c.state ?? "—"}</td>
                        <td className={`px-4 py-3 text-right tabular-nums ${out > 0 ? "text-rose font-semibold" : "text-ink-3"}`}>{out > 0 ? rupee(out) : "—"}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-ink-2">{mrr > 0 ? rupee(mrr) : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2">
            {members.map((c) => {
              const out = outstandingByCustomer.get(c.id) ?? 0;
              const mrr = mrrByCustomer.get(c.id) ?? 0;
              return (
                <li key={c.id}>
                  <Card className="p-3 active:bg-paper-2/60" onClick={() => router.push(`/customers/${c.id}` as never)}>
                    <div className="font-medium text-ink">{c.name}</div>
                    <div className="text-xs text-ink-3 font-mono mt-0.5">{c.gstin ?? "No GSTIN"} · {c.state ?? "—"}</div>
                    <div className="flex justify-between mt-2 text-sm">
                      <span className={out > 0 ? "text-rose font-semibold" : "text-ink-3"}>{out > 0 ? `${rupee(out)} due` : "Nothing due"}</span>
                      <span className="text-ink-2 tabular-nums">{mrr > 0 ? `${rupee(mrr)} MRR` : ""}</span>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {group.notes && (
        <Card className="mt-6 p-4">
          <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Notes</div>
          <p className="text-sm text-ink-2 whitespace-pre-wrap">{group.notes}</p>
        </Card>
      )}

      <GroupFormDialog open={editOpen} onOpenChange={setEditOpen} group={group} />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete this group?</DialogTitle>
            <DialogDescription>
              This only removes the umbrella. The {members.length} {members.length === 1 ? "company" : "companies"} stay as customers
              (with all their invoices &amp; payments) — they&apos;re just un-linked from this group.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="primary"
              className="!bg-rose hover:!bg-rose/90"
              loading={del.isPending}
              onClick={() => {
                del.mutate(group.id, { onSuccess: () => router.push("/customers/groups" as never) });
              }}
            >
              Delete group
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
