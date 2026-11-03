/**
 * R-1526 "Send pending dues" → R-2412: now the one "Send reminder" dialog, opened on
 * "Full statement". Kept as a name so existing callers (collections page, customer follow-up
 * card) keep working. All behaviour lives in send-reminder-dialog.tsx.
 */
"use client";

import { SendReminderDialog } from "./send-reminder-dialog";

export { pendingDuesUrl } from "./send-reminder-dialog";
export type { PendingDuesPreview } from "./send-reminder-dialog";

export interface PendingDuesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  customerId: string;
  customerName: string;
}

export function PendingDuesDialog(props: PendingDuesDialogProps) {
  return <SendReminderDialog {...props} defaultScope="statement" />;
}
