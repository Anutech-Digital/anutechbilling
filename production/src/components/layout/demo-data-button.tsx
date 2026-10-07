"use client";

/**
 * R-201: "+ Demo data" next to the STAGING / LOCAL badge. Never rendered in production (the
 * route refuses there too). R-361: Add fills every module — customers, deals, quotes,
 * subscriptions, invoices, payments, tasks, catalogue, vendors, bills, expenses — all tagged
 * "DEMO · …". A second Add changes nothing. Clear: only those rows.
 */
import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { demoDataAllowed } from "@/lib/demo/demo-data";

export function DemoDataButton() {
  const qc = useQueryClient();
  const [busy, setBusy] = React.useState(false);
  if (!demoDataAllowed(process.env.NEXT_PUBLIC_APP_ENV)) return null;

  async function run(method: "POST" | "DELETE") {
    setBusy(true);
    try {
      const res = await fetch("/api/demo-data", { method });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string; already?: boolean; summary?: string; invoicesSkipped?: string | null;
      };
      if (!res.ok) {
        toast.error(method === "POST" ? "Could not add demo data." : "Could not clear demo data.", { description: j.error ?? "Try again in a moment." });
        return;
      }
      if (j.already) {
        toast.info("Demo data is already here.", { description: "Nothing added. Clear it first to start again." });
        return;
      }
      const note = j.invoicesSkipped ? ` ${j.invoicesSkipped}` : "";
      toast.success(method === "POST" ? "Demo data added." : "Demo data cleared.", {
        description: method === "POST"
          ? `${j.summary || "Nothing"} — names start with “DEMO ·”.${note}`
          : `${j.summary ? `${j.summary} removed.` : "Nothing to remove."}${note}`,
      });
      await qc.invalidateQueries();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={busy}
        className="shrink-0 inline-flex items-center gap-1 rounded border border-amber/60 text-ink text-3xs font-semibold px-1.5 sm:px-2 py-0.5 hover:bg-amber/10 disabled:opacity-60"
        aria-label="Demo data for testing"
      >
        <Icon name="plus" size={11} />
        {/* R-203: icon only on a phone — the topbar has no room for the label there. */}
        <span className="hidden sm:inline">Demo data</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Test data (staging / local only)</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => void run("POST")}>
          <Icon name="plus" size={14} /> Add test data to every module
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void run("DELETE")}>
          <Icon name="trash" size={14} /> Clear demo data (only “DEMO ·”)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
