"use client";
/**
 * The ⋯ cell at the end of every lead row — moved verbatim out of (app)/leads/page.tsx
 * (S35, 28 Sep 2026).
 */
import * as React from "react";
import dynamic from "next/dynamic";
import { useDeleteLead, useSetLeadJunk } from "@/lib/queries/leads";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { useLeadOutcome } from "@/lib/leads/use-outcome";
import { useCallLog } from "@/components/features/leads/call-log-dialog";
import { chipsForStage } from "@/lib/leads/outcomes";
import { useConfirm } from "@/components/providers/confirm-provider";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { LeadListRow } from "@/lib/leads/list-page";
import { STICK_R_ACTIONS } from "@/components/features/leads/lead-list-grid";
import { isMaskedContact, usableContact, type ContactPurpose } from "@/lib/contacts/reveal-client";

const MarkJunkDialog = dynamic(() => import("@/components/features/leads/mark-junk-dialog").then((m) => m.MarkJunkDialog), { ssr: false });

/** Open a WhatsApp chat — WhatsApp Web on desktop, the app on mobile. */
export function openWhatsApp(rawNumber: string, text?: string) {
  const num = (rawNumber || "").replace(/\D/g, "");
  if (!num) return;
  const isMobile = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const q = text ? `${isMobile ? "?" : "&"}text=${encodeURIComponent(text)}` : "";
  const url = isMobile
    ? `https://wa.me/${num}${q}`
    : `https://web.whatsapp.com/send?phone=${num}${q}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** The number wa.me wants: digits, with 91 in front of a 10-digit Indian number. */
export function waFrom(phone: string): string {
  const d = (phone || "").replace(/\D/g, "");
  return d.startsWith("91") ? d : (d.length === 10 ? `91${d}` : d);
}

// ============================================================
// RowActions — the sticky trailing cell for a lead row. A persistent ⋯ that
// opens a clean, LABELLED action menu (coloured icon + name), so every action
// is unambiguous. Call, WhatsApp and Send quote were loose glyphs in this cell until
// 26 Aug 2026 — three coloured icons a rep had to decode — and are labelled rows now.
// the cell (which is why the old hover-slide panel needed a JS hover-intent).
// ============================================================
export function RowActions({
  lead, isSelected, onSendQuote, onFollowUp, onWhatsApp,
}: {
  lead: LeadListRow;
  isSelected: boolean;
  onSendQuote: (l: LeadListRow) => void;
  onFollowUp: (l: LeadListRow) => void;
  onWhatsApp?: (l: LeadListRow) => void;
}) {
  const phoneDigits = (lead.contact_phone ?? "").replace(/\D/g, "");
  /* R-1009: a role without can_view_contact_details gets "••••••3210" from the gateway. The
     lead still has a phone — Call / WhatsApp / Email fetch the real value (logged) when used. */
  const phoneMasked = isMaskedContact(lead.contact_phone);
  const hasPhone = phoneDigits.length >= 10 || phoneMasked;
  const hasEmail = Boolean(lead.contact_email);
  const realPhone = (purpose: ContactPurpose) =>
    usableContact(lead.contact_phone, { table: "leads", id: lead.id, field: "contact_phone" }, purpose);
  const realEmail = () =>
    usableContact(lead.contact_email, { table: "leads", id: lead.id, field: "contact_email" }, "email");
  const logActivity = useLogLeadActivity();
  const setJunk = useSetLeadJunk();
  const runOutcome = useLeadOutcome();
  const callLog = useCallLog(runOutcome);
  const deleteLead = useDeleteLead();
  const confirm = useConfirm();
  const [junkOpen, setJunkOpen] = React.useState(false);

  const itemCls = "gap-2.5 py-2 cursor-pointer";

  /* ── "Kya hua" — wahi outcomes jo card ke ⋯ me hain (26 Aug 2026) ────────────
     Stage ka dropdown row se hata diya gaya tha, aur outcome chips sirf card par the.
     Table par switch karte hi stage badalne ka koi raasta hi nahi bachta — yaani ek
     poora surface jahan pipeline aage nahi badh sakti.

     `send_quote` aur `mark_junk` yahan se hataye gaye hain kyunki is menu me unke apne
     item pehle se maujood hain ("Send quote", "Mark as junk…"). Ek hi menu me do baar
     ek hi kaam dikhna wahi galti hai jo is file ne "Generate quote" hatate waqt theek
     ki thi. */
  const outcomeItems = chipsForStage(lead.stage).filter(
    (c) => c.id !== "send_quote" && c.id !== "mark_junk",
  );

  return (
    <td
      /* Daayen kinare par jama hua — horizontal scroll par bhi ⋯ pahunch me rehta hai.
         Background solid hona zaroori hai: iske neeche se baaki cells guzarti hain. */
      className={cn(
        "px-2 py-[var(--cell-py)]", STICK_R_ACTIONS,
        isSelected ? "bg-amber-soft" : "bg-paper group-hover:bg-paper-2",
      )}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-end gap-0.5">

        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="More actions"
              /* h-6, h-7 nahi: 28px ka button `compact` density (8px padding) me row ko
                 36px par pin kar deta tha, yaani density switcher kuch nahi karta tha —
                 padding badalti thi aur unchai wahi rehti thi. */
              className="flex h-6 w-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 data-[state=open]:text-ink"
            >
              <Icon name="more_h" size={18} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]">
            <DropdownMenuLabel>More actions</DropdownMenuLabel>
            {hasPhone && (
              <DropdownMenuItem asChild className={itemCls}>
                <a
                  href={`tel:${lead.contact_phone}`}
                  onClick={(e) => {
                    if (phoneMasked) {
                      e.preventDefault();
                      void realPhone("call").then((p) => { if (p) window.location.href = `tel:${p}`; });
                    }
                    logActivity.mutate({ leadId: lead.id, kind: "call", detail: `Called ${lead.contact_phone}` });
                  }}
                >
                  <Icon name="call" size={20} className="text-emerald" /> Call
                  <span className="ml-auto max-w-[9rem] truncate text-xs text-ink-3">{lead.contact_phone}</span>
                </a>
              </DropdownMenuItem>
            )}
            {hasPhone && (
              <DropdownMenuItem
                className={itemCls}
                onClick={async () => {
                  const p = await realPhone("whatsapp");
                  if (!p) return;
                  if (onWhatsApp) { onWhatsApp({ ...lead, contact_phone: p }); } else { openWhatsApp(waFrom(p)); }
                  logActivity.mutate({ leadId: lead.id, kind: "whatsapp", detail: `WhatsApp to ${lead.contact_phone}` });
                }}
              >
                <Icon name="whatsapp" size={20} className="text-emerald" /> WhatsApp
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className={itemCls} onClick={() => onSendQuote(lead)}>
              <Icon name="quote" size={20} className="text-amber" /> Send quote
            </DropdownMenuItem>

            {outcomeItems.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-3xs uppercase tracking-wider text-ink-3">
                  Log outcome
                </DropdownMenuLabel>
                {outcomeItems.map((chip) => {
                  const blocked = chip.needsPhone && !hasPhone;
                  return (
                    <DropdownMenuItem
                      key={chip.id}
                      disabled={blocked}
                      title={blocked
                        ? `${chip.hint}\n\nNo phone number on this lead — add one first.`
                        : chip.hint}
                      /* `callLog.run`, seedha `runOutcome` NAHI — warna "Call log" yahan
                         chup-chaap log kar deta aur drawer me popup kholta. 26 Aug 2026:
                         theek wahi hua tha. */
                      onSelect={() => callLog.run(chip.id, lead)}
                      className={cn(itemCls, chip.tone === "rose" && "text-rose")}
                    >
                      <Icon name={chip.icon} size={20} />
                      {chip.label}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem className={itemCls} onClick={() => onFollowUp(lead)}>
            <Icon name="reminder" size={20} /> Schedule follow-up
          </DropdownMenuItem>
          <DropdownMenuItem
            className={itemCls}
            onClick={async () => {
              const url  = `${window.location.origin}/enquiry`;
              const hi   = lead.contact_name ? `Hi ${lead.contact_name},` : "Hello,";
              const text =
                `${hi}\n\n` +
                `Thanks for your interest. To prepare an accurate quote, please fill this short 1-minute form with your requirement (product, number of users, and any notes):\n\n` +
                `${url}\n\n` +
                `Once you submit it, we'll review and send you a price quote with GST. Thank you!`;
              if (hasPhone) {
                const p = await realPhone("whatsapp");
                if (!p) return;
                // wa.me/<number>?text= reliably opens THIS number's chat (desktop
                // app OR web) with the link pre-filled — not the "new chat" picker.
                window.open(`https://wa.me/${waFrom(p)}?text=${encodeURIComponent(text)}`, "_blank", "noopener");
              } else if (hasEmail) {
                const m = await realEmail();
                if (!m) return;
                window.location.href = `mailto:${encodeURIComponent(m)}?subject=${encodeURIComponent("Please share your requirement for a quote")}&body=${encodeURIComponent(text)}`;
              }
              logActivity.mutate({ leadId: lead.id, kind: "email", detail: "Sent enquiry form link" });
            }}
          >
            <Icon name="link" size={20} /> Send enquiry form
          </DropdownMenuItem>

          {hasEmail && <DropdownMenuSeparator />}
          {hasEmail && (
            <DropdownMenuItem asChild className={itemCls}>
              <a
                href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(lead.contact_email ?? "")}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (isMaskedContact(lead.contact_email)) {
                    e.preventDefault();
                    void realEmail().then((m) => {
                      if (m) window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(m)}`, "_blank", "noopener,noreferrer");
                    });
                  }
                  logActivity.mutate({ leadId: lead.id, kind: "email", detail: `Emailed ${lead.contact_email}` });
                }}
              >
                <Icon name="email" size={20} /> Email
                <span className="ml-auto max-w-[9rem] truncate text-xs text-ink-3">{lead.contact_email}</span>
              </a>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />
          {lead.is_junk ? (
            <DropdownMenuItem className={itemCls} onClick={() => setJunk.mutate({ ids: [lead.id], isJunk: false })}>
              <Icon name="check_circle" size={20} /> Restore from junk
            </DropdownMenuItem>
          ) : (
            /* Opens the dialog instead of binning on the click. One tap is faster and
               it throws away the only fact that makes the decision reversible — see
               MarkJunkDialog. */
            <DropdownMenuItem className={cn(itemCls, "text-rose")} onClick={() => setJunkOpen(true)}>
              <Icon name="alert" size={20} /> Mark as junk
            </DropdownMenuItem>
          )}
            {/* ── Delete, row se bhi (26 Aug 2026, Pardeep ke kehne par) ─────────────
                Delete drawer me pehle se tha, par row ke menu me nahi — to ek galat lead
                mitane ke liye use pehle KHOLNA padta tha. Har row action ⋯ ke neeche hone
                ka wada is menu ki apni hint line karti hai, aur delete uska apwad bana
                hua tha.

                Wahi confirm jo drawer me hai (`danger: true`), aur wahi shabd — ek hi
                kaam do jagah do tarah se poochhe, to ek jagah par aadmi ka bharosa kam
                hota hai. Aur "Mark as junk" ke NEECHE rakha gaya hai: junk wapas laya ja
                sakta hai, delete nahi — to narm option pehle padha jata hai. */}
            <DropdownMenuItem
              className={cn(itemCls, "text-rose")}
              onClick={async () => {
                const ok = await confirm({
                  title: `Permanently delete lead "${lead.company}"?`,
                  body:
                    "This cannot be undone.\n\n" +
                    "To just hide it, use \"Mark as junk\" — it can be restored from the Junk view.",
                  confirmLabel: "Delete",
                  danger: true,
                });
                if (ok) deleteLead.mutate(lead.id);
              }}
            >
              <Icon name="trash" size={20} /> Delete lead…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <MarkJunkDialog
          open={junkOpen}
          onOpenChange={setJunkOpen}
          leadName={lead.company}
          busy={setJunk.isPending}
          onConfirm={({ reasonId, note }) => {
            setJunk.mutate({ ids: [lead.id], isJunk: true, reason: reasonId, note });
            setJunkOpen(false);
          }}
        />

        {/* Menu ke BAAHAR, uske andar nahi — DropdownMenuItem ka `onSelect` menu band
            karta hai, aur menu ke andar rakha popup usi ke saath unmount ho jata. Wahi
            wajah hai jis se MarkJunkDialog bhi yahan hai. */}
        {callLog.dialog}
      </div>
    </td>
  );
}
