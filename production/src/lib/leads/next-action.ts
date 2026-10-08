/**
 * The lead drawer's ONE primary call-to-action — "what to do next".
 *
 * Lifted out of LeadDetailSheet (then in (app)/leads/page.tsx) on 28 Sep 2026 (S35) as a
 * pure function. It used to be an IIFE that closed over router pushes and dialog openers,
 * so the rules could only be checked by clicking. It now returns WHAT the button is and
 * WHERE it goes (`target`); the drawer maps the target to the handler. Rules, order and
 * copy are unchanged — next-action.test.ts pins every branch.
 *
 * Smart "next action" suggestion — tells the rep THE one thing to do next instead of
 * making them stare at 10 buttons trying to decide. Pattern from Linear / Notion: cut
 * decision fatigue by surfacing the most likely next move, ranked by lead state + quote
 * age + payment status.
 */
import type { Lead } from "@/lib/supabase/database.types";
import type { ThreadSummary } from "@/lib/leads/email-thread";
import { formatDate } from "@/lib/utils";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";

export type NextActionTarget =
  /** changeStage(lead, stage) */
  | { kind: "stage"; stage: Lead["stage"] }
  /** close the drawer, then router.push(href) */
  | { kind: "go"; href: string }
  /** the drawer's handleSendQuote (licence quote, or the project quotation) */
  | { kind: "send_quote" }
  /** the drawer's handleEmail (in-app composer) */
  | { kind: "email" }
  /** the native dialer */
  | { kind: "tel"; phone: string | null };

export interface NextAction {
  label: string;
  icon: string;
  tone: "amber" | "rose" | "emerald" | "indigo";
  target: NextActionTarget;
  hint?: string;
  help?: string;
}

export interface NextActionInput {
  lead: Pick<Lead, "stage" | "enquiry_type" | "project_id" | "contact_phone">;
  /** The project quotation a custom-software lead was quoted on (useLeadProject). */
  leadProject: { title: string; status: string; total_amount: number | null } | null | undefined;
  /** Newest quote sent to this lead (quotes are sorted newest first). */
  latestQuoteForAction:
    | { id: string; status: string | null; payment_status?: string | null; payment_amount?: number | null; invoice_id?: string | null }
    | undefined;
  /** Whole days since that quote was created, or null when there is no quote. */
  quoteAgeDays: number | null;
  threadSummary: Pick<ThreadSummary, "total" | "latest">;
  activities: readonly unknown[];
}

export function nextActionFor(input: NextActionInput): NextAction | null {
  const { lead, leadProject, latestQuoteForAction, quoteAgeDays, threadSummary, activities } = input;
  // 0. Project lead: its quotation lives in Project Sales. Accepted there = Won here.
  if (lead.enquiry_type === "project" && lead.project_id) {
    if (leadProject && (leadProject.status === "active" || leadProject.status === "completed") && lead.stage !== "won") {
      return {
        label: "Project accepted · mark Won",
        icon: "check",
        tone: "emerald",
        target: { kind: "stage", stage: "won" },
        hint: `${leadProject.title} · ₹${(leadProject.total_amount ?? 0).toLocaleString("en-IN")}`,
      };
    }
    return {
      label: "Open project quotation",
      icon: "file",
      tone: "indigo",
      target: { kind: "go", href: `/projects/${lead.project_id}` },
      hint: leadProject ? `${leadProject.title} · ${leadProject.status === "quoted" ? "awaiting acceptance" : leadProject.status}` : undefined,
    };
  }
  // 1. Paid quote → issue invoice / view invoice / record remainder
  if (latestQuoteForAction?.payment_status === "received") {
    return {
      label: "Issue GST invoice",
      icon: "receipt",
      tone: "emerald",
      target: { kind: "go", href: `/quotes/${latestQuoteForAction.id}` },
      hint: `Paid · ₹${(latestQuoteForAction.payment_amount ?? 0).toLocaleString("en-IN")}`,
    };
  }
  if (latestQuoteForAction?.payment_status === "invoiced") {
    /* A button labelled "View invoice" goes to the INVOICE. invoiceHref() opens its
       own page (R-218), and the quote id is only used when there is no invoice id to open,
       which should not happen at payment_status `invoiced` but is not worth crashing
       over if it does. */
    const invoiceId = latestQuoteForAction.invoice_id;
    return {
      label: invoiceId ? "View invoice" : "Open quote",
      icon: "receipt",
      tone: "emerald",
      target: { kind: "go", href: invoiceId ? invoiceHref(invoiceId) : `/quotes/${latestQuoteForAction.id}` },
      hint: invoiceId ? `Invoiced · ${invoiceId}` : "Already invoiced",
    };
  }
  if (latestQuoteForAction?.payment_status === "partial") {
    return {
      label: "Record remaining payment",
      icon: "rupee",
      tone: "amber",
      target: { kind: "go", href: `/quotes/${latestQuoteForAction.id}` },
      hint: "Partial received",
    };
  }
  // 2. Draft quote exists but was never sent → prompt to SEND it (open the draft).
  //    A draft has no sent-date, so the age-based copy below would be misleading.
  if (latestQuoteForAction?.status === "draft") {
    return {
      label: "Send draft quote",
      icon: "send",
      tone: "amber",
      target: { kind: "go", href: `/quotes/${latestQuoteForAction.id}` },
      hint: "Not sent yet",
    };
  }
  // 3. Quote SENT but not yet paid → the goal now is getting PAID, so the primary
  //    action is "Record payment" (→ the quote hub). Chasing is the header
  //    WhatsApp/Call buttons; revising is the footer "Revise & resend".
  if (latestQuoteForAction && quoteAgeDays !== null) {
    const overdue = quoteAgeDays > 7;
    const ageText = quoteAgeDays === 0 ? "Sent today" : `Sent ${quoteAgeDays}d ago`;
    return {
      label: "Record payment",
      icon: "rupee",
      tone: overdue ? "rose" : "amber",
      target: { kind: "go", href: `/quotes/${latestQuoteForAction.id}` },
      hint: overdue ? `${ageText} · overdue — chase them` : ageText,
      help: "Quote is sent. Record the payment here the moment it lands. To chase, use the WhatsApp/Call buttons above; to change the quote, use Revise & resend below.",
    };
  }
  // 4. No quote yet → by stage
  if (lead.stage === "lost") {
    return { label: "Re-engage · send new quote", icon: "send", tone: "indigo", target: { kind: "send_quote" } };
  }
  if (lead.stage === "won") {
    return { label: "Upsell · new quote", icon: "send", tone: "indigo", target: { kind: "send_quote" } };
  }
  /* THEY WROTE LAST AND NOBODY HAS ANSWERED. Checked before every stage rule below,
     because it outranks all of them: an unanswered customer is the most expensive thing
     on this screen and no stage column records it. `latest.direction` is the whole test.

     Reported 23 Aug 2026 from a screenshot: a lead with 15 emails in the thread showed
     "Call now · first contact" as its biggest, loudest button, because the rules below
     read `lead.stage` and nothing else. */
  if (threadSummary.latest?.direction === "inbound") {
    return {
      label: "Reply — they are waiting",
      icon: "mail",
      tone: "amber",
      target: { kind: "email" },
      hint: formatDate(threadSummary.latest.at ?? ""),
      /* NO `help` line, and that is a fix rather than an omission — this CTA renders ON
         the Email tab, directly above the thread it would have pointed at. */
    };
  }
  /* "First contact" now means it: nothing sent, nothing received, nothing logged. */
  if (lead.stage === "new" && lead.contact_phone && threadSummary.total === 0 && activities.length === 0) {
    return { label: "Call now · first contact", icon: "mobile", tone: "amber", target: { kind: "tel", phone: lead.contact_phone }, hint: lead.contact_phone ?? undefined };
  }
  /* Contact has happened and no quote exists. The gap is the money step, not another hello. */
  if (lead.stage === "new") {
    return {
      label: "Send quote",
      icon: "send",
      tone: "amber",
      target: { kind: "send_quote" },
      help: "You have already been in touch and there is no quote yet, so this is the step that is missing.",
    };
  }
  if (lead.stage === "trial") {
    return { label: "Convert trial · send quote", icon: "send", tone: "amber", target: { kind: "send_quote" } };
  }
  // Default: send quote (covers contact/demo stages with no quote yet)
  return { label: "Send quote", icon: "send", tone: "amber", target: { kind: "send_quote" } };
}
