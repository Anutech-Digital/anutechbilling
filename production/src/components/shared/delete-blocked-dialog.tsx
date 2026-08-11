/**
 * DeleteBlockedDialog — shown when a delete is refused because other documents
 * depend on the record. Instead of a vanishing error toast, it explains WHAT is
 * linked and HOW to resolve it (with a link to the right place), in a
 * money-safe, auditable way — we never silently cascade-delete money records.
 *
 * Reusable across entities: pass the blocker `reason` (usually the RPC's own
 * message) plus optional resolve links.
 */
"use client";

import * as React from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface ResolveLink { label: string; href: string }

export function DeleteBlockedDialog({
  open,
  onClose,
  title = "Can't delete this yet",
  reason,
  links = [],
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** Why it's blocked — usually the delete RPC's own message. */
  reason: string;
  /** Optional "go handle it here" links (e.g., the blocking invoice). */
  links?: ResolveLink[];
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="alert" size={18} className="text-amber-ink" />
            {title}
          </DialogTitle>
          <DialogDescription className="whitespace-pre-wrap leading-relaxed">
            {reason}
          </DialogDescription>
        </DialogHeader>

        {links.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Handle it here</p>
            {links.map((l) => (
              <a
                key={l.href}
                href={l.href}
                className="inline-flex items-center gap-1.5 text-sm text-amber-ink hover:text-amber"
              >
                <Icon name="arrow_right" size={13} /> {l.label}
              </a>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="primary" onClick={onClose}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
