/**
 * WhatsApp Inbox — conversations + thread view.
 *
 * Left rail: list of contacts (sorted by recency).
 * Right pane: scrollable message thread + reply composer.
 *
 * 24-hour rule: Meta only allows free-form text within 24 hours of the
 * customer's last inbound message. Outside that window, the composer
 * disables free-form and prompts for a template (Phase 2C — template
 * picker not built yet).
 */

"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDate } from "@/lib/utils";
import {
  useWhatsAppConversations,
  useWhatsAppThread,
  useSendWhatsApp,
} from "@/lib/queries/whatsapp";
import type { WhatsAppMessageRow, WhatsAppMessageStatus } from "@/lib/supabase/database.types";

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1)   return "just now";
  if (m < 60)  return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7)   return `${d}d`;
  return formatDate(iso);
}

const STATUS_GLYPH: Record<WhatsAppMessageStatus, string> = {
  pending:   "⋯",
  sent:      "✓",
  delivered: "✓✓",
  read:      "✓✓",
  failed:    "!",
  received:  "↓",
};

// ──────────────────────────────────────────────────────────────────────
// Conversation list
// ──────────────────────────────────────────────────────────────────────
function ConversationList({
  selected, onSelect,
}: { selected: string | null; onSelect: (phone: string) => void }) {
  const { data: convos, isLoading, error, hasNextPage, fetchNextPage, isFetchingNextPage } = useWhatsAppConversations();

  if (isLoading) return (
    <div className="p-2 space-y-1">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-14 w-full" />
    </div>
  );
  if (error) return <p className="p-4 text-xs text-rose">Couldn&apos;t load: {(error as Error).message}</p>;
  if (!convos || convos.length === 0) return (
    <div className="p-6 text-center">
      <p className="text-sm text-ink-2 font-medium">No conversations yet</p>
      <p className="text-xs text-ink-3 mt-1">
        Send a message from a quote / lead, or wait for a customer to reply.
      </p>
    </div>
  );

  return (
    <ul className="overflow-y-auto h-full">
      {convos.map((c) => {
        const active = selected === c.contact_phone;
        return (
          <li key={c.contact_phone}>
            <button
              type="button"
              onClick={() => onSelect(c.contact_phone)}
              className={cn(
                "w-full text-left px-3 py-2.5 border-b border-hairline transition-colors flex items-start gap-2.5",
                active ? "bg-amber-soft" : "hover:bg-paper-2"
              )}
            >
              <div className="w-9 h-9 rounded-full bg-emerald/15 text-emerald grid place-items-center text-xs font-semibold shrink-0">
                <Icon name="whatsapp" size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-mono text-xs text-ink truncate">{c.contact_phone}</p>
                  <span className="text-3xs text-ink-3 shrink-0">{relativeTime(c.last_message.created_at)}</span>
                </div>
                <p className={cn(
                  "text-xs truncate mt-0.5",
                  c.last_message.direction === "inbound" ? "text-ink-2" : "text-ink-3 italic",
                )}>
                  {c.last_message.direction === "outbound" && "You: "}
                  {c.last_message.text_body || `[${c.last_message.type}]`}
                </p>
              </div>
              {c.unread_count > 0 && !active && (
                <span className="ml-1 bg-emerald text-paper text-3xs font-semibold rounded-full px-1.5 py-0.5 min-w-[18px] text-center shrink-0">
                  {c.unread_count}
                </span>
              )}
            </button>
          </li>
        );
      })}
      {/* S37: conversations come in pages (list_whatsapp_threads). Older ones used to be
          missing outright; now they are one click away. */}
      {hasNextPage && (
        <li className="p-2 text-center">
          <Button size="sm" variant="ghost" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            Load older conversations
          </Button>
        </li>
      )}
    </ul>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Thread view
// ──────────────────────────────────────────────────────────────────────
function MessageBubble({ m }: { m: WhatsAppMessageRow }) {
  const mine = m.direction === "outbound";
  return (
    <div className={cn("flex w-full", mine ? "justify-end" : "justify-start")}>
      <div className={cn(
        "max-w-[75%] rounded-2xl px-3 py-2 break-words",
        mine ? "bg-emerald/15 text-ink rounded-br-sm" : "bg-paper-2 text-ink rounded-bl-sm",
      )}>
        {m.text_body ? (
          <p className="text-sm whitespace-pre-wrap">{m.text_body}</p>
        ) : (
          <p className="text-xs text-ink-3 italic">[{m.type}]</p>
        )}
        <div className="flex items-center justify-end gap-1.5 mt-1">
          <span className="text-3xs text-ink-3 tabular-nums">{relativeTime(m.created_at)}</span>
          {mine && (
            <span className={cn(
              "text-3xs tabular-nums",
              m.status === "read"    ? "text-emerald"
              : m.status === "failed" ? "text-rose"
              : "text-ink-3",
            )} title={m.error_message ?? m.status}>
              {STATUS_GLYPH[m.status] ?? ""}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadPane({ contactPhone }: { contactPhone: string | null }) {
  const { data: messages, isLoading } = useWhatsAppThread(contactPhone);
  const sendMutation = useSendWhatsApp();
  const [draft, setDraft] = React.useState("");
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  // Auto-scroll to bottom on new messages
  React.useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages?.length]);

  if (!contactPhone) {
    return (
      <div className="h-full grid place-items-center text-center px-6">
        <div>
          <Icon name="whatsapp" size={32} className="text-ink-3 mx-auto" />
          <p className="mt-3 text-sm font-medium text-ink-2">Pick a conversation</p>
          <p className="text-xs text-ink-3 mt-1">Or wait for a customer to message you.</p>
        </div>
      </div>
    );
  }

  // 24-hour window check — Meta only allows free-form text within 24h
  // of the customer's last inbound. Determine from messages.
  const lastInbound = (messages ?? [])
    .filter((m) => m.direction === "inbound")
    .at(-1);
  const hoursSinceInbound = lastInbound
    ? (Date.now() - new Date(lastInbound.created_at).getTime()) / 3_600_000
    : Infinity;
  const within24h = hoursSinceInbound < 24;

  async function send() {
    if (!draft.trim() || !contactPhone) return;
    try {
      await sendMutation.mutateAsync({ to: contactPhone, text: draft.trim() });
      setDraft("");
      // Force-refetch thread so the new message appears immediately
      await qc.invalidateQueries({ queryKey: ["whatsapp", "thread", contactPhone] });
    } catch {
      // toast handled in hook
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-hairline bg-paper flex items-center justify-between">
        <div>
          <p className="font-mono text-sm text-ink">{contactPhone}</p>
          <p className="text-3xs text-ink-3">
            {messages?.length ?? 0} messages
            {lastInbound && ` · last reply ${relativeTime(lastInbound.created_at)}`}
          </p>
        </div>
        {!within24h && lastInbound && (
          <Badge kind="warning" size="sm" dot>
            24h window closed — template required
          </Badge>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-2 bg-paper-2/30">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-2/3" />
            <Skeleton className="h-12 w-1/2 ml-auto" />
          </div>
        ) : !messages || messages.length === 0 ? (
          <p className="text-center text-xs text-ink-3 mt-6">No messages yet — say hi.</p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} m={m} />)
        )}
      </div>

      {/* Composer */}
      <div className="border-t border-hairline bg-paper p-3">
        {within24h ? (
          <div className="flex gap-2">
            <Input
              aria-label="Message"
              placeholder="Type a message…"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              className="flex-1"
              disabled={sendMutation.isPending}
            />
            <Button
              type="button"
              variant="primary"
              icon="send"
              onClick={send}
              loading={sendMutation.isPending}
              disabled={!draft.trim()}
            >
              Send
            </Button>
          </div>
        ) : (
          <div className="rounded-md bg-amber-soft/40 border border-amber/20 p-3 text-xs text-amber-ink leading-snug">
            <p className="font-medium mb-1 inline-flex items-center gap-1.5">
              <Icon name="info" size={11} /> 24-hour customer service window has closed
            </p>
            Meta requires pre-approved <b>template</b> messages outside this window.
            Template send is coming in the next release.
          </div>
        )}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Page
// ──────────────────────────────────────────────────────────────────────
export default function WhatsAppInboxPage() {
  const [selected, setSelected] = React.useState<string | null>(null);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">WhatsApp Inbox</h1>
          <p className="text-sm text-ink-3 mt-1">
            Conversations with leads and customers · powered by Meta Cloud API
          </p>
        </div>
      </div>

      <Card flush className="overflow-hidden">
        <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] h-[calc(100vh-220px)] min-h-[480px]">
          {/* Conversation rail — on mobile this is the whole screen until a
              conversation is opened; on md+ it's always the left pane. */}
          <div className={`${selected ? "hidden md:flex" : "flex"} border-r border-hairline overflow-hidden flex-col`}>
            <div className="px-3 py-2 border-b border-hairline bg-paper-2/30">
              <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Conversations</p>
            </div>
            <div className="flex-1 overflow-y-auto">
              <ConversationList selected={selected} onSelect={setSelected} />
            </div>
          </div>

          {/* Thread — the only pane on mobile once a conversation is picked
              (with a back button); the right pane on md+. */}
          <div className={`${selected ? "flex" : "hidden md:flex"} flex-col overflow-hidden min-h-0`}>
            {selected && (
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="md:hidden flex items-center gap-1.5 px-3 py-2 border-b border-hairline text-sm text-ink-2 hover:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-inset"
              >
                <Icon name="arrow_left" size={14} /> Conversations
              </button>
            )}
            <div className="flex-1 min-h-0 overflow-hidden">
              <ThreadPane contactPhone={selected} />
            </div>
          </div>
        </div>
      </Card>

      <p className="text-2xs text-ink-3 mt-3 flex items-center gap-1.5">
        <Icon name="info" size={11} />
        Refresh: every 15s for conversation list, 10s for active thread. Meta delivery status (sent → delivered → read) arrives via webhook.
      </p>
    </div>
  );
}

