"use client";

/**
 * R-1705: in the subscription drawer — added seats whose pro-rata quote is still unpaid.
 * The seats are live (Manage seats adds them at once); this says the money is not in yet,
 * and that rejecting the quote takes the seats and MRR back.
 */
import Link from "next/link";
import { useOpenSeatQuotes } from "@/lib/queries/seat-quotes";
import { seatQuotesForSubscription, seatQuotePendingText } from "@/lib/subscriptions/seat-quotes-pending";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenQuotes } from "@/lib/quotes/access";
import { Icon } from "@/components/ui/icon";

export function SeatQuotesPending({ subscriptionId }: { subscriptionId: string }) {
  const { data } = useOpenSeatQuotes();
  const { data: me } = useCurrentUser();
  const mine = seatQuotesForSubscription(data ?? [], subscriptionId);
  if (mine.length === 0) return null;
  const canQuotes = canOpenQuotes(me?.role);
  return (
    <div role="status" className="mb-4 rounded-lg border border-amber/50 bg-amber-soft/40 px-3 py-2.5 text-sm">
      <ul className="space-y-1">
        {mine.map((q) => (
          <li key={q.quoteId} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <Icon name="alert" size={14} className="shrink-0 text-amber" />
            <span className="font-medium text-ink">{seatQuotePendingText(q)}</span>
            {canQuotes ? (
              <Link href={`/quotes/${q.quoteId}` as never} className="font-mono text-xs text-amber-ink underline-offset-2 hover:underline">
                {q.quoteId}
              </Link>
            ) : (
              <span className="font-mono text-xs text-ink-3">{q.quoteId}</span>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-ink-3">
        These seats are already on the subscription but not paid for. Record the payment on the quote,
        or reject it to take the seats and MRR back.
      </p>
    </div>
  );
}
