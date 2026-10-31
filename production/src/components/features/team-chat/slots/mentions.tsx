/**
 * Team chat slot — R-2303 (G-TEAMCHAT TC-10) @mentions.
 *
 * Composer (Popover): typing "@" at the start or after a space lists THIS conversation's
 * members (props.members — never the whole company), filtered as you type (start of the name
 * or of any word). Up / Down move, Enter / Tab pick, Escape closes — while the list is open those
 * keys are taken from the composer (registerKeyHandler), so Enter never sends half a mention.
 * A pick writes a readable "@Hitesh Kumar " token into the text and the person's user id into
 * draft.mentions; deleting the token takes the id back out. The server keeps only real members
 * (never the author) and writes each one ONE 'chat.mention' bell item with href
 * /team-chat?c=<channel>&m=<message> (R-2295).
 *
 * Conversation (MessageBelow): a message that mentions me shows "Mentioned you"; the message
 * named by ?m=<id> (the bell link) is scrolled into view and highlighted once, and ?m= is then
 * dropped from the address (history.replaceState) so switching channels does not jump again.
 * The message text itself stays plain text (message-list.tsx) — nothing here renders HTML.
 */
"use client";

import * as React from "react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ChatExtension, ComposerSlotProps, MessageSlotProps } from "../composer-slots";
import { chatAvatarColor, personInitials, personName } from "../chat-format";

/** At most this many names in the list. */
const MAX_OPTIONS = 8;
/** A query longer than this is not a name being typed any more. */
const MAX_QUERY = 40;
/** How long the bell's target message stays highlighted. */
const HIGHLIGHT_MS = 4000;
const HIGHLIGHT_CLASSES = ["bg-amber/10", "ring-1", "ring-amber/40"] as const;

/**
 * The "@query" being typed at the caret: "@" at the start or after whitespace, then no new
 * line and no second "@" up to the caret. null when the caret is not in one.
 */
export function findMentionQuery(text: string, caret: number): { at: number; query: string } | null {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > MAX_QUERY || /[\n@]/.test(query)) return null;
  return { at, query };
}

interface MentionOption {
  id: string;
  name: string;
  initials: string;
  color: ReturnType<typeof chatAvatarColor>;
}

function matches(name: string, query: string): boolean {
  const q = query.toLowerCase();
  if (q === "") return true;
  const n = name.toLowerCase();
  return n.startsWith(q) || n.split(/\s+/).some((w) => w.startsWith(q));
}

/** The token a pick writes for this person. */
const tokenFor = (name: string) => `@${name}`;

function MentionPopover({ channelId, draft, setDraft, textareaRef, members, teammates, sending, registerKeyHandler }: ComposerSlotProps) {
  const [caret, setCaret] = React.useState(0);
  /** The "@" (position + query) the person closed or just filled — stays closed until it changes. */
  const [dismissed, setDismissed] = React.useState<{ at: number; query: string } | null>(null);
  /** Highlighted row, for the query it was chosen in (a new query starts at the top). */
  const [active, setActive] = React.useState<{ query: string; index: number }>({ query: "", index: 0 });
  const pendingCaret = React.useRef<number | null>(null);

  /* Follow the caret: typing, clicking and arrow keys inside the box all move it. */
  React.useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const read = () => setCaret(el.selectionStart ?? el.value.length);
    const events = ["input", "change", "keyup", "click", "focus", "select"] as const;
    for (const ev of events) el.addEventListener(ev, read);
    return () => { for (const ev of events) el.removeEventListener(ev, read); };
  }, [textareaRef]);

  /* After a pick, put the caret right after the inserted token. */
  React.useLayoutEffect(() => {
    const el = textareaRef.current;
    const pos = pendingCaret.current;
    if (!el || pos === null) return;
    pendingCaret.current = null;
    el.setSelectionRange(pos, pos);
  }, [draft.body, textareaRef]);

  const people = React.useMemo(() => new Map(teammates.map((t) => [t.id, t])), [teammates]);
  const roster = React.useMemo<MentionOption[]>(
    () =>
      members
        .map((m) => {
          const p = people.get(m.user_id);
          return p ? { id: m.user_id, name: personName(p), initials: personInitials(p), color: chatAvatarColor(m.user_id, p.color) } : null;
        })
        .filter((o): o is MentionOption => o !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [members, people],
  );

  /* A deleted (or edited) token takes its id out of the mentions. */
  React.useEffect(() => {
    setDraft((d) => {
      if (d.mentions.length === 0) return d;
      const kept = d.mentions.filter((id) => {
        const p = people.get(id);
        return p ? d.body.includes(tokenFor(personName(p))) : false;
      });
      return kept.length === d.mentions.length ? d : { ...d, mentions: kept };
    });
  }, [draft.body, people, setDraft]);

  const found = sending ? null : findMentionQuery(draft.body, caret);
  const closed = !found || (dismissed !== null && dismissed.at === found.at && dismissed.query === found.query);
  const options = !found || closed ? [] : roster.filter((o) => matches(o.name, found.query)).slice(0, MAX_OPTIONS);
  const open = options.length > 0;
  const index = found && active.query === found.query ? Math.min(active.index, options.length - 1) : 0;

  const pick = (o: MentionOption) => {
    if (!found) return;
    /* Focus FIRST: its focus event reads the old caret and must not win over the pick's. */
    textareaRef.current?.focus();
    const end = found.at + 1 + found.query.length;
    const token = `${tokenFor(o.name)} `;
    const pos = found.at + token.length;
    pendingCaret.current = pos;
    setCaret(pos);
    setDismissed({ at: found.at, query: `${o.name} ` });
    setDraft((d) => ({
      ...d,
      body: d.body.slice(0, found.at) + token + d.body.slice(end),
      mentions: d.mentions.includes(o.id) ? d.mentions : [...d.mentions, o.id],
    }));
  };

  /* The composer asks every handler first; the latest render's state answers. */
  const keyState = React.useRef({ open, options, index, found, pick });
  React.useLayoutEffect(() => { keyState.current = { open, options, index, found, pick }; });
  React.useEffect(
    () =>
      registerKeyHandler((e) => {
        const s = keyState.current;
        if (!s.open || e.nativeEvent.isComposing) return false;
        const query = s.found?.query ?? "";
        switch (e.key) {
          case "ArrowDown":
          case "ArrowUp": {
            e.preventDefault();
            const n = s.options.length;
            setActive({ query, index: (s.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
            return true;
          }
          case "Enter":
          case "Tab": {
            if (e.shiftKey) return false;
            e.preventDefault();
            s.pick(s.options[s.index]);
            return true;
          }
          case "Escape": {
            e.preventDefault();
            if (s.found) setDismissed({ at: s.found.at, query: s.found.query });
            return true;
          }
          default:
            return false;
        }
      }),
    [registerKeyHandler],
  );

  if (!open || !found) return null;
  const listId = `chat-mentions-${channelId}`;
  return (
    <ul
      id={listId}
      role="listbox"
      aria-label="Mention a teammate"
      className="absolute bottom-full left-0 z-20 mb-1 max-h-64 w-72 max-w-full overflow-y-auto rounded-md border border-hairline bg-paper py-1 shadow-lg"
    >
      {options.map((o, i) => (
        <li
          key={o.id}
          id={`${listId}-${o.id}`}
          role="option"
          aria-label={o.name}
          aria-selected={i === index}
          /* mousedown, not click: the text box keeps focus and the caret. */
          onMouseDown={(e) => { e.preventDefault(); pick(o); }}
          onMouseEnter={() => setActive({ query: found.query, index: i })}
          className={cn(
            "flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink",
            i === index ? "bg-amber/10" : "hover:bg-paper-2",
          )}
        >
          <Avatar initials={o.initials} name={o.name} color={o.color} size="sm" />
          <span className="truncate">{o.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** Under a message: "Mentioned you", and the bell's ?m= target scrolled to + highlighted once. */
function MentionBelow({ message, myUserId }: MessageSlotProps) {
  const ref = React.useRef<HTMLSpanElement | null>(null);
  const done = React.useRef(false);

  React.useEffect(() => {
    if (done.current || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("m") !== message.id) return;
    done.current = true;
    const row: HTMLElement | null = ref.current?.closest("li") ?? ref.current;
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    row.setAttribute("data-chat-target", "true");
    row.classList.add(...HIGHLIGHT_CLASSES);
    params.delete("m");
    const qs = params.toString();
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
    const t = window.setTimeout(() => {
      row.classList.remove(...HIGHLIGHT_CLASSES);
      row.removeAttribute("data-chat-target");
    }, HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [message.id]);

  const mentionsMe = !!myUserId && (message.mentions ?? []).includes(myUserId);
  if (!mentionsMe) return <span ref={ref} hidden />;
  return (
    <span ref={ref} className="mt-0.5 inline-flex items-center gap-1 rounded bg-amber/10 px-1.5 py-0.5 text-xs font-medium text-amber">
      <Icon name="bell" size={12} aria-hidden="true" />
      Mentioned you
    </span>
  );
}

export const mentionsExtension: ChatExtension | null = {
  id: "mentions",
  Popover: MentionPopover,
  MessageBelow: MentionBelow,
};
