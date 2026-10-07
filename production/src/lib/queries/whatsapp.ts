/**
 * WhatsApp — TanStack Query hooks for the /whatsapp Inbox page.
 *
 * Two views:
 *   - useWhatsAppConversations() — list of contacts with last message
 *   - useWhatsAppThread(phone)   — full message log for one contact
 *
 * Mutations:
 *   - useSendWhatsApp() — calls /api/whatsapp/send
 */

"use client";

import * as React from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Json, WhatsAppMessageRow } from "@/lib/supabase/database.types";
import { flattenPages } from "@/lib/queries/keyset";

/** One contact's last message + count of inbound messages we haven't
 *  marked read yet (treat anything inbound as unread for first cut). */
export interface WhatsAppConversation {
  contact_phone:    string;
  last_message:     WhatsAppMessageRow;
  last_inbound_at:  string | null;
  unread_count:     number;
  message_count:    number;
}

/** The keyset cursor for list_whatsapp_threads(), exactly as the server returned it. */
export interface WhatsAppThreadCursor {
  last_at: string;
  contact_phone: string;
}

export interface WhatsAppThreadPage {
  rows: WhatsAppConversation[];
  next_cursor: WhatsAppThreadCursor | null;
}

/** Conversations per page. Enough to fill the rail; "Load more" fetches the next page. */
export const WHATSAPP_THREADS_PAGE = 50;

/**
 * The inbox's conversations, one row per contact, in keyset pages (S37).
 *
 * ─── WHAT THIS REPLACED ─────────────────────────────────────────────────────
 * It fetched the newest 500 MESSAGES and grouped them in the browser. So a contact whose
 * last message was the 501st did not exist in the inbox at all, and every unread and
 * message count was a count of that window, not of the conversation. list_whatsapp_threads()
 * (migration 20260928200000) groups over ALL of the tenant's messages in the database and
 * returns one page of conversations, newest activity first — the same shape and the same
 * order as before, without the window.
 *
 * `data` is the flattened list, so the page reads it exactly as it read the old array. A
 * poll refetches every loaded page in order, each from the previous page's fresh cursor.
 */
export function useWhatsAppConversations() {
  const q = useInfiniteQuery({
    queryKey: ["whatsapp", "conversations"],
    initialPageParam: null as WhatsAppThreadCursor | null,
    queryFn: async ({ pageParam }): Promise<WhatsAppThreadPage> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("list_whatsapp_threads", {
        p_cursor: pageParam as unknown as Json,
        p_limit: WHATSAPP_THREADS_PAGE,
      });
      if (error) throw error;
      const page = (data ?? { rows: [], next_cursor: null }) as unknown as WhatsAppThreadPage;
      return { rows: page.rows ?? [], next_cursor: page.next_cursor ?? null };
    },
    getNextPageParam: (last) => last.next_cursor,
    // Realtime poll — 15s feels live enough without hammering Supabase
    refetchInterval: 15_000,
  });
  const data = React.useMemo(
    () => (q.data ? flattenPages(q.data.pages, (c) => c.contact_phone) : undefined),
    [q.data],
  );
  return { ...q, data };
}

/** How many of the latest messages one thread poll loads. */
export const WHATSAPP_THREAD_MAX = 200;

export function useWhatsAppThread(contactPhone: string | null) {
  return useQuery({
    queryKey: ["whatsapp", "thread", contactPhone ?? "none"],
    enabled:  Boolean(contactPhone),
    queryFn: async (): Promise<WhatsAppMessageRow[]> => {
      const supabase = createClient();
      /* S16: bounded. This polls every 10s and used to fetch the WHOLE history with
         this number each time. Newest WHATSAPP_THREAD_MAX first, then flipped back to
         oldest-first, which is the order the thread renders in. */
      const { data, error } = await supabase
        .from("whatsapp_messages")
        .select("*")
        .eq("contact_phone", contactPhone!)
        .order("created_at", { ascending: false })
        .limit(WHATSAPP_THREAD_MAX);
      if (error) throw error;
      return ((data ?? []) as WhatsAppMessageRow[]).reverse();
    },
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

interface SendInput {
  to:   string;
  text?: string;
  template?: { name: string; language: string; components?: unknown[] };
  /** Quote ID to render PDF for + attach to the message. Server renders
   *  the PDF, uploads to Meta /media, then sends type=document with the
   *  text becoming the caption. */
  attach_quote_id?: string;
  related?: { leadId?: string; quoteId?: string; customerId?: string };
}

export function useSendWhatsApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SendInput) => {
      const res  = await fetch("/api/whatsapp/send", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(input),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error ?? "Send failed");
      return json as { wamid: string | null; status: string };
    },
    onSuccess: () => {
      toast.success("WhatsApp message sent");
      qc.invalidateQueries({ queryKey: ["whatsapp"] });
    },
    onError: (err) => toastError(err),
  });
}
