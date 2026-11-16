"use client";
/**
 * R-2423 (2) + R-2871 — "which subscription is this quote for" under the quote page's title.
 * One subscription → "For subscription: <it>" (as before). A together renewal quote (R-2847..R-2849:
 * one quote renewing 2+ yearly subscriptions) names every member: "For subscriptions:" and one line
 * each (plan · seats · its own renewal date), each opening its subscription.
 */
import Link from "next/link";
import { subscriptionOpenHref } from "@/app/(app)/subscriptions/open-link";

type Target = { id: string; domain?: string | null; customer_name?: string | null };

export function ForSubscriptionLine({ single, singleText, members }: {
  single: Target | null;
  singleText: string | null;
  members: ReadonlyArray<{ id: string; sub: Target; text: string }>;
}) {
  const linkCls = "font-medium text-ink hover:text-amber-ink hover:underline";
  if (members.length >= 2) {
    return (
      <div className="text-sm text-ink-3 mt-1" data-testid="quote-for-subscription">
        For subscriptions:
        <ul className="mt-0.5 space-y-0.5">
          {members.map((m) => (
            <li key={m.id} data-testid="quote-for-subscription-member">
              <Link href={subscriptionOpenHref(m.sub) as never} className={linkCls}>{m.text}</Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (!single || !singleText) return null;
  return (
    <p className="text-sm text-ink-3 mt-1" data-testid="quote-for-subscription">
      For subscription:{" "}
      <Link href={subscriptionOpenHref(single) as never} className={linkCls}>{singleText}</Link>
    </p>
  );
}
