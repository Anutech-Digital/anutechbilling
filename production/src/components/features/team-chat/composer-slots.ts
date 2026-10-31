/**
 * R-2299 (G-TEAMCHAT TC-06) — the Team chat EXTENSION API.
 *
 * The page ships the plain chat. Four later cards plug in WITHOUT editing the page:
 *   R-2301 attachments  → slots/attachments.tsx   (attach button, files bar, files under a message)
 *   R-2302 record links → slots/links.tsx         (link chips under the box, record chips under a message)
 *   R-2303 @mentions    → slots/mentions.tsx      (popover over the box; claims ↑ ↓ Enter while open)
 *   R-2304 post type    → slots/post-type.tsx     (Text / Problem / Suggestion switch, status + actions)
 * Each of those files exports ONE `ChatExtension | null` (null until its card lands); the card
 * replaces only its own file. `extensions.ts` collects them — nobody needs to edit it.
 *
 * What an extension gets (ComposerSlotProps): the shared DRAFT — body, kind, mentions, links,
 * attachments — exactly what usePostChatMessage sends. An extension only fills its own field
 * through `setDraft`; the composer sends the whole draft on Enter / Send and clears it, and
 * puts it back if the server refuses.
 */
import type * as React from "react";
import type { ChatAttachmentInput, ChatLink, ChatMember, ChatMessage, ChatMessageKind } from "@/lib/team-chat/types";
import type { TeamMember } from "@/lib/queries/team";

/** What the composer will send — the fields of PostChatMessageInput the person controls. */
export interface ComposerDraft {
  body: string;
  kind: Exclude<ChatMessageKind, "system">;
  mentions: string[];
  links: ChatLink[];
  attachments: ChatAttachmentInput[];
}

export const EMPTY_DRAFT: ComposerDraft = { body: "", kind: "text", mentions: [], links: [], attachments: [] };

/**
 * A key handler from an extension. Return true when it USED the key — the composer then does
 * nothing else with it (e.g. the mention popover takes Enter to pick a name instead of sending).
 */
export type ComposerKeyHandler = (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;

/** Props every composer slot component receives. */
export interface ComposerSlotProps {
  channelId: string;
  draft: ComposerDraft;
  /** Change the draft (always as a function of the latest draft). */
  setDraft: (update: (d: ComposerDraft) => ComposerDraft) => void;
  /** The message text box — for caret position, focus, anchoring a popover. */
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** Members of this channel (R-2295 member rows) and every active teammate (names, initials). */
  members: readonly ChatMember[];
  teammates: readonly TeamMember[];
  /** true while a send is running — slots should not change the draft then. */
  sending: boolean;
  /**
   * Hold Send while something is unfinished (e.g. "Uploading 2 files…"); pass null to release.
   * The reason shows next to the disabled Send button.
   */
  setBlocking: (reason: string | null) => void;
  /** Take keys before the composer does; returns the unregister function. */
  registerKeyHandler: (handler: ComposerKeyHandler) => () => void;
}

/** Props of a slot drawn on a message in the conversation. */
export interface MessageSlotProps {
  message: ChatMessage;
  channelId: string;
  /** The signed-in user's id. */
  myUserId: string | null;
  teammates: readonly TeamMember[];
}

/** One plug-in. Every part is optional; give only what the card needs. */
export interface ChatExtension {
  /** Unique id, e.g. "attachments". */
  id: string;
  /** Buttons in the composer's bottom row, left of Send (attach, link a record, post type). */
  Toolbar?: React.ComponentType<ComposerSlotProps>;
  /** Above the text box (the files being attached, with progress). */
  AboveInput?: React.ComponentType<ComposerSlotProps>;
  /** Under the text box (chips of the records linked). */
  BelowInput?: React.ComponentType<ComposerSlotProps>;
  /** Floating over the text box (the @mention list). Rendered inside a `relative` wrapper. */
  Popover?: React.ComponentType<ComposerSlotProps>;
  /** Next to a message's author/time line (a "Problem" / "Task made" chip). */
  MessageBadge?: React.ComponentType<MessageSlotProps>;
  /** Under a message's text (its files, record previews, "Make a task" buttons). */
  MessageBelow?: React.ComponentType<MessageSlotProps>;
  /** Files dropped/pasted into the composer — return true when handled. */
  onFiles?: (files: File[], props: ComposerSlotProps) => boolean;
}
