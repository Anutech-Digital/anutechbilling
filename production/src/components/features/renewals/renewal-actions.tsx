"use client";

/**
 * R-2401 — the renewal buttons, ONE component for the Renewals cards/table and the Payment
 * Follow-up renewal rows (rules + labels: ./renewal-actions-rules.ts).
 *
 *   Send renewal quote         → /api/renewals/send-now (creates the quote if missing, emails it
 *                                with the accept / pay link) — after the same confirm as before.
 *   Create quote (don't send)  → /api/subscriptions/[id]/generate-renewal-quote (opens the quote
 *                                to edit). "Bill next part" for a subscription billed in parts.
 *   Customer not renewing      → before the renewal date: the existing Won't renew dialog;
 *                                after it: the existing Cancel subscription dialog (with reason).
 *   Grace over                 → "Renew anyway" (VendorHoldBadge, R-1796) and "Cancel" side by side.
 *
 * R-2422: the row shows ONE next-step button (renewalNextStep: the rule's primary, else Follow-up)
 * and a ⋯ menu for the rest (Create quote (don't send), Follow-up, Nudge, Voice note, Customer not
 * renewing) — the pattern of Payment Follow-up's rows (collections/row-actions.tsx, R-2408).
 *
 * No new money call: the two routes and the two dialogs (and their RPCs) are the ones the
 * Renewals page and the subscription drawer already used.
 */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/providers/confirm-provider";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { toastError } from "@/lib/errors/toast-error";
import { useOpenRenewalQuotes } from "@/lib/queries/subscriptions";
import { queryKeys } from "@/lib/queries/keys";
import { mayMarkNonRenewing } from "@/lib/subscriptions/non-renewing";
import { readJsonSafe, sendNowConfirm, sendNowStep, sentToastText } from "@/app/(app)/renewals/reminders";
import { openRenewalQuoteMap, openRenewalQuoteStatus } from "@/app/(app)/renewals/open-renewal-quotes";
import { NonRenewingDialog } from "@/components/features/subscriptions/non-renewing-dialog";
import { CancelSubscriptionDialog } from "@/components/features/subscriptions/cancel-subscription-dialog";
import { VendorHoldBadge } from "@/components/features/subscriptions/vendor-hold-badge";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AiDraftButton } from "@/components/shared/ai-draft-button";
import { useVoiceNoteSend } from "@/components/shared/voice-note-button";
import {
  renewalActionSet, renewalNextStep, FOLLOW_UP,
  type RenewalActionSub, type RenewalButtonKind, type RenewalMenuItem,
} from "./renewal-actions-rules";

const NOT_RENEWING_TITLE = {
  "non-renewing": "Mark Won't renew: it runs till the renewal date, then ends — no renewal quote or reminder",
  cancel: "Cancel the subscription with a reason — it leaves MRR and renewals",
} as const;

export interface RenewalActionsSub extends RenewalActionSub {
  customer_name: string | null;
  plan: string | null;
  status: string;
  renewal_state: string | null;
  outstanding_amount: number | null;
  start_date: string | null;
  quote_id: string | null;
  vendor_hold_override_for?: string | null;
  /** R-2422: Nudge / Voice note need the customer. */
  customer_id?: string | null;
}

export function RenewalActions({ sub: raw, daysUntil, layout, strong = false, onFollowup, messaging = false }: {
  sub: RenewalActionsSub;
  /** IST days to the renewal date; negative = past it. */
  daysUntil: number;
  /** card = buttons share the row (Renewals cards); table = compact (Renewals table, Payment Follow-up). */
  layout: "card" | "table";
  /** Urgent rows: the primary button is filled. */
  strong?: boolean;
  /** R-2422: the screen's Follow-up dialog — the next-step button when nothing is left to send, else a ⋯ item. */
  onFollowup?: () => void;
  /** R-2422: offer Nudge (AI draft) and Voice note in the ⋯ menu (Renewals). */
  messaging?: boolean;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  const graceDays = me?.tenantGracePeriodDays ?? 0;
  /* R-453 / R-2232: an open renewal quote whose link-back is missing still counts; draft vs sent. */
  const { data: openRenewals } = useOpenRenewalQuotes();
  const sub = React.useMemo(() => {
    if (raw.renewal_quote_id) return raw;
    const q = openRenewalQuoteMap(openRenewals ?? []).get(raw.id.toLowerCase());
    return q ? { ...raw, renewal_quote_id: q } : raw;
  }, [raw, openRenewals]);
  const quoteStatus = React.useMemo(
    () => openRenewalQuoteStatus(openRenewals ?? []).get(sub.renewal_quote_id ?? "") ?? null,
    [openRenewals, sub.renewal_quote_id],
  );
  const set = renewalActionSet(sub, quoteStatus, {
    daysUntil, tenantGraceDays: graceDays, canEndSubscription: mayMarkNonRenewing(me?.role),
  });
  const name = sub.customer_name ?? "this customer";

  const [busy, setBusy] = React.useState<"send-now" | "generate" | null>(null);
  const [dialog, setDialog] = React.useState<"non-renewing" | "cancel" | "nudge" | null>(null);
  const voice = useVoiceNoteSend({ customerId: sub.customer_id ?? "", purpose: "renewal", customerName: name });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["subscriptions"] });
    void qc.invalidateQueries({ queryKey: ["quotes"] });
    void qc.invalidateQueries({ queryKey: queryKeys.collections() });
  };

  async function onGenerate() {
    setBusy("generate");
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/generate-renewal-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      /* R-239: an HTML 500 used to surface as "Failed: Unexpected token <". */
      const json = (await readJsonSafe(res)) as { error?: string; alreadyExisted?: boolean; quoteId?: string; split?: boolean; message?: string; href?: string | null };
      if (!res.ok) {
        toastError(new Error(json.error ?? "Could not create the renewal quote"), {
          action: { label: "Retry", onClick: () => void onGenerate() },
        });
        return;
      }
      refresh();
      /* R-2095: billed in parts → this billed the next part (request or invoice), not a quote. */
      if (json.split) {
        void qc.invalidateQueries({ queryKey: ["invoices"] });
        toast.success(json.message ?? "Next part billed", { duration: 6000 });
        if (json.href && (canQuotes || json.href.startsWith("/invoices"))) router.push(json.href as never);
        return;
      }
      toast.success(json.alreadyExisted
        ? `Opening the existing renewal quote for ${name}`
        : `Renewal quote ${json.quoteId} created for ${name} — not sent yet`, { duration: 3500 });
      /* Open it so it can be checked before sending (only roles that can open quotes). */
      if (canQuotes) router.push(`/quotes/${json.quoteId}` as never);
    } catch (err) {
      toastError(err, {
        fallback: "Could not create the renewal quote",
        action: { label: "Retry", onClick: () => void onGenerate() },
      });
    } finally {
      setBusy(null);
    }
  }

  /* R-239: an email to a customer is never one stray click — say who and which email. */
  async function onSendNow() {
    const s = { ...sub, customer_name: name };
    const step = sendNowStep(s, graceDays);
    const ok = await confirm({ ...sendNowConfirm(s, step), confirmLabel: "Send email", icon: "mail" });
    if (!ok) return;
    setBusy("send-now");
    try {
      const res = await fetch("/api/renewals/send-now", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription_id: sub.id }),
      });
      const json = (await readJsonSafe(res)) as { error?: string; email_mode?: string; status?: string; step?: string };
      if (!res.ok) {
        toastError(new Error(json.error ?? "Could not send the renewal quote"), {
          action: { label: "Retry", onClick: () => void onSendNow() },
        });
        return;
      }
      const mode = json.email_mode === "stub" ? " (stub mode — no real email)" : "";
      toast.success(`${sentToastText(json, name)}${mode}`);
      refresh();
    } catch (err) {
      toastError(err, {
        fallback: "Could not send the renewal quote",
        action: { label: "Retry", onClick: () => void onSendNow() },
      });
    } finally {
      setBusy(null);
    }
  }

  const run = (kind: "send-now" | "generate") => (kind === "send-now" ? onSendNow() : onGenerate());
  const grow = layout === "card" ? "flex-1" : undefined;
  /* R-2422: ONE next-step button + ⋯ (Payment Follow-up's R-2408 pattern) instead of six stacked buttons. */
  const step = renewalNextStep(set, { followup: !!onFollowup, messaging: !!messaging && !!sub.customer_id });
  const button = step.button;

  const notRenewingButton = set.notRenewing && (
    <Button
      variant="ghost"
      size="sm"
      className="text-rose-700 hover:text-rose-800"
      onClick={() => setDialog(set.notRenewing!.dialog)}
      title={NOT_RENEWING_TITLE[set.notRenewing.dialog]}
    >
      <Icon name="x" size={12} />
      {set.notRenewing.label}
    </Button>
  );

  const ITEM = "gap-2.5 py-2 cursor-pointer";
  /* The ⋯ has its own name — on Payment Follow-up this sits inside a row that has a ⋯ of its own. */
  const menuLabel = `More renewal actions for ${name}${sub.plan ? ` — ${sub.plan}` : ""}`;
  const menuItem: Record<RenewalMenuItem, React.ReactNode> = {
    "create-quote": (
      <DropdownMenuItem key="create-quote" className={ITEM} disabled={busy !== null} onClick={() => void onGenerate()}
        title="Create the renewal quote and open it — nothing is emailed until you send it">
        <Icon name="plus" size={15} /> {set.secondary?.label}
      </DropdownMenuItem>
    ),
    followup: (
      <DropdownMenuItem key="followup" className={ITEM} onClick={() => onFollowup?.()}
        title="Log a call / promise / next date for this renewal">
        <Icon name="phone" size={15} /> {FOLLOW_UP}
      </DropdownMenuItem>
    ),
    nudge: (
      <DropdownMenuItem key="nudge" className={ITEM} onClick={() => setDialog("nudge")}
        title="AI drafts a WhatsApp renewal message — you edit and send it yourself">
        <Icon name="sparkles" size={15} /> Nudge
      </DropdownMenuItem>
    ),
    voice: (
      <DropdownMenuItem key="voice" className={ITEM} disabled={voice.sending} onClick={() => void voice.send()}
        title="Send a Hindi voice-note renewal reminder on WhatsApp (asks first)">
        <Icon name="whatsapp" size={15} /> Voice note
      </DropdownMenuItem>
    ),
    "not-renewing": (
      <DropdownMenuItem key="not-renewing" className={cn(ITEM, "text-rose-700")} onClick={() => setDialog(set.notRenewing!.dialog)}
        title={set.notRenewing ? NOT_RENEWING_TITLE[set.notRenewing.dialog] : undefined}>
        <Icon name="x" size={15} /> {set.notRenewing?.label}
      </DropdownMenuItem>
    ),
  };

  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-1.5", layout === "card" && "w-full")}>
        {set.graceOver && (
          /* Grace over — owner decides: Renew anyway and Cancel side by side (R-2401). */
          <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="grace-over-choice">
            <VendorHoldBadge sub={{ ...sub, customer_name: name, plan: sub.plan }} />
            {notRenewingButton}
          </span>
        )}
        {button && button.kind === "followup" && (
          <Button variant="default" size="sm" icon="phone" className={grow}
            aria-label={`Log a follow-up for ${name}`} onClick={() => onFollowup?.()}>
            {button.label}
          </Button>
        )}
        {button && button.kind !== "followup" && (
          <Button
            variant={strong ? "primary" : "default"}
            size="sm"
            className={grow}
            loading={busy === button.kind}
            disabled={busy !== null}
            onClick={() => void run(button.kind as RenewalButtonKind)}
            title={button.kind === "send-now"
              ? "Email the customer the renewal quote with its accept / pay link (creates it first if needed)"
              : "Bill the next part of this subscription (payment request, or the tax invoice when paid)"}
          >
            <Icon name={button.kind === "send-now" ? "mail" : "plus"} size={12} />
            {button.label}
          </Button>
        )}
        {step.menu.length > 0 && (
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={menuLabel}
                title="More actions"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
              >
                <Icon name="more_h" size={16} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              {step.menu.map((k) => menuItem[k])}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {dialog === "nudge" && sub.customer_id && (
        <AiDraftButton customerId={sub.customer_id} channel="whatsapp" purpose="renewal" onClose={() => setDialog(null)} />
      )}
      {dialog === "non-renewing" && (
        <NonRenewingDialog
          sub={{ id: sub.id, customer_name: name, plan: sub.plan ?? "Subscription", renewal_date: sub.renewal_date }}
          open
          onOpenChange={(v) => { if (!v) setDialog(null); }}
        />
      )}
      {dialog === "cancel" && (
        <CancelSubscriptionDialog
          /* renewal_date left out: the renewal date has passed, so "At end of term" is not offered. */
          sub={{
            id: sub.id, customer_name: name, plan: sub.plan ?? "Subscription",
            outstanding_amount: sub.outstanding_amount ?? 0, start_date: sub.start_date,
            quote_id: sub.quote_id, renewal_quote_id: sub.renewal_quote_id,
            status: sub.status as React.ComponentProps<typeof CancelSubscriptionDialog>["sub"]["status"],
            auto_renew: sub.auto_renew ?? true,
          }}
          open
          onOpenChange={(v) => { if (!v) setDialog(null); }}
        />
      )}
    </>
  );
}
