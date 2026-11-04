/**
 * /support/my — Support for a personal login (GP-07a, R-2115).
 *
 * Not the company Support Desk at /support (a staff queue a personal login must never open).
 * A stub so the Personal menu row resolves: the person's own requests to Anutech support
 * (decision D4: a free support desk at verified signup) arrive with a later G-PERSONAL card.
 */
import { EmptyState } from "@/components/shared/empty-state";

export default function MySupportPage() {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">Support</h1>
        <p className="text-sm text-ink-3 mt-1">Your questions to our support team, and their answers.</p>
      </div>
      <EmptyState
        icon="ticket"
        title="No support requests yet"
        body="When you ask us for help, your requests and our replies will show here."
      />
    </div>
  );
}
