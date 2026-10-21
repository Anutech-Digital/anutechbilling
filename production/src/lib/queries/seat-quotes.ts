"use client";

/**
 * R-1705: open add-seats (pro-rata) quotes — seats already live, money not yet in.
 * Read by the subscription drawer and Payments → Subscription dues. Under the ["quotes"] key
 * so every quote change (reject, payment) refreshes it.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { openSeatQuotes, SEAT_QUOTE_COLS, type OpenSeatQuote, type SeatQuoteRow } from "@/lib/subscriptions/seat-quotes-pending";

export function useOpenSeatQuotes() {
  return useQuery({
    queryKey: ["quotes", "open-seat-quotes"],
    queryFn: async (): Promise<OpenSeatQuote[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("quotes")
        .select(SEAT_QUOTE_COLS)
        .eq("is_add_seats", true)
        .in("status", ["sent", "viewed", "accepted"])
        .is("superseded_by", null)
        .is("add_seats_taken_back_at", null)
        .is("invoice_id", null);
      if (error) throw error;
      return openSeatQuotes((data ?? []) as unknown as SeatQuoteRow[]);
    },
  });
}
