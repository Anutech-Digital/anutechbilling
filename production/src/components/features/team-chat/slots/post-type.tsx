/**
 * Team chat slot — R-2304 (TC-11) post type — the Text / Problem / Suggestion switch (draft.kind), the status chip and Make a task / Report buttons on a post.
 *
 * R-2299 left this as `null`; the card that builds it replaces this file with its
 * ChatExtension (see ../composer-slots.ts for the props each part receives). Nothing else in
 * the page needs editing: ../extensions.ts already includes this export.
 */
/*
 * R-2304 (G-TEAMCHAT TC-11) — Pardeep: "koi problem ho ya suggestion ho" — these must not get
 * lost in chat. What each part does:
 *
 * - Toolbar: Message / Problem / Suggestion switch — sets draft.kind (chat_post_message starts a
 *   problem / suggestion with post_status 'open').
 * - MessageBadge: one chip on a problem / suggestion post — "Problem · Open", "Problem · Task
 *   made", "Suggestion · Reported", "… · Resolved".
 * - MessageBelow: the next step (UI rule 3). The POSTER chooses (decision 8), both buttons shown:
 *     no task yet → primary "Make a task" (assignee + due date, then chat_message_to_task);
 *     task made   → primary "Open task" (/tasks?tab=all&task=<id>) — for everyone in the channel;
 *     not reported yet → "Report as bug" (problem) / "Report as idea" (suggestion) →
 *     chat_message_report files it like the in-app report form; triage is asked after, never fatal.
 *   Both RPCs (migration 20261031183408) are idempotent and also allow the owner / a manager.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { teamChatKeys, toChatError } from "@/lib/queries/team-chat";
import { memberLabel } from "@/lib/queries/team";
import type { ChatMessage } from "@/lib/team-chat/types";
import { cn } from "@/lib/utils";
import type { ChatExtension, ComposerDraft, ComposerSlotProps, MessageSlotProps } from "../composer-slots";

type PostKind = ComposerDraft["kind"];

const KINDS: { kind: PostKind; label: string }[] = [
  { kind: "text", label: "Message" },
  { kind: "problem", label: "Problem" },
  { kind: "suggestion", label: "Suggestion" },
];

const STATUS_LABEL: Record<string, string> = {
  open: "Open",
  task: "Task made",
  reported: "Reported",
  resolved: "Resolved",
};

type BadgeKind = "warning" | "info" | "success" | "muted";

/** The chip on a post: "Problem · Open". null for plain messages. Pure — tested directly. */
export function postStatusChip(m: Pick<ChatMessage, "kind" | "post_status">): { label: string; kind: BadgeKind } | null {
  if (m.kind !== "problem" && m.kind !== "suggestion") return null;
  const what = m.kind === "problem" ? "Problem" : "Suggestion";
  const status = m.post_status ?? "open";
  const kind: BadgeKind =
    status === "task" || status === "resolved" ? "success"
    : status === "reported" ? "info"
    : m.kind === "problem" ? "warning" : "muted";
  return { label: `${what} · ${STATUS_LABEL[status] ?? "Open"}`, kind };
}

/** Where "Open task" goes — the Tasks page opens that task's dialog (R-341). */
export const chatTaskHref = (taskId: string) => `/tasks?tab=all&task=${encodeURIComponent(taskId)}`;

/** Tomorrow as YYYY-MM-DD in India time (the default due date). */
export function tomorrowIst(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + 5.5 * 3600_000 + 24 * 3600_000);
  return ist.toISOString().slice(0, 10);
}

/** A picked due DATE → 10:00 India time that day (what chat_message_to_task stores). */
export const dueAtFromDate = (date: string) => `${date}T10:00:00+05:30`;

// ── composer: Message / Problem / Suggestion ─────────────────────────────────────────────

function PostTypeSwitch({ draft, setDraft, sending }: ComposerSlotProps) {
  return (
    <div role="group" aria-label="Post type" className="inline-flex rounded-md border border-hairline p-0.5">
      {KINDS.map(({ kind, label }) => {
        const on = draft.kind === kind;
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            disabled={sending}
            onClick={() => setDraft((d) => ({ ...d, kind }))}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
              on ? "bg-paper-2 text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── on a message ─────────────────────────────────────────────────────────────────────────

function PostStatusBadge({ message }: MessageSlotProps) {
  const chip = postStatusChip(message);
  if (!chip) return null;
  return <Badge kind={chip.kind} size="sm">{chip.label}</Badge>;
}

function useRefreshChat(message: ChatMessage, channelId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: teamChatKeys.messages(channelId) });
    void qc.invalidateQueries({ queryKey: teamChatKeys.thread(message.parent_id ?? message.id) });
  };
}

function MakeTaskDialog({
  open, onOpenChange, message, channelId, myUserId, teammates,
}: MessageSlotProps & { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const refresh = useRefreshChat(message, channelId);
  const [owner, setOwner] = React.useState<string>(myUserId ?? "");
  const [due, setDue] = React.useState<string>(() => tomorrowIst());
  const others = teammates.filter((t) => t.id !== myUserId);

  const make = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_message_to_task", {
        p_message_id: message.id,
        ...(owner && owner !== myUserId ? { p_owner_id: owner } : {}),
        p_due_at: dueAtFromDate(due),
      });
      if (error) throw toChatError(error);
      return data as string;
    },
    onSuccess: () => {
      refresh();
      void qc.invalidateQueries({ queryKey: ["tasks"] });
      const who = owner && owner !== myUserId ? memberLabel(teammates.find((t) => t.id === owner)) : "you";
      toast.success(`Task made for ${who}`);
      onOpenChange(false);
    },
    onError: (err) => toastError(err),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:!max-w-md">
        <DialogHeader>
          <DialogTitle>Make a task</DialogTitle>
          <DialogDescription>
            The task gets this post&apos;s text and a link back to it, and shows in Tasks.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (due) make.mutate();
          }}
        >
          <FormField label="Assign to" htmlFor={`task-owner-${message.id}`}>
            <select
              id={`task-owner-${message.id}`}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              className="h-9 w-full rounded-md border border-hairline bg-paper px-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <option value={myUserId ?? ""}>Me (myself)</option>
              {others.map((t) => (
                <option key={t.id} value={t.id}>{memberLabel(t)}</option>
              ))}
            </select>
          </FormField>
          <FormField label="Due" required htmlFor={`task-due-${message.id}`}>
            <Input
              id={`task-due-${message.id}`}
              type="date"
              required
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" variant="primary" icon="check" loading={make.isPending} disabled={!due}>
              Make task
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PostActions(props: MessageSlotProps) {
  const { message, channelId, myUserId } = props;
  const refresh = useRefreshChat(message, channelId);
  const [dialog, setDialog] = React.useState(false);

  const report = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("chat_message_report", { p_message_id: message.id });
      if (error) throw toChatError(error);
      const id = data as string;
      // Triage last and never fatal — the report is already saved (same order as submitFeedback).
      try {
        await fetch("/api/feedback/triage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedbackId: id }),
        });
      } catch {
        /* the admin page can re-run triage */
      }
      return id;
    },
    onSuccess: () => {
      refresh();
      toast.success(message.kind === "problem" ? "Reported as a bug" : "Sent as an idea");
    },
    onError: (err) => toastError(err),
  });

  if ((message.kind !== "problem" && message.kind !== "suggestion") || message.pending) return null;
  const mine = !!myUserId && message.author_id === myUserId;
  const showMake = mine && !message.task_id;
  const showReport = mine && !message.feedback_id;
  if (!message.task_id && !showMake && !showReport) return null;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {message.task_id ? (
        <Button asChild variant="primary" size="sm" icon="arrow_right">
          <Link href={chatTaskHref(message.task_id)}>Open task</Link>
        </Button>
      ) : showMake ? (
        <Button type="button" variant="primary" size="sm" icon="check" onClick={() => setDialog(true)}>
          Make a task
        </Button>
      ) : null}
      {showReport && (
        <Button type="button" variant="default" size="sm" loading={report.isPending} onClick={() => report.mutate()}>
          {message.kind === "problem" ? "Report as bug" : "Report as idea"}
        </Button>
      )}
      {dialog && <MakeTaskDialog {...props} open={dialog} onOpenChange={setDialog} />}
    </div>
  );
}

export const postTypeExtension: ChatExtension | null = {
  id: "post-type",
  Toolbar: PostTypeSwitch,
  MessageBadge: PostStatusBadge,
  MessageBelow: PostActions,
};
