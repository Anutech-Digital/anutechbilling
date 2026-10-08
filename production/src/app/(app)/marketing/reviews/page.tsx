/**
 * Google reviews — /marketing/reviews
 *
 * Phase 2 (Pardeep, 26 Sep 2026): ask happy customers for a Google review, by email (sent
 * by the app) or WhatsApp (opened with the message typed), and keep a record so nobody is
 * asked twice in a month. Message text and the 30-day rule: lib/marketing/review-request.ts.
 */
"use client";

import * as React from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { useConfirm } from "@/components/providers/confirm-provider";
import { toastError } from "@/lib/errors/toast-error";
import { cn, formatDate } from "@/lib/utils";
import {
  isValidReviewLink, tooSoon, daysSince, reviewWhatsAppText, whatsAppLink, REVIEW_COOLDOWN_DAYS,
} from "@/lib/marketing/review-request";
import {
  useReviewLink, useSaveReviewLink, useReviewCustomers, useSendReviewEmail, useLogWhatsAppReview, useCompanyName,
  type ReviewCustomer,
} from "@/lib/queries/marketing-hub";

export default function ReviewsPage() {
  const linkQ = useReviewLink();
  const saveLink = useSaveReviewLink();
  const customers = useReviewCustomers();
  const [link, setLink] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [onlyNever, setOnlyNever] = React.useState(false);
  React.useEffect(() => { if (linkQ.data !== undefined) setLink(linkQ.data); }, [linkQ.data]);

  const saved = (linkQ.data ?? "").trim();
  const linkOk = isValidReviewLink(saved);
  const list = (customers.data ?? [])
    .filter((c) => !search.trim() || `${c.name} ${c.contact ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()))
    .filter((c) => !onlyNever || c.asks === 0);
  const asked = (customers.data ?? []).filter((c) => c.asks > 0).length;

  return (
    <div className="mx-auto max-w-[1240px] p-4 md:p-6 lg:p-8 space-y-5">
      <header>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Marketing &amp; Advertising</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Google reviews</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-3xl">
          New customers check Google reviews first. Ask happy customers for a review — email is sent from the app,
          WhatsApp opens with the message typed. At most once per customer every {REVIEW_COOLDOWN_DAYS} days.
        </p>
      </header>

      <Card className={cn("p-4 space-y-2", !linkOk && "border-amber/40 bg-amber-soft/20")}>
        <p className="text-sm font-semibold text-ink">Your Google review link</p>
        <div className="flex gap-2 flex-wrap">
          <Input aria-label="Google review link" className="flex-1 min-w-[260px]" placeholder="https://g.page/r/…/review" value={link} onChange={(e) => setLink(e.target.value)} />
          <Button onClick={() => saveLink.mutate(link)} disabled={saveLink.isPending || (link.trim() !== "" && !isValidReviewLink(link))}>Save</Button>
        </div>
        {link.trim() !== "" && !isValidReviewLink(link) && <p className="text-xs text-red-600">Enter the full https:// link.</p>}
        <p className="text-xs text-ink-3">
          Where to find it: business.google.com → your profile → &ldquo;Ask for reviews&rdquo; / &ldquo;Get more reviews&rdquo; → copy the link.
        </p>
      </Card>

      <div className="flex items-center gap-3 flex-wrap">
        <Input aria-label="Search customers" className="max-w-xs" placeholder="Search customers…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" checked={onlyNever} onChange={(e) => setOnlyNever(e.target.checked)} /> Only never asked
        </label>
        <span className="text-xs text-ink-3 ml-auto">{asked} / {(customers.data ?? []).length} customers asked</span>
      </div>

      <Card flush>
        {customers.isLoading ? (
          <div className="p-4 space-y-2">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : customers.error ? (
          <p className="p-4 text-sm text-red-600">{(customers.error as Error).message}</p>
        ) : list.length === 0 ? (
          <EmptyState icon="users" title="No customers" body="Change the filter, or add customers." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px]">
              <thead className="bg-paper-2 border-y border-hairline-strong">
                <tr>
                  {["Customer", "Contact", "Last asked", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-2xs font-semibold text-ink-3 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.map((c) => <Row key={c.id} c={c} link={saved} linkOk={linkOk} />)}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({ c, link, linkOk }: { c: ReviewCustomer; link: string; linkOk: boolean }) {
  const send = useSendReviewEmail();
  const logWa = useLogWhatsAppReview();
  const confirm = useConfirm();
  const company = useCompanyName();
  const recent = tooSoon(c.lastAsked);
  const sender = company.data || "Our team";
  const wa = linkOk ? whatsAppLink(c.phone, reviewWhatsAppText({ contactName: c.contact, company: c.name, sender, link })) : null;

  async function okToAskAgain(): Promise<boolean> {
    if (!recent) return true;
    return confirm({
      title: "Ask again?",
      body: `${c.name} was asked only ${daysSince(c.lastAsked)} days ago. Asking too often puts people off.`,
      confirmLabel: "Yes, ask anyway", cancelLabel: "Cancel",
    });
  }

  return (
    <tr className="border-b border-hairline last:border-0">
      <td className="px-3 py-2 text-sm font-medium text-ink">{c.name}</td>
      <td className="px-3 py-2 text-xs text-ink-2">
        {c.contact ?? "—"}
        <div className="text-ink-3">{[c.email, c.phone].filter(Boolean).join(" · ") || "No email / phone"}</div>
      </td>
      <td className={cn("px-3 py-2 text-xs", recent ? "text-amber-ink" : "text-ink-3")}>
        {c.lastAsked ? `${formatDate(c.lastAsked)} (${c.asks}×)` : "Never"}
      </td>
      <td className="px-3 py-2 text-right whitespace-nowrap">
        <Button variant="outline" size="sm" icon="mail" disabled={!linkOk || !c.email || send.isPending}
          title={!linkOk ? "Save the review link first" : !c.email ? "No email" : undefined}
          onClick={async () => {
            if (!(await okToAskAgain())) return;
            send.mutate({ customerId: c.id, force: recent }, { onError: (e) => toastError(e) });
          }}>Email</Button>
        {wa ? (
          <a href={wa} target="_blank" rel="noopener noreferrer" className="ml-2 inline-block"
             onClick={async (e) => {
               if (recent) { e.preventDefault(); if (!(await okToAskAgain())) return; window.open(wa, "_blank", "noopener"); }
               logWa.mutate({ customerId: c.id, phone: c.phone! });
             }}>
            <Button variant="ghost" size="sm" icon="whatsapp">WhatsApp</Button>
          </a>
        ) : (
          <Button variant="ghost" size="sm" icon="whatsapp" className="ml-2" disabled title={!linkOk ? "Save the review link first" : "No mobile number"}>WhatsApp</Button>
        )}
      </td>
    </tr>
  );
}
