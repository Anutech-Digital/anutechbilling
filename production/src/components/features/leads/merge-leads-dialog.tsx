/**
 * MergeLeadsDialog — fold duplicate leads into one, with the operator in control.
 *
 * Opened from the "Duplicate?" flag on the Leads list. Shows the matching leads,
 * lets the operator pick which record to KEEP (primary), and — only on explicit
 * confirm — merges the rest into it via the atomic `merge_leads` RPC (repoints
 * activities/quotes/tasks, backfills empty fields, keeps the bigger value).
 * Nothing is deleted until the operator hits Merge.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import { useMergeLeads } from "@/lib/queries/leads";
import type { MergeLead } from "@/lib/queries/leads";

/** How many useful fields a lead has filled — used to default-pick the richest
 *  record as the one to keep. */
function completeness(l: MergeLead): number {
  return [l.contact_name, l.contact_email, l.contact_phone, l.plan, l.seats, l.value, l.gstin, l.notes]
    .filter((v) => v != null && v !== "").length;
}

export function MergeLeadsDialog({
  cluster, onClose,
}: {
  cluster: MergeLead[];   // 2+ leads that duplicate one another (only the columns shown — S40)
  onClose: () => void;
}) {
  const merge = useMergeLeads();

  // Default to keeping the richest record; tiebreak by higher value, then oldest.
  const defaultPrimary = React.useMemo(
    () =>
      [...cluster].sort(
        (a, b) =>
          completeness(b) - completeness(a) ||
          (b.value ?? 0) - (a.value ?? 0) ||
          new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
      )[0]?.id,
    [cluster],
  );
  const [primaryId, setPrimaryId] = React.useState<string>(defaultPrimary);
  React.useEffect(() => { setPrimaryId(defaultPrimary); }, [defaultPrimary]);
  const [busy, setBusy] = React.useState(false);

  const dups = cluster.filter((l) => l.id !== primaryId);
  const primary = cluster.find((l) => l.id === primaryId);

  async function handleMerge() {
    if (dups.length === 0) return;
    setBusy(true);
    try {
      // One duplicate at a time into the chosen primary (each is atomic server-side).
      for (const d of dups) {
        await merge.mutateAsync({ primaryId, duplicateId: d.id });
      }
      toast.success(
        `Merged ${dups.length} duplicate${dups.length > 1 ? "s" : ""} into ${primary?.company ?? "the primary lead"}`,
      );
      onClose();
    } catch {
      // useMergeLeads already surfaces the error toast.
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-2xl p-0 gap-0 flex flex-col max-h-[92vh]">
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-hairline space-y-1">
          <DialogTitle className="text-base flex items-center gap-2">
            <Icon name="copy" size={16} className="text-amber-ink" />
            Merge duplicate leads
          </DialogTitle>
          <p className="text-xs text-ink-3">
            Pick the lead to <b className="text-ink-2">keep</b>. The others merge into it —
            their activities / quotes / tasks move to it, empty fields get filled in, and
            the larger deal value stays. <b className="text-rose">This cannot be undone.</b>
          </p>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
          {cluster.map((l) => {
            const isPrimary = l.id === primaryId;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => setPrimaryId(l.id)}
                aria-pressed={isPrimary}
                className={cn(
                  "w-full text-left rounded-lg border p-3 flex items-start gap-3 transition-colors",
                  isPrimary
                    ? "border-emerald bg-emerald-soft/40 ring-1 ring-emerald"
                    : "border-hairline hover:bg-paper-2",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0",
                    isPrimary ? "border-emerald" : "border-hairline",
                  )}
                >
                  {isPrimary && <span className="w-2 h-2 rounded-full bg-emerald" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-ink truncate">{l.company}</span>
                    {isPrimary ? (
                      <Badge kind="success" size="sm" dot>Keep</Badge>
                    ) : (
                      <Badge kind="muted" size="sm">will merge in</Badge>
                    )}
                    <span className="text-xs font-mono text-ink-3">{l.id}</span>
                  </div>
                  <div className="text-xs text-ink-2 mt-1.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5">
                    <span className="truncate"><Icon name="user" size={10} className="inline text-ink-3 mr-1" />{l.contact_name || "—"}</span>
                    <span className="font-mono truncate"><Icon name="call" size={10} className="inline text-ink-3 mr-1" />{l.contact_phone || "—"}</span>
                    <span className="truncate"><Icon name="mail" size={10} className="inline text-ink-3 mr-1" />{l.contact_email || "—"}</span>
                    <span className="truncate">
                      <Icon name="rupee" size={10} className="inline text-ink-3 mr-1" />
                      {l.value ? rupee(l.value) : "—"} · {formatDate(l.created_at)}
                    </span>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-hairline gap-2 sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            variant="primary"
            icon="copy"
            onClick={handleMerge}
            disabled={busy || dups.length === 0}
          >
            {busy ? "Merging…" : `Merge ${dups.length} into this`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
