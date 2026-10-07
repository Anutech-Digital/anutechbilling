/**
 * R-260 — setup wizard's last screen. Every status row comes from real data
 * (tenant fields + the same integration GETs as Settings → Integrations) via
 * buildDoneChecklist; nothing here is hard-coded.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCustomers } from "@/lib/queries/customers";
import { useItems } from "@/lib/queries/items";
import { productCount } from "@/lib/items/catalog-state";
import { buildDoneChecklist, NEXT_STEPS, type ChecklistItem } from "./done-checklist";
import { useGoogleResellerStatus, useRazorpayStatus, useWhatsAppStatus } from "./integration-status";

const STATUS_ICON: Record<ChecklistItem["status"], { icon: string; className: string; sr: string }> = {
  done:     { icon: "check", className: "bg-emerald-600", sr: "Done" },
  pending:  { icon: "clock", className: "bg-amber",       sr: "Needs one more step" },
  todo:     { icon: "plus",  className: "bg-ink-3",       sr: "To do" },
  checking: { icon: "clock", className: "bg-hairline",    sr: "Checking" },
  unknown:  { icon: "info",  className: "bg-hairline",    sr: "Status not available" },
};

export function StepDone() {
  // R-260: every row comes from real data — tenant fields + the same integration
  // GETs Settings → Integrations reads. Nothing here is hard-coded.
  const { data: me } = useCurrentUser();
  const { data: customers, isLoading: customersLoading } = useCustomers();
  const { data: catalogItems, isLoading: itemsLoading } = useItems();
  const razorpay = useRazorpayStatus();
  const whatsapp = useWhatsAppStatus();
  const google = useGoogleResellerStatus();

  const doneChecklist = buildDoneChecklist({
    gstin:              me?.tenantGstin,
    gstinVerifiedAt:    me?.tenantGstinVerifiedAt,
    stateCode:          me?.tenantStateCode,
    upiVpa:             me?.tenantUpiVpa,
    remitAccountNumber: me?.tenantRemitAccountNumber,
    customerCount:      customersLoading ? undefined : (customers?.length ?? 0),
    catalogCount:       itemsLoading ? undefined : productCount(catalogItems),
    razorpay:           razorpay.isLoading ? undefined : (razorpay.data ?? null),
    whatsapp:           whatsapp.isLoading ? undefined : (whatsapp.data ?? null),
    googleReseller:     google.isLoading ? undefined : (google.data ?? null),
  });

  return (
    <div className="py-4 text-center">
      {/* Rocket icon */}
      <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full text-emerald-600"
        style={{ background: "linear-gradient(135deg, #dcfce7 0%, #fef3c7 100%)", boxShadow: "0 12px 32px rgba(22,101,52,0.18)" }}>
        <Icon name="rocket" size={36} />
      </div>

      <h2 className="font-serif text-3xl text-ink">Setup done.</h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-3">
        Here&apos;s what&apos;s ready and what&apos;s left. Everything below can be finished later.
      </p>

      {/* Status checklist — R-260: from real data, one column on phones */}
      <ul className="mx-auto mt-6 grid max-w-md grid-cols-1 gap-2.5 text-left sm:grid-cols-2">
        {doneChecklist.map((it) => {
          const s = STATUS_ICON[it.status];
          return (
            <li key={it.id} className="flex items-start gap-2 text-sm">
              <span
                className={cn("mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-white", s.className)}
              >
                <Icon name={s.icon} size={10} />
                <span className="sr-only">{s.sr}</span>
              </span>
              <div className="min-w-0">
                <p className="font-medium text-ink">{it.status === "checking" ? `${it.label} · checking…` : it.label}</p>
                {it.note && (
                  it.href
                    ? <Link href={it.href as never} className="text-xs text-ink-3 underline underline-offset-2 hover:text-amber-ink">{it.note}</Link>
                    : <p className="text-xs text-ink-3">{it.note}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {/* Next steps — links that open the page (the old checkboxes saved nothing). */}
      <div className="mx-auto mt-6 max-w-md rounded-xl border border-hairline bg-paper-2 p-4 text-left">
        <p className="mb-3 text-3xs font-bold uppercase tracking-widest text-ink-3">
          Next steps
        </p>
        <ul className="space-y-1">
          {NEXT_STEPS.map((t) => (
            <li key={t.href}>
              <Link
                href={t.href as never}
                className="flex min-h-[40px] items-center justify-between gap-2 rounded-md px-2 text-sm text-ink hover:bg-paper"
              >
                {t.label}
                <Icon name="arrow_right" size={13} className="shrink-0 text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      </div>

      {/* CTAs */}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Button variant="primary" asChild>
          <Link href="/dashboard">
            <Icon name="home" size={14} />
            Open dashboard
          </Link>
        </Button>
        <Button variant="default" asChild>
          <Link href="/quotes/new">
            <Icon name="file" size={14} />
            Send first quote
          </Link>
        </Button>
        <Button variant="ghost" asChild>
          <Link href="/settings">
            <Icon name="settings" size={14} />
            Settings
          </Link>
        </Button>
      </div>
    </div>
  );
}
