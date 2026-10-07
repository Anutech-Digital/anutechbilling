"use client";

/**
 * The tap that issues a GST tax invoice.
 *
 * ─── WHY A DIALOG AT ALL ────────────────────────────────────────────────────
 * Before this, /invoices issued invoices from a bare `onClick={() =>
 * generateInvoice.mutate(q.id)}` — and a BULK button that looped the same call over
 * every selected quote. One click, no confirmation, on the two most irreversible
 * things this app does: consuming a GST serial number, and creating a document that
 * since migration 20260823090000 genuinely cannot be edited.
 *
 * ─── THE POINT IS THE FACTS, NOT THE FRICTION ───────────────────────────────
 * A confirm dialog that says "Are you sure?" adds a click and no information, and gets
 * clicked through. Every line here is computed from this quote and this tenant's
 * series (`lib/invoices/issue-consequences.ts`) — the number that will be taken, the
 * amount, whose it is, which due date applies, and whether the series already has
 * holes in it. The operator should be able to spot a wrong one BECAUSE of what it
 * says, not be slowed down until they concentrate.
 *
 * The number is the sharpest part. Shown "this takes INV-ADPL-2026-27-0033" when they
 * have never issued an invoice, an operator learns something no summary would tell
 * them: thirty-two numbers were used and deleted.
 */

import * as React from "react";

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { IssueConsequences } from "@/lib/invoices/issue-consequences";
import type { EinvoiceNoticeText } from "@/lib/compliance/einvoice";
import { EinvoiceBanner } from "./einvoice-banner";

export interface ConfirmIssueDialogProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Computed by the caller so this component stays presentational and testable. */
  consequences: IssueConsequences | null;
  /** "Issue invoice" / "Issue 3 invoices" — the caller knows which. */
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  /** R-337: e-invoice IRN reminder. Rendered on its own, never added to `consequences`,
      so it cannot trip the blocking check below — it warns, it does not block. */
  einvoiceNotice?: EinvoiceNoticeText | null;
}

export function ConfirmIssueDialog({
  open, onOpenChange, consequences, confirmLabel, busy, onConfirm, einvoiceNotice = null,
}: ConfirmIssueDialogProps) {
  /* A blocking warning is one that makes the action impossible — a ₹0 quote, or a
     selection with nothing to issue. generate_invoice would refuse it anyway (#26);
     refusing here means the operator reads why instead of getting a raw error after
     the click. */
  const blocked = consequences?.consequences.some(
    (c) => c.tone === "warning" && /no amount|nothing can be issued/i.test(c.text),
  ) ?? false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-serif text-xl">
            {consequences?.predictedIsCertain && consequences.predictedNumber
              ? consequences.predictedNumber
              : "Issue tax invoice"}
          </DialogTitle>
          <DialogDescription>
            {/* Named as a prediction, because it is one: next_document_number is the only
                thing that allocates, and a concurrent issue can take this number first. */}
            {consequences?.predictedIsCertain
              ? "This is the number this invoice will take. Read what it does before issuing."
              : "Read what this does before issuing."}
          </DialogDescription>
        </DialogHeader>

        <EinvoiceBanner notice={einvoiceNotice} />

        <ul className="space-y-2.5">
          {consequences?.consequences.map((c, i) => (
            <li key={i} className="flex gap-2.5 text-[13px] leading-relaxed">
              <Icon
                name={c.tone === "warning" ? "alert" : "info"}
                size={14}
                className={c.tone === "warning" ? "text-amber mt-0.5 shrink-0" : "text-ink-3 mt-0.5 shrink-0"}
              />
              <span className={c.tone === "warning" ? "text-ink" : "text-ink-2"}>{c.text}</span>
            </li>
          ))}
        </ul>

        <DialogFooter className="mt-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="receipt"
            loading={busy}
            disabled={busy || blocked || !consequences}
            onClick={onConfirm}
            /* Not an autofocused primary. The whole point is that this is read first,
               and a focused confirm button is one Enter away from the thing the dialog
               exists to slow down. */
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
