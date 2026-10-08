"use client";
/** The drawer's footer — edit / archive / delete, and the reach-out row (S35, moved verbatim). */
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SheetFooter } from "@/components/ui/sheet";
import type { Lead, Quote } from "@/lib/supabase/database.types";
import type { NextAction } from "@/lib/leads/next-action";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { subscriptionFromLeadHref } from "@/lib/subscriptions/lead-prefill";

/**
 * R-073: does this won deal's customer already have a subscription? An online purchase gets
 * one from record_payment, so offering "Create subscription" there would invite a duplicate.
 * null while unknown — the button waits rather than guessing.
 */
function useCustomerHasSubscription(customerId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["lead-footer", "has-subscription", customerId ?? "none"],
    enabled,
    queryFn: async (): Promise<boolean> => {
      if (!customerId) return false;
      const { count } = await createClient()
        .from("subscriptions").select("id", { count: "exact", head: true })
        .eq("customer_id", customerId).neq("status", "cancelled");
      return (count ?? 0) > 0;
    },
    staleTime: 30_000,
  });
}

export interface LeadDetailFooterProps {
  lead: Lead;
  onEdit: (lead: Lead) => void;
  handleArchive: () => void;
  handleDelete: () => void;
  deletePending: boolean;
  handleEmail: () => void;
  setWhatsOpen: (open: boolean) => void;
  latestQuote: Quote | undefined;
  hasQuotes: boolean;
  nextAction: NextAction | null;
  handleSendQuote: () => void;
  handleReviseQuote: () => void;
}

export function LeadDetailFooter({
  lead, onEdit, handleArchive, handleDelete, deletePending, handleEmail, setWhatsOpen,
  latestQuote, hasQuotes, nextAction, handleSendQuote, handleReviseQuote,
}: LeadDetailFooterProps) {
  const router = useRouter();
  const hasSub = useCustomerHasSubscription(lead.customer_id, lead.stage === "won");
  return (
        <SheetFooter className="!p-4 border-t border-hairline !flex-col !items-stretch gap-2">
          {/* Secondary row — edit / archive / delete */}
          <div className="flex justify-between items-center gap-2">
            <div className="flex gap-1.5">
              <Button
                size="sm"
                variant="ghost"
                icon="edit"
                onClick={() => onEdit(lead)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleArchive}
              >
                Archive
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              icon="trash"
              onClick={handleDelete}
              loading={deletePending}
              className="!text-rose hover:!bg-rose/10"
            >
              Delete
            </Button>
          </div>

          {/* Reach-out row — how you contact this lead, plus the quote actions the
              top-of-drawer decision block does not cover.

              It is NOT the primary row any more, and the old comment here claimed the
              opposite ("stage-aware so the primary CTA always reflects the actual next
              step") — which was true when written and became a duplicate once nextAction
              grew the same responsibility with better inputs. Call is still first: on a
              phone it is the most common action and this row is the thumb zone. */}
          <div className="flex justify-end gap-2 pt-2 border-t border-hairline flex-wrap">
            {lead.contact_phone && (
              <Button
                icon="mobile"
                onClick={() => { window.location.href = `tel:${lead.contact_phone}`; }}
                title="Native dialer"
              >
                Call
              </Button>
            )}
            <Button icon="mail" onClick={handleEmail}>Email</Button>
            {lead.contact_phone && (
              <Button
                icon="whatsapp"
                onClick={() => setWhatsOpen(true)}
                title="Send a WhatsApp message via Meta Cloud API"
              >
                WhatsApp
              </Button>
            )}

            {/* WHAT IS DELIBERATELY NOT HERE ANY MORE: a stage-aware `variant="primary"`
                button. This row used to end in one, built from its own stage logic, while
                the top of the drawer showed `nextAction` built from different logic — two
                full-strength primaries that could disagree, and did. A new lead with a
                phone got "Call now · first contact" up there and "Send Quote" down here.
                Two primaries is no primary, so this one went and nextAction stayed: it is
                the better-informed of the two (it reads quote age and payment status) and
                it already carried the explanatory line underneath.

                These two survive as `default`-variant secondaries because nextAction does
                NOT cover them, and dropping them would have been a quiet capability loss:
                nextAction offers "Upsell · new quote" on a won deal but no way to open the
                accepted quote, and on a sent quote the top block is the QuoteActionBar,
                which moves the quote's STATUS and cannot revise it. Everything else the
                old block did — send draft, re-engage a lost deal, upsell, send the first
                quote — nextAction already says, in the same words. */}
            {lead.stage === "won" && latestQuote && (
              <Button
                icon="receipt"
                onClick={() => router.push(`/quotes/${latestQuote.id}` as never)}
              >
                Open accepted quote
              </Button>
            )}
            {/* R-073: a won deal proposes its subscription, the form filled from this deal. */}
            {lead.stage === "won" && hasSub.data === false && (
              <Button
                icon="refresh"
                onClick={() => router.push(subscriptionFromLeadHref(lead.id) as never)}
              >
                Create subscription
              </Button>
            )}
            {lead.stage === "won" && hasSub.data === true && (
              <Button
                icon="refresh"
                onClick={() => router.push("/subscriptions" as never)}
              >
                Open subscriptions
              </Button>
            )}
            {/* THE ONE CASE THE COMMENT ABOVE GOT WRONG. It claims nextAction already says
                "send the first quote" in the same words, so a footer button would be the
                duplicate primary that was just removed. True in every branch but one: a NEW
                lead WITH a phone and nothing logged yet gets "Call now · first contact", and
                then there is no route to a quote anywhere in the drawer — the pre-quote stage
                rail that carries one lives inside the `details` TAB, which is the fourth tab
                and not the one that opens. Reported by Pardeep, 24 Aug 2026: "new stage me
                quote bhejne ka option hi nahi aata hai." He was right, and the tab split I
                built the day before is what buried it.

                Gated on nextAction's own handler rather than on the stage, because the stage
                is not what causes the collision — being told to call is. When nextAction IS
                already send-quote this renders nothing, so the two-primaries mistake cannot
                come back through the very fix for its side effect. */}
            {lead.stage !== "won" && lead.stage !== "lost" && !hasQuotes &&
             nextAction?.target.kind !== "send_quote" && (
              <Button icon="send" onClick={handleSendQuote}>
                Send quote
              </Button>
            )}
            {lead.stage !== "won" && lead.stage !== "lost" && hasQuotes && latestQuote?.status !== "draft" && (
              <>
                <Button icon="send" onClick={handleSendQuote}>
                  New quote
                </Button>
                <Button icon="copy" onClick={handleReviseQuote}>
                  Revise &amp; resend
                </Button>
              </>
            )}
          </div>
        </SheetFooter>
  );
}
