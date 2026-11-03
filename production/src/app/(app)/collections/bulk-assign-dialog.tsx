"use client";
/**
 * R-2413 — bulk "Assign owner" on Payment Follow-up (staging 3 Nov: 22 of 22 rows Unassigned).
 *
 * Suggestion first: "Each customer's account manager" (customers.account_manager_id) when at
 * least one ticked customer has one; else / or "One person". Each ticked customer gets one
 * follow-up (kind note, "Payment follow-up owner: <name>") through POST /api/collections/followups
 * — the same route as the Follow-up dialog, where resolveAssignee and the DB trigger
 * trg_payment_followups_reassign_guard re-check that only owner / manager / accountant hand work
 * to someone else (the same path as R-2404's Renewals bulk assign). Rules:
 * lib/collections/bulk-actions.ts.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { istToday } from "@/lib/dates/ist";
import type { UserName } from "@/lib/hooks/useUserNames";
import type { CollectionRow } from "@/lib/queries/collections";
import { FollowupSaveError, postFollowup } from "@/lib/queries/payment-followups";
import {
  assignChoices, bulkAssignReport, bulkAssignRequests, skipSummary, type AssignPick,
} from "@/lib/collections/bulk-actions";

const pill = (on: boolean) =>
  `w-full text-left min-h-[44px] md:min-h-0 px-3 py-2 rounded-md border text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber ${
    on ? "border-amber bg-amber-soft text-ink" : "border-hairline bg-paper text-ink-2 hover:border-amber/60"
  }`;

export function BulkAssignDialog({
  open, onOpenChange, rows, team, onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: readonly CollectionRow[];
  /** Active people, sorted by name. */
  team: readonly UserName[];
  /** After a run: the keys that were NOT saved (the page keeps only those ticked). */
  onDone: (failedKeys: string[]) => void;
}) {
  const qc = useQueryClient();
  const teamMap = React.useMemo(() => new Map(team.map((u) => [u.id, u.label])), [team]);
  const choice = assignChoices(rows, teamMap);
  const [mode, setMode] = React.useState<"managers" | "person">(choice.suggestManagers ? "managers" : "person");
  const [personId, setPersonId] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) { setMode(choice.suggestManagers ? "managers" : "person"); setPersonId(""); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset once per opening
  }, [open]);

  const person = team.find((u) => u.id === personId);
  const pick: AssignPick | null = mode === "managers" ? { mode: "managers" } : person ? { mode: "person", id: person.id, name: person.label } : null;
  const plan = pick ? bulkAssignRequests(rows, pick, teamMap, istToday()) : null;

  async function run() {
    if (!plan || busy || plan.requests.length === 0) return;
    setBusy(true);
    const failed: { key: string; name: string; error: string }[] = plan.skipped.map((s) => ({ key: s.row.key, name: s.row.customerName, error: s.reason }));
    let done = 0;
    for (const r of plan.requests) {
      try { await postFollowup(r.body); done += 1; }
      catch (e) { failed.push({ key: r.row.key, name: r.row.customerName, error: e instanceof FollowupSaveError ? e.message : "not saved — check your internet" }); }
    }
    setBusy(false);
    void qc.invalidateQueries({ queryKey: ["collections"] });
    void qc.invalidateQueries({ queryKey: ["payment-followups"] });
    const m = bulkAssignReport(done, failed);
    if (m.tone === "success") toast.success(m.title);
    else if (m.tone === "warning") toast.warning(m.title, { description: m.description, duration: 15_000 });
    else toast.error(m.title, { description: m.description, duration: 15_000 });
    onDone(failed.map((f) => f.key));
    onOpenChange(false);
  }

  const n = plan?.requests.length ?? 0;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign owner · {rows.length} selected</DialogTitle>
          <DialogDescription>
            Who chases these customers for payment. It shows in their &quot;Mere&quot; list and in each customer&apos;s follow-up history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2" role="radiogroup" aria-label="Give them to">
          <button
            type="button" role="radio" aria-checked={mode === "managers"} disabled={!choice.suggestManagers}
            onClick={() => setMode("managers")} className={`${pill(mode === "managers")} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <span className="font-medium text-ink">Each customer&apos;s account manager</span>
            <span className="block text-xs text-ink-3">
              {choice.suggestManagers
                ? `${choice.managersCovered} of ${choice.total} have one${choice.managersCovered < choice.total ? " — the rest are skipped" : ""}`
                : "None of the selected customers has an account manager"}
            </span>
          </button>
          <button type="button" role="radio" aria-checked={mode === "person"} onClick={() => setMode("person")} className={pill(mode === "person")}>
            <span className="font-medium text-ink">One person</span>
            <span className="block text-xs text-ink-3">All selected customers go to the person you pick</span>
          </button>
          {mode === "person" && (
            <Select value={personId} onValueChange={setPersonId}>
              <SelectTrigger aria-label="Owner" className="w-full"><SelectValue placeholder="Pick a person" /></SelectTrigger>
              <SelectContent>
                {team.map((u) => <SelectItem key={u.id} value={u.id}>{u.label}</SelectItem>)}
              </SelectContent>
            </Select>
          )}
        </div>

        {plan && plan.skipped.length > 0 && (
          <p className="text-xs text-ink-3" role="note">Skipped {plan.skipped.length}: {skipSummary(plan.skipped)}.</p>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" variant="primary" icon="check" disabled={n === 0} loading={busy} onClick={() => void run()}>
            {n === 0 ? "Assign" : mode === "person" && person ? `Give ${n} to ${person.label}` : `Assign ${n} ${n === 1 ? "customer" : "customers"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
