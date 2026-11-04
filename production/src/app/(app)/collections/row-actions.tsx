"use client";
/**
 * R-2408 — one next-step button per row + a ⋯ menu, instead of 4 stacked buttons (audit #1:
 * rows were ~110px tall). The button is "Record payment" when the promise falls today and the
 * person may record money, else "Follow-up" (worklist.ts nextAction). The menu opens the SAME
 * dialogs as before (Follow-up R-1517, Record payment R-1525) — the page owns which dialog is open.
 * R-2413: the two items "Remind" + "Send pending dues" are ONE, "Send reminder" — R-2412's
 * SendReminderDialog, where the person picks This invoice or Full statement.
 */
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CollectionRow } from "@/lib/queries/collections";
import { nextAction } from "./worklist";

export type RowDialog = "followup" | "send" | "pay";

export function RowActions({
  r, canPay, onOpen, className,
}: {
  r: CollectionRow;
  canPay: boolean;
  onOpen: (dialog: RowDialog, key: string) => void;
  className?: string;
}) {
  const next = nextAction(r, canPay);
  if (next === "none") {
    return <p className={`text-2xs text-ink-3 ${className ?? ""}`}>Link this invoice to a customer to log follow-ups.</p>;
  }
  const open = (d: RowDialog) => () => onOpen(d, r.key);
  return (
    <div className={`flex items-center gap-1.5 ${className ?? ""}`}>
      {next === "pay" ? (
        <Button type="button" size="sm" variant="default" icon="rupee" className="flex-1 md:flex-none"
          aria-label={`Record a payment from ${r.customerName} across their invoices`} onClick={open("pay")}>
          Record payment
        </Button>
      ) : (
        <Button type="button" size="sm" variant="default" icon="phone" className="flex-1 md:flex-none"
          aria-label={`Log a follow-up for ${r.customerName}`} onClick={open("followup")}>
          Follow-up
        </Button>
      )}
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`More actions for ${r.customerName}`}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
          >
            <Icon name="more_h" size={16} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[13rem]">
          {next !== "followup" && (
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={open("followup")}>
              <Icon name="phone" size={15} /> Follow-up
            </DropdownMenuItem>
          )}
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={open("send")}>
            <Icon name="send" size={15} /> Send reminder
          </DropdownMenuItem>
          {canPay && next !== "pay" && r.amountDue > 0 && (
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={open("pay")}>
              <Icon name="rupee" size={15} /> Record payment
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
