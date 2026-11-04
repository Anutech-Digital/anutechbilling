/**
 * Settings → Privacy requests — R-2013 (2 Nov 2026, goal G-DPDP).
 *
 * Data-rights requests people sent from the website form (/privacy/request) after confirming
 * their email: see / correct / delete my data, withdraw consent, nominate someone. Each has a
 * due-by date (30 days from confirmation — our privacy policy's promise) and an Overdue badge.
 * Owner or manager only (menu, middleware and the database all agree). Actions: Export the
 * person's data (JSON / CSV), Mark corrected, Close — each logged in activity_log.
 * A "withdraw consent" request has already stopped offers, greetings and AI follow-ups by itself.
 */
"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { useAskText, useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { istToday } from "@/lib/dates/ist";
import { toastError } from "@/lib/errors/toast-error";
import { usePrivacyRequests, usePrivacyAction, downloadPersonExport } from "@/lib/privacy/queries";
import { DPDP_RESPONSE_DAYS, dueState, type PrivacyRequestRow } from "@/lib/privacy/requests";
import { RequestTable } from "./request-table";

export default function PrivacyRequestsPage() {
  const { data: me } = useCurrentUser();
  const q = usePrivacyRequests();
  const act = usePrivacyAction();
  const confirm = useConfirm();
  const askText = useAskText();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const today = istToday();
  const allowed = me == null || me.role === "owner" || me.role === "manager";
  const rows = q.data ?? [];
  const overdue = rows.filter((r) => dueState(r.due_by, r.status, today).overdue).length;
  const open = rows.filter((r) => r.status !== "closed").length;

  async function onExport(r: PrivacyRequestRow, format: "json" | "csv") {
    setBusyId(r.id);
    try {
      await downloadPersonExport(r, format);
      await act.mutateAsync({ id: r.id, action: "exported" });
      toast.success(`${r.full_name}'s data downloaded (${format.toUpperCase()}). Send it to ${r.email}.`);
    } catch (e) {
      toastError(e);
    } finally {
      setBusyId(null);
    }
  }

  async function onCorrected(r: PrivacyRequestRow) {
    const note = await askText({
      title: `What did you correct for ${r.full_name}?`,
      body: "A short note for the record.",
      label: "What changed",
      placeholder: "e.g. Mobile number changed to the new one",
      confirmLabel: "Mark corrected",
    });
    if (note == null) return;
    setBusyId(r.id);
    try { await act.mutateAsync({ id: r.id, action: "corrected", note }); toast.success("Marked corrected."); }
    catch { /* toast shown by the mutation */ }
    finally { setBusyId(null); }
  }

  async function onClose(r: PrivacyRequestRow) {
    const ok = await confirm({
      title: `Close ${r.full_name}'s request?`,
      body: "Close it once you have answered the person. It stays in this list as closed.",
      confirmLabel: "Close request",
      icon: "check",
    });
    if (!ok) return;
    setBusyId(r.id);
    try { await act.mutateAsync({ id: r.id, action: "closed" }); toast.success("Request closed."); }
    catch { /* toast shown by the mutation */ }
    finally { setBusyId(null); }
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1200px] mx-auto">
      <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Settings</p>
      <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Privacy requests</h1>
      <p className="text-sm text-ink-2 mt-1 mb-4 max-w-3xl">
        People who asked, from your website&apos;s &ldquo;Your data&rdquo; form, to see, correct or delete their data,
        to withdraw consent, or to nominate someone. Their email is confirmed with a code. Answer each one within{" "}
        {DPDP_RESPONSE_DAYS} days{rows.length > 0 && <> — <b>{open} open</b>{overdue > 0 && <>, <b className="text-rose-ink">{overdue} overdue</b></>}</>}.
      </p>

      {!allowed ? (
        <Card className="py-2">
          <EmptyState icon="lock" title="Only the owner or a manager can see privacy requests"
            body="These requests carry people's contact details and what they asked for. Ask your owner to open this page." />
        </Card>
      ) : q.isLoading ? (
        <div className="space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : q.isError ? (
        <LoadError what="Privacy requests" error={q.error} onRetry={() => { void q.refetch(); }} />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState icon="inbox" title="No privacy requests yet"
            body="When someone sends the &quot;Make a request about your data&quot; form on your website and confirms their email, it shows here with its due-by date." />
        </Card>
      ) : (
        <RequestTable rows={rows} todayIst={today} busyId={busyId} onExport={onExport} onCorrected={onCorrected} onClose={onClose} />
      )}
    </div>
  );
}
