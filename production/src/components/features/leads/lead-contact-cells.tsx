"use client";
/**
 * R-2970 (20 Nov 2026) — the Phone and Email cells of the lead list.
 *
 * Pardeep: phone and email should show in the list itself, and the phone should call or
 * open WhatsApp in one click. Phone left the grid on 29 Aug 2026 because thirteen columns
 * did not fit; the default view is now eight data columns (Plan, Seats and Wait moved to
 * "Add a column" — measured in lib/leads/list-columns.ts), so it fits again.
 *
 * Masking is unchanged (R-1009 / R-1821): a role without can_view_contact_details gets the
 * value already masked by the data gateway ("••••••3210") and the cell prints exactly that.
 * Call / WhatsApp / Email then go through usableContact(), which fetches the real value from
 * /api/contacts/reveal (role-checked, logged) — the same path the row's ⋯ menu uses.
 */
import * as React from "react";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LeadListRow } from "@/lib/leads/list-page";
import { GRID_TD, GRID_TD_ATOM } from "@/components/features/leads/lead-list-grid";
import { isMaskedContact, usableContact, followRevealed, type ContactPurpose } from "@/lib/contacts/reveal-client";
import { openWhatsApp, waFrom } from "@/components/features/leads/lead-row-actions";

export function PhoneCell({ lead, onWhatsApp }: { lead: LeadListRow; onWhatsApp?: (l: LeadListRow) => void }) {
  const logActivity = useLogLeadActivity();
  const phone = (lead.contact_phone ?? "").trim();
  const masked = isMaskedContact(phone);
  const dialable = masked || phone.replace(/\D/g, "").length >= 6;
  const realPhone = (purpose: ContactPurpose) =>
    usableContact(lead.contact_phone, { table: "leads", id: lead.id, field: "contact_phone" }, purpose);

  return (
    <td className={cn(GRID_TD_ATOM, "text-xs")} onClick={(e) => e.stopPropagation()}>
      {!phone ? (
        <span className="text-ink-3">—</span>
      ) : !dialable ? (
        <span className="text-ink-2" title={phone}>{phone}</span>
      ) : (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Call or WhatsApp ${phone}`}
              title={`${phone} — call or WhatsApp`}
              className="inline-flex max-w-full items-center gap-1 rounded px-0.5 text-ink-2 tabular-nums hover:bg-paper-2 hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber"
            >
              <Icon name="call" size={11} className="shrink-0 text-emerald" />
              <span className="truncate">{phone}</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[11rem]">
            <DropdownMenuItem asChild className="gap-2.5 py-2 cursor-pointer">
              <a
                href={`tel:${phone}`}
                onClick={(e) => {
                  if (masked) {
                    e.preventDefault();
                    void realPhone("call").then((p) => { if (p) window.location.href = `tel:${p}`; });
                  }
                  logActivity.mutate({ leadId: lead.id, kind: "call", detail: `Called ${phone}` });
                }}
              >
                <Icon name="call" size={18} className="text-emerald" /> Call
              </a>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="gap-2.5 py-2 cursor-pointer"
              onClick={async () => {
                const p = await realPhone("whatsapp");
                if (!p) return;
                if (onWhatsApp) onWhatsApp({ ...lead, contact_phone: p }); else openWhatsApp(waFrom(p));
                logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${phone}` });
              }}
            >
              <Icon name="whatsapp" size={18} className="text-emerald" /> WhatsApp
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </td>
  );
}

export function EmailCell({ lead }: { lead: LeadListRow }) {
  const email = (lead.contact_email ?? "").trim();
  return (
    <td className={cn(GRID_TD, "text-xs")} onClick={(e) => email && e.stopPropagation()}>
      {email ? (
        <a
          href={`mailto:${email}`}
          title={`Email ${email}`}
          onClick={(e) => followRevealed(
            e, email, { table: "leads", id: lead.id, field: "contact_email" }, "email",
            (real) => `mailto:${real}`,
          )}
          className="block truncate text-ink-2 hover:text-ink hover:underline"
        >
          {email}
        </a>
      ) : (
        <span className="text-ink-3">—</span>
      )}
    </td>
  );
}
