/**
 * Inbound emails — the Enquiries Inbox data layer.
 *
 * Fetches tenant-scoped inbound emails via server endpoint /api/inbound-emails
 * and handles atomic lead conversion.
 */
"use client";

import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { InboundEmailRow } from "@/lib/supabase/database.types";
import { flattenPages, type InboxCursor } from "@/lib/queries/keyset";
import { fetchInboxPage, type InboxPage } from "@/lib/inbound/list-load-state";

/**
 * How often the inbox looks for new mail.
 *
 * Reported 22 Aug 2026 as "email receive me bahut time lagta hai". Inbound mail is
 * not polled from Gmail — it is PUSHED, customer → Gmail → forwarding rule →
 * inbound-parse provider → POST /api/webhooks/inbound-email → inbound_emails. Every
 * hop to the database takes seconds. The delay was entirely in the last one: this
 * hook declared no refetchInterval, so once the page was open a new email could sit
 * in the database indefinitely and never appear on screen.
 *
 * 20s, between two real limits: above about a minute a customer's reply feels lost,
 * and below about five seconds this is a database query per open tab for no
 * perceptible gain. `lib/queries/whatsapp.ts` already sits at 10-15s for the same
 * reason and is the precedent.
 */
const INBOX_REFETCH_MS = 20_000;

export function useInboundEmails() {
  return useQuery({
    queryKey: ["inbound-emails"],
    /* R-363: React Query's signal goes to fetch, so a superseded poll is cancelled. */
    queryFn: ({ signal }): Promise<InboundEmailRow[]> => fetchInboxPage(null, signal).then((p) => p.rows),
    refetchInterval: INBOX_REFETCH_MS,
    /* Overridden LOCALLY, not globally. query-provider.tsx turns this off for the
       whole app and is right to — a settings screen that refetches every time you
       alt-tab is noise. An inbox is the exception: the commonest real motion is
       reading mail in Gmail and switching to this tab expecting to see it. */
    refetchOnWindowFocus: true,
    /* The global staleTime is 30s, which would let a poll be answered from cache and
       show nothing new — the same bug wearing a shorter delay. An inbox has no use
       for a cached answer; that is what the interval above is for. */
    staleTime: 0,
    /* A hidden tab does not poll (S16). It used to, every 20s, for every open tab all
       day. Switching back is already covered: refetchOnWindowFocus above fetches the
       moment the tab is shown, so mail that arrived while hidden still appears at once. */
    refetchIntervalInBackground: false,
  });
}

/** The paged inbox's cache key. Under ["inbound-emails"], so every invalidation of the
 *  flat list reaches it too. */
export const INBOX_PAGES_KEY = ["inbound-emails", "pages"] as const;

export type InboundEmailPage = InboxPage;

/**
 * The Enquiries inbox, in keyset pages (S37).
 *
 * Page 1 is exactly what useInboundEmails() returns — the newest INBOX_LIST_MAX_ROWS — so a
 * workspace under that many mails sees no difference at all. Beyond it, "Load older mail"
 * fetches the next page instead of the mail simply not existing on screen. Same polling
 * rules as the flat hook; a poll refetches every page already loaded, in order, each from
 * the previous page's fresh cursor, so a page boundary moves with new mail instead of
 * repeating or dropping a row.
 *
 * `data` is the flattened list (first occurrence wins), so a caller that read the flat
 * hook's array reads this one the same way.
 */
export function useInboundEmailPages() {
  const q = useInfiniteQuery({
    queryKey: INBOX_PAGES_KEY,
    initialPageParam: null as InboxCursor | null,
    /* R-363: signal passed through (abort stays an abort); lib/inbound/list-load-state.ts. */
    queryFn: ({ pageParam, signal }) => fetchInboxPage(pageParam, signal),
    getNextPageParam: (last) => last.next,
    refetchInterval: INBOX_REFETCH_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchIntervalInBackground: false,
  });
  const data = React.useMemo(
    () => (q.data ? flattenPages(q.data.pages, (r) => r.id) : undefined),
    [q.data],
  );
  return { ...q, data };
}

/** Apply one row edit to every loaded page of the paged inbox. */
function mapInboxPages(
  data: InfiniteData<InboundEmailPage, InboxCursor | null> | undefined,
  fn: (r: InboundEmailRow) => InboundEmailRow,
): InfiniteData<InboundEmailPage, InboxCursor | null> | undefined {
  if (!data) return data;
  return { ...data, pages: data.pages.map((p) => ({ ...p, rows: p.rows.map(fn) })) };
}

/**
 * Read, star, snooze, archive.
 *
 * ─── OPTIMISTIC, BECAUSE THESE ARE THE CLICKS A REP MAKES ALL DAY ───────────
 * Starring and archiving happen dozens of times an hour. A round-trip before the row
 * moves makes the inbox feel broken, and a rep who is not sure the click registered
 * clicks again. onMutate moves it immediately; onError puts it back and says so, so
 * a failed archive can never look like a successful one.
 */
export function useSetInboundState() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      read?: boolean;
      starred?: boolean;
      /** ISO instant, or null to wake it now. */
      snoozeUntil?: string | null;
      archived?: boolean;
    }) => {
      const { id, ...body } = input;
      const res = await fetch(`/api/inbound-emails/${id}/state`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not update this email");
      }
      return res.json();
    },

    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["inbound-emails"] });
      const previous = qc.getQueryData<InboundEmailRow[]>(["inbound-emails"]);
      const previousPages = qc.getQueryData<InfiniteData<InboundEmailPage, InboxCursor | null>>(INBOX_PAGES_KEY);
      const now = new Date().toISOString();
      const edit = (r: InboundEmailRow): InboundEmailRow => {
        if (r.id !== input.id) return r;
        return {
          ...r,
          /* Mirrors the server: a first-open stamp never overwrites an earlier one. */
          read_at: input.read === true ? (r.read_at ?? now)
                 : input.read === false ? null
                 : r.read_at,
          starred:       input.starred ?? r.starred,
          snoozed_until: input.snoozeUntil !== undefined ? input.snoozeUntil : r.snoozed_until,
          archived_at:   input.archived === undefined ? r.archived_at
                       : input.archived ? now : null,
        };
      };
      qc.setQueryData<InboundEmailRow[]>(["inbound-emails"], (rows) => (rows ?? []).map(edit));
      /* The Enquiries page reads the PAGED cache (S37); the lead drawer the flat one. Both
         move at once, so neither screen can show the old state while the other shows the new. */
      qc.setQueryData<InfiniteData<InboundEmailPage, InboxCursor | null>>(INBOX_PAGES_KEY, (d) => mapInboxPages(d, edit));
      return { previous, previousPages };
    },

    onError: (err, _input, ctx) => {
      if (ctx?.previous) qc.setQueryData(["inbound-emails"], ctx.previous);
      if (ctx?.previousPages) qc.setQueryData(INBOX_PAGES_KEY, ctx.previousPages);
      toastError(err, {
        description: "Nothing was changed — the email is back where it was.",
      });
    },

    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
    },
  });
}

export function useConvertInboundToLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const res = await fetch(`/api/inbound-emails/${id}/convert`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not convert email to lead");
      }
      const data = await res.json();
      return data.leadId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead created from email");
    },
    onError: (err) => toastError(err),
  });
}

/**
 * What has already been sent in answer to one enquiry.
 *
 * Read from email_log through the route, never from a flag on the row — see
 * lib/inbound/replied.ts for why. Disabled until an enquiry is selected, so opening the
 * page does not fire a request per email in the list.
 */
export function useEnquiryReplies(enquiryId: string | null) {
  return useQuery({
    queryKey: ["enquiry-replies", enquiryId],
    enabled: enquiryId != null,
    queryFn: async (): Promise<{ sentAt: string; status: string; subject: string | null }[]> => {
      const res = await fetch(`/api/inbound-emails/${enquiryId}/reply`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not check what was already sent");
      }
      const json = await res.json();
      return json.replies ?? [];
    },
  });
}

/**
 * Send a reply to an enquiry.
 *
 * ─── NOT OPTIMISTIC, UNLIKE STAR AND ARCHIVE ────────────────────────────────
 * Those move a row and are undoable. This puts an email in a stranger's inbox and cannot
 * be recalled, so the button stays in its loading state until the server says the send
 * happened. A composer that clears itself on click would, on a failed send, leave a rep
 * looking at an empty box believing the customer had been answered.
 */
export function useSendEnquiryReply() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      id: string;
      subject: string;
      body: string;
      /**
       * The AI draft this send started from, when it did.
       *
       * Passed straight through to the route, which stores the pair so somebody can later
       * read what reps keep changing. Nothing downstream trusts it — see the route's own
       * comment on ai_draft_body — and omitting it simply means no row is recorded.
       */
      ai_draft_subject?: string;
      ai_draft_body?: string;
    }) => {
      const { id, ...body } = input;

      let res: Response;
      try {
        res = await fetch(`/api/inbound-emails/${id}/reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (e) {
        /* ─── NO ANSWER IS NOT THE SAME AS "IT FAILED" ─────────────────────────
           This happened on 18 Aug 2026 and is the reason the branch exists. Pardeep
           pressed Send, the server sent the mail through Gmail (email_log 04:15:18 UTC,
           status sent, id 1a01314af035739c) — and the connection dropped before the
           reply came back. The screen said "The reply did not send… your text is still
           in the box", which is an invitation to send a second copy of an email the
           customer already had.

           A thrown fetch means the outcome is UNKNOWN. Saying so is the only honest
           answer, and it is the opposite instruction: go and look, do not resend. */
        throw new UnknownSendOutcome(e instanceof Error ? e.message : "connection lost");
      }

      const json = await res.json().catch(() => ({}));
      /* The server answered — this IS a known failure, and nothing was sent: the route
         returns 502 only after sendEmail reported failure. */
      if (!res.ok) throw new Error(json.error || "Could not send this reply");
      return json as { ok: true; stub: boolean; provider: string };
    },
    onSuccess: (result, input) => {
      qc.invalidateQueries({ queryKey: ["enquiry-replies", input.id] });
      if (result.stub) {
        /* §24 — the honest version. No provider is configured, so nothing left. Saying
           "Sent" here is the exact lie this codebase keeps hunting. */
        toast.warning("Nothing was actually sent — no email provider is connected.", {
          description: "The reply was recorded but no mail left. Connect Gmail or Resend in Settings, then send it again.",
        });
      } else {
        toast.success("Reply sent.");
      }
    },
    onError: (e: Error, input) => {
      if (e instanceof UnknownSendOutcome) {
        /* Deliberately NOT an error toast and NOT "did not send". The mail may well be
           in the customer's inbox. §24 — what happened, why, and the next step, which
           here is CHECK rather than retry. */
        qc.invalidateQueries({ queryKey: ["enquiry-replies", input.id] });
        toast.warning("The connection dropped — we do not know if this went out.", {
          description: "It may already be with the customer. Reload this enquiry: if it says you have replied, it was sent. Do not send again until you have checked.",
        });
        return;
      }
      toast.error("The reply did not send.", {
        description: `${e.message} Your text is still in the box — nothing was lost.`,
      });
    },
  });
}

/**
 * The request never got an answer, so the send may or may not have happened.
 *
 * A distinct class rather than a message string because the two cases need opposite
 * advice — "try again" for a refusal the server stated, "go and check" for a silence —
 * and a string comparison is how that distinction quietly rots.
 */
export class UnknownSendOutcome extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "UnknownSendOutcome";
  }
}

/**
 * Which address this workspace's mail actually leaves from.
 *
 * Cached for the session — it changes only when somebody reconnects an account in
 * Settings, and asking on every render would be a request per enquiry click.
 */
export function useEmailSender() {
  return useQuery({
    queryKey: ["email-sender"],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<{ provider: string | null; address: string | null }> => {
      const res = await fetch("/api/settings/email-sender");
      if (!res.ok) return { provider: null, address: null };
      return res.json();
    },
  });
}
