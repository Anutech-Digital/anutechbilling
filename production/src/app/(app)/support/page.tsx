/**
 * /support — reseller-side support & tenant feedback inbox.
 *
 * Pardeep & Deepak see tickets raised by Tenants / Customers +
 * internal employee software testing reports.
 */
"use client";

import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { formatDate } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { SupportTicketRow, SupportTicketStatus } from "@/lib/supabase/database.types";

export type ViewScope = "tenant_feedback" | "team_testing";

const STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open:              "Open",
  in_progress:       "In progress",
  awaiting_customer: "Awaiting customer",
  resolved:          "Resolved",
  closed:            "Closed",
};
const STATUS_COLOR: Record<SupportTicketStatus, "rose" | "amber" | "indigo" | "emerald" | "slate"> = {
  open:              "rose",
  in_progress:       "amber",
  awaiting_customer: "indigo",
  resolved:          "emerald",
  closed:            "slate",
};
const STATUSES: ("all" | SupportTicketStatus)[] = ["open", "in_progress", "awaiting_customer", "resolved", "closed", "all"];

function useTickets(scope: ViewScope, statusFilter: "all" | SupportTicketStatus) {
  return useQuery({
    queryKey: ["support_tickets", scope, statusFilter],
    queryFn: async (): Promise<SupportTicketRow[]> => {
      const supabase = createClient();
      let q = supabase.from("support_tickets").select("*").order("created_at", { ascending: false });
      
      if (scope === "team_testing") {
        q = q.or("subject.ilike.[BUG]%,subject.ilike.[FEATURE]%,subject.ilike.[UI_IMPROVEMENT]%");
      } else {
        // Tenant / Customer Feedback — exclude team tags
        q = q.not("subject", "ilike", "[BUG]%").not("subject", "ilike", "[FEATURE]%").not("subject", "ilike", "[UI_IMPROVEMENT]%");
      }

      if (statusFilter !== "all") {
        q = q.eq("status", statusFilter);
      }
      
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SupportTicketRow[];
    },
  });
}

function useTicketCounts(scope: ViewScope) {
  return useQuery({
    queryKey: ["support_tickets", "counts", scope],
    queryFn: async () => {
      const supabase = createClient();
      const { data } = await supabase.from("support_tickets").select("status, subject");
      const out: Record<string, number> = { all: 0, open: 0, in_progress: 0, awaiting_customer: 0, resolved: 0, closed: 0 };
      
      for (const r of data ?? []) {
        const isTeam = r.subject && (r.subject.includes("[BUG]") || r.subject.includes("[FEATURE]") || r.subject.includes("[UI_IMPROVEMENT]"));
        
        if (scope === "team_testing" && isTeam) {
          out.all += 1;
          out[r.status as string] = (out[r.status as string] ?? 0) + 1;
        } else if (scope === "tenant_feedback" && !isTeam) {
          out.all += 1;
          out[r.status as string] = (out[r.status as string] ?? 0) + 1;
        }
      }
      return out;
    },
  });
}

export default function SupportPage() {
  const [scope, setScope] = React.useState<ViewScope>("tenant_feedback");
  const [statusFilter, setStatusFilter] = React.useState<"all" | SupportTicketStatus>("open");
  const [selected, setSelected] = React.useState<SupportTicketRow | null>(null);

  const { data: tickets = [], isLoading } = useTickets(scope, statusFilter);
  const { data: counts }                  = useTicketCounts(scope);
  const qc = useQueryClient();

  const updateTicket = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<Omit<SupportTicketRow, "id" | "tenant_id" | "created_at" | "updated_at">> }) => {
      const supabase = createClient();
      const { error } = await supabase.from("support_tickets").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["support_tickets"] });
      toast.success("Ticket updated");
    },
    onError: (err) => toast.error((err as Error).message),
  });

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6 flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage & Feedback Inbox</p>
          <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Support & Feedback Desk</h1>
          <p className="text-sm text-ink-3 mt-1">
            Manage feedback and support queries from your Tenants / Customers + internal employee bug reports.
          </p>
        </div>

        {/* Primary View Switcher: Tenant Feedback vs Team Testing */}
        <div className="flex items-center gap-1.5 p-1 bg-paper-2 border border-hairline rounded-xl shadow-xs">
          <button
            type="button"
            onClick={() => { setScope("tenant_feedback"); setStatusFilter("open"); }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              scope === "tenant_feedback"
                ? "bg-paper text-primary shadow-sm border border-hairline"
                : "text-ink-3 hover:text-ink hover:bg-paper-3"
            }`}
          >
            <Icon name="building" size={15} />
            <span>🏢 Tenant / Customer Feedback</span>
          </button>

          <button
            type="button"
            onClick={() => { setScope("team_testing"); setStatusFilter("open"); }}
            className={`px-4 py-2 rounded-lg text-xs font-bold transition-all flex items-center gap-2 ${
              scope === "team_testing"
                ? "bg-rose-soft text-rose-ink shadow-sm border border-rose/30"
                : "text-ink-3 hover:text-ink hover:bg-paper-3"
            }`}
          >
            <Icon name="bug" size={15} />
            <span>🐛 Internal Team Reports</span>
          </button>
        </div>
      </div>

      {/* Sub-Status Pills */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-5">
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((s) => {
            const active = statusFilter === s;
            const count  = counts?.[s] ?? 0;
            const label = s === "all" ? "All Tickets" : STATUS_LABEL[s];
            return (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`text-xs px-3 py-1.5 rounded-full border transition-all inline-flex items-center gap-2 ${
                  active
                    ? scope === "team_testing"
                      ? "border-rose bg-rose-soft text-rose-ink font-bold shadow-sm"
                      : "border-primary bg-primary-soft text-primary font-bold shadow-sm"
                    : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                }`}
              >
                <span>{label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${active ? "bg-paper font-bold" : "bg-paper-2 text-ink-3"}`}>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="text-xs text-ink-3 font-medium">
          Showing <span className="font-bold text-ink">{tickets.length}</span> {scope === "tenant_feedback" ? "Tenant/Customer Tickets" : "Team Bug Reports"}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3].map((i) => <Skeleton key={i} className="h-20 w-full" />)}
        </div>
      ) : tickets.length === 0 ? (
        <Card className="py-10 text-center">
          <EmptyState
            icon={scope === "tenant_feedback" ? "building" : "bug"}
            title={scope === "tenant_feedback" ? "No Customer / Tenant Tickets Found" : "No Team Bug Reports Found"}
            body={
              scope === "tenant_feedback"
                ? "Feedback and support requests submitted by your Tenants & Clients on the portal will appear here."
                : "Bug reports and feature suggestions submitted by employees via the Report Bug button will appear here."
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => {
            const isTeam = t.subject.includes("[BUG]") || t.subject.includes("[FEATURE]") || t.subject.includes("[UI_IMPROVEMENT]");
            return (
              <Card
                key={t.id}
                className={`p-5 hover:bg-paper-2/30 cursor-pointer transition-all border-l-4 ${
                  isTeam ? "border-l-rose hover:border-l-rose-ink" : "border-l-primary hover:border-l-primary"
                }`}
                onClick={() => setSelected(t)}
              >
                <div className="flex items-start justify-between gap-3 flex-wrap mb-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      {scope === "tenant_feedback" ? (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary-soft text-primary border border-primary/30">
                          🏢 Tenant Feedback
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-soft text-rose-ink border border-rose/30">
                          🐛 Team Bug Report
                        </span>
                      )}
                      <div className="font-semibold text-ink text-base leading-tight">{t.subject}</div>
                    </div>
                    <div className="text-[11px] text-ink-3 mt-1 flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-ink-2">{t.id.slice(0, 8)}</span>
                      <span>·</span>
                      <span className="font-semibold text-ink">{t.customer_name} ({t.raised_by_email})</span>
                      <span>·</span>
                      <span>{formatDate(t.created_at.slice(0, 10))}</span>
                      <span>·</span>
                      <span className="capitalize">{t.category.replace("_", " ")}</span>
                      {t.priority !== "normal" && (
                        <>
                          <span>·</span>
                          <span className={t.priority === "urgent" ? "text-rose font-bold uppercase" : "text-amber-ink font-semibold"}>
                            {t.priority}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <Badge color={STATUS_COLOR[t.status]}>{STATUS_LABEL[t.status]}</Badge>
                </div>
                <p className="text-xs text-ink-2 leading-relaxed line-clamp-2 mt-2 font-mono bg-paper-2/50 p-2.5 rounded border border-hairline/60">
                  {t.body}
                </p>
              </Card>
            );
          })}
        </div>
      )}

      {/* Detail dialog */}
      {selected && (
        <TicketDetail
          ticket={selected}
          onClose={() => setSelected(null)}
          onUpdate={(patch) => updateTicket.mutateAsync({ id: selected.id, patch })}
        />
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Detail modal — show + action
// ────────────────────────────────────────────────────────────────

function TicketDetail({
  ticket, onClose, onUpdate,
}: {
  ticket: SupportTicketRow;
  onClose: () => void;
  onUpdate: (patch: Partial<Omit<SupportTicketRow, "id" | "tenant_id" | "created_at" | "updated_at">>) => Promise<unknown>;
}) {
  const [note, setNote] = React.useState(ticket.resolution_note ?? "");
  const [busy, setBusy] = React.useState(false);
  const [zoomImage, setZoomImage] = React.useState<string | null>(null);

  const isTeamReport = ticket.subject.includes("[BUG]") || ticket.subject.includes("[FEATURE]") || ticket.subject.includes("[UI_IMPROVEMENT]");

  async function setStatus(newStatus: SupportTicketStatus) {
    setBusy(true);
    const patch: Partial<Omit<SupportTicketRow, "id" | "tenant_id" | "created_at" | "updated_at">> = { status: newStatus };
    if (newStatus === "resolved") {
      patch.resolved_at     = new Date().toISOString();
      patch.resolution_note = note;
    }
    try {
      await onUpdate(patch);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-ink/50 backdrop-blur-xs z-50 grid place-items-center p-4" onClick={onClose}>
      <Card className="max-w-3xl w-full p-6 max-h-[92vh] overflow-y-auto shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Badge color={STATUS_COLOR[ticket.status]}>{STATUS_LABEL[ticket.status]}</Badge>
              {isTeamReport ? (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-rose-soft text-rose-ink border border-rose/30">
                  🐛 Employee Testing Report
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider bg-primary-soft text-primary border border-primary/30">
                  🏢 Tenant / Client Feedback
                </span>
              )}
            </div>
            <h2 className="font-serif text-xl md:text-2xl text-ink leading-tight">{ticket.subject}</h2>
            <div className="text-[11px] text-ink-3 mt-1 font-mono">{ticket.id}</div>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-ink-3 hover:text-ink hover:bg-paper-2"><Icon name="x" size={20} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs border-y border-hairline py-3 mb-4 bg-paper-2/40 p-3 rounded-lg">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Tenant / Client Name</div>
            <div className="text-ink font-semibold text-sm">{ticket.customer_name}</div>
            <div className="text-ink-3 font-mono text-[11px]">{ticket.raised_by_email}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Category · Priority</div>
            <div className="text-ink font-medium capitalize">{ticket.category.replace("_", " ")}</div>
            <div className={`text-[11px] font-semibold ${ticket.priority === "urgent" ? "text-rose" : ticket.priority === "high" ? "text-amber-ink" : "text-ink-3"}`}>
              {ticket.priority.toUpperCase()} priority
            </div>
          </div>
        </div>

        <div className="mb-4">
          <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1">Feedback / Issue Details</div>
          <div className="text-xs text-ink-2 leading-relaxed whitespace-pre-wrap font-mono p-3 bg-paper border border-hairline rounded-lg">
            {ticket.body}
          </div>
        </div>

        {/* Resolution note */}
        <div className="mb-4">
          <label className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-1 block">
            Resolution Note (Visible to Tenant on Portal)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 text-xs border border-hairline rounded-md bg-paper text-ink placeholder:text-ink-4 focus:outline-none focus:ring-1 focus:ring-primary font-mono"
            placeholder="Describe the action taken or response for this tenant feedback..."
          />
        </div>

        <div className="flex flex-wrap gap-2 justify-end pt-2 border-t border-hairline">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {ticket.status === "open" && (
            <Button variant="default" loading={busy} onClick={() => setStatus("in_progress")}>
              Mark In Progress
            </Button>
          )}
          {ticket.status !== "resolved" && (
            <Button variant="primary" loading={busy} onClick={() => setStatus("resolved")}>
              <Icon name="check" size={14} className="mr-1" /> Mark Resolved
            </Button>
          )}
          {ticket.status === "resolved" && (
            <Button variant="default" loading={busy} onClick={() => setStatus("closed")}>
              Close Ticket
            </Button>
          )}
        </div>

        {/* Contact Reporter */}
        <div className="mt-4 pt-3 border-t border-hairline flex items-center justify-between text-xs text-ink-3">
          <span>Tenant Email: <span className="font-mono text-ink">{ticket.raised_by_email}</span></span>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`Hi ${ticket.customer_name}, regarding your feedback ${ticket.id}: ${ticket.subject}\n\n`)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs px-3.5 py-2 rounded-md text-white font-semibold shadow-xs"
            style={{ background: "#25D366" }}
          >
            <Icon name="whatsapp" size={14} /> Contact Tenant on WhatsApp
          </a>
        </div>
      </Card>

      {/* Image Zoom Modal */}
      {zoomImage && (
        <div className="fixed inset-0 bg-ink/90 z-50 grid place-items-center p-4" onClick={() => setZoomImage(null)}>
          <div className="relative max-w-4xl max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setZoomImage(null)}
              className="absolute top-2 right-2 p-2 rounded-full bg-ink/70 text-white hover:bg-ink"
            >
              <Icon name="x" size={20} />
            </button>
            <img src={zoomImage} alt="Zoomed screenshot" className="w-full h-auto max-h-[85vh] object-contain rounded-lg border border-paper/20" />
          </div>
        </div>
      )}
    </div>
  );
}
