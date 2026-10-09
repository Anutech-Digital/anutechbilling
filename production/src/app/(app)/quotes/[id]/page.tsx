/**
 * /quotes/[id] — quote detail page with status + payment workflow + invoice action.
 */
"use client";

import * as React from "react";
import { isAnnualTier } from "@/lib/quotes/commitment-rate";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { asPdfError, PDF_FAILED_DESCRIPTION } from "@/lib/pdf/pdf-timeout";

import { useQuote, useDeleteQuote, quoteDeleteBlockReason, useQuotesByLead } from "@/lib/queries/quotes";
import { canReviseQuote, nextRevision, revisionDraft } from "@/lib/quotes/revise";
import { istToday } from "@/lib/dates/ist";
import { withInvoiceIssued, leadStageNow, rejectLeadOffer, lostActivityDetail, lossLabel, acceptHint } from "@/lib/quotes/quote-page-actions";
import type { LossReasonCode } from "@/lib/leads/loss-reasons";
import { RejectQuoteDialog } from "./reject-quote-dialog";
import { isQuoteEditableInPlace } from "@/lib/quotes/editable";
import { paymentDomainDefault } from "@/lib/quotes/payment-domain";
import { useGenerateInvoice } from "@/lib/queries/invoices";
import { quoteMoneyActions, splitBilledCycleOf } from "@/lib/quotes/money-stage";
import { planForQuote, splitDue } from "@/lib/billing/instalments";
import { subscriptionHref } from "@/app/(app)/subscriptions/palette-links";
import { orphanState, isOrphan, orphanNote } from "@/lib/subscriptions/orphan-quote";
import { useSubscriptions, useRecreateSubscription } from "@/lib/queries/subscriptions";
import { quotePlaceOfSupply } from "@/lib/quotes/quote-place-of-supply";
import { COMPANY_STATE_FIX } from "@/lib/onboarding/setup-links";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button, IconButton } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { ActivityTimeline, type TimelineEvent } from "@/components/shared/activity-timeline";
import { MarginPill, computeMargin } from "@/components/features/margin-pill";
import { RecordPaymentDialog } from "@/components/features/quotes/record-payment-dialog";
import { payIntent } from "./pay-intent";
import { QuotePreviewDialog } from "@/components/features/quotes/quote-preview-dialog";
import { quoteContact } from "@/lib/quotes/quote-contact";
import { ReceiptVoucherDialog } from "@/components/features/quotes/receipt-voucher-dialog";
import { SendQuoteDialog } from "@/components/features/quotes/send-quote-dialog";
import SendWhatsAppDialog from "@/components/features/whatsapp/send-whatsapp-dialog";
import { ApprovalDrawer } from "@/components/features/quotes/approval-drawer";
import { LifecycleStepper } from "@/components/features/quotes/lifecycle-stepper";
import { ProvisioningCard } from "@/components/features/quotes/provisioning-card";
import { quoteLifecycle } from "@/lib/quotes/lifecycle";
import { withTrialStep, quoteTrialState, quoteTrialEligibility, formatIstDate } from "@/lib/trials/start-from-quote";
import { QuoteTrialDialog } from "@/components/features/quotes/quote-trial-dialog";
import { ActivateOnCreditDialog } from "@/components/features/quotes/activate-on-credit-dialog";
import { duplicateQuoteHref } from "@/lib/quotes/duplicate-customer";
import { acceptedToast } from "@/lib/quotes/accepted-toast";
import { showActivateOnCredit, customerCreditEligibility, splitBillingCreditEligibility, quoteCreditState, NEEDS_DB_UPDATE_MESSAGE } from "@/lib/credit/activate-on-credit";
import { useCreditInvoice } from "@/lib/credit/queries";
import { LateInterestLine } from "@/components/features/quotes/late-interest-line";
import { overallProvisionStatus, type ProvisionStatus } from "@/lib/provisioning/plan";
import { useProvisioning } from "@/lib/queries/provisioning";
import { useQuoteSignature } from "@/lib/queries/quote-signatures";
import { requiredApproval, canSend, canApprove, approvalBadge } from "@/lib/quotes/approval";
import { eligibleApprovers, approverSentence } from "@/lib/quotes/awaiting-approval";
import { useTeamMembers } from "@/lib/queries/team";
import { quoteEconomics, quoteApprovalRecord } from "@/lib/quotes/approval-economics";
import { anyCostUnknown } from "@/lib/quotes/line-cost";
import { useRequestApproval } from "@/lib/queries/quotes";
import { usePaymentsByQuote, totalReceived as sumReceived } from "@/lib/queries/payments";
import { useCustomer } from "@/lib/queries/customers";
import { useLead, useUpdateLeadStage } from "@/lib/queries/leads";
import { useLogLeadActivity } from "@/lib/queries/lead-activities";
import { stageAfterQuoteSent } from "@/lib/leads/stage-after-quote-sent";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { rupee, formatDate, daysBetween, toWhatsAppDigits } from "@/lib/utils";
import { logoDataUri } from "@/lib/pdf/logo";
import { quoteIsPaid } from "@/lib/pdf/quote-document-kind";
import { cn } from "@/lib/utils";
import type { Quote, QuoteLineItem, Payment, BillingCycle } from "@/lib/supabase/database.types";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import { FeeNetLine } from "@/app/(app)/payments/gateway-fee";

// ============================================================
// Status meta
// ============================================================
const STATUS_META: Record<Quote["status"], { kind: "muted" | "success" | "warning" | "danger" | "info"; label: string }> = {
  draft:    { kind: "muted",   label: "Draft" },
  sent:     { kind: "warning", label: "Sent" },
  viewed:   { kind: "info",    label: "Viewed" },
  accepted: { kind: "success", label: "Accepted" },
  rejected: { kind: "danger",  label: "Rejected" },
  expired:  { kind: "danger",  label: "Expired" },
};

const PAYMENT_META: Record<Quote["payment_status"], { kind: "muted" | "success" | "warning" | "info" | "danger"; label: string }> = {
  none:     { kind: "muted",   label: "Not awaiting" },
  awaiting: { kind: "warning", label: "Awaiting payment" },
  /* Rose, matching the list. `info` put half-collected money in the same blue as
     "Invoiced" and "Payment received" — the two states where nothing is owed — so the one
     row with cash outstanding looked like the settled ones. Tone is the only thing a
     glance reads. */
  partial:  { kind: "danger",  label: "Partly paid" },
  received: { kind: "info",    label: "Payment received" },
  invoiced: { kind: "success", label: "Invoiced" },
};

// ============================================================
// Page
// ============================================================
export default function QuoteDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { data: quote, isLoading, error } = useQuote(params.id);
  const { data: paymentHistory } = usePaymentsByQuote(params.id);
  const { data: customer } = useCustomer(quote?.customer_id ?? undefined);
  // Prospect quotes have no customer yet — fall back to the lead's phone so the
  // WhatsApp recipient still prefills (quotes usually go to that same contact).
  const { data: lead } = useLead(quote?.lead_id ?? undefined);
  const updateLeadStage = useUpdateLeadStage();
  const logActivity     = useLogLeadActivity();
  const recipientPhone = React.useMemo(() => {
    const raw = customer?.contact_phone || lead?.contact_phone || "";
    const d = raw.replace(/\D/g, "");
    if (!d) return "";
    // WhatsApp needs a country code — assume India (+91) for a bare 10-digit number.
    return d.startsWith("91") ? `+${d}` : d.length === 10 ? `+91${d}` : `+${d}`;
  }, [customer?.contact_phone, lead?.contact_phone]);
  /* R-445 (1): who the quote is addressed to — customer first, else the lead. Same values in
     the preview, the downloaded PDF and the WhatsApp attachment preview. */
  const contact = quoteContact(customer, lead);
  const { data: me } = useCurrentUser();
  const qc = useQueryClient();
  const deleteQuote = useDeleteQuote();
  const [paymentOpen, setPaymentOpen] = React.useState(false);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [downloadingPdf, setDownloadingPdf] = React.useState(false);
  const [sharingWa, setSharingWa] = React.useState(false);
  const [receiptPayment, setReceiptPayment] = React.useState<Payment | null>(null);
  const [sendOpen,    setSendOpen]    = React.useState(false);
  const [whatsOpen,   setWhatsOpen]   = React.useState(false);
  // "Can't delete" → show WHICH related records block it (invoice + payments).
  const [blockedOpen, setBlockedOpen] = React.useState(false);
  const [approvalOpen, setApprovalOpen] = React.useState(false);
  const requestApproval = useRequestApproval();
  const { data: allSubs } = useSubscriptions();
  const recreateSub = useRecreateSubscription();
  // In-app confirm dialog — native window.confirm() is suppressed in some
  // embeds/webviews and silently returns false, which made destructive actions
  // (Reopen, Delete) look dead. See tasks/page.tsx for the same fix.
  const [confirm, setConfirm] = React.useState<{
    title: string; body: string; confirmLabel: string; icon: string; danger?: boolean;
    onConfirm: () => void;
  } | null>(null);

  // Auto-open a send dialog when the builder redirected here with ?send=
  // (?send=whatsapp or ?send=email). Use a ref to only fire once per
  // navigation so closing the dialog doesn't immediately re-open it.
  const searchParams = useSearchParams();
  const sendIntent   = searchParams.get("send");
  const sendIntentHandled = React.useRef(false);
  React.useEffect(() => {
    if (sendIntentHandled.current) return;
    if (!quote)                     return;            // wait for data
    if (sendIntent === "whatsapp") {
      setWhatsOpen(true);
      sendIntentHandled.current = true;
      router.replace(`/quotes/${quote.id}` as never);   // clean the URL
    } else if (sendIntent === "email") {
      setSendOpen(true);
      sendIntentHandled.current = true;
      router.replace(`/quotes/${quote.id}` as never);
    }
  }, [sendIntent, quote, router]);

  /* Approval state. Derived from the quote's own lines every render rather than read
     from a stored flag — the flag records a DECISION, the lines are the facts, and if
     they disagree it is because someone edited the quote after sign-off. That
     disagreement is exactly what `canSend` is for. */
  const approvalEconomics = React.useMemo(() => quote ? quoteEconomics(quote) : null, [quote]);
  const approvalNeed      = React.useMemo(() => approvalEconomics ? requiredApproval(approvalEconomics) : null, [approvalEconomics]);
  const approvalRec       = React.useMemo(() => quote ? quoteApprovalRecord(quote) : null, [quote]);

  /* Who can actually clear it, by name. "Waiting for the owner to approve" is wrong in a
     workspace with three owners, and worse than vague: the person most likely to be
     reading it is the one who RAISED the quote, and they are the one person who cannot
     approve it. `isSuccess` is what separates "nobody is eligible" (null → the banner says
     the rule cannot be satisfied) from "the roster has not arrived yet" (undefined → the
     banner keeps the old role wording). Treating a slow query as "nobody can approve"
     would flash a dead end on every load. */
  const { data: team, isSuccess: teamLoaded } = useTeamMembers();
  const approverNames = React.useMemo(() => {
    if (!teamLoaded || !quote) return undefined;
    return approverSentence(eligibleApprovers(team ?? [], quote));
  }, [teamLoaded, team, quote]);

  const sendGate          = approvalNeed && approvalRec ? canSend(approvalRec, approvalNeed, approverNames) : null;
  const approvalPill      = approvalNeed && approvalRec ? approvalBadge(approvalRec, approvalNeed) : null;
  const viewerCanApprove  = approvalNeed && approvalRec && me
    ? canApprove({ id: me.userId, role: me.role }, approvalRec, approvalNeed).allowed
    : false;

  /* Lifecycle bar. Every step reads a fact that either exists or does not — see
     lib/quotes/lifecycle.ts on why a skipped step must never render as a tick. */
  const { data: provisioningTasks = [] } = useProvisioning(params.id);
  const { data: signature } = useQuoteSignature(params.id);
  const lifecycle = quote
    ? quoteLifecycle({
        status: quote.status,
        paymentStatus: quote.payment_status,
        invoiceId: quote.invoice_id,
        hasSignature: Boolean(signature),
        provisionStatus: overallProvisionStatus(
          provisioningTasks.map((t) => t.status as ProvisionStatus),
        ),
        signerName: signature?.signer_name ?? null,
        // R-159: paid means the money is in, not that an invoice exists.
        paid: quoteIsPaid(quote),
      })
    : null;

  const totalReceivedSoFar = sumReceived(paymentHistory ?? []);

  /* R-282: trial first, pay later. TRIAL sits between SIGNED and PAID while the quote's lead
     is on a trial; its end day is the payment due date. Rules in lib/trials/start-from-quote.ts. */
  const [trialOpen, setTrialOpen] = React.useState(false);
  const trialLead = quote?.lead_id ? lead : null;
  const trialSteps = lifecycle && quote ? withTrialStep(lifecycle.steps, trialLead, quote.status) : null;
  const trialState = trialLead ? quoteTrialState(trialLead) : null;
  const trialEligibility = quote
    ? quoteTrialEligibility(
        { status: quote.status, payment_status: quote.payment_status, received: totalReceivedSoFar },
        trialLead,
      )
    : null;

  /* R-346: activate now, pay later. Columns read loosely: before the migration they are simply
     absent (undefined), and the menu item then says a database update is needed. */
  const [creditOpen, setCreditOpen] = React.useState(false);
  const creditQuote = quote as (typeof quote & {
    credit_activated_at?: string | null; credit_due_date?: string | null;
    is_one_off?: boolean | null; is_add_seats?: boolean | null;
  }) | undefined;
  const creditCustomer = customer as (typeof customer & {
    allow_pay_later?: boolean | null; credit_limit?: number | null; payment_terms_days?: number | null;
  }) | undefined;
  const creditDbReady = Boolean(creditCustomer && "allow_pay_later" in creditCustomer);
  const showCredit = creditQuote
    ? showActivateOnCredit(
        {
          status: creditQuote.status, payment_status: creditQuote.payment_status, received: totalReceivedSoFar,
          is_one_off: creditQuote.is_one_off, is_add_seats: creditQuote.is_add_seats,
          line_items: creditQuote.line_items, credit_activated_at: creditQuote.credit_activated_at,
        },
        trialLead,
      )
    : false;
  /* One click handler for both places "Activate now, pay later" appears (More menu and,
     R-379 (i), the accepted-and-unpaid action row) — same gate, same reasons. */
  const openActivateOnCredit = () => {
    if (!creditDbReady) { toast.info(NEEDS_DB_UPDATE_MESSAGE); return; }
    /* R-370: split billing would bill twice (credit invoice + instalments) — say why. */
    const split = splitBillingCreditEligibility(creditQuote?.billing_cycle);
    if (!split.ok) { toast.info(split.reason); return; }
    const gate = customerCreditEligibility(creditCustomer ?? null);
    if (gate.ok) setCreditOpen(true);
    else toast.info(gate.reason);
  };
  const isOnCredit = Boolean(creditQuote?.credit_activated_at);
  const { data: creditInvoice } = useCreditInvoice(quote?.invoice_id, isOnCredit);
  const creditState = creditQuote ? quoteCreditState(creditQuote, creditInvoice) : null;

  /* R-243: ?pay=1 opens Record payment directly (amount filled), like ?send= above — once
     per navigation, then the URL is cleaned. A quote that takes no payment just drops it. */
  const payParam = searchParams.get("pay");
  const payIntentHandled = React.useRef(false);
  React.useEffect(() => {
    if (payIntentHandled.current || !quote) return;
    const action = payIntent(payParam, quote, paymentHistory === undefined ? null : totalReceivedSoFar);
    if (action === "none") return;
    payIntentHandled.current = true;
    if (action === "open") setPaymentOpen(true);
    router.replace(`/quotes/${quote.id}` as never);
  }, [payParam, quote, paymentHistory, totalReceivedSoFar, router]);

  /* R-248: ?receipt=<paymentId> (Record payment's "Send receipt" toast button) opens that
     payment's Receipt Voucher — the same dialog as the row's Receipt button. Waits for the
     payment to appear: the list is refetching right after the payment was recorded. A
     different id later (a second payment) opens again; the URL is then cleaned. */
  const receiptParam = searchParams.get("receipt");
  const receiptIntentHandled = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!receiptParam || !quote || receiptIntentHandled.current === receiptParam) return;
    const p = (paymentHistory ?? []).find((x) => x.id === receiptParam && x.status === "received");
    if (!p) return;
    receiptIntentHandled.current = receiptParam;
    setReceiptPayment(p);
    router.replace(`/quotes/${quote.id}` as never);
  }, [receiptParam, quote, paymentHistory, router]);
  // Records that keep this quote un-deletable (must be voided/refunded first).
  const receivedPayments = (paymentHistory ?? []).filter((p) => p.status === "received");

  /* Place of supply — customer → lead → typed prospect (R-376 f / R-381), named with its
     state ("Haryana (06) · IGST"). Comparing the customer alone left a lead quote with no
     state, so a Haryana lead of a Delhi seller previewed and downloaded as intra-state. */
  const pos = quotePlaceOfSupply({
    customer: customer ?? null,
    lead: quote?.customer_id ? null : (lead ?? null),
    quote: quote ?? null,
    seller: { state_code: me?.tenantStateCode, gstin: me?.tenantGstin },
  });
  const interState = pos.interState;
  /* R-431 (board R-406): before an invoice exists, an unknown head blocks it — the company's
     own state first (one click to Settings), then the customer's. generate_invoice refuses
     both server-side; this says so BEFORE the click, with the fix one tap away. An issued
     invoice keeps its frozen head and is never re-decided here. */
  const gstBlock: null | { title: string; body: string; href: string; label: string } =
    !quote || quote.invoice_id || !me ? null
    : pos.head.kind === "seller_state_missing"
      ? { title: COMPANY_STATE_FIX.message, body: `${COMPANY_STATE_FIX.description} Until then the GST invoice can't be issued.`, href: COMPANY_STATE_FIX.href, label: COMPANY_STATE_FIX.label }
      : pos.head.kind === "buyer_state_missing" && quote.customer_id
        ? { title: `${quote.customer_name ?? "This customer"} has no state on record`, body: "The customer's state decides CGST + SGST or IGST. Add it on the customer, then issue the GST invoice.", href: `/customers/${quote.customer_id}`, label: "Open customer" }
        : null;

  // Delete — blocked for quotes with a recorded payment (cascade would wipe the
  // ledger). On success, navigate back to the list since this record is gone.
  const deleteBlock = quote ? quoteDeleteBlockReason(quote) : null;
  const handleDelete = () => {
    if (!quote) return;
    if (deleteBlock) {
      // §24: don't toast a bare reason — open the blocking dialog below, which
      // lists the exact records holding this quote (invoice + received payments)
      // each with its own Open button. That dialog already existed and is what
      // §24 cites as the pattern; this path was the one place still dead-ending
      // on a plain toast.
      setBlockedOpen(true);
      return;
    }
    setConfirm({
      title: `Delete quote ${quote.id}?`,
      body: "This permanently deletes the quote. It cannot be undone.",
      confirmLabel: "Delete",
      icon: "trash",
      danger: true,
      onConfirm: () => deleteQuote.mutate(quote, { onSuccess: () => router.push("/quotes" as never) }),
    });
  };

  // ────────── Mutations ──────────
  /** The page's lead query — may still be loading when a button is pressed (R-443). */
  const cachedLead = lead;
  /**
   * "Mark as sent" — THE FOURTH SEND PATH, and the likeliest one behind Darshan's report.
   *
   * It is deliberately not the emailing route (`/api/quotes/[id]/send`): this button means "I
   * already sent it myself, on WhatsApp or by hand — just record it". So it cannot be folded
   * into that route, and it therefore needs its own copy of the stage rule.
   *
   * Which is exactly how the bug survived a fix. The scan added with `stageAfterQuoteSent`
   * searched for writes of `stage: "quote"` and for the two server senders by name — and this
   * path writes neither. It writes `status: "sent"`, from the browser, and moved no stage at
   * all. A scan is only as wide as the thing it greps for; this one was too narrow, and the
   * most obvious operator action in the whole app fell through it.
   */
  const sendQuote = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      /* `.select("id")` because supabase-js counts "matched no rows" as success — an RLS
         refusal or a stale id would otherwise toast "marked as sent" over a quote that never
         changed status, which is the same class of lie as AGENTS.md L84. */
      const { data, error } = await supabase
        .from("quotes").update({ status: "sent" }).eq("id", params.id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error("The quote was not updated — reopen this page and try again.");
      }

      /* Forward-only, same single rule as the other three senders. Runs through
         useUpdateLeadStage rather than a raw update so the lost-reason hygiene and the
         no-rows-matched throw come along with it.
         R-443: the stage is read from the database NOW. The page's lead query may not have
         loaded yet (pressed right after opening the page) — that undefined stage read as
         "the lead has no stage recorded" and the lead stayed in Contacted. */
      const sentLeadId = quote?.lead_id;
      const lead = sentLeadId
        ? { stage: await leadStageNow(() => supabase.from("leads").select("stage").eq("id", sentLeadId).maybeSingle(), cachedLead?.stage) }
        : cachedLead;
      const move = stageAfterQuoteSent(lead?.stage);
      if (quote?.lead_id && move.nextStage) {
        await updateLeadStage.mutateAsync({ id: quote.lead_id, stage: move.nextStage });
        /* And SAY so on the timeline.
           Caught by watching this run on live data, 24 Aug 2026: the lead moved from Contacted
           to Quote Sent correctly and its timeline said nothing at all, because
           useUpdateLeadStage writes the column and no activity row. The other three senders
           each insert a `kind: "stage"` row — so this path moved a deal between columns with no
           record of why, which is the version of the reported bug that is HARDER to debug than
           the original: the board is right and the history is silent.

           That is the L98 shape again — a rule reaching three call sites out of four — and I
           introduced it hours after writing L98 down. Logged through the RPC rather than a
           direct insert so tenant_id comes from the server, not from this component. */
        try {
          await logActivity.mutateAsync({
            leadId: quote.lead_id,
            kind:   "stage",
            detail: `Quote ${params.id} marked as sent — ${move.reason}`,
          });
        } catch {
          /* Swallowed on purpose, and it is the last statement for that reason. The quote is
             already sent and the stage already moved; letting a failed HISTORY row throw here
             would show "could not mark as sent" over two writes that both succeeded, and the
             operator would press it again. The hook raises its own toast, so the failure is
             still visible — it just does not masquerade as the action failing. */
        }
      }
      return move;
    },
    onSuccess: (move) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      /* The lead board reads the stage this just changed. Without this the operator marks a
         quote sent, walks to the pipeline, and sees the lead still sitting in Contacted —
         which is the exact symptom that was reported. */
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(
        move.nextStage ? "Quote marked as sent · lead moved to Quote Sent" : "Quote marked as sent",
        /* The refusal reason, shown rather than swallowed: on a Won deal the lead deliberately
           does NOT move, and silence there looks identical to the bug being fixed. */
        move.nextStage ? undefined : { description: move.reason },
      );
    },
    onError: (e) => toastError(e),
  });

  /**
   * Mark accepted (without payment) — calls accept_quote RPC which:
   *   - Sets quote.status = 'accepted'
   *   - Converts lead → customer (so the customer record exists immediately,
   *     even before payment lands)
   *   - Marks lead.stage = 'won'
   * Subscription is still created later via record_payment when money arrives.
   */
  const markAccepted = useMutation({
    mutationFn: async () => {
      const res  = await fetch(`/api/quotes/${params.id}/mark-accepted`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not mark as accepted");
      return json as { customerId: string; convertedNow: boolean; matchedExisting?: boolean; customerName?: string | null };
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      toast.success(acceptedToast(data));
    },
    onError: (e) => toastError(e),
  });

  /* R-448: "Revise" — copy this sent quote into the next family version (Q-…-R2) as a DRAFT
     and open it in the draft editor. Nothing changes for the customer until that draft is
     SENT; then the database marks this quote replaced (trg_quote_revision_sent). */
  const startRevision = useMutation({
    mutationFn: async () => {
      if (!quote) throw new Error("The quote is still loading.");
      const supabase = createClient();
      const root = quote.revision_of || quote.id;
      const { data: fam, error: famErr } = await supabase
        .from("quotes").select("revision_no").eq("revision_of", root)
        .order("revision_no", { ascending: false }).limit(1);
      if (famErr) throw famErr;
      const highest = Math.max(quote.revision_no ?? 1, fam?.[0]?.revision_no ?? 1);
      const next = nextRevision({ id: root, revision_of: root, revision_no: highest });
      const { data, error } = await supabase
        .from("quotes")
        .insert(revisionDraft(quote, next, istToday()))
        .select("id").single();
      if (error) throw error;
      return data.id;
    },
    onSuccess: (newId) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success(`Revision ${newId} created as a draft`, {
        description: "Change what you need and send it. The old quote is replaced when this one is sent.",
      });
      router.push(`/quotes/${newId}/edit` as never);
    },
    onError: (e) => toastError(e, { fallback: "Couldn't start the revision." }),
  });

  /* R-452: "Mark rejected" asks why (same reasons as a lost lead) and, when this was the
     lead's last open quote, offers to mark the lead Lost in the same step — before, the
     lead sat in Quote Sent and its value stayed in the pipeline. */
  const [rejectOpen, setRejectOpen] = React.useState(false);
  const { data: leadQuotes } = useQuotesByLead(quote?.lead_id ?? undefined);
  const leadOffer = rejectLeadOffer({ quoteId: params.id, lead: quote?.lead_id ? (lead ?? null) : null, leadQuotes: leadQuotes ?? [] });
  const markRejected = useMutation({
    mutationFn: async (input: { reason: LossReasonCode; note: string | null; markLeadLost: boolean }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update({ status: "rejected", rejected_reason: input.reason, rejected_note: input.note })
        .eq("id", params.id)
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("The quote was not updated — reopen this page and try again.");
      if (input.markLeadLost && quote?.lead_id) {
        await updateLeadStage.mutateAsync({ id: quote.lead_id, stage: "lost", lostReason: input.reason, lostNote: input.note });
        try {
          await logActivity.mutateAsync({ leadId: quote.lead_id, kind: "stage", detail: lostActivityDetail(params.id, input.reason, input.note) });
        } catch {
          /* The quote and lead are already updated; the hook shows its own toast. */
        }
      }
      return input;
    },
    onSuccess: (input) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      setRejectOpen(false);
      toast.success(input.markLeadLost ? "Quote rejected · lead marked Lost" : "Quote marked as rejected");
    },
    onError: (e) => toastError(e),
  });

  /* R-452: a rejected quote can be reopened (the old copy promised a Reopen button and
     had none). The lead is not touched — if it was marked Lost, reopening it is a choice
     made on the lead. */
  const reopenRejected = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .update({ status: "sent", rejected_reason: null, rejected_note: null })
        .eq("id", params.id)
        .eq("status", "rejected")
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("The quote was not updated — reopen this page and try again.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      toast.success("Quote reopened — moved back to Sent");
    },
    onError: (e) => toastError(e),
  });

  // Reopen — revert an accidentally-accepted quote back to 'sent'. The RPC
  // refuses if any money has moved (invoice/payment); the customer + lead stay.
  const reopenQuote = useMutation({
    mutationFn: async () => {
      const supabase = createClient();
      const { error } = await supabase.rpc("reopen_quote", { p_quote_id: params.id });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quotes", params.id] });
      toast.success("Quote reopened — moved back to Sent");
    },
    onError: (e) => toastError(e),
  });

  // Use the central useGenerateInvoice hook — it calls next_document_number RPC
  // (sequential GST-compliant), compute_advance_adjustment RPC (frozen
  // snapshot per Rule 53), and links quote_id correctly. The previous local
  // implementation used Math.random() which broke all three properties.
  const generateInvoice = useGenerateInvoice();

  // ────────── Loading / Error ──────────
  if (isLoading) {
    return (
      <div className="p-4 md:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (error || !quote) {
    return (
      <div className="p-8 max-w-5xl mx-auto">
        <EmptyState
          icon="alert"
          title={error ? "Could not load quote" : "Quote not found"}
          body={error?.message ?? "This quote does not exist in your tenant."}
          action={
            <Button asChild variant="primary" icon="file">
              <Link href={"/quotes" as any}>Back to quotes</Link>
            </Button>
          }
        />
      </div>
    );
  }

  // ────────── Derived ──────────
  /* R-448: a replaced quote reads "Replaced", not "Expired". */
  const status = quote.superseded_by ? { kind: "muted" as const, label: "Replaced" } : STATUS_META[quote.status];
  const revise = canReviseQuote(quote, totalReceivedSoFar);
  const payment = PAYMENT_META[quote.payment_status];
  const items: QuoteLineItem[] = Array.isArray(quote.line_items) ? quote.line_items : [];
  const discount = Math.round(quote.subtotal * (quote.discount_pct / 100));
  const taxable = quote.subtotal - discount;
  const tax = Math.round(taxable * (quote.tax_rate / 100));
  const total = quote.amount ?? taxable + tax;

  /* What can be DONE with the money right now — one tested decision instead of three
     inline conditions that between them left `payment_status = 'none'` (the column
     default) with no action at all. See lib/quotes/money-stage.ts. */
  /* R-446: same test the database trigger uses — any subscription of this quote that is not
     yearly (or the quote's own cycle, before the subscription exists). */
  const splitCycle = splitBilledCycleOf(
    quote.billing_cycle,
    (allSubs ?? []).filter((s) => s.quote_id === quote.id).map((s) => s.billing_cycle),
  );
  /* R-527: a split-billed quote owes only the instalments whose date has arrived — the same
     plan (and rounding) as the customer page, the payment sheet and the instalment invoice. */
  const firstQuoteSub = (allSubs ?? [])
    .filter((s) => s.quote_id === quote.id)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
  const splitPlan = splitCycle && !quote.invoice_id
    ? planForQuote(quote, (firstQuoteSub?.start_date ?? istToday()).slice(0, 10))
    : null;
  const due = splitPlan ? splitDue(splitPlan, { todayISO: istToday(), received: totalReceivedSoFar }) : null;
  const money = quoteMoneyActions(
    {
      splitDue: splitPlan && due ? {
        dueGross: due.dueGross,
        outstanding: due.outstanding,
        count: splitPlan.count,
        next: due.next ? { gross: due.next.gross, billOn: formatDate(due.next.billOn), index: due.next.index } : null,
      } : null,
      status:        quote.status,
      paymentStatus: quote.payment_status,
      invoiceId:     quote.invoice_id,
      total,
      received:      totalReceivedSoFar,
      /* R-446: same test the database trigger uses — any subscription of this quote that
         is not yearly (or the quote's own cycle, before the subscription exists). */
      splitBilledCycle: splitCycle,
    },
    rupee,
  );
  /* ── Did this quote's subscription survive? ───────────────────────────────
     A deleted subscription does not stop the money, it stops the money being KNOWN:
     the customer keeps their mailboxes, the reseller keeps paying the vendor, and
     nothing ever chases the renewal. It is the quietest way this product can lose a
     customer's annual revenue, and until now no screen said a word about it.

     Counted per LINE, not "is there one?" — a licence line plus a support line is the
     normal shape here, so a quote that had two and lost one still looks connected.
     See lib/subscriptions/orphan-quote.ts. */
  /* A plain filter, NOT useMemo: this sits below the page's early returns, and a hook
     called after one runs in a different order on the loading render — React's
     rules-of-hooks caught it. The list is a handful of rows; memoising it would buy
     nothing and cost correctness. */
  const quoteSubs = (allSubs ?? []).filter((s) => s.quote_id === quote.id);
  const orphan = orphanState({
    status:        quote.status,
    paymentStatus: quote.payment_status,
    received:      totalReceivedSoFar,
    isRenewal:     quote.is_renewal,
    isAddSeats:    quote.is_add_seats,
    lines:         (quote.line_items ?? []) as { name?: string | null; qty?: number | null; rate?: number | null }[],
    existingSubs:  quoteSubs.length,
  });

  /* Margin comes from the LINE ITEMS, not from quotes.total_cost.
     The column is an aggregate written at save time and at least one writer forgot
     it: Q-2026-9778 stores total_cost = 0 while its single line carries ₹19,800, so
     this page reported "100% est. margin" on a 17.5% deal. The lines are the facts
     and there is one of them per product, so they are what both this page and the
     approval matrix read — one source, and they cannot disagree. */
  const lineCostTotal = items.reduce((s, l) => s + l.qty * l.cost, 0);
  /* R-388: shared rule — our own support plan at ₹0 is a known cost. */
  const marginKnown   = !anyCostUnknown(items);
  const margin = computeMargin(lineCostTotal, taxable);

  const acceptUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/quote/${quote.id}/accept?t=${encodeURIComponent(quote.public_token)}`;

  /** Render + download the quote PDF. Shared by the Download button and the
   *  free WhatsApp share (so the file is ready for the owner to attach). */
  const downloadQuotePdfFile = async (): Promise<void> => {
    const { downloadQuotePDF } = await import("@/lib/pdf");
    await downloadQuotePDF({
      tenantName:    me?.tenantName    ?? "Workspace",
      tenantGstin:   me?.tenantGstin,
      tenantEmail:   me?.tenantEmail,
      tenantPhone:   me?.tenantPhone,
      tenantAddress: me?.tenantAddress,
      /* Browser fetch of the public logo bucket. Same helper as the server paths so the
         downloaded file matches what the customer is emailed — a logo on one and a monogram
         on the other is the kind of difference nobody reports and everybody notices. */
      tenantLogo:    await logoDataUri(me?.tenantLogoUrl),
      quoteId:       quote.id,
      customerName:  quote.customer_name,
      ...contact,
      createdDate:   quote.created_at,
      expiresDate:   quote.expires_date,
      validityDays:  quote.expires_date
        ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
        : 30,
      lineItems:     items,
      subtotal:      quote.subtotal,
      discountPct:   quote.discount_pct,
      discount,
      taxable,
      taxRate:       quote.tax_rate,
      tax,
      total,
      interState,
      placeOfSupply: pos.label,
      isExport:      pos.isExport,
      notes:         quote.notes ?? "",
      /* R-034. Same rule as the server builder — a paid quote downloads as a record of
         the order, not as an offer with a validity window and Net-7 terms on it. */
      isPaid:        quoteIsPaid(quote),
    });
  };

  /** Free wa.me share — opens WhatsApp with a prefilled Hinglish message (quote
   *  no · total · accept link) and downloads the PDF so the owner can attach it.
   *  No Cloud API / keys needed, so it works day one. */
  const shareQuoteOnWhatsApp = async (): Promise<void> => {
    const message =
      `Namaste ${quote.customer_name},\n\n` +
      `Aapka quotation ${quote.id} taiyaar hai.\n` +
      `Total: ${rupee(total)} (GST included)\n\n` +
      `Online review + accept yahan kar sakte hain:\n${acceptUrl}\n\n` +
      `PDF bhi attach kar raha hoon. Koi sawaal ho to bataiyega.\n\n` +
      `Dhanyavaad,\n${me?.tenantName ?? ""}`;
    const digits = toWhatsAppDigits(recipientPhone);
    if (!digits) {
      // §24: had the reason + the why, but no way to act on it. Send them to the
      // exact record that needs the phone number.
      toast.error("No phone number for this customer/lead", {
        description: "Add a phone number on the record, then send on WhatsApp.",
        action: quote.customer_id
          ? { label: "Add phone", onClick: () => router.push(`/customers/${quote.customer_id}/edit` as any) }
          : quote.lead_id
            ? { label: "Open lead", onClick: () => router.push(`/leads?lead=${quote.lead_id}` as any) }
            : undefined,
      });
      return;
    }
    // Device-aware target (matches the leads screen): mobile → wa.me deep link;
    // desktop → web.whatsapp.com/send (wa.me shows a landing page on desktop).
    const q = encodeURIComponent(message);
    const isMobile = typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches;
    const link = isMobile
      ? `https://wa.me/${digits}?text=${q}`
      : `https://web.whatsapp.com/send?phone=${digits}&text=${q}`;
    // Open WhatsApp synchronously (inside the click gesture) so pop-up blockers
    // don't eat it, THEN download the PDF for the owner to attach.
    window.open(link, "_blank", "noopener,noreferrer");
    setSharingWa(true);
    try {
      await downloadQuotePdfFile();
      toast.success("Quote PDF downloaded", {
        description: "Attach this PDF in the WhatsApp chat.",
      });
    } catch (err) {
      console.error("Quote PDF failed:", err);
      toastError(asPdfError(err), { description: "WhatsApp opened — download the PDF again, then attach it in the chat." });
    } finally {
      setSharingWa(false);
    }
  };
  const daysLeft = quote.expires_date ? daysBetween(new Date(), quote.expires_date) : null;

  // Activity timeline
  const events: TimelineEvent[] = [
    { icon: "file", kind: "indigo", title: "Quote created",
      body: `Draft created with ${items.length} line items`,
      time: formatDate(quote.created_date, "long") },
  ];
  if (quote.status !== "draft") {
    events.push({ icon: "send", kind: "indigo", title: "Sent to customer", body: `Quote shared with ${quote.customer_name}`, time: formatDate(quote.updated_at, "long") });
  }
  if (quote.status === "accepted") {
    events.push({ icon: "check_circle", kind: "emerald", title: "Customer accepted", body: "Quote accepted · payment workflow started", time: formatDate(quote.updated_at, "long") });
  }
  // Only record a "Payment received" event when money ACTUALLY landed. A quote
  // can be 'invoiced' with ₹0 received (invoice raised, awaiting payment) — the
  // old check keyed on payment_status === 'invoiced' and fell back to `total`,
  // fabricating a "Payment received · <full total>" with "undefined · ref: null".
  if (totalReceivedSoFar > 0) {
    const received = (paymentHistory ?? []).filter((p) => p.status === "received");
    const latest = received[received.length - 1];
    events.push({
      icon: "rupee", kind: "emerald",
      title: `Payment received · ${rupee(totalReceivedSoFar)}`,
      body: received.length > 1
        ? `${received.length} payments received`
        : latest?.method
          ? `${latest.method.toUpperCase()}${latest.reference ? ` · ref: ${latest.reference}` : ""}`
          : "Recorded",
      time: latest?.received_at ? formatDate(latest.received_at, "long") : "Recently",
    });
  }
  if (quote.payment_status === "invoiced" && quote.invoice_id) {
    events.push({
      icon: "receipt", kind: "emerald", title: `Invoice ${quote.invoice_id} generated`,
      body: "GST e-invoice ready",
      time: formatDate(quote.updated_at, "long"),
    });
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="flex items-start gap-3 min-w-0">
          <IconButton icon="arrow_left" aria-label="Back" onClick={() => router.push("/quotes" as any)} />
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Revenue · {quote.is_extension ? "Extension Quote" : quote.is_renewal ? "Renewal Quote" : "Quote"}
            </p>
            <h1 className="font-serif text-3xl md:text-4xl leading-tight">
              {quote.id}
            </h1>
            <p className="text-sm text-ink-3 mt-1 flex items-center gap-2 flex-wrap">
              <span>
                For{" "}
                {quote.customer_id ? (
                  <Link
                    href={`/customers/${quote.customer_id}` as any}
                    className="font-semibold text-ink hover:text-amber-ink hover:underline"
                  >
                    {quote.customer_name}
                  </Link>
                ) : (
                  <b className="text-ink">{quote.customer_name}</b>
                )}
              </span>
              <span>·</span>
              <Badge kind={status.kind} dot>{status.label}</Badge>
              {quote.revision_no > 1 && quote.revision_of && (
                <>
                  <span>·</span>
                  <span>Revision {quote.revision_no} of{" "}
                    <Link href={`/quotes/${quote.revision_of}` as never} className="hover:text-amber-ink hover:underline">{quote.revision_of}</Link>
                  </span>
                </>
              )}
              {approvalPill && (
                <>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={() => setApprovalOpen(true)}
                    title={approvalPill.title}
                    className="rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
                  >
                    <Badge kind={approvalPill.kind === "muted" ? "muted" : approvalPill.kind === "success" ? "success" : approvalPill.kind === "danger" ? "danger" : "warning"}>
                      {approvalPill.label}
                    </Badge>
                  </button>
                </>
              )}
              {quote.is_extension ? (
                <>
                  <span>·</span>
                  <Badge kind="warning">Extension · {Math.round((quote.extension_months ?? 12) / 12)} yr</Badge>
                </>
              ) : quote.is_renewal && (
                <>
                  <span>·</span>
                  <Badge kind="info">Renewal</Badge>
                </>
              )}
              {quote.payment_status !== "none" && (
                <>
                  <span>·</span>
                  <Badge kind={payment.kind} dot>{payment.label}</Badge>
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <Button icon="file" onClick={() => setPreviewOpen(true)}>
            Preview
          </Button>
          <Button
            variant="primary"
            icon="whatsapp"
            loading={sharingWa}
            onClick={shareQuoteOnWhatsApp}
            title="WhatsApp par bhejein — PDF download hoga, chat me attach kar dein"
          >
            Send on WhatsApp
          </Button>
          <Button
            icon="download"
            loading={downloadingPdf}
            onClick={async () => {
              setDownloadingPdf(true);
              try {
                await downloadQuotePdfFile();
                toast.success(`${quote.id}.pdf downloaded`);
              } catch (err) {
                /* R-525: a hung or refused render now rejects within 20 s with operator copy. */
                toastError(asPdfError(err), { description: PDF_FAILED_DESCRIPTION });
              } finally {
                setDownloadingPdf(false);
              }
            }}
          >
            Download PDF
          </Button>
          {/* Secondary utilities collapse into an overflow menu so the header
              has one clear reading order — the money next-step lives in the
              status action bar below, not fighting these buttons. Delete is
              separated at the bottom to avoid a fat-finger next to Send. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon="more_h">More</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[13rem]">
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  navigator.clipboard?.writeText(acceptUrl);
                  toast.success("Customer link copied · share via email or WhatsApp");
                }}
              >
                <Icon name="link" size={15} /> Copy customer link
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => setSendOpen(true)}
              >
                <Icon name="mail" size={15} /> {quote.status === "sent" ? "Resend via email" : "Send via email"}
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => setWhatsOpen(true)}
              >
                <Icon name="whatsapp" size={15} /> Send via WhatsApp automation (Cloud API)
              </DropdownMenuItem>
              {revise.ok && (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={() => startRevision.mutate()}
                >
                  <Icon name="edit" size={15} /> Revise (replaces this quote)
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                className="gap-2.5 py-2 cursor-pointer"
                onClick={() => {
                  // Lead context only for a prospect quote — R-379 (h): see duplicate-customer.ts.
                  router.push(duplicateQuoteHref(quote) as never);
                }}
              >
                <Icon name="copy" size={15} /> {revise.ok ? "Duplicate as a new quote" : "Duplicate & edit"}
              </DropdownMenuItem>
              {/* R-282: only an accepted quote with no money in. A running trial still shows
                  the item, and says why it cannot start a second one. */}
              {quote.status === "accepted" && totalReceivedSoFar === 0 && (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={() => {
                    if (trialEligibility?.ok) setTrialOpen(true);
                    else if (trialEligibility) toast.info(trialEligibility.reason);
                  }}
                >
                  <Icon name="clock" size={15} /> Start trial (pay later)
                </DropdownMenuItem>
              )}
              {/* R-346: credit sale. Hidden on a trial quote (trial ≠ credit) and once on credit. */}
              {showCredit && (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={openActivateOnCredit}
                >
                  <Icon name="check_circle" size={15} /> Activate now, pay later
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              {deleteBlock ? (
                <DropdownMenuItem
                  className="gap-2.5 py-2 cursor-pointer text-ink-2"
                  onClick={() => setBlockedOpen(true)}
                >
                  <Icon name="lock" size={15} /> Can&apos;t delete — why?
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  destructive
                  className="gap-2.5 py-2 cursor-pointer"
                  onClick={handleDelete}
                >
                  <Icon name="trash" size={15} /> Delete quote
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Quote-to-cash lifecycle */}
      {lifecycle && (
        <Card>
          <LifecycleStepper steps={trialSteps ?? lifecycle.steps} dead={lifecycle.dead} />
          {/* R-282: the trial's last day IS the payment due date — said in words, because the
              stepper's detail line is hidden on a phone. */}
          {quote.status === "accepted" && totalReceivedSoFar === 0 && trialState && trialState.kind !== "converted" && (
            <p className={cn("mt-3 border-t border-hairline pt-2.5 text-xs", trialState.kind === "ended" ? "text-rose" : "text-ink-2")}>
              {trialState.kind === "running"
                ? <>Trial running · payment due <b>{formatIstDate(trialState.endDate)}</b> ({trialState.daysLeft === 0 ? "today" : `${trialState.daysLeft} ${trialState.daysLeft === 1 ? "day" : "days"} left`})</>
                : <>Trial ended <b>{formatIstDate(trialState.endDate)}</b> · payment not in. Extend, stop or convert — nothing is suspended automatically.</>}
            </p>
          )}
          {/* R-346: activated on credit — what is due and when, in words. */}
          {creditState && creditState.kind !== "paid" && (
            <p className={cn("mt-3 border-t border-hairline pt-2.5 text-xs", creditState.kind === "overdue" ? "text-rose" : "text-ink-2")}>
              {creditState.kind === "due"
                ? <>Active on credit · <b>{rupee(creditState.amountDue)}</b> due <b>{formatIstDate(creditState.dueDate)}</b> ({creditState.daysLeft === 0 ? "today" : `${creditState.daysLeft} ${creditState.daysLeft === 1 ? "day" : "days"} left`})</>
                : <>Active on credit · <b>{rupee(creditState.amountDue)}</b> was due <b>{formatIstDate(creditState.dueDate)}</b> ({creditState.daysLate} {creditState.daysLate === 1 ? "day" : "days"} late). Nothing is suspended automatically.</>}
            </p>
          )}
          {/* R-368: 18% p.a. late interest — shown; charged only by an owner/billing click. Stays
              after a late payment until it is charged (or there was none). */}
          {isOnCredit && quote?.invoice_id && (
            <LateInterestLine quoteId={quote.id} invoiceId={quote.invoice_id} role={me?.role} />
          )}
        </Card>
      )}

      {creditOpen && quote && creditCustomer && (
        <ActivateOnCreditDialog
          open={creditOpen}
          onOpenChange={setCreditOpen}
          quote={{
            id: quote.id, customer_name: quote.customer_name, amount: quote.amount ?? 0, invoice_id: quote.invoice_id, seats: quote.seats,
            line_items: Array.isArray(quote.line_items) ? quote.line_items : null,
            billing_cycle: quote.billing_cycle,
          }}
          customer={{
            id: creditCustomer.id, name: creditCustomer.name,
            payment_terms_days: creditCustomer.payment_terms_days ?? null,
            credit_limit: creditCustomer.credit_limit ?? null,
          }}
          role={me?.role}
        />
      )}

      {trialOpen && (
        <QuoteTrialDialog
          open={trialOpen}
          onOpenChange={setTrialOpen}
          quote={{
            id: quote.id, tenant_id: quote.tenant_id, lead_id: quote.lead_id, customer_id: quote.customer_id,
            customer_name: quote.customer_name, domain: quote.domain, seats: quote.seats,
          }}
          lead={lead ? { id: lead.id, notes: lead.notes } : null}
          customer={customer ? {
            contact_name: customer.contact_name, contact_email: customer.contact_email,
            contact_phone: customer.contact_phone, domain: customer.domain,
          } : null}
          ownerId={me?.userId}
        />
      )}

      {/* Status-aware action bar */}
      <Card>
        {quote.status === "draft" && (
          <div className="space-y-3">
            {/* Approval gate. §24 — the refusal names what happened, why, and the one
                button that moves it forward. A disabled Send with no explanation is
                the dead end this rule exists to prevent. */}
            {sendGate && !sendGate.allowed && (
              <div className="flex items-start gap-2.5 rounded-lg border border-amber/60 bg-amber-soft p-3.5">
                <Icon name="alert" size={18} className="mt-px shrink-0 text-amber-ink" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-amber-ink">{sendGate.reason}</p>
                  <p className="mt-0.5 text-[12px] leading-snug text-ink-2">{sendGate.nextStep}</p>
                  {approvalNeed && approvalNeed.reasons.length > 0 && approvalRec?.status === "not_required" && (
                    <ul className="mt-1.5 space-y-0.5">
                      {approvalNeed.reasons.map((r) => (
                        <li key={r} className="text-2xs leading-snug text-ink-3">· {r}</li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex flex-wrap gap-2">
                    {approvalRec?.status !== "pending" && (
                      <Button
                        size="sm"
                        loading={requestApproval.isPending}
                        onClick={() => {
                          if (!me || !approvalNeed || approvalNeed.tier === "none") return;
                          requestApproval.mutate(
                            { id: quote.id, tier: approvalNeed.tier, userId: me.userId },
                            { onSuccess: () => toast.success(`Sent to ${approvalNeed.tier === "owner" ? "the owner" : "a manager"} for approval.`) },
                          );
                        }}
                      >
                        Request approval
                      </Button>
                    )}
                    {viewerCanApprove && (
                      <Button size="sm" variant="default" onClick={() => setApprovalOpen(true)}>
                        Review &amp; decide
                      </Button>
                    )}
                    {/* Was `/quotes/<id>/edit`, which 404s — that route does not exist.
                        Verified by fetching it: HTTP 404, "This page could not be found".
                        The `as any` on the href is what let it ship; typedRoutes would
                        have rejected an unknown route, and the cast silenced exactly the
                        check that was right.

                        The working path is the one the More menu already offers: duplicate
                        into the builder, prefilled from this quote (quote-builder reads
                        ?duplicate=). Labelled for what it does, because it does make a new
                        quote rather than editing this one. A dead end is the one thing
                        §24 says a block may never be. */}
                    <Button size="sm" variant="default" asChild>
                      <Link href={`/quotes/new?duplicate=${quote.id}` as any}>Duplicate &amp; re-price</Link>
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm text-ink-3">This is a draft. Send it to the customer when ready.{quote.revision_of ? " Once sent, it replaces the earlier version." : ""}</div>
              <div className="flex gap-2">
                {/* This block only renders for a draft, and a draft is what the in-place
                    editor accepts — so "Edit" means edit here, and the route now exists.
                    The guard is still CONSULTED rather than assumed from context: a draft
                    can carry a payment (the direct-invoice path produces exactly that
                    shape), and that one must not be rewritten. When it says no, the
                    duplicate flow is offered instead of a disabled button. */}
                {isQuoteEditableInPlace(quote) ? (
                  <Button asChild variant="default" icon="edit">
                    <Link href={`/quotes/${quote.id}/edit` as any}>Edit</Link>
                  </Button>
                ) : (
                  <Button asChild variant="default" icon="copy">
                    <Link href={`/quotes/new?duplicate=${quote.id}` as any}>Duplicate &amp; edit</Link>
                  </Button>
                )}
                <Button
                  variant="primary"
                  icon="send"
                  loading={sendQuote.isPending}
                  disabled={!!sendGate && !sendGate.allowed}
                  title={sendGate && !sendGate.allowed ? sendGate.reason : undefined}
                  onClick={() => sendQuote.mutate()}
                >
                  Mark as sent
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Pre-acceptance row — only while the quote is genuinely still open.
            Once an invoice exists (payment_status 'invoiced' / invoice_id set),
            the invoice block below owns the payment action — showing "Mark
            accepted (no payment yet)" + "Record payment now" here too would be
            contradictory (deal already invoiced) and duplicate the balance
            button. */}
        {(quote.status === "sent" || quote.status === "viewed")
          && quote.payment_status !== "invoiced" && !quote.invoice_id && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-ink-3">
              {daysLeft !== null && daysLeft > 0 && (
                <>Expires in <b>{daysLeft} days</b> · </>
              )}
              {acceptHint(quote)}
              {" "}
              {/* What this sentence used to say, unconditionally: "Payment can land later —
                  record it when received." On Q-ADPL-2026-27-0024 that was printed under a
                  ₹20,000 UPI payment with its own receipt voucher. Money that has already
                  arrived is stated, in rose, instead of being described as a future
                  possibility. */}
              {totalReceivedSoFar > 0 ? (
                <span className="font-medium text-rose">
                  {due
                    ? <>{rupee(totalReceivedSoFar)} received · {rupee(due.outstanding)} due now{due.next && due.outstanding === 0 ? <> · next instalment {rupee(due.next.gross)} on {formatDate(due.next.billOn)}</> : null}.</>
                    : <>{rupee(totalReceivedSoFar)} already received of {rupee(total)} — {rupee(Math.max(0, total - totalReceivedSoFar))} still outstanding.</>}
                </span>
              ) : (
                <span className="text-ink-2">Payment can land later — record it when received.</span>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="ghost" loading={markRejected.isPending} onClick={() => setRejectOpen(true)}>
                Mark rejected
              </Button>
              {/* R-448: change a sent quote without leaving the old one acceptable. */}
              {revise.ok && (
                <Button variant="default" icon="edit" loading={startRevision.isPending} onClick={() => startRevision.mutate()}>
                  Revise
                </Button>
              )}
              {/* This row owns the STATUS decision only. The payment button that used to
                  sit here has moved to the money row below, which is now the single
                  place that decides what can be done with the money — leaving it here
                  as well put two "Record payment" buttons on one screen. */}
              {/* "(no payment yet)" is a claim about the bank, and it was printed whether
                  or not one had. The parenthetical is what made it wrong, so it goes when
                  money exists; the button's job — recording the STATUS decision — does
                  not change. */}
              <Button variant="primary" icon="check_circle" loading={markAccepted.isPending} onClick={() => markAccepted.mutate()}>
                {totalReceivedSoFar > 0 ? "Mark accepted" : "Mark accepted (no payment yet)"}
              </Button>
            </div>
          </div>
        )}

        {/* ── One money row, one decision ───────────────────────────────────
            This used to be three separate conditions written months apart, each
            handling one payment_status by name — and none of them matched 'none',
            which is the column DEFAULT. An accepted quote that never went through
            the Mark-accepted button therefore showed NO money action at all: live
            example Q-2026-9776, accepted, ₹45,360, no Record payment and no invoice
            button, so the deal could not be progressed from its own page.

            The decision now lives in lib/quotes/money-stage.ts with tests, and this
            renders whatever it says. It also reads the RECORDED payments rather than
            the status label, because the label is something somebody has to remember
            to move and the payment rows are what actually happened. */}
        {/* ── The subscription this quote should have, and does not ───────────
            Above the money row on purpose: a paid deal with no subscription is a
            bigger problem than anything the money row can offer, and it is the one
            nobody would otherwise notice. */}
        {isOrphan(orphan) && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rose/50 bg-rose-soft/40 px-4 py-3">
            <div className="flex items-start gap-2 text-sm">
              <Icon name="alert" size={16} className="mt-0.5 shrink-0 text-rose" />
              <span className="text-ink">{orphanNote(orphan)}</span>
            </div>
            <Button
              variant="primary"
              icon="refresh"
              loading={recreateSub.isPending}
              onClick={() => setConfirm({
                title: "Rebuild the subscription from this quote?",
                /* Says exactly what it will and will NOT touch. A repair button that
                   does not explain its blast radius is one nobody dares press. */
                body: "It creates only the missing subscription rows, dated from this quote's own start date so the renewal falls where it always should have. No payment, invoice or document number is touched.",
                confirmLabel: "Rebuild subscription",
                icon: "refresh",
                onConfirm: () => recreateSub.mutate(params.id),
              })}
            >
              Re-create subscription from quote
            </Button>
          </div>
        )}

        {gstBlock && money.canGenerateInvoice && (
          <div role="alert" className="flex items-start justify-between gap-3 flex-wrap rounded-md border border-amber/40 bg-amber-soft/40 p-3">
            <div className="text-sm text-ink-2 min-w-0">
              <div className="font-semibold text-amber-ink">⚠ {gstBlock.title}</div>
              <div className="text-xs mt-0.5">{gstBlock.body}</div>
            </div>
            <Button asChild variant="primary" icon="settings">
              <Link href={gstBlock.href as never}>{gstBlock.label}</Link>
            </Button>
          </div>
        )}

        {/* R-452 / R-448: one line for a closed quote, with the action it needs. */}
        {money.stage === "closed" && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-ink-2">
              {quote.superseded_by ? (
                <>Replaced by{" "}
                  <Link href={`/quotes/${quote.superseded_by}` as never} className="font-semibold text-ink hover:text-amber-ink hover:underline">
                    {quote.superseded_by}
                  </Link>
                  . The customer&apos;s old link now shows that this quote was replaced.
                </>
              ) : quote.status === "rejected" ? (
                <>Rejected{lossLabel(quote.rejected_reason) ? <> · <b>{lossLabel(quote.rejected_reason)}</b></> : null}
                  {quote.rejected_note ? <> — {quote.rejected_note}</> : null}. Reopen it if the customer comes back.
                </>
              ) : (
                <>This quote has expired. Duplicate it to send a fresh one.</>
              )}
            </div>
            <div className="flex gap-2 flex-wrap">
              {quote.status === "rejected" && !quote.superseded_by && (
                <Button
                  variant="default"
                  icon="arrow_left"
                  loading={reopenRejected.isPending}
                  onClick={() => setConfirm({
                    title: `Reopen quote ${quote.id}?`,
                    body: "It moves back to Sent. The lead is not changed — if it was marked Lost, reopen it on the lead.",
                    confirmLabel: "Reopen quote",
                    icon: "arrow_left",
                    onConfirm: () => reopenRejected.mutate(),
                  })}
                >
                  Reopen
                </Button>
              )}
              {!quote.superseded_by && (
                <Button asChild variant="default" icon="copy">
                  <Link href={duplicateQuoteHref(quote) as never}>Duplicate</Link>
                </Button>
              )}
            </div>
          </div>
        )}

        {money.stage !== "closed" && (money.canRecordPayment || money.canGenerateInvoice || money.note) && (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-sm text-ink-2">{money.note}</div>
            <div className="flex gap-2 flex-wrap">
              {/* Reopen stays available while no money has moved — undoing an
                  accidental accept must not need a database. */}
              {money.stage === "unpaid" && (
                <Button
                  variant="ghost"
                  icon="arrow_left"
                  loading={reopenQuote.isPending}
                  onClick={() => setConfirm({
                    title: `Reopen quote ${quote.id}?`,
                    body: "It moves back to Sent so you can edit or re-send. The customer record stays — reverse this only if the accept was a mistake.",
                    confirmLabel: "Reopen quote",
                    icon: "arrow_left",
                    onConfirm: () => reopenQuote.mutate(),
                  })}
                >
                  Reopen
                </Button>
              )}

              {/* Invoicing no longer waits for money. CGST §31(2) with Rule 47 requires
                  the invoice within 30 days of supply and says nothing about payment —
                  and a B2B customer routinely needs it before their accounts team will
                  release the payment at all. Refusing meant the reseller raised that
                  invoice somewhere else and these books never heard about it. */}
              {money.canGenerateInvoice && (
                <Button
                  variant={money.canRecordPayment ? "default" : "primary"}
                  icon="receipt"
                  loading={generateInvoice.isPending}
                  disabled={!!gstBlock}
                  title={gstBlock ? gstBlock.title : undefined}
                  onClick={() => generateInvoice.mutate(params.id, {
                    /* R-409: show the issued invoice at once — button gone, "Invoiced"
                       ticked, "View invoice" link — instead of waiting for a reload. */
                    onSuccess: ({ invoiceId }) => {
                      qc.setQueryData<Quote | null>(["quotes", params.id], (prev) => (prev ? withInvoiceIssued(prev, invoiceId) : prev));
                      void qc.refetchQueries({ queryKey: ["quotes", params.id], exact: true });
                      void qc.invalidateQueries({ queryKey: ["payments"] });
                    },
                  })}
                >
                  {money.outstanding > 0 && money.outstanding === total
                    ? "Invoice now (before payment)"
                    : "Generate GST Invoice"}
                </Button>
              )}

              {/* R-446: per-period plan — no whole-term invoice button; the way to its
                  invoices is the subscription's billing schedule. */}
              {splitCycle && !money.canGenerateInvoice && (
                <Button asChild variant="default" icon="calendar">
                  <Link href={subscriptionHref({ domain: quoteSubs[0]?.domain, customer_name: quote.customer_name }) as never}>
                    Billing schedule
                  </Link>
                </Button>
              )}

              {/* R-379 (i): credit sale beside Record payment, not only in More. Same gate
                  as the menu item (showActivateOnCredit), so it vanishes once activated. */}
              {showCredit && money.stage === "unpaid" && (
                <Button variant="default" icon="check_circle" onClick={openActivateOnCredit}>
                  Activate now, pay later
                </Button>
              )}

              {money.canRecordPayment && (
                <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
                  {money.recordLabel}
                </Button>
              )}
            </div>
          </div>
        )}

        {quote.payment_status === "invoiced" && quote.invoice_id && (() => {
          const balanceRemaining = Math.max(0, total - totalReceivedSoFar);
          const hasBalance = balanceRemaining > 0;
          // "Balance" only makes sense once SOME money has landed. With ₹0
          // received the whole amount is simply "due" and the action is
          // "Record payment" — not "Record balance payment".
          const nothingPaid = totalReceivedSoFar <= 0;
          return (
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm">
                {!hasBalance ? (
                  <span className="font-medium text-emerald">
                    ✓ Complete · Invoice fully paid
                  </span>
                ) : nothingPaid ? (
                  <>
                    <span className="font-medium text-amber-ink">
                      Invoice issued · {rupee(total)} due
                    </span>{" "}
                    <span className="text-ink-3">
                      Awaiting payment. Record it when received — no new receipt voucher needed (post-invoice).
                    </span>
                  </>
                ) : (
                  <>
                    <span className="font-medium text-amber-ink">
                      Invoice issued · {rupee(balanceRemaining)} balance due
                    </span>{" "}
                    <span className="text-ink-3">
                      Customer paid {rupee(totalReceivedSoFar)} of {rupee(total)}. Record the balance when received — no new receipt voucher needed (post-invoice).
                    </span>
                  </>
                )}
              </div>
              <div className="flex gap-2">
                {hasBalance && (
                  <Button variant="primary" icon="rupee" onClick={() => setPaymentOpen(true)}>
                    {nothingPaid ? "Record payment" : "Record balance payment"}
                  </Button>
                )}
                {/* Deep-link to the one invoice, not to the list of them.
                    This button names a specific document — "View invoice
                    INV-ADPL-2026-27-0018" — and used to land on `/invoices`, leaving the
                    reader to find that row among 21. The exact destination already
                    existed (now its own page, invoiceHref → /invoices/<id>, R-218), and
                    five other places already used it (the Quotes LIST's own Invoiced
                    button, payments, the customer panel, the command palette, and the
                    invoices page's copy-link). This screen was the odd one out, which is
                    also why it read as a bug rather than a missing feature.
                    §24: when a destination exists, the button goes there. */}
                <Button asChild variant={hasBalance ? "ghost" : "primary"} icon="receipt">
                  <Link
                    href={
                      quote.invoice_id
                        ? (invoiceHref(quote.invoice_id) as any)
                        : (`/invoices` as any)
                    }
                  >
                    View invoice {quote.invoice_id}
                  </Link>
                </Button>
              </div>
            </div>
          );
        })()}

      </Card>

      {/* Line items */}
      <Card title="Line items" sub={`${items.length} item${items.length === 1 ? "" : "s"}`} flush>
        {/* Phone (S32, 1 Oct 2026): this page opens from the WhatsApp link, so it is
            read on a phone first. Five columns squeezed the item name to one word
            per line; under md each line is a row of name + amount, qty × rate below. */}
        <ul className="md:hidden divide-y divide-hairline">
          {items.map((line) => {
            const per = line.commitment ? (isAnnualTier(line.commitment) ? "/yr" : "/mo") : "";
            return (
              <li key={line.id} className="p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="text-sm font-medium min-w-0">{line.name}</div>
                  <div className="text-sm font-medium tabular-nums whitespace-nowrap">
                    {rupee(line.qty * line.rate)}<span className="text-ink-3 font-normal">{per}</span>
                  </div>
                </div>
                <div className="text-xs text-ink-3 tabular-nums mt-0.5">
                  {line.qty} × {rupee(line.rate)}{per}
                  {line.commitment && (isAnnualTier(line.commitment) ? " · Annual commitment" : " · Monthly, flexible")}
                </div>
              </li>
            );
          })}
        </ul>
        <table className="w-full hidden md:table">
          <thead className="bg-paper-2 border-b border-hairline">
            <tr>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-12">#</th>
              <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Item</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-24">Qty</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-32">Rate</th>
              <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider w-32">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((line, i) => (
              <tr key={line.id} className="border-b border-hairline last:border-0">
                <td className="p-3 text-sm text-ink-3 tabular-nums">{i + 1}</td>
                <td className="p-3 text-sm font-medium">
                  {line.name}
                  {/* ── Term, item ke NEECHE hi (Pardeep, 31 Aug 2026) ────────────
                      "item monthly hai ya yearly ye bhi show hona chahiye." ₹325 aur
                      ₹3,240 dono sahi rate hain — farak sirf ikai ka hai, aur wahi
                      farak 12× ka hai. isAnnualTier wahi boundary hai jo PDF aur
                      chitthi use karte hain; yahan apna if likhna drift ka nyota. */}
                  {line.commitment && (
                    <span className="block text-xs text-ink-3 font-normal">
                      {isAnnualTier(line.commitment)
                        ? "Annual commitment · billed per year"
                        : "Monthly, flexible · billed per month"}
                    </span>
                  )}
                </td>
                <td className="p-3 text-right tabular-nums text-sm">{line.qty}</td>
                <td className="p-3 text-right tabular-nums text-sm">
                  {rupee(line.rate)}
                  <span className="text-ink-3">{line.commitment ? (isAnnualTier(line.commitment) ? "/yr" : "/mo") : ""}</span>
                </td>
                <td className="p-3 text-right tabular-nums text-sm font-medium">
                  {rupee(line.qty * line.rate)}
                  <span className="text-ink-3 font-normal">{line.commitment ? (isAnnualTier(line.commitment) ? "/yr" : "/mo") : ""}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {/* Totals + Margin */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Totals breakdown">
          <div className="space-y-2 text-sm">
            <Row label="Subtotal" value={rupee(quote.subtotal)} />
            {discount > 0 && <Row label={`Discount (${quote.discount_pct}%)`} value={`−${rupee(discount)}`} tone="emerald" />}
            <Row label="Taxable amount" value={rupee(taxable)} />
            <Row label={`GST (${quote.tax_rate}%)`} value={rupee(tax)} />
            <div className="border-t border-hairline pt-3 flex items-baseline justify-between">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Total</span>
              <span className="font-serif text-2xl text-amber tabular-nums">
                {rupee(total)}
                {/* Flex quote ka total MAHINE ka hai — bina ikai ye wahi "per kya?" sawaal
                   chhod deta jo line items par abhi band kiya. */}
                {quote.billing_cycle === "monthly" && <span className="text-sm text-ink-3 font-sans"> /month</span>}
              </span>
            </div>
          </div>
        </Card>

        <Card title="Est. margin" sub="Post-discount · from line costs">
          <div className="text-center py-3">
            {/* A line with no cost makes the whole figure meaningless, so it says so
                rather than rendering the 100% that a ₹0 cost arithmetically produces. */}
            {!marginKnown ? (
              <>
                <div className="font-serif text-4xl leading-none mb-2 text-amber-ink">Unknown</div>
                <div className="text-[12px] leading-snug text-ink-2 px-2">
                  At least one line has no vendor cost, so the margin on this quote cannot be
                  worked out. Add those plans to the catalogue, or type the cost on the line.
                </div>
                <Button size="sm" variant="default" className="mt-3" asChild>
                  <Link href={"/items" as any}>Open catalogue</Link>
                </Button>
              </>
            ) : (
              <>
                <div className={cn(
                  "font-serif text-5xl leading-none mb-2",
                  margin.marginPct >= 18 ? "text-emerald" :
                  margin.marginPct >= 14 ? "text-amber-ink" :
                  "text-rose"
                )}>
                  {rupee(margin.margin, { compact: true })}
                </div>
                <div className="text-sm text-ink-3 mb-3 tabular-nums">{margin.marginPct}% est. margin</div>
                <MarginPill margin={margin} period="one-time" estimated />
                <div className="text-2xs text-ink-3 mt-3 tabular-nums">
                  Cost: {rupee(margin.cost)} · Price: {rupee(margin.price)}
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      {/* What still has to be created at the vendor */}
      <ProvisioningCard
        tasks={provisioningTasks}
        quoteId={quote.id}
        tenantId={quote.tenant_id}
        lines={items}
        quoteDomain={quote.domain}
        userId={me?.userId}
      />

      {/* Notes */}
      {quote.notes && (
        <Card title="Notes">
          <p className="text-sm text-ink-2 whitespace-pre-wrap">{quote.notes}</p>
        </Card>
      )}

      {/* Payment history (installments) */}
      {paymentHistory && paymentHistory.length > 0 && (
        <Card title="Payment history" sub={`${paymentHistory.length} payment${paymentHistory.length === 1 ? "" : "s"} · ${rupee(totalReceivedSoFar)} of ${rupee(total)} received`}>
          {/* Phone (S32): six columns pushed the page to 640px wide, so the whole
              quote zoomed out. Under md each payment is one row. */}
          <ul className="md:hidden -mx-1 divide-y divide-hairline">
            {paymentHistory.map((p, idx) => (
              <li key={p.id} className="px-1 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm">
                    <span className="font-medium tabular-nums">{rupee(p.amount)}</span>{" "}
                    <span className="text-ink-3 capitalize">· {p.method.replace("_", " ")}</span>
                  </div>
                  {p.status === "received" ? (
                    <Badge kind="success" dot>received</Badge>
                  ) : (
                    <Badge kind="danger" dot>refunded</Badge>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 mt-0.5">
                  <div className="text-xs text-ink-3 min-w-0 truncate">
                    #{idx + 1} · {formatDate(p.received_at)}
                    {p.reference ? <> · <span className="font-mono">{p.reference}</span></> : null}
                    <FeeNetLine payment={p} />
                  </div>
                  {p.status === "received" && me && (
                    <Button size="sm" variant="ghost" icon="file" onClick={() => setReceiptPayment(p)}>
                      Receipt
                    </Button>
                  )}
                </div>
              </li>
            ))}
            <li className="px-1 pt-2.5 flex items-baseline justify-between gap-3">
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider">Total received</span>
              <span className="text-right">
                <span className="font-serif text-lg tabular-nums text-emerald">{rupee(totalReceivedSoFar)}</span>
                <span className="block text-xs text-ink-3">
                  {totalReceivedSoFar >= total ? (
                    <span className="text-emerald">✓ Fully paid</span>
                  ) : (
                    <>Remaining <b className="text-amber-ink">{rupee(total - totalReceivedSoFar)}</b></>
                  )}
                </span>
              </span>
            </li>
          </ul>
          <div className="hidden md:block overflow-x-auto">
          <table className="w-full">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Date</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Amount</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Method</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Reference</th>
                <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Receipt</th>
              </tr>
            </thead>
            <tbody>
              {paymentHistory.map((p, idx) => (
                <tr key={p.id} className="border-b border-hairline last:border-0">
                  <td className="p-3 text-xs text-ink-2">
                    <div>{formatDate(p.received_at)}</div>
                    <div className="text-3xs text-ink-3">#{idx + 1}</div>
                  </td>
                  <td className="p-3 text-right tabular-nums text-sm font-medium">
                    {rupee(p.amount)}
                    <FeeNetLine payment={p} className="font-normal" />
                  </td>
                  <td className="p-3 text-sm capitalize">{p.method.replace("_", " ")}</td>
                  <td className="p-3 font-mono text-xs text-ink-2 truncate max-w-[180px]">{p.reference ?? "—"}</td>
                  <td className="p-3">
                    {p.status === "received" ? (
                      <Badge kind="success" dot>received</Badge>
                    ) : (
                      <Badge kind="danger" dot>refunded</Badge>
                    )}
                    {p.receipt_voucher_no && (
                      <div className="text-3xs text-ink-3 font-mono mt-0.5">{p.receipt_voucher_no}</div>
                    )}
                  </td>
                  <td className="p-3 text-right">
                    {p.status === "received" && me ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="file"
                        onClick={() => setReceiptPayment(p)}
                        title="GST-compliant receipt voucher"
                      >
                        View
                      </Button>
                    ) : (
                      <span className="text-2xs text-ink-3">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {/* Total row */}
              <tr className="bg-paper-2">
                <td className="p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Total received</td>
                <td className="p-3 text-right font-serif text-lg tabular-nums text-emerald">{rupee(totalReceivedSoFar)}</td>
                <td colSpan={4} className="p-3 text-xs text-ink-3">
                  {totalReceivedSoFar >= total ? (
                    <span className="text-emerald">✓ Fully paid</span>
                  ) : (
                    <>Remaining <b className="text-amber-ink">{rupee(total - totalReceivedSoFar)}</b></>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
          </div>
        </Card>
      )}

      {/* Receipt Voucher dialog — opens for any "received" payment */}
      {me && receiptPayment && (
        <ReceiptVoucherDialog
          open={!!receiptPayment}
          onOpenChange={(open) => !open && setReceiptPayment(null)}
          payment={receiptPayment}
          customerName={customer?.name ?? quote.customer_name}
          customerGstin={customer?.gstin}
          customerEmail={customer?.contact_email}
          tenantName={me.tenantName}
          tenantGstin={me.tenantGstin}
          tenantEmail={me.tenantEmail}
          tenantPhone={me.tenantPhone}
          tenantAddress={me.tenantAddress}
          tenantState={me.tenantState}
          interState={interState}
          quoteId={quote.id}
        />
      )}

      {/* Activity timeline */}
      <Card title="Activity" sub="Workflow history">
        <ActivityTimeline events={events} />
      </Card>

      {/* Payment dialog */}
      <RecordPaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        quoteId={quote.id}
        customerName={quote.customer_name}
        expectedAmount={total}
        alreadyReceived={totalReceivedSoFar}
        isProspect={!!quote.lead_id && !quote.customer_id}
        invoiceId={quote.invoice_id}
        customerId={quote.customer_id}
        /* So the dialog can explain WHY no subscription appeared, rather than leaving the
           operator to guess — which is exactly what a tester hit twice on 22 Aug. */
        lineItems={Array.isArray(quote.line_items) ? quote.line_items : null}
        askDomain={!quote.is_one_off}
        isRenewal={!!quote.is_renewal}
        /* The QUOTE first — it is the record being paid and the one the operator typed
           the domain into. Leaving it out is what made the field open empty on a quote
           that had the answer written on it (reported 22 Aug from Q-TEST-2026-27-0009). */
        defaultDomain={paymentDomainDefault({
          quoteDomain:    quote.domain,
          customerDomain: customer?.domain,
          leadDomain:     lead?.domain,
          /* R-379 (j): a domain already on a subscription — this quote's (credit
             activation creates one) and then the customer's others. */
          quoteSubscriptionDomains: quoteSubs.map((s) => s.domain),
          customerSubscriptionDomains: quote.customer_id
            ? (allSubs ?? []).filter((s) => s.customer_id === quote.customer_id).map((s) => s.domain)
            : [],
        })}
      />

      {/* Customer-facing quote preview */}
      <QuotePreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        tenantName={me?.tenantName    ?? "Workspace"}
        tenantGstin={me?.tenantGstin}
        tenantEmail={me?.tenantEmail}
        tenantPhone={me?.tenantPhone}
        tenantAddress={me?.tenantAddress}
        quoteId={quote.id}
        customerName={quote.customer_name}
        contactName={contact.contactName}
        contactEmail={contact.contactEmail}
        contactPhone={contact.contactPhone}
        lineItems={items}
        subtotal={quote.subtotal}
        discountPct={quote.discount_pct}
        discount={discount}
        taxable={taxable}
        taxRate={quote.tax_rate}
        tax={tax}
        total={total}
        interState={interState}
        placeOfSupply={pos.label}
        isExport={pos.isExport}
        /* R-527: without it the preview fell back to the line's commitment and printed a
           quarterly quote as "billed yearly" with the year's CGST/SGST. */
        billingCycle={quote.billing_cycle as BillingCycle}
        validityDays={
          quote.expires_date
            ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
            : 30
        }
        notes={quote.notes ?? ""}
        isProspect={!!quote.lead_id}
      />

      {/* Send-via-email dialog — replaces legacy mailto: handler */}
      <SendQuoteDialog
        open={sendOpen}
        onOpenChange={setSendOpen}
        quoteId={quote.id}
        customerName={quote.customer_name}
        defaultRecipient={customer?.contact_email ?? null}
        alreadySent={quote.status === "sent" || quote.status === "viewed"}
        /* The quote's own figures, so the dialog can state what sending commits you to
           — the amount that reaches the customer, whether the total matches its own GST,
           and how long the price stands. Passing null where the quote is genuinely
           silent, never a zero: an invented figure in that list is worse than no list. */
        amount={quote.amount}
        subtotal={quote.subtotal}
        taxRate={quote.tax_rate}
        validityDays={
          quote.expires_date
            ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
            : null
        }
      />

      {/* Approve / reject drawer */}
      {approvalEconomics && approvalNeed && approvalRec && me && (
        <ApprovalDrawer
          open={approvalOpen}
          onOpenChange={setApprovalOpen}
          quoteId={quote.id}
          quoteLabel={quote.id}
          economics={approvalEconomics}
          requirement={approvalNeed}
          record={approvalRec}
          viewer={{ id: me.userId, role: me.role }}
        />
      )}

      {/* Send-via-WhatsApp dialog — pre-fills the customer's contact phone
          (or leaves blank for lead-mode quotes — user can type it in)
          and a templated opening line with the quote ID + accept link.
          attachQuoteId enables a PDF-attach checkbox in the dialog so the
          customer receives the actual quote PDF in WhatsApp, not just a
          link. */}
      {whatsOpen && (
        <SendWhatsAppDialog
          open={whatsOpen}
          onOpenChange={setWhatsOpen}
          defaultTo={recipientPhone}
          defaultText={
            `Hi ${quote.customer_name},\n\n` +
            `Your quote ${quote.id} for ${rupee(quote.amount)} is attached. ` +
            `You can also review and accept it online:\n` +
            `${typeof window !== "undefined" ? window.location.origin : ""}/quote/${quote.id}/accept?t=${encodeURIComponent(quote.public_token)}\n\n` +
            /* Sign-off ka fallback HATA diya gaya, badla nahi. Pehle yahan
               `?? "Excel Technologies"` tha — yaani `me` load na hone par ye WhatsApp
               grahak ke paas ek AISI company ke naam se jaata jo use bheji hi nahi.
               Wahi shreni jo lib/invoices/supplier-identity.ts poore comment ke saath
               likhti hai: galat company ka naam likhne se behtar hai naam na likhna.
               Naam pata ho to sign hota hai; na ho to line hi nahi aati. */
            (me?.tenantName ? `— ${me.tenantName}` : "")
          }
          title={`Send quote ${quote.id} via WhatsApp`}
          attachQuoteId={quote.id}
          attachQuoteLabel={`Quote-${quote.id}.pdf`}
          // Preview the PDF in a new tab — uses the SAME renderer as
          // Download PDF + the server-side WhatsApp send path, so what
          // Pardeep reviews is exactly what the customer will receive.
          onPreviewAttachment={async () => {
            const { previewQuotePDF } = await import("@/lib/pdf");
            await previewQuotePDF({
              tenantName:    me?.tenantName    ?? "Workspace",
              tenantGstin:   me?.tenantGstin,
              tenantEmail:   me?.tenantEmail,
              tenantPhone:   me?.tenantPhone,
              tenantAddress: me?.tenantAddress,
              tenantLogo:    await logoDataUri(me?.tenantLogoUrl),
              quoteId:       quote.id,
              customerName:  quote.customer_name,
              ...contact,
              createdDate:   quote.created_at,
              expiresDate:   quote.expires_date,
              validityDays:  quote.expires_date
                ? Math.max(1, daysBetween(new Date(quote.created_at), quote.expires_date))
                : 30,
              lineItems:     items,
              subtotal:      quote.subtotal,
              discountPct:   quote.discount_pct,
              discount,
              taxable,
              taxRate:       quote.tax_rate,
              tax,
              total,
              interState,
              placeOfSupply: pos.label,
              isExport:      pos.isExport,
              notes:         quote.notes ?? "",
              isRenewal:     quote.is_renewal,
            });
          }}
          related={{
            quoteId:    quote.id,
            customerId: quote.customer_id ?? undefined,
            leadId:     quote.lead_id ?? undefined,
          }}
        />
      )}

      {/* "Can't delete — why?" — shows the related records that block deletion
          (the invoice + recorded payments) so the owner knows what to void first. */}
      <Dialog open={blockedOpen} onOpenChange={setBlockedOpen}>
        <DialogContent className="max-w-[480px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Icon name="lock" size={18} className="text-amber" />
              This quote can't be deleted yet
            </DialogTitle>
            <DialogDescription>
              Money is recorded against this quote. Deleting it would erase the payment ledger and audit trail.
              Clear these related records first:
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {quote.invoice_id && (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-hairline p-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <Icon name="receipt" size={16} className="text-emerald shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-ink truncate">Invoice {quote.invoice_id}</div>
                    <div className="text-2xs text-ink-3">Issue a credit note or void it first</div>
                  </div>
                </div>
                <Button asChild variant="ghost" size="sm" icon="external" className="shrink-0">
                  <Link href={invoiceHref(quote.invoice_id) as any}>Open</Link>
                </Button>
              </div>
            )}

            {receivedPayments.length > 0 && (
              <div className="rounded-lg border border-hairline p-3">
                <div className="flex items-center gap-2.5 mb-1.5">
                  <Icon name="rupee" size={16} className="text-emerald shrink-0" />
                  <div className="text-sm font-medium text-ink">
                    {receivedPayments.length} payment{receivedPayments.length === 1 ? "" : "s"} · {rupee(totalReceivedSoFar)} received
                  </div>
                </div>
                <ul className="space-y-0.5 pl-6">
                  {receivedPayments.map((p, i) => (
                    <li key={p.id} className="text-2xs text-ink-3 tabular-nums">
                      #{i + 1} · {rupee(p.amount)} · {p.method.replace("_", " ")} · {formatDate(p.received_at)}
                    </li>
                  ))}
                </ul>
                <div className="text-2xs text-ink-3 mt-1.5 pl-6">Refund or void these first (from Payment history).</div>
              </div>
            )}

            {!quote.invoice_id && receivedPayments.length === 0 && (
              <p className="text-sm text-ink-3">{deleteBlock}</p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="primary" onClick={() => setBlockedOpen(false)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <RejectQuoteDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        quoteId={quote.id}
        leadOffer={leadOffer}
        pending={markRejected.isPending}
        onConfirm={(input) => markRejected.mutate(input)}
      />

      {/* Reusable confirm dialog (replaces native window.confirm, which is
          suppressed in some embeds and silently returns false). */}
      <Dialog open={!!confirm} onOpenChange={(o) => { if (!o) setConfirm(null); }}>
        <DialogContent className="max-w-[440px]">
          {confirm && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <Icon name={confirm.icon} size={18} className={confirm.danger ? "text-rose" : "text-amber"} />
                  {confirm.title}
                </DialogTitle>
                <DialogDescription>{confirm.body}</DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant={confirm.danger ? "danger" : "primary"}
                  icon={confirm.icon}
                  loading={deleteQuote.isPending || reopenQuote.isPending}
                  onClick={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
                >
                  {confirm.confirmLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ============================================================
// Row helper
// ============================================================
function Row({ label, value, tone }: { label: string; value: string; tone?: "emerald" | "rose" }) {
  return (
    <div className="flex justify-between items-baseline">
      <span className="text-ink-3">{label}</span>
      <span className={cn(
        "tabular-nums",
        tone === "emerald" && "text-emerald",
        tone === "rose" && "text-rose"
      )}>{value}</span>
    </div>
  );
}
