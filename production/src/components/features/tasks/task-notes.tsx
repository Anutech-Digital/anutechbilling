/**
 * R-2327 — a task's notes on /tasks, with the Team chat link made clickable.
 *
 * A task made from a Team chat post (R-2304; R-2328 for a DM / private post) ends its notes with
 * "From team chat: /team-chat?c=<channel id>&m=<message id>". That line was plain text. It now
 * shows as ONE "Open in team chat" link (row and edit sheet) that opens that exact message.
 *
 * Safety: ONLY that exact same-origin RELATIVE address becomes a link — "/team-chat?c=<uuid>&m=<uuid>"
 * and nothing after it. Any other URL in the notes (another host, "//host", javascript:, a
 * look-alike path, extra parameters) stays plain text; React escapes all of it.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { cn } from "@/lib/utils";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The line chat_message_to_task writes, alone on its line (the last line of the notes). */
const CHAT_LINE = new RegExp(`(?:^|\\n)From team chat: (/team-chat\\?c=${UUID}&m=${UUID})\\s*$`, "i");

/** Split notes into the text and the Team chat address (null when there is none). Pure. */
export function taskNoteParts(notes: string | null | undefined): { text: string; chatHref: string | null } {
  const s = notes ?? "";
  const m = CHAT_LINE.exec(s);
  if (!m) return { text: s, chatHref: null };
  return { text: s.slice(0, m.index).trimEnd(), chatHref: m[1] };
}

/** "Open in team chat" for notes that carry the line; nothing otherwise. */
export function TaskChatLink({ notes, className }: { notes: string | null | undefined; className?: string }) {
  const { chatHref } = taskNoteParts(notes);
  if (!chatHref) return null;
  return (
    <Link href={chatHref as Route} className={cn("inline-flex items-center gap-1 text-[12px] font-medium text-amber-ink underline underline-offset-2 hover:text-ink", className)}>
      Open in team chat
    </Link>
  );
}

/** The notes as the /tasks row shows them: the text, then the link (if any). */
export function TaskNotes({ notes }: { notes: string | null | undefined }) {
  const { text, chatHref } = taskNoteParts(notes);
  if (!text && !chatHref) return null;
  return (
    <div className="mt-1.5">
      {text && <p className="text-[12px] text-ink-3 whitespace-pre-line">{text}</p>}
      {chatHref && <TaskChatLink notes={notes} className={text ? "mt-1" : undefined} />}
    </div>
  );
}
