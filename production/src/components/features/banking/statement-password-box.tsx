/**
 * StatementPasswordBox (R-2662) — asks for a locked statement PDF's password.
 *
 * The password is read straight from the input when the person presses Open, the input is
 * emptied at once, and the value goes only to `onUnlock` (which opens the PDF in this browser
 * with pdfjs). It is never React state, never in a request, a log or storage. No <form>: a
 * submitted password form makes browsers offer to save it.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

interface Props {
  fileName: string;
  /** What to tell the person right now (locked / wrong password / …). */
  message: string;
  /** true after a failed try — the message shows as an error. */
  failed: boolean;
  busy: boolean;
  onUnlock: (password: string) => void | Promise<void>;
  onCancel: () => void;
}

export function StatementPasswordBox({ fileName, message, failed, busy, onUnlock, onCancel }: Props) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = React.useState(true);
  /* Focus on open and again after each try (the input is disabled while the PDF opens). */
  React.useEffect(() => { if (!busy) inputRef.current?.focus(); }, [busy, message]);

  const open = () => {
    const el = inputRef.current;
    if (!el || busy) return;
    const password = el.value;
    el.value = "";          // cleared before anything else runs
    setEmpty(true);
    if (!password) return;
    void onUnlock(password);
  };

  return (
    <div className="rounded-md border border-amber/60 bg-amber-soft/30 p-4 space-y-3" data-testid="statement-password-box">
      <div className="flex items-start gap-2">
        <Icon name="lock" size={16} className="text-amber-ink mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink break-words">{fileName}</p>
          <p className={failed ? "text-xs text-rose" : "text-xs text-ink-2"} role={failed ? "alert" : "status"} aria-live="polite">
            {message}
          </p>
        </div>
      </div>
      <div>
        <label htmlFor="statement-pdf-password" className="text-xs font-medium text-ink-2">PDF password</label>
        <div className="mt-1 flex flex-wrap gap-2">
          <input
            ref={inputRef}
            id="statement-pdf-password"
            type="password"
            /* "new-password": browsers never fill the app's saved login here (they ignore "off"). */
            autoComplete="new-password"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            disabled={busy}
            onChange={(e) => setEmpty(!e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); open(); } }}
            className="h-9 min-w-0 flex-1 rounded-md border border-hairline bg-paper px-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber"
          />
          <Button type="button" size="sm" onClick={open} disabled={busy || empty}>
            {busy ? "Opening…" : "Open PDF"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
        </div>
        <p className="mt-1.5 text-[11px] text-ink-3">
          The PDF is opened here in your browser. The password is not sent or saved anywhere — only the statement&apos;s text goes on to be read.
        </p>
      </div>
    </div>
  );
}
