/**
 * R-209 — the phone half of the Enquiries folder list, and the empty-Inbox buttons.
 *
 * On a phone the folders used to sit inside one "Inbox ▾" <select>. A new user saw a
 * single word and never learned that Starred, Snoozed, Converted Leads, Sent, Done and
 * Spam exist. They are now a row of chips. The row scrolls sideways INSIDE itself
 * (overflow-x-auto + min-w-0 on the nav, w-max on the list), so at 375px the page itself
 * never gets a horizontal scrollbar. Desktop keeps its rail in page.tsx; this is md:hidden.
 */
"use client";

import Link from "next/link";
import type { Route } from "next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MAIL_FOLDERS, type MailFolder } from "@/lib/inbound/folders";

export function FolderChips({
  folder, counts, unread, onPick,
}: {
  folder: MailFolder;
  counts: Record<MailFolder, number>;
  unread: number;
  onPick: (f: MailFolder) => void;
}) {
  return (
    <nav aria-label="Mail folders" className="md:hidden mb-2 w-full min-w-0 shrink-0 overflow-x-auto pb-1">
      <ul className="flex w-max gap-2">
        {MAIL_FOLDERS.map((f) => {
          const isActive = f.id === folder;
          const count = counts[f.id] ?? 0;
          const badge = f.id === "inbox" ? unread : 0;
          return (
            <li key={f.id}>
              <button
                type="button"
                onClick={() => onPick(f.id)}
                aria-current={isActive ? "page" : undefined}
                aria-label={`${f.label}, ${count} conversation${count === 1 ? "" : "s"}${
                  badge > 0 ? `, ${badge} unread` : ""
                }`}
                className={cn(
                  "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors",
                  isActive
                    ? "border-ink bg-paper-2 font-semibold text-ink"
                    : "border-hairline bg-paper text-ink-2 hover:bg-paper-2/60",
                )}
              >
                <span aria-hidden className="text-[14px] leading-none">{f.icon}</span>
                <span>{f.label}</span>
                {badge > 0 && <Badge kind="danger" size="sm">{badge}</Badge>}
                {count > 0 && <span className="text-xs tabular-nums text-ink-3">{count}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** The main job of an empty Inbox: put a lead in by hand. Primary, so it reads as the way forward. */
export function AddLeadButton() {
  return (
    <Button size="sm" variant="primary" asChild>
      <Link href={"/leads" as Route}>Add a lead manually</Link>
    </Button>
  );
}

/** The one-time setup. Secondary (hairline border), so it does not compete with the main job. */
export function SetUpEmailButton() {
  return (
    <Button size="sm" variant="default" asChild>
      <Link href={"/settings?tab=integrations" as Route}>Set up email in Settings</Link>
    </Button>
  );
}
