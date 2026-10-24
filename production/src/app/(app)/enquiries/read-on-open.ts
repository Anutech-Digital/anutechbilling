/**
 * R-1125: when an Enquiries conversation counts as "read".
 *
 * The selection IS the preview (j/k moves it), so marking read on every selection change
 * meant holding j through the list marked every thread it passed as read. Now:
 *   • a thread is marked read after it has stayed open READ_AFTER_MS, or
 *   • at once when the rep clicks it (markRead) — an explicit open, and
 *   • "Mark unread" (markUnread) puts the dot back, and cancels a pending dwell so the
 *     timer cannot undo it a second later.
 */
import * as React from "react";

export const READ_AFTER_MS = 2000;

export interface ReadThread {
  key: string;
  messages: ReadonlyArray<{ id: string; read_at: string | null }>;
}

type Mark = (id: string, read: boolean) => void;

export function useReadOnOpen(thread: ReadThread | null, mark: Mark) {
  // Refs so the timer reads the thread as it is when it fires (after optimistic updates)
  // and a new `mark` identity does not restart the dwell.
  const threadRef = React.useRef(thread);
  const markRef = React.useRef(mark);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => {
    threadRef.current = thread;
    markRef.current = mark;
  });

  const cancel = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const markRead = React.useCallback((t: ReadThread) => {
    for (const m of t.messages) if (m.read_at == null) markRef.current(m.id, true);
  }, []);

  const markUnread = React.useCallback((t: ReadThread) => {
    cancel();
    // The latest message is enough: a thread shows the dot when ANY message is unread.
    const latest = t.messages[t.messages.length - 1];
    if (latest) markRef.current(latest.id, false);
  }, [cancel]);

  const key = thread?.key ?? null;
  React.useEffect(() => {
    if (key == null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      const t = threadRef.current;
      if (t && t.key === key) markRead(t);
    }, READ_AFTER_MS);
    return cancel;
  }, [key, markRead, cancel]);

  return { markRead, markUnread };
}
