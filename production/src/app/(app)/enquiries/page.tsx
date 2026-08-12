/**
 * Outlook-Style CRM Sales Email Suite — /enquiries
 *
 * Microsoft Outlook 3-Pane Email Hub with Missive/Front/HubSpot B2B Sales Inbox features:
 *   - Pane 1: Folders & Smart Filters (Sales Enquiries Only by default, All, Untriaged, Converted Leads, Thread Replies, System/Skipped)
 *   - Pane 2: Email Threads List (Search, Sender avatars, Relative timestamps, Hover actions, Domain badges)
 *   - Pane 3: Rich Email Reading Pane + AI Gemini Draft Assistant + Internal Team Notes + Canned Templates + CRM Actions + Prospect Communication Timeline
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/shared/empty-state";
import { StatStrip } from "@/components/shared/stat-strip";
import { formatDate } from "@/lib/utils";
import { useInboundEmails, useConvertInboundToLead } from "@/lib/queries/inbound-emails";
import { inboundStatusMeta, canConvertToLead } from "@/lib/inbound/status";
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import { toast } from "sonner";

type FilterFolder = "sales_only" | "all" | "untriaged" | "leads" | "appended" | "skipped";
type ReadingTab = "email" | "notes";
type AiTone = "professional" | "warm" | "formal" | "urgent";

interface InternalNote {
  id: string;
  author: string;
  text: string;
  createdAt: string;
}

function StatusBadge({ status }: { status: string }) {
  const meta = inboundStatusMeta(status);
  return <Badge kind={meta.kind} dot>{meta.label}</Badge>;
}

function senderLabel(e: InboundEmailRow): string {
  return e.from_name?.trim() || e.from_email || "Unknown sender";
}

function senderInitials(e: InboundEmailRow): string {
  const name = senderLabel(e);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export default function EnquiriesOutlookPage() {
  const { data: rows, isLoading, error, refetch } = useInboundEmails();
  const convert = useConvertInboundToLead();

  // Default view is "sales_only" to hide non-sales/system mails by default
  const [activeFolder, setActiveFolder] = React.useState<FilterFolder>("sales_only");
  const [searchQuery, setSearchQuery] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  // Tabs & Views
  const [activeTab, setActiveTab] = React.useState<ReadingTab>("email");
  const [aiTone, setAiTone] = React.useState<AiTone>("professional");

  // Internal Notes State (persisted in local state per thread)
  const [internalNotes, setInternalNotes] = React.useState<Record<string, InternalNote[]>>({});
  const [newNoteText, setNewNoteText] = React.useState("");

  // Starred / Flagged Threads
  const [starredIds, setStarredIds] = React.useState<Set<string>>(new Set());

  // AI Reply State
  const [isAiDrafting, setIsAiDrafting] = React.useState(false);
  const [aiDraft, setAiDraft] = React.useState<{ subject: string; message: string } | null>(null);
  const [showReplyComposer, setShowReplyComposer] = React.useState(false);

  // Folder Counts & Stats
  const totals = React.useMemo(() => {
    const list = rows ?? [];
    return {
      total:      list.length,
      salesOnly:  list.filter((r) => r.status !== "skipped_non_enquiry").length,
      untriaged:  list.filter((r) => r.status === "received" && !r.lead_id).length,
      leads:      list.filter((r) => !!r.lead_id).length,
      appended:   list.filter((r) => r.status === "appended_to_lead").length,
      skipped:    list.filter((r) => r.status === "skipped_non_enquiry").length,
    };
  }, [rows]);

  // Filtered Threads
  const filteredRows = React.useMemo(() => {
    let list = rows ?? [];

    // Apply Folder Filter
    if (activeFolder === "sales_only") {
      // Default: Only show genuine sales enquiries (exclude Google account confirmation / system mails)
      list = list.filter((r) => r.status !== "skipped_non_enquiry");
    } else if (activeFolder === "untriaged") {
      list = list.filter((r) => r.status === "received" && !r.lead_id);
    } else if (activeFolder === "leads") {
      list = list.filter((r) => !!r.lead_id);
    } else if (activeFolder === "appended") {
      list = list.filter((r) => r.status === "appended_to_lead");
    } else if (activeFolder === "skipped") {
      list = list.filter((r) => r.status === "skipped_non_enquiry");
    }

    // Apply Search Query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter((r) =>
        (r.from_name ?? "").toLowerCase().includes(q) ||
        (r.from_email ?? "").toLowerCase().includes(q) ||
        (r.subject ?? "").toLowerCase().includes(q) ||
        (r.body_text ?? "").toLowerCase().includes(q)
      );
    }

    return list;
  }, [rows, activeFolder, searchQuery]);

  // Auto-select first item if none selected or filter changes
  React.useEffect(() => {
    if (filteredRows.length > 0) {
      if (!selectedId || !filteredRows.some((r) => r.id === selectedId)) {
        setSelectedId(filteredRows[0].id);
      }
    } else {
      setSelectedId(null);
    }
  }, [filteredRows, selectedId]);

  // Keyboard Shortcuts (J / K navigation, C to compose)
  React.useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (["input", "textarea"].includes((e.target as HTMLElement)?.tagName?.toLowerCase())) {
        return;
      }

      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        const currentIndex = filteredRows.findIndex((r) => r.id === selectedId);
        if (currentIndex < filteredRows.length - 1) {
          setSelectedId(filteredRows[currentIndex + 1].id);
        }
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        const currentIndex = filteredRows.findIndex((r) => r.id === selectedId);
        if (currentIndex > 0) {
          setSelectedId(filteredRows[currentIndex - 1].id);
        }
      } else if (e.key === "c") {
        e.preventDefault();
        setShowReplyComposer((prev) => !prev);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [filteredRows, selectedId]);

  // Currently Selected Thread
  const selectedThread = React.useMemo(
    () => (rows ?? []).find((r) => r.id === selectedId) ?? null,
    [rows, selectedId]
  );

  // Clear AI draft when thread changes
  React.useEffect(() => {
    setAiDraft(null);
    setShowReplyComposer(false);
    setActiveTab("email");
  }, [selectedId]);

  async function handleConvert(id: string) {
    await convert.mutateAsync(id);
  }

  function toggleStar(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setStarredIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Add Internal Note
  function handleAddInternalNote() {
    if (!selectedId || !newNoteText.trim()) return;
    const note: InternalNote = {
      id: "note-" + Date.now(),
      author: "Sales Rep",
      text: newNoteText.trim(),
      createdAt: new Date().toISOString(),
    };
    setInternalNotes((prev) => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] || []), note],
    }));
    setNewNoteText("");
    toast.success("Internal note added to thread.");
  }

  // Canned Responses / Snippets
  function applyCannedTemplate(templateKey: "gworkspace" | "m365" | "bank") {
    if (!selectedThread) return;
    const recipientName = (selectedThread.from_name || selectedThread.from_email || "Customer").split("@")[0];
    const subject = selectedThread.subject ? `Re: ${selectedThread.subject.replace(/^Re:\s*/i, "")}` : "Quotation & Details";

    let message = "";
    if (templateKey === "gworkspace") {
      message = `Hi ${recipientName},\n\nThank you for your enquiry regarding Google Workspace licenses. We are an authorized Google Cloud Partner in India.\n\nHere is our special volume pricing:\n• Business Starter: ₹145/user/month (excl GST)\n• Business Standard: ₹730/user/month (excl GST)\n\nWe provide free domain setup, data migration, 24/7 technical support, and GST tax invoicing.\n\nWould you like me to share a formal quotation for your team?\n\nBest regards,\nSales Team\nAnutech Digital Private Limited`;
    } else if (templateKey === "m365") {
      message = `Hi ${recipientName},\n\nThank you for contacting us regarding Microsoft 365 plans for your organization.\n\nWe provide official Microsoft 365 Business Basic, Standard, and Enterprise licenses with local INR billing and GST tax compliance.\n\nCould you please share your required user count so we can prepare a customized quote for you?\n\nBest regards,\nSales Team\nAnutech Digital Private Limited`;
    } else if (templateKey === "bank") {
      message = `Hi ${recipientName},\n\nPlease find our company bank details for official payment transfer:\n\nAccount Name: Anutech Digital Private Limited\nBank: HDFC Bank\nAccount No: 50200012345678\nIFSC Code: HDFC0001234\n\nAlternatively, you can pay online via UPI or Card using our secure payment link.\n\nBest regards,\nFinance Team`;
    }

    setAiDraft({ subject, message });
    setShowReplyComposer(true);
    toast.success("Canned sales template applied.");
  }

  // Generate AI Draft
  async function handleGenerateAiReply() {
    if (!selectedThread) return;
    setIsAiDrafting(true);
    setShowReplyComposer(true);

    try {
      const emailAddr = selectedThread.from_email || "customer@domain.com";
      const recipientName = (selectedThread.from_name || emailAddr).split("@")[0];
      const subject = selectedThread.subject ? `Re: ${selectedThread.subject.replace(/^Re:\s*/i, "")}` : "Reply regarding your enquiry";
      
      const response = await fetch("/api/ai/draft-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leadId: selectedThread.lead_id || undefined,
          channel: "email",
          purpose: "followup",
        }),
      });

      if (response.ok) {
        const data = await response.json();
        let message = data.message || `Hi ${recipientName},\n\nThank you for reaching out regarding ${selectedThread.subject || "your enquiry"}.\n\nWe have received your requirements and our solutions team is preparing the details for you.\n\nBest regards,\nSales Team`;
        
        if (aiTone === "warm") {
          message = message.replace(/^Hi /, "Hello ").replace(/\n\nBest regards,/, "\n\nWarm regards,\nSales Team");
        } else if (aiTone === "formal") {
          message = `Dear ${recipientName},\n\nThank you for contacting Anutech Digital. We reference your inquiry: "${selectedThread.subject || "Software licenses"}".\n\nOur team is reviewing your requirements to provide an official quotation.\n\nSincerely,\nAnutech Digital Sales Operations`;
        }

        setAiDraft({
          subject: data.subject || subject,
          message,
        });
      } else {
        // Fallback Draft
        setAiDraft({
          subject,
          message: `Hi ${recipientName},\n\nThank you for getting in touch with us regarding ${selectedThread.subject || "your requirement"}.\n\nWe would be glad to assist you with our cloud license and software solutions. When would be a good time to connect over a brief call?\n\nBest regards,\nSales Team`,
        });
      }
    } catch {
      toast.error("Could not generate AI draft, using standard template.");
      setAiDraft({
        subject: selectedThread?.subject ? `Re: ${selectedThread.subject}` : "Enquiry Response",
        message: `Hi ${selectedThread?.from_name || "there"},\n\nThank you for reaching out. We have logged your enquiry and will assist you shortly.\n\nBest regards,`,
      });
    } finally {
      setIsAiDrafting(false);
    }
  }

  function handleCopyReply() {
    if (!aiDraft || !selectedId) return;
    const fullText = `Subject: ${aiDraft.subject}\n\n${aiDraft.message}`;
    navigator.clipboard.writeText(fullText);
    toast.success("AI draft response copied to clipboard!");

    // Automatically log audit note for team transparency
    const auditNote: InternalNote = {
      id: "note-" + Date.now(),
      author: "Sales Rep (System)",
      text: `📤 Email reply drafted & copied: "${aiDraft.subject}"`,
      createdAt: new Date().toISOString(),
    };
    setInternalNotes((prev) => ({
      ...prev,
      [selectedId]: [...(prev[selectedId] || []), auditNote],
    }));
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1450px] mx-auto flex flex-col h-[calc(100vh-80px)]">
      {/* Top Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4 shrink-0">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Sales CRM</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber/10 text-amber font-medium">Outlook Suite</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald/10 text-emerald-dark font-medium">Inbox: sales@anutech.in</span>
          </div>
          <h1 className="font-serif text-2xl md:text-3xl font-bold leading-tight">Sales Email Suite</h1>
        </div>

        {/* Stat Summary */}
        {!isLoading && !error && rows && rows.length > 0 && (
          <StatStrip
            className="py-1 px-3 border border-hairline bg-paper rounded-lg"
            items={[
              { label: "Sales Mails", value: String(totals.salesOnly), tone: "emerald" },
              { label: "Untriaged", value: String(totals.untriaged), tone: totals.untriaged > 0 ? "amber" : undefined },
              { label: "Leads Created", value: String(totals.leads) },
              { label: "Total Received", value: String(totals.total) },
            ]}
          />
        )}
      </div>

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load email inbox"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {isLoading && (
        <Card flush className="flex-1 p-6 space-y-4">
          <Skeleton className="h-8 w-64" />
          <div className="grid grid-cols-3 gap-4 h-full">
            <Skeleton className="h-full w-full" />
            <Skeleton className="h-full w-full" />
            <Skeleton className="h-full w-full" />
          </div>
        </Card>
      )}

      {!isLoading && !error && rows && (
        <div className="flex-1 flex flex-col md:flex-row border border-hairline rounded-xl bg-paper overflow-hidden shadow-sm min-h-[550px] md:min-h-0">
          
          {/* ========================================================================= */}
          {/* PANE 1: FOLDERS & SMART FILTERS */}
          {/* ========================================================================= */}
          <div className="w-full md:w-48 lg:w-56 border-b md:border-b-0 md:border-r border-hairline bg-paper-2/30 flex flex-col p-3 shrink-0">
            <p className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold px-2 mb-2">Mail Folders</p>
            
            <nav className="space-y-1 flex-1">
              <button
                type="button"
                onClick={() => setActiveFolder("sales_only")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "sales_only" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="sparkles" size={15} className="text-amber" />
                  <span>Sales Enquiries Only</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber/20 font-bold text-amber-dark">
                  {totals.salesOnly}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("untriaged")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "untriaged" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="inbox" size={15} />
                  <span>New to Triage</span>
                </div>
                {totals.untriaged > 0 ? (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-amber text-white font-semibold">
                    {totals.untriaged}
                  </span>
                ) : (
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">0</span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("leads")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "leads" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="target" size={15} />
                  <span>Converted Leads</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.leads}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("appended")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "appended" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="refresh" size={15} />
                  <span>Thread Replies</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.appended}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("all")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "all" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="mail" size={15} />
                  <span>All Inbound Mails</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.total}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setActiveFolder("skipped")}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg transition-colors ${
                  activeFolder === "skipped" ? "bg-amber/15 text-amber-dark font-semibold" : "text-ink-2 hover:bg-paper-2"
                }`}
              >
                <div className="flex items-center gap-2">
                  <Icon name="x" size={15} />
                  <span>System / Non-Sales</span>
                </div>
                <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-paper border border-hairline text-ink-3">
                  {totals.skipped}
                </span>
              </button>
            </nav>

            <div className="mt-auto p-3 rounded-lg border border-hairline bg-paper text-xs text-ink-3 space-y-1">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <Icon name="sparkles" size={14} className="text-amber" />
                <span>Smart AI Filtering</span>
              </div>
              <p className="text-[11px] leading-tight">
                System filters out non-sales emails (Google account confirmations/newsletters) so you focus 100% on potential customers.
              </p>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* PANE 2: EMAIL THREADS LIST */}
          {/* ========================================================================= */}
          <div className="w-full md:w-64 lg:w-80 border-b md:border-b-0 md:border-r border-hairline bg-paper flex flex-col shrink-0">
            {/* Search Header */}
            <div className="p-3 border-b border-hairline bg-paper-2/20 flex flex-col gap-1.5">
              <Input
                placeholder="Search prospect name, email..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-8 text-xs bg-paper"
              />
              <div className="flex items-center justify-between text-[11px] text-ink-3 px-1">
                <span>Showing: {filteredRows.length} threads</span>
                {activeFolder === "sales_only" && <span className="text-amber font-semibold">Sales Mails Only</span>}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto divide-y divide-hairline">
              {filteredRows.length === 0 ? (
                <div className="p-8 text-center text-xs text-ink-3">
                  No emails match this filter.
                </div>
              ) : (
                filteredRows.map((e) => {
                  const isSelected = e.id === selectedId;
                  const isStarred = starredIds.has(e.id);
                  const isNonEnquiry = e.status === "skipped_non_enquiry";
                  return (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setSelectedId(e.id)}
                      className={`w-full text-left p-3.5 transition-colors flex flex-col gap-1.5 relative group ${
                        isSelected
                          ? "bg-amber/10 border-l-4 border-amber pl-2.5"
                          : isNonEnquiry
                          ? "opacity-60 bg-paper-2/20"
                          : "hover:bg-paper-2/40"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className={`w-6 h-6 rounded-full border flex items-center justify-center text-[10px] font-bold shrink-0 ${
                            isNonEnquiry ? "bg-paper-2 border-hairline text-ink-3" : "bg-amber/10 border-amber/30 text-amber-dark"
                          }`}>
                            {senderInitials(e)}
                          </div>
                          <span className="font-semibold text-xs text-ink truncate">
                            {senderLabel(e)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span
                            onClick={(ev) => toggleStar(e.id, ev)}
                            className={`text-xs cursor-pointer ${isStarred ? "text-amber" : "text-ink-3 opacity-0 group-hover:opacity-100"}`}
                          >
                            ★
                          </span>
                          <span className="text-[10px] text-ink-3">
                            {formatDate(e.created_at, "relative")}
                          </span>
                        </div>
                      </div>

                      <p className="text-xs font-medium text-ink-2 truncate">
                        {e.subject?.trim() || "(no subject)"}
                      </p>

                      <p className="text-[11px] text-ink-3 line-clamp-1">
                        {e.body_text?.trim() || "No preview body text"}
                      </p>

                      <div className="flex items-center justify-between gap-2 mt-1">
                        <StatusBadge status={e.status} />
                        {e.from_email && (
                          <span className="text-[10px] text-ink-3 truncate max-w-[120px]">
                            {e.from_email.split("@")[1]}
                          </span>
                        )}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* ========================================================================= */}
          {/* PANE 3: READING PANE & CRM COPILOT */}
          {/* ========================================================================= */}
          <div className="flex-1 bg-paper flex flex-col min-w-0 overflow-y-auto">
            {!selectedThread ? (
              <div className="flex-1 flex items-center justify-center p-8">
                <EmptyState
                  icon="mail"
                  title="No email selected"
                  body="Select an email thread from the middle pane to view message details, generate AI replies, or convert to a lead."
                />
              </div>
            ) : (
              <div className="flex-1 flex flex-col p-6 space-y-5">
                
                {/* Email Header Bar */}
                <div className="border-b border-hairline pb-4 space-y-3">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div>
                      <h2 className="text-xl font-bold text-ink leading-tight">
                        {selectedThread.subject?.trim() || "(no subject)"}
                      </h2>
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="text-xs font-semibold text-ink">
                          From: {senderLabel(selectedThread)}
                        </span>
                        {selectedThread.from_email && (
                          <span className="text-xs text-ink-3">
                            &lt;{selectedThread.from_email}&gt;
                          </span>
                        )}
                        <span className="text-xs text-emerald-dark font-medium px-1.5 py-0.5 rounded bg-emerald/10">
                          To: sales@anutech.in
                        </span>
                        <span className="text-xs text-ink-3">· {formatDate(selectedThread.created_at, "long")}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <StatusBadge status={selectedThread.status} />
                    </div>
                  </div>

                  {/* Top Action Toolbar */}
                  <div className="flex items-center gap-2 pt-2 flex-wrap">
                    {selectedThread.lead_id ? (
                      <Button asChild variant="outline" icon="target">
                        <Link href={"/leads" as never}>View in Leads</Link>
                      </Button>
                    ) : canConvertToLead(selectedThread) ? (
                      <Button
                        variant="primary"
                        icon="plus"
                        loading={convert.isPending}
                        onClick={() => handleConvert(selectedThread.id)}
                      >
                        Convert to Lead
                      </Button>
                    ) : null}

                    <Button
                      variant="outline"
                      icon="sparkles"
                      loading={isAiDrafting}
                      onClick={handleGenerateAiReply}
                    >
                      {aiDraft ? "Regenerate AI Reply" : "Draft AI Reply"}
                    </Button>

                    <Button
                      asChild
                      variant="ghost"
                      icon="file"
                    >
                      <Link href={`/quotes/new?contact_email=${encodeURIComponent(selectedThread.from_email ?? "")}` as never}>
                        Create Quote
                      </Link>
                    </Button>
                  </div>
                </div>

                {/* Reading Pane View Switcher (Email Content vs Internal Team Notes) */}
                <div className="flex items-center justify-between border-b border-hairline pb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-1 bg-paper-2/40 p-1 rounded-lg border border-hairline">
                    <button
                      type="button"
                      onClick={() => setActiveTab("email")}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        activeTab === "email" ? "bg-paper shadow-xs text-ink font-semibold" : "text-ink-3 hover:text-ink"
                      }`}
                    >
                      ✉️ Customer Email
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("notes")}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1 ${
                        activeTab === "notes" ? "bg-paper shadow-xs text-ink font-semibold" : "text-ink-3 hover:text-ink"
                      }`}
                    >
                      <span>📝 Team Internal Notes</span>
                      {internalNotes[selectedThread.id]?.length ? (
                        <span className="text-[10px] px-1.5 rounded-full bg-amber text-white font-bold">
                          {internalNotes[selectedThread.id].length}
                        </span>
                      ) : null}
                    </button>
                  </div>

                  {activeTab === "email" && (
                    <div className="flex items-center gap-1 flex-wrap">
                      <span className="text-[11px] text-ink-3">Quick Snippets:</span>
                      <button
                        type="button"
                        onClick={() => applyCannedTemplate("gworkspace")}
                        className="text-[11px] px-2 py-0.5 rounded border border-hairline bg-paper hover:bg-paper-2 text-ink-2 font-medium"
                      >
                        Google Workspace Quote
                      </button>
                      <button
                        type="button"
                        onClick={() => applyCannedTemplate("m365")}
                        className="text-[11px] px-2 py-0.5 rounded border border-hairline bg-paper hover:bg-paper-2 text-ink-2 font-medium"
                      >
                        M365 Quote
                      </button>
                      <button
                        type="button"
                        onClick={() => applyCannedTemplate("bank")}
                        className="text-[11px] px-2 py-0.5 rounded border border-hairline bg-paper hover:bg-paper-2 text-ink-2 font-medium"
                      >
                        Bank Details
                      </button>
                    </div>
                  )}
                </div>

                {/* TAB 1: CUSTOMER EMAIL CONTENT */}
                {activeTab === "email" && (
                  <div className="flex-1 bg-paper-2/20 border border-hairline rounded-xl p-5 overflow-y-auto min-h-[160px]">
                    <div className="flex items-center justify-between text-xs text-ink-3 mb-3 border-b border-hairline/60 pb-2">
                      <span className="font-semibold uppercase tracking-wider text-[10px]">Prospect Email Body</span>
                      <span>Captured via Inbound Mailbox</span>
                    </div>

                    {selectedThread.body_text?.trim() ? (
                      <pre className="whitespace-pre-wrap break-words font-sans text-sm text-ink leading-relaxed">
                        {selectedThread.body_text}
                      </pre>
                    ) : selectedThread.body_html?.trim() ? (
                      <div className="p-4 rounded-lg border border-amber/30 bg-amber/5 text-xs text-ink-2">
                        <p className="font-semibold text-amber-dark mb-1">HTML-Only Mail Received</p>
                        <p>This email was sent in HTML-only format. Plain-text view is unavailable to prevent XSS security issues.</p>
                      </div>
                    ) : (
                      <p className="text-sm text-ink-3 italic">No body text captured for this email.</p>
                    )}
                  </div>
                )}

                {/* TAB 2: INTERNAL TEAM NOTES (Missive / Front Style) */}
                {activeTab === "notes" && (
                  <div className="flex-1 border border-hairline rounded-xl p-5 bg-paper space-y-4 min-h-[160px] flex flex-col">
                    <div className="flex items-center justify-between text-xs text-ink-3 border-b border-hairline pb-2">
                      <span className="font-semibold text-ink">Internal Team Discussion (Not visible to customer)</span>
                      <span>{internalNotes[selectedThread.id]?.length || 0} notes</span>
                    </div>

                    <div className="flex-1 overflow-y-auto space-y-3 max-h-[220px]">
                      {(!internalNotes[selectedThread.id] || internalNotes[selectedThread.id].length === 0) ? (
                        <p className="text-xs text-ink-3 italic py-4 text-center">
                          No internal notes added yet. Add a comment below to discuss this lead with your sales team.
                        </p>
                      ) : (
                        internalNotes[selectedThread.id].map((note) => (
                          <div key={note.id} className="p-3 rounded-lg border border-amber/20 bg-amber/5 text-xs space-y-1">
                            <div className="flex items-center justify-between text-ink-3">
                              <span className="font-semibold text-amber-dark">{note.author}</span>
                              <span className="text-[10px]">{formatDate(note.createdAt, "relative")}</span>
                            </div>
                            <p className="text-ink-2">{note.text}</p>
                          </div>
                        ))
                      )}
                    </div>

                    <div className="pt-2 border-t border-hairline flex gap-2">
                      <Input
                        placeholder="Add an internal note or @mention teammate..."
                        value={newNoteText}
                        onChange={(e) => setNewNoteText(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") handleAddInternalNote(); }}
                        className="text-xs"
                      />
                      <Button variant="primary" icon="plus" onClick={handleAddInternalNote}>
                        Add Note
                      </Button>
                    </div>
                  </div>
                )}

                {/* AI Gemini Auto-Reply Draft Assistant */}
                {showReplyComposer && (
                  <div className="border border-amber/30 bg-amber/5 rounded-xl p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-dark">
                          <Icon name="sparkles" size={15} />
                          <span>Gemini AI Reply Assistant</span>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-ink-3">
                          <span>Tone:</span>
                          <select
                            value={aiTone}
                            onChange={(e) => setAiTone(e.target.value as AiTone)}
                            className="bg-paper border border-hairline rounded px-1.5 py-0.5 text-xs font-medium text-ink"
                          >
                            <option value="professional">Professional</option>
                            <option value="warm">Warm &amp; Consultative</option>
                            <option value="formal">Formal Corporate</option>
                          </select>
                        </div>
                      </div>
                      <Button variant="ghost" icon="x" onClick={() => setShowReplyComposer(false)}>
                        Close
                      </Button>
                    </div>

                    {isAiDrafting ? (
                      <div className="py-6 text-center space-y-2">
                        <Skeleton className="h-4 w-48 mx-auto" />
                        <Skeleton className="h-16 w-full" />
                      </div>
                    ) : aiDraft ? (
                      <div className="space-y-3">
                        <div>
                          <label className="text-[11px] font-semibold text-ink-3 block mb-1">Subject</label>
                          <Input
                            value={aiDraft.subject}
                            onChange={(e) => setAiDraft({ ...aiDraft, subject: e.target.value })}
                            className="bg-paper text-xs"
                          />
                        </div>
                        <div>
                          <label className="text-[11px] font-semibold text-ink-3 block mb-1">AI Response Text</label>
                          <textarea
                            rows={5}
                            value={aiDraft.message}
                            onChange={(e) => setAiDraft({ ...aiDraft, message: e.target.value })}
                            className="w-full text-xs font-sans p-3 rounded-lg border border-hairline bg-paper text-ink focus:outline-none focus:ring-2 focus:ring-amber"
                          />
                        </div>

                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-[11px] text-ink-3">Review &amp; edit draft before sending.</span>
                          <div className="flex items-center gap-2">
                            <Button variant="outline" icon="file" onClick={handleCopyReply}>
                              Copy Reply Text
                            </Button>
                            <Button
                              asChild
                              variant="primary"
                              icon="mail"
                            >
                              <a href={`mailto:${selectedThread.from_email}?subject=${encodeURIComponent(aiDraft.subject)}&body=${encodeURIComponent(aiDraft.message)}`}>
                                Send Email
                              </a>
                            </Button>
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                {/* Prospect Meta Details Footer */}
                <div className="p-3 border border-hairline rounded-lg bg-paper-2/40 flex items-center justify-between text-xs text-ink-3 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Icon name="info" size={14} />
                    <span>Sender: <strong>{selectedThread.from_email || "Unknown"}</strong></span>
                  </div>
                  <div>
                    <span>Message ID: <code className="text-[10px]">{selectedThread.message_id.slice(0, 24)}...</code></span>
                  </div>
                </div>

              </div>
            )}
          </div>

        </div>
      )}
    </div>
  );
}
