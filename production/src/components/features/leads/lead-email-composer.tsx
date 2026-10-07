"use client";

/**
 * Write the FIRST email to a lead, from inside the app.
 *
 * ─── WHY NOT REUSE ReplyComposer ────────────────────────────────────────────
 * That one is bound to an enquiry — `enquiryId`, `useEnquiryReplies`, and an
 * "already replied?" window judged against when the mail arrived. None of that exists here:
 * the customer has not written, so there is nothing to reply to and nothing to be a
 * duplicate of. Threading a second mutation and a second notion of "already sent" through
 * it would contort a working component rather than reuse it.
 *
 * ─── WHY IT REPLACES THE GMAIL HAND-OFF ─────────────────────────────────────
 * The Email button used to open Gmail compose in a new tab and log "Emailed x@y · subject".
 * The text went nowhere, so the lead's Email thread could show the customer's words and
 * only a stub for ours. A half thread reads as data loss, which is worse than the honest
 * note it replaced. Sending from here means the body is stored and both sides are real.
 *
 * The recipient is displayed and NOT editable — /api/leads/[id]/email ignores any address
 * in the body and reads it off the lead row. An editable field would imply otherwise.
 */

import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

export interface LeadEmailComposerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  company: string;
  /** Shown so the operator can see where it goes. Never sent — the route reads the lead. */
  toEmail: string;
  contactName: string | null;
  plan: string | null;
  /** Signed off with the workspace name, matching what the old Gmail draft used. */
  senderName: string | null;
}

/** The same opener the Gmail hand-off used, so nobody's habits change with the plumbing. */
export function defaultSubject(company: string): string {
  return `About your inquiry · ${company}`;
}

export function defaultBody(contactName: string | null, plan: string | null, senderName: string | null): string {
  return `Hi ${contactName ?? "there"},\n\nThanks for your interest in ${plan ?? "our services"}. `
    + `Let me know a good time to connect.\n\n— ${senderName ?? "your team"}`;
}

export function LeadEmailComposer({
  open, onOpenChange, leadId, company, toEmail, contactName, plan, senderName,
}: LeadEmailComposerProps) {
  const [subject, setSubject] = React.useState(() => defaultSubject(company));
  const [body, setBody]       = React.useState(() => defaultBody(contactName, plan, senderName));

  /* A different lead gets a fresh box. Without this the previous lead's half-typed message
     sits there under somebody else's address — the same trap ReplyComposer guards. */
  React.useEffect(() => {
    setSubject(defaultSubject(company));
    setBody(defaultBody(contactName, plan, senderName));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/leads/${encodeURIComponent(leadId)}/email`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ subject: subject.trim(), body: body.trim() }),
      });
      const json = await res.json() as { ok?: boolean; error?: string; stub?: boolean; logged?: boolean };
      if (!res.ok || json.error) throw new Error(json.error ?? "The email could not be sent.");
      return json;
    },
    onSuccess: (r) => {
      /* The thread reads inbound_emails; the timeline reads lead_activities. Both refresh so
         the message the operator just sent is visible without a reload. */
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["lead-activities", leadId] });

      if (r.stub) {
        /* Never a plain tick for mail that did not leave. */
        toast.error("No email provider is configured, so nothing was sent.", { description: "Open Settings → Email and connect one, then send again." });
        return;
      }
      if (r.logged === false) {
        /* Sent but not filed — say both halves rather than implying they both worked. */
        toast.success("Email sent — but it could not be filed on the lead, so it may not appear in the thread.");
      } else {
        toast.success(`Email sent to ${toEmail} — the text is saved on the lead.`);
      }
      onOpenChange(false);
    },
    onError: (e) => toastError(e, { fallback: "Could not send the email.", description: "Nothing was sent. Your text is still here — try again." }),
  });

  const canSend = subject.trim().length > 0 && body.trim().length > 0 && !send.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Email {company}</DialogTitle>
          <DialogDescription>
            Sent from your connected account, and the text is kept on the lead — so it shows
            up in the Email thread.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md bg-paper-2 px-2.5 py-2 text-xs">
            <Icon name="mail" size={13} className="shrink-0 text-ink-3" />
            <span className="text-ink-3">To</span>
            <span className="truncate font-mono text-ink-2">{toEmail}</span>
          </div>

          <FormField label="Subject" required htmlFor="lead-email-subject">
            <Input
              id="lead-email-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={300}
            />
          </FormField>

          <FormField label="Message" required htmlFor="lead-email-body">
            <textarea
              id="lead-email-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={8}
              maxLength={20_000}
              className="w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-amber"
            />
          </FormField>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon="send"
            loading={send.isPending}
            disabled={!canSend}
            onClick={() => send.mutate()}
          >
            Send email
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
