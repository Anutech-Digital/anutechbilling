/**
 * R-2299 (G-TEAMCHAT TC-06) — the message box at the bottom of a conversation.
 *
 * Enter sends, Shift+Enter starts a new line (IME composition never sends). The text clears at
 * once (the hook shows the message as "Sending…"); if the server refuses, the hook toasts its
 * plain-English reason ONCE (§24) and the draft comes back here so nothing typed is lost.
 * Plug-ins (attachments, record links, mentions, post type) draw into the slots described in
 * composer-slots.ts — this file does not need to change for them.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { usePostChatMessage } from "@/lib/queries/team-chat";
import type { ChatMember } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";
import { cn } from "@/lib/utils";
import { CHAT_EXTENSIONS } from "./extensions";
import {
  EMPTY_DRAFT,
  type ChatExtension,
  type ComposerDraft,
  type ComposerKeyHandler,
  type ComposerSlotProps,
} from "./composer-slots";

export interface ComposerProps {
  channelId: string;
  /** "#general" or the teammate's name — used in the placeholder and the box's label. */
  channelLabel: string;
  myUserId: string | null;
  members: readonly ChatMember[];
  teammates: readonly TeamMember[];
  /** Plug-ins; defaults to the registered ones (tests may pass their own). */
  extensions?: readonly ChatExtension[];
}

export function Composer({ channelId, channelLabel, myUserId, members, teammates, extensions = CHAT_EXTENSIONS }: ComposerProps) {
  const post = usePostChatMessage();
  const [draft, setDraftState] = React.useState<ComposerDraft>(EMPTY_DRAFT);
  const [blocking, setBlockingMap] = React.useState<Record<string, string>>({});
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const keyHandlers = React.useRef(new Set<ComposerKeyHandler>());

  /* A new conversation starts with an empty box. */
  React.useEffect(() => {
    setDraftState(EMPTY_DRAFT);
    setBlockingMap({});
  }, [channelId]);

  const setDraft = React.useCallback((update: (d: ComposerDraft) => ComposerDraft) => setDraftState((d) => update(d)), []);
  const registerKeyHandler = React.useCallback((handler: ComposerKeyHandler) => {
    keyHandlers.current.add(handler);
    return () => { keyHandlers.current.delete(handler); };
  }, []);
  const blockingFor = React.useCallback(
    (id: string) => (reason: string | null) =>
      setBlockingMap((m) => {
        if ((m[id] ?? null) === reason) return m;
        const next = { ...m };
        if (reason) next[id] = reason;
        else delete next[id];
        return next;
      }),
    [],
  );

  /* Grow with the text up to max-h-40, then scroll. */
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`;
  }, [draft.body]);

  const blockReason = Object.values(blocking)[0] ?? null;
  const hasContent = draft.body.trim().length > 0 || draft.attachments.length > 0;
  const canSend = hasContent && !blockReason;

  const send = React.useCallback(() => {
    if (!canSend) return;
    const sent = draft;
    setDraftState(EMPTY_DRAFT);
    post.mutate(
      {
        channelId,
        body: sent.body,
        kind: sent.kind,
        mentions: sent.mentions,
        links: sent.links,
        attachments: sent.attachments,
        authorId: myUserId,
      },
      {
        /* The hook already toasted the reason — only give the text back (if the box is still empty). */
        onError: () => setDraftState((now) => (now.body === "" && now.attachments.length === 0 ? sent : now)),
      },
    );
    textareaRef.current?.focus();
  }, [canSend, draft, post, channelId, myUserId]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    for (const h of keyHandlers.current) {
      if (h(e)) return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  };

  const slotProps = (ext: ChatExtension): ComposerSlotProps => ({
    channelId,
    draft,
    setDraft,
    textareaRef,
    members,
    teammates,
    sending: post.isPending,
    setBlocking: blockingFor(ext.id),
    registerKeyHandler,
  });

  const onFiles = (files: File[]): boolean => {
    for (const ext of extensions) {
      if (ext.onFiles?.(files, slotProps(ext))) return true;
    }
    return false;
  };

  const boxId = `chat-box-${channelId}`;

  return (
    <form
      className="border-t border-hairline bg-paper px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] md:px-4 md:pb-3"
      onSubmit={(e) => { e.preventDefault(); send(); }}
    >
      {extensions.map((ext) => ext.AboveInput && <ext.AboveInput key={`above-${ext.id}`} {...slotProps(ext)} />)}
      <div className="relative">
        {extensions.map((ext) => ext.Popover && <ext.Popover key={`pop-${ext.id}`} {...slotProps(ext)} />)}
        <label htmlFor={boxId} className="sr-only">Message {channelLabel}</label>
        <textarea
          id={boxId}
          ref={textareaRef}
          rows={1}
          value={draft.body}
          onChange={(e) => setDraftState((d) => ({ ...d, body: e.target.value }))}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0 && onFiles(files)) e.preventDefault();
          }}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer?.files ?? []);
            if (files.length > 0 && onFiles(files)) e.preventDefault();
          }}
          placeholder={`Message ${channelLabel}`}
          maxLength={4000}
          className={cn(
            "block w-full resize-none rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink",
            "placeholder:text-ink-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber/40",
            "max-h-40 min-h-[2.5rem] overflow-y-auto",
          )}
        />
      </div>
      {extensions.map((ext) => ext.BelowInput && <ext.BelowInput key={`below-${ext.id}`} {...slotProps(ext)} />)}
      <div className="mt-2 flex items-center gap-2">
        {extensions.map((ext) => ext.Toolbar && <ext.Toolbar key={`tool-${ext.id}`} {...slotProps(ext)} />)}
        <p className="ml-auto hidden text-xs text-ink-3 sm:block" aria-live="polite">
          {blockReason ?? "Enter to send · Shift+Enter for a new line"}
        </p>
        <Button type="submit" variant="primary" size="sm" icon="send" disabled={!canSend} className="ml-auto sm:ml-0">
          Send
        </Button>
      </div>
    </form>
  );
}
