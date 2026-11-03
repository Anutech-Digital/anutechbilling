/**
 * R-1518 "Remind" → R-2412: now the one "Send reminder" dialog, opened on "This invoice".
 * Kept as a name so existing callers (collections page) keep working until they open
 * SendReminderDialog directly. All behaviour lives in send-reminder-dialog.tsx.
 */
"use client";

import { SendReminderDialog } from "./send-reminder-dialog";

export type { ReminderDraftResponse } from "./send-reminder-dialog";

export interface ReminderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
  /** Start on this bill (else the most overdue one). */
  invoiceId?: string | null;
}

export function ReminderDialog(props: ReminderDialogProps) {
  return <SendReminderDialog {...props} defaultScope="invoice" />;
}
