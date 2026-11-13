"use client";

/**
 * R-2401 — the renewal buttons, ONE component for the Renewals cards/table and the Payment
 * Follow-up renewal rows (rules + labels: ./renewal-actions-rules.ts).
 *
 *   Review renewal quote       → R-2710: generate-renewal-quote {review:true} makes / reuses it as a
 *                                DRAFT and opens /quotes/<id>/edit (Save & send to customer there).
 *   Change renewal quote       → R-2710: the sent quote is revised (R-448 / R-2368) and the new draft
 *                                opens in the editor. Send as is / Resend stay in the ⋯ menu.
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
import { MONEY_RECORD_ROLES, canRecordMoney, type UserRole } from "@/lib/auth/roles";
import { toastError } from "@/lib/errors/toast-error";
import { useOpenRenewalQuotes } from "@/lib/queries/subscriptions";
import { queryKeys } from "@/lib/queries/keys";
import { mayMarkNonRenewing } from "@/lib/subscriptions/non-renewing";
import { readJsonSafe, sendNowConfirm, sendNowStep, sentToastText } from "@/app/(app)/renewals/reminders";
import { openRenewalQuoteMap, openRenewalQuoteStatus } from "@/app/(app)/renewals/open-renewal-quotes";
import { NonRenewingDialog } from "@/components/features/subscriptions/non-renewing-dialog";
import { CancelSubscriptionDialog } from "@/components/features/subscriptions/cancel-subscription-dialog";
import { VendorHoldBadge, useRenewAnyway } from "@/components/features/subscriptions/vendor-hold-badge";
import { useSetNonRenewing } from "@/components/features/subscriptions/use-non-renewing";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";
import { canOpenInvoices } from "@/lib/invoices/access";
import { vendorHoldState } from "@/lib/renewals/vendor-hold";
import { notRenewingDialog, type PrimaryContext, type PrimaryKind, type RenewalStage } from "@/lib/renewals/stage";
import { stageButtons, STAGE_MENU_LABEL, type StageMenuItem, type StageRunKind } from "./stage-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { BillNextPartDialog, type BillNextChoice } from "./bill-next-part-dialog";
import { isSplitBilled } from "@/lib/billing/instalments";
import { createClient } from "@/lib/supabase/client";
import { openRenewalRevision } from "@/lib/quotes/start-revision";
import type { BillingCycle } from "@/lib/supabase/database.types";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AiDraftButton } from "@/components/shared/ai-draft-button";
import { useVoiceNoteSend } from "@/components/shared/voice-note-button";
import {
  renewalActionSet, renewalNextStep, billPartDialogTitle, FOLLOW_UP, BILL_NEXT_PART, RECORD_PAYMENT,
  type RenewalActionSub, type RenewalButtonKind, type RenewalMenuItem,
} from "./renewal-actions-rules";
import { quoteEditHrefFromRenewals } from "@/lib/renewals/back-to-renewals";

/** R-2754: the Renewals URL this button was clicked on (keeps the tab) — the editor links back to it. */
function hereUrl(): string | null {
  return typeof window === "undefined" ? null : `${window.location.pathname}${window.location.search}`;
}

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

export function RenewalActions({ sub: raw, daysUntil, layout, strong = false, onFollowup, messaging = false, recordPaymentQuoteId, stage, payHref }: {
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
  /** R-2728: the renewal quote / part proforma with the customer, unpaid → ⋯ "Record payment" (/quotes/<id>?pay=1). */
  recordPaymentQuoteId?: string;
  /**
   * R-2758 (R-2738 model): the row's ONE stage — the button and ⋯ come from renewalPrimary(stage).
   * undefined = the older rules (Payment Follow-up rows); null = the row's documents are still
   * loading → a placeholder, never a button that could act on a half-known row.
   */
  stage?: RenewalStage | null;
  /** R-2758: where Record payment goes (stage-input.ts payHref); null = nothing to pay. */
  payHref?: string | null;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const confirm = useConfirm();
  const { data: me } = useCurrentUser();
  const canQuotes = canOpenQuotes(me?.role);
  const graceDays = me?.tenantGracePeriodDays ?? 0;
  /* R-453 / R-2232: an open renewal quote whose link-back is missing still counts; draft vs sent. */
  const { data: openRenewals, isLoading: openRenewalsLoading } = useOpenRenewalQuotes();
  /* R-2710: until the user and the open renewal quotes are read, the row cannot know whether its
     button is Review, Change or (for a role without the editor) Send — no click that could email
     the customer before it is known. */
  const factsLoading = !me || !!openRenewalsLoading;
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
    /* R-2710: the editor (canOpenQuotes) AND the generate route (MONEY_RECORD_ROLES) — else the old buttons. */
    canReview: canQuotes && !!me?.role && MONEY_RECORD_ROLES.includes(me.role as UserRole),
  });
  const name = sub.customer_name ?? "this customer";

  const [busy, setBusy] = React.useState<RenewalButtonKind | null>(null);
  const [dialog, setDialog] = React.useState<"non-renewing" | "cancel" | "nudge" | "bill-next" | null>(null);
  /* R-2519: billed in parts → "Bill next part" opens the proforma preview first (seats, rate, periods). */
  const splitBilled = isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null);
  const voice = useVoiceNoteSend({ customerId: sub.customer_id ?? "", purpose: "renewal", customerName: name });
  /* R-2758: grace over → Renew anyway is a ⋯ item (same prompt + RPC as the badge); Undo Won't renew. */
  const renewAnyway = useRenewAnyway({ ...sub, customer_name: name, plan: sub.plan });
  const setNonRenewing = useSetNonRenewing();

  async function onUndoWontRenew() {
    const ok = await confirm({
      title: `Undo Won't renew for ${name}?`,
      body: "It comes back to Renewals as a normal renewal — the renewal quote and reminders go out as usual.",
      confirmLabel: "Undo Won't renew", icon: "refresh",
    });
    if (ok) setNonRenewing.mutate({ id: sub.id, on: false });
  }

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["subscriptions"] });
    void qc.invalidateQueries({ queryKey: ["quotes"] });
    void qc.invalidateQueries({ queryKey: queryKeys.collections() });
  };

  async function onGenerate(choice?: BillNextChoice) {
    if (splitBilled && !choice) { setDialog("bill-next"); return; }
    setBusy("generate");
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/generate-renewal-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: choice ? JSON.stringify(choice) : undefined,
      });
      /* R-239: an HTML 500 used to surface as "Failed: Unexpected token <". */
      const json = (await readJsonSafe(res)) as { error?: string; alreadyExisted?: boolean; quoteId?: string; split?: boolean; message?: string; href?: string | null };
      if (!res.ok) {
        toastError(new Error(json.error ?? "Could not create the renewal quote"), {
          action: { label: "Retry", onClick: () => void onGenerate(choice) },
        });
        return;
      }
      refresh();
      setDialog(null);
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

  /* R-2710 (Pratik, 12 Nov): "Review renewal quote" — make (or reuse) the renewal quote as a DRAFT
     and open it in the editor: check seats, rate and term, then "Save & send to customer" there.
     Nothing is emailed here. A linked quote that was already sent goes through Change (Revise). */
  async function onReview() {
    const from = hereUrl();   // R-2754: the tab clicked on, before the await (the owner may switch tabs meanwhile)
    setBusy("review");
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/generate-renewal-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ review: true }),
      });
      const json = (await readJsonSafe(res)) as { error?: string; quoteId?: string; quoteStatus?: string | null };
      if (!res.ok || !json.quoteId) {
        toastError(new Error(json.error ?? "Could not open the renewal quote"), {
          action: { label: "Retry", onClick: () => void onReview() },
        });
        return;
      }
      refresh();
      /* Not a draft (or its status unread) → Change: it opens a draft itself, revises a sent one, or says why not. */
      if (json.quoteStatus !== "draft") {
        await onChange(json.quoteId, from);
        return;
      }
      router.push(quoteEditHrefFromRenewals(json.quoteId, from) as never);
    } catch (err) {
      toastError(err, { fallback: "Could not open the renewal quote", action: { label: "Retry", onClick: () => void onReview() } });
    } finally {
      setBusy(null);
    }
  }

  /* R-2710: "Change renewal quote" — the customer already has it: Revise it (R-448; the
     subscription link moves to the revision when it is sent, R-2368) and open that draft. A second
     click re-opens the same unsent revision. */
  async function onChange(quoteId = sub.renewal_quote_id, from: string | null = hereUrl()) {
    if (!quoteId) return;
    setBusy("change");
    try {
      const r = await openRenewalRevision(createClient(), quoteId);
      if (!r.ok) {
        toastError(new Error(r.reason), {
          action: { label: "Open quote", onClick: () => router.push(`/quotes/${encodeURIComponent(quoteId)}` as never) },
        });
        return;
      }
      refresh();
      if (r.created) toast.success(`Revision ${r.quoteId} created as a draft`, { description: "The customer's old quote is replaced when you send this one." });
      router.push(quoteEditHrefFromRenewals(r.quoteId, from) as never);
    } catch (err) {
      toastError(err, { fallback: "Couldn't start the revision." });
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

  const run = (kind: RenewalButtonKind) => (
    kind === "send-now" ? onSendNow() : kind === "review" ? onReview() : kind === "change" ? onChange() : onGenerate()
  );
  const grow = layout === "card" ? "flex-1" : undefined;
  /* R-2422: ONE next-step button + ⋯ (Payment Follow-up's R-2408 pattern) instead of six stacked buttons. */
  const step = renewalNextStep(set, { followup: !!onFollowup, messaging: !!messaging && !!sub.customer_id });
  const button = step.button;
  /* R-2519: billed in parts and Bill next part is not the row's button → it is in the ⋯ menu
     (bill a period ahead, or re-bill one whose proforma was cancelled). */
  const baseMenu: RenewalMenuItem[] = splitBilled && sub.status === "active" && button?.kind !== "generate"
    ? ["bill-ahead", ...step.menu] : step.menu;
  /* R-2728: the quote's own Record payment dialog (R-243 ?pay=1) — only for roles that can open it and record money. */
  const payQuote = recordPaymentQuoteId && canQuotes && canRecordMoney(me?.role) ? recordPaymentQuoteId : null;
  const menuKeys: RenewalMenuItem[] = payQuote
    ? [...baseMenu.filter((k) => k === "bill-ahead" || k === "secondary"), "record-payment", ...baseMenu.filter((k) => k !== "bill-ahead" && k !== "secondary")]
    : baseMenu;

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
    "bill-ahead": (
      <DropdownMenuItem key="bill-ahead" className={ITEM} disabled={busy !== null} onClick={() => setDialog("bill-next")}
        title="Make the next period's proforma now — check seats, rate and how many periods first">
        <Icon name="plus" size={15} /> Bill next part…
      </DropdownMenuItem>
    ),
    secondary: (
      <DropdownMenuItem key="secondary" className={ITEM} disabled={busy !== null}
        onClick={() => void run(set.secondary?.kind ?? "generate")}
        title={set.secondary?.kind === "send-now"
          ? "Email the customer the renewal quote as it is, with its accept / pay link (asks first)"
          : "Create the renewal quote and open it — nothing is emailed until you send it"}>
        <Icon name={set.secondary?.kind === "send-now" ? "mail" : "plus"} size={15} /> {set.secondary?.label}
      </DropdownMenuItem>
    ),
    "record-payment": (
      <DropdownMenuItem key="record-payment" className={ITEM}
        onClick={() => payQuote && router.push(`/quotes/${encodeURIComponent(payQuote)}?pay=1` as never)}
        title={`Record the customer's payment against ${payQuote ?? "the quote"} — its own Record payment dialog opens`}>
        <Icon name="rupee" size={15} /> {RECORD_PAYMENT}
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

  const dialogs = (
    <>
      {dialog === "bill-next" && (
        <BillNextPartDialog
          sub={{ id: sub.id, customer_name: name, plan: sub.plan }}
          titleFor={(firstStart) => billPartDialogTitle(sub, button && button.kind === "generate" ? button.label : BILL_NEXT_PART, firstStart)}
          open
          busy={busy === "generate"}
          onOpenChange={(v) => { if (!v) setDialog(null); }}
          onConfirm={(choice) => void onGenerate(choice)}
        />
      )}
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

  /* R-2758 (R-2738): the row's ONE button + ⋯ from its stage (renewalPrimary). */
  if (stage !== undefined) {
    const onRun = (kind: StageRunKind) => {
      if (!stage) return;
      switch (kind) {
        /* R-2710: the editor needs canOpenQuotes AND the generate route's money roles (set.canReview's rule). */
        case "send-renewal": return void (canQuotes && !!me?.role && MONEY_RECORD_ROLES.includes(me.role as UserRole) ? onReview() : onSendNow());
        case "send-as-is": return void onSendNow();
        /* code-review: send-now refuses split-billed subs — a part proforma is resent from its own page. */
        case "resend": return stage.split && stage.quoteId ? router.push(`/quotes/${encodeURIComponent(stage.quoteId)}` as never) : void onSendNow();
        case "bill-part": return setDialog("bill-next");
        case "continue": return stage.quoteId ? router.push(`/quotes/${encodeURIComponent(stage.quoteId)}/edit` as never) : undefined;
        case "follow-up": return onFollowup?.();
        case "record-payment": return payHref ? router.push(payHref as never) : undefined;
        case "change-renewal": return void onChange(stage.quoteId ?? undefined);
        case "resend-invoice": return stage.invoiceId ? router.push(`/invoices/${encodeURIComponent(stage.invoiceId)}` as never) : undefined;
        case "open-quote": return stage.quoteId ? router.push(`/quotes/${encodeURIComponent(stage.quoteId)}` as never) : undefined;
        case "nudge": return setDialog("nudge");
        case "voice": return void voice.send();
        case "renew-anyway": return void renewAnyway.run();
        case "not-renewing": return setDialog(notRenewingDialog(stage));
        case "undo-wont-renew": return void onUndoWontRenew();
        case "view-subscription": return router.push(subscriptionOpenHref({ id: sub.id, customer_name: sub.customer_name }) as never);
      }
    };
    return (
      <>
        <StageActions
          stage={stage} name={name} layout={layout} strong={strong}
          busy={busy !== null || renewAnyway.busy || setNonRenewing.isPending}
          disabled={busy !== null || factsLoading}
          ctx={{
            role: me?.role, canEndSubscription: mayMarkNonRenewing(me?.role), tenantGraceDays: graceDays,
            offers: { followup: !!onFollowup, messaging: !!messaging && !!sub.customer_id }, vendorHold: vendorHoldState(sub),
          }}
          sub={sub}
          canQuotes={canQuotes}
          canPay={!!payHref && canRecordMoney(me?.role) && (payHref.startsWith("/quotes/") ? canQuotes : canOpenInvoices(me?.role))}
          canInvoices={canOpenInvoices(me?.role)}
          onRun={onRun}
        />
        {dialogs}
      </>
    );
  }

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
            disabled={busy !== null || factsLoading}
            onClick={() => void run(button.kind as RenewalButtonKind)}
            title={button.kind === "review"
              ? "Open the renewal quote to check seats, rate and term, then send it from there (nothing is emailed yet)"
              : button.kind === "change"
              ? "The customer already has this quote — make a revision to edit and send; the old one stops accepting once it is sent"
              : button.kind === "send-now"
              ? "Email the customer the renewal quote with its accept / pay link (creates it first if needed)"
              : set.renewal
                ? "Bill part 1 of the next term — the renewal, at today's seats × rate (you check them first; proforma, then the tax invoice when paid)"
                : "Bill the next part of this subscription (payment request, or the tax invoice when paid)"}
          >
            <Icon name={button.kind === "send-now" ? "mail" : button.kind === "review" || button.kind === "change" ? "edit" : "plus"} size={12} />
            {button.label}
          </Button>
        )}
        {button && button.kind === "generate" && set.renewal && set.note && (
          /* R-2548: what the renewal click bills — the next term's dates and today's seats × rate. */
          <p className="basis-full text-2xs text-ink-3 tabular-nums" data-testid="renewal-part-note">{set.note}</p>
        )}
        {menuKeys.length > 0 && (
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
              {menuKeys.map((k) => menuItem[k])}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {dialogs}
    </>
  );
}

// ─── R-2758: the stage row's ONE button + ⋯ ──────────────────────────────────

const PRIMARY_ICON: Record<PrimaryKind, React.ComponentProps<typeof Icon>["name"]> = {
  "send-renewal": "edit", "bill-part": "plus", continue: "edit", "follow-up": "phone", "record-payment": "rupee",
};

const PRIMARY_TITLE: Record<PrimaryKind, string> = {
  "send-renewal": "Open the renewal quote to check seats, rate and term, then send it from there (nothing is emailed yet)",
  "bill-part": "Bill the next part — check seats, rate and periods first (proforma, then the tax invoice when paid)",
  continue: "Open the part quote you started — nothing has gone to the customer yet",
  "follow-up": "Log a call / promise / next date for this renewal",
  "record-payment": "Record the customer's payment for this renewal",
};

const MENU_ICON: Record<StageMenuItem, React.ComponentProps<typeof Icon>["name"]> = {
  "send-as-is": "mail", "bill-part": "plus", "record-payment": "rupee", "change-renewal": "edit", resend: "mail",
  "resend-invoice": "mail", "follow-up": "phone", nudge: "sparkles", voice: "whatsapp", "renew-anyway": "refresh",
  "not-renewing": "x", "undo-wont-renew": "refresh", "view-subscription": "eye", "open-quote": "file",
};

const MENU_TITLE: Partial<Record<StageMenuItem, string>> = {
  "send-as-is": "Email the customer the renewal quote as it is, with its accept / pay link (asks first)",
  "bill-part": "Make the next period's proforma now — check seats, rate and how many periods first",
  "change-renewal": "The customer already has this quote — make a revision to edit and send; the old one stops accepting once it is sent",
  resend: "Email the renewal quote again (asks first)",
  "resend-invoice": "Open the invoice to send it or its payment link again",
  nudge: "AI drafts a WhatsApp renewal message — you edit and send it yourself",
  voice: "Send a Hindi voice-note renewal reminder on WhatsApp (asks first)",
  "renew-anyway": "Owner / manager: renew at the vendor before payment (reason goes to the activity log)",
  "not-renewing": "Before the renewal date: mark Won't renew. After it: cancel with a reason.",
  "undo-wont-renew": "The customer will renew after all — back to a normal renewal",
  "open-quote": "The renewal quote is closed — open it to revise it, or to release it before a new renewal",
};

function StageActions({ stage, sub, name, layout, strong, busy, disabled, ctx, canQuotes, canPay, canInvoices, onRun }: {
  stage: RenewalStage | null;
  sub: RenewalActionsSub;
  name: string;
  layout: "card" | "table";
  strong: boolean;
  busy: boolean;
  disabled: boolean;
  ctx: PrimaryContext;
  canQuotes: boolean;
  canPay: boolean;
  canInvoices: boolean;
  onRun: (kind: StageRunKind) => void;
}) {
  /* Documents still loading: a placeholder — never a button that could act on a half-known row. */
  if (!stage) return <Skeleton className="h-8 w-28" aria-label="Loading the next step" data-testid="stage-action-loading" />;
  const { primary, menu } = stageButtons(stage, sub, ctx, { canQuotes, canPay, canInvoices });
  const grow = layout === "card" ? "flex-1" : undefined;
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", layout === "card" && "w-full")} data-testid="stage-actions">
      {primary && (
        <Button
          variant={strong && primary.kind !== "follow-up" ? "primary" : "default"}
          size="sm"
          className={cn("shrink-0", grow)}
          loading={busy}
          disabled={disabled}
          onClick={() => onRun(primary.kind)}
          title={PRIMARY_TITLE[primary.kind]}
          data-testid="stage-primary"
        >
          <Icon name={PRIMARY_ICON[primary.kind]} size={12} />
          {primary.label}
        </Button>
      )}
      {menu.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`More renewal actions for ${name}${sub.plan ? ` — ${sub.plan}` : ""}`}
              title="More actions"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-hairline text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <Icon name="more_h" size={16} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[13rem]">
            {menu.map((k) => (
              <DropdownMenuItem key={k} disabled={disabled && k !== "follow-up" && k !== "view-subscription"}
                className={cn("gap-2.5 py-2 cursor-pointer", k === "not-renewing" && "text-rose-700")}
                onClick={() => onRun(k)} title={MENU_TITLE[k]}>
                <Icon name={MENU_ICON[k]} size={15} /> {STAGE_MENU_LABEL[k]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
