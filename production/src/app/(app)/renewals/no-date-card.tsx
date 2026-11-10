"use client";
/**
 * R-2586 — subscriptions with no renewal date (not cancelled). The queue cannot place them on a
 * tab, so they used to vanish from Renewals with no word (5 active yearly subs on local data).
 * One line names them; each name opens that subscription (its drawer on /subscriptions) to set the date.
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { subscriptionOpenHref } from "../subscriptions/open-link";

/** Names shown before "and N more" — the line stays one or two rows on a 1280 laptop. */
export const NO_DATE_NAMES_SHOWN = 8;

export interface NoDateSub {
  id: string;
  customer_name: string;
  plan: string | null;
  domain?: string | null;
}

export function NoRenewalDateCard({ subs }: { subs: readonly NoDateSub[] }) {
  if (subs.length === 0) return null;
  const n = subs.length;
  const shown = subs.slice(0, NO_DATE_NAMES_SHOWN);
  return (
    <div className="mb-4 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg border border-hairline bg-paper px-3 py-2 text-sm" data-testid="renewals-no-date">
      <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-amber-ink" />
      <span className="font-medium text-ink">
        {n} subscription{n === 1 ? " has" : "s have"} no renewal date — not on any tab. Set the date:
      </span>
      {shown.map((s, i) => (
        <span key={s.id} className="text-ink-2">
          <Link href={subscriptionOpenHref(s) as never} className="underline underline-offset-2 hover:text-ink">
            {s.customer_name}{s.plan ? ` · ${s.plan}` : ""}
          </Link>
          {i < shown.length - 1 ? "," : ""}
        </span>
      ))}
      {n > shown.length && <span className="text-ink-3">and {n - shown.length} more</span>}
    </div>
  );
}
