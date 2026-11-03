/**
 * R-2413 — Payment Follow-up bulk actions: tick rows → Assign owner, Send reminder, Send
 * statement. Pure — tested in ./bulk-actions.test.ts. Card R-2413: staging had 22 of 22 rows
 * "Unassigned", and every reminder was sent one customer at a time.
 *
 * WHO: owner / manager / accountant only — the same people who may give a follow-up to someone
 * else (REASSIGN_ROLES, R-1514). The page shows the tick boxes and the bar only to them; Assign
 * owner goes through POST /api/collections/followups one row at a time, where resolveAssignee and
 * the DB trigger trg_payment_followups_reassign_guard re-check who may hand work away (exactly
 * as R-2404's Renewals bulk assign). Each email goes through the same per-customer route the
 * Send reminder dialog uses (R-2412: reminder/email, pending-dues/email — `can_contact_customers`,
 * RLS, one email per requestId).
 *
 * WHO IS SKIPPED (listed with the reason before anything is sent — §24):
 *   • Send reminder: a customer on hold (R-2411 collectionHold — promised, or disputes the bill),
 *     one with nothing late yet (no bill past its due date — a renewal not invoiced is not a
 *     bill), one owing nothing, and a line with no customer record.
 *   • Send statement: a statement is information, not a chase, so not-due and promised customers
 *     get it; a customer who disputes the bill is still skipped (sending them the bill again
 *     while it is argued reads as pressure). Owing nothing / no customer record are skipped too.
 *
 * Nothing is sent by this file. The bulk dialog lists every recipient and sends only when the
 * person presses its Send button (R-1514: a human sends every reminder).
 */
import type { CollectionRow } from "@/lib/queries/collections";
import { defaultNextFollowUp, mayReassignFollowup, type FollowupRequest } from "./followup-rules";
import { formatDate } from "@/lib/utils";

export function mayBulkCollect(role: string | null | undefined): boolean {
  return mayReassignFollowup(role);
}

export const BULK_NEEDS_ROLE =
  "Only an owner, manager or accountant can act on many customers at once. Use the row's own buttons, or ask your manager.";

export type BulkSendMode = "reminder" | "statement";

export interface Skipped<T> {
  row: T;
  reason: string;
}

const NO_CUSTOMER = "no customer record on this bill";
const OWES_NOTHING = "owes nothing yet (renewal not invoiced)";
const NOT_LATE = "nothing is late yet";
const DISPUTED = "disputes the bill — reminders paused";

type SendRow = Pick<CollectionRow, "key" | "customerId" | "customerName" | "amountDue" | "items" | "hold">;

function skipReason(r: SendRow, mode: BulkSendMode): string | null {
  if (!r.customerId) return NO_CUSTOMER;
  if (r.amountDue <= 0) return OWES_NOTHING;
  if (r.hold?.kind === "dispute") return DISPUTED;
  if (mode === "statement") return null;
  if (r.hold?.kind === "promise") return `promised to pay on ${formatDate(r.hold.until)} — reminders paused`;
  if (!r.items.some((i) => i.daysOverdue > 0 && i.amountDue > 0)) return NOT_LATE;
  return null;
}

/** Split the ticked rows into who gets the message and who is skipped (with why), in list order. */
export function bulkSendTargets<T extends SendRow>(rows: readonly T[], mode: BulkSendMode): { send: T[]; skipped: Skipped<T>[] } {
  const send: T[] = [];
  const skipped: Skipped<T>[] = [];
  for (const r of rows) {
    const reason = skipReason(r, mode);
    if (reason) skipped.push({ row: r, reason });
    else send.push(r);
  }
  return { send, skipped };
}

/** "2 nothing is late yet · 1 disputes the bill — …" — most common reason first. */
export function skipSummary(skipped: readonly Skipped<unknown>[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${n} ${reason}`).join(" · ");
}

// ─── Assign owner ────────────────────────────────────────────────────────────

export type AssignPick = { mode: "managers" } | { mode: "person"; id: string; name: string };

/**
 * The suggestion (card: "suggest the customer's account manager"): "Each customer's account
 * manager" is offered first when at least one ticked customer has one; else pick a person.
 */
export function assignChoices(
  rows: readonly Pick<CollectionRow, "customerId" | "ownerId">[],
  team: ReadonlyMap<string, string>,
): { suggestManagers: boolean; managersCovered: number; total: number } {
  const covered = rows.filter((r) => !!r.customerId && !!r.ownerId && team.has(r.ownerId)).length;
  return { suggestManagers: covered > 0, managersCovered: covered, total: rows.length };
}

export const NO_MANAGER = "no account manager on this customer — pick a person instead";

/**
 * One follow-up (kind note) per ticked customer, given to the picked person or to the customer's
 * own account manager. The next follow-up date is kept when it is today or later, else today + 3.
 */
export function bulkAssignRequests<T extends Pick<CollectionRow, "key" | "customerId" | "customerName" | "ownerId" | "nextFollowUpOn">>(
  rows: readonly T[],
  pick: AssignPick,
  team: ReadonlyMap<string, string>,
  today: string,
): { requests: { row: T; name: string; body: FollowupRequest }[]; skipped: Skipped<T>[] } {
  const requests: { row: T; name: string; body: FollowupRequest }[] = [];
  const skipped: Skipped<T>[] = [];
  for (const r of rows) {
    if (!r.customerId) { skipped.push({ row: r, reason: NO_CUSTOMER }); continue; }
    const to = pick.mode === "person"
      ? { id: pick.id, name: pick.name }
      : r.ownerId && team.has(r.ownerId) ? { id: r.ownerId, name: team.get(r.ownerId)! } : null;
    if (!to) { skipped.push({ row: r, reason: NO_MANAGER }); continue; }
    const next = r.nextFollowUpOn && r.nextFollowUpOn >= today ? r.nextFollowUpOn : defaultNextFollowUp(today);
    requests.push({
      row: r,
      name: to.name,
      body: {
        customerId: r.customerId,
        kind: "note",
        note: `Payment follow-up owner: ${to.name}`,
        nextFollowUpOn: next,
        assignedTo: to.id,
      },
    });
  }
  return { requests, skipped };
}

export interface BulkReport {
  tone: "success" | "warning" | "error";
  title: string;
  description?: string;
}

const failList = (failed: readonly { name: string; error: string }[]) =>
  failed.slice(0, 3).map((f) => `${f.name} — ${f.error}`).join("; ") + (failed.length > 3 ? `; and ${failed.length - 3} more` : "");

/** After a bulk assign (§24: who failed and what to do). */
export function bulkAssignReport(done: number, failed: readonly { name: string; error: string }[]): BulkReport {
  if (failed.length === 0) return { tone: "success", title: `${done} customer${done === 1 ? "" : "s"} given an owner` };
  return {
    tone: done > 0 ? "warning" : "error",
    title: done > 0 ? `${done} given an owner, ${failed.length} not saved` : "No owner saved",
    description: `${failList(failed)}. Press Retry failed, or open the row's Follow-up.`,
  };
}

/** After a bulk email run. `already` = the server said that email had gone before (R-1544). */
export function bulkSendReport(
  mode: BulkSendMode,
  out: { sent: number; already: number; failed: readonly { name: string; error: string }[] },
): BulkReport {
  const noun = (n: number) => `${mode === "statement" ? "statement" : "reminder"}${n === 1 ? "" : "s"}`;
  const head = `${out.sent} ${noun(out.sent)} emailed${out.already > 0 ? ` · ${out.already} had already gone (not sent again)` : ""}`;
  if (out.failed.length === 0) return { tone: "success", title: head };
  return {
    tone: out.sent + out.already > 0 ? "warning" : "error",
    title: `${head} · ${out.failed.length} not sent`,
    description: `${failList(out.failed)}. Press Send again for the ones not sent — the ones that went are not sent twice.`,
  };
}
