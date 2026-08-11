/**
 * Enquiries Inbox — inbound emails to the reseller, shown logically.
 *
 * Any email forwarded to the ERP (via the inbound-email webhook) lands here:
 * genuine enquiries auto-become leads; the rest wait for the operator to triage
 * and convert by hand. Read-only over inbound_emails (RLS-scoped) + the atomic
 * convert-to-lead RPC. No money writes.
 *
 * The body is NEVER rendered as HTML (arbitrary senders → XSS). We show the
 * plain-text version only; HTML-only mail gets a clear note instead.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { formatDate } from "@/lib/utils";
import { useInboundEmails, useConvertInboundToLead } from "@/lib/queries/inbound-emails";
import { inboundStatusMeta, canConvertToLead } from "@/lib/inbound/status";
import type { InboundEmailRow } from "@/lib/supabase/database.types";

function StatusBadge({ status }: { status: string }) {
  const meta = inboundStatusMeta(status);
  return <Badge kind={meta.kind} dot>{meta.label}</Badge>;
}

function senderLabel(e: InboundEmailRow): string {
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

export default function EnquiriesPage() {
  const { data: rows, isLoading, error, refetch } = useInboundEmails();
  const convert = useConvertInboundToLead();
  const [openId, setOpenId] = React.useState<string | null>(null);

  const selected = React.useMemo(
    () => (rows ?? []).find((r) => r.id === openId) ?? null,
    [rows, openId],
  );

  const totals = React.useMemo(() => {
    const list = rows ?? [];
    return {
      total:     list.length,
      untriaged: list.filter((r) => r.status === "received" && !r.lead_id).length,
      leads:     list.filter((r) => r.lead_id).length,
    };
  }, [rows]);

  async function handleConvert(id: string) {
    await convert.mutateAsync(id);
    // Keep the sheet open — it re-renders with the "View lead" link on success.
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Enquiries</h1>
          <p className="text-sm text-ink-3 mt-1">
            Emails forwarded to your ERP. Genuine enquiries become leads automatically — triage the rest here.
          </p>
        </div>
      </div>

      {!isLoading && !error && rows && rows.length > 0 && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "New to triage", value: String(totals.untriaged), tone: totals.untriaged > 0 ? "amber" : undefined },
            { label: "Became leads",  value: String(totals.leads), tone: "emerald" },
            { label: "Total received", value: String(totals.total) },
          ]}
        />
      )}

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load enquiries"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {isLoading && (
        <Card flush>
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        </Card>
      )}

      {!isLoading && !error && rows && rows.length === 0 && (
        <EmptyState
          icon="mail"
          title="No emails yet"
          body="When someone emails your connected inbox, it'll show up here — and real enquiries turn into leads on their own."
        />
      )}

      {!isLoading && !error && rows && rows.length > 0 && (
        <>
          {/* Mobile: card list */}
          <ul className="md:hidden space-y-3">
            {rows.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(e.id)}
                  className="w-full text-left rounded-lg border border-hairline bg-paper p-4 hover:bg-paper-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-medium text-ink truncate">{senderLabel(e)}</span>
                    <StatusBadge status={e.status} />
                  </div>
                  <p className="text-sm text-ink-2 truncate">{e.subject?.trim() || "(no subject)"}</p>
                  <p className="text-xs text-ink-3 mt-1">{formatDate(e.created_at, "relative")}</p>
                </button>
              </li>
            ))}
          </ul>

          {/* Desktop: table */}
          <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">From</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Subject</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Received</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr
                    key={e.id}
                    onClick={() => setOpenId(e.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open enquiry from ${senderLabel(e)}`}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setOpenId(e.id); } }}
                    className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
                  >
                    <td className="p-3 text-sm">
                      <div className="font-medium text-ink">{senderLabel(e)}</div>
                      {e.from_name?.trim() && e.from_email && (
                        <div className="text-xs text-ink-3">{e.from_email}</div>
                      )}
                    </td>
                    <td className="p-3 text-sm text-ink-2 max-w-[360px] truncate">
                      {e.subject?.trim() || "(no subject)"}
                    </td>
                    <td className="p-3 text-sm text-ink-3 whitespace-nowrap">{formatDate(e.created_at, "relative")}</td>
                    <td className="p-3"><StatusBadge status={e.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}

      {/* Detail drawer */}
      <Sheet open={!!selected} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>{selected.subject?.trim() || "(no subject)"}</SheetTitle>
                <SheetDescription>
                  {senderLabel(selected)}
                  {selected.from_name?.trim() && selected.from_email ? ` · ${selected.from_email}` : ""}
                </SheetDescription>
                <div className="flex items-center gap-2 mt-2">
                  <StatusBadge status={selected.status} />
                  <span className="text-xs text-ink-3">{formatDate(selected.created_at, "long")}</span>
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto p-6">
                {selected.body_text?.trim() ? (
                  <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink-2 leading-relaxed">
                    {selected.body_text}
                  </pre>
                ) : selected.body_html?.trim() ? (
                  <p className="text-sm text-ink-3 italic">
                    This email was sent as HTML only — no plain-text version is available to show safely.
                  </p>
                ) : (
                  <p className="text-sm text-ink-3 italic">No message body was captured.</p>
                )}
              </div>

              <div className="border-t border-hairline p-4 flex items-center justify-between gap-2">
                {selected.lead_id ? (
                  <Button asChild variant="primary" icon="target">
                    <Link href={"/leads" as never}>View in Leads</Link>
                  </Button>
                ) : canConvertToLead(selected) ? (
                  <Button
                    variant="primary"
                    icon="plus"
                    loading={convert.isPending}
                    onClick={() => handleConvert(selected.id)}
                  >
                    Convert to lead
                  </Button>
                ) : (
                  <span className="text-xs text-ink-3 flex items-center gap-1.5">
                    <Icon name="info" size={14} /> No action needed
                  </span>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
