/**
 * /assets — "My digital assets" for a personal login (GP-07a, R-2115).
 *
 * A stub so the Personal menu row resolves: the list itself (domains and hosting from DMS,
 * subscriptions and bills from Billing, with Add buttons) is a later G-PERSONAL card. Until
 * then the page says plainly what will be here, and offers no button that does nothing.
 */
import { EmptyState } from "@/components/shared/empty-state";

export default function MyDigitalAssetsPage() {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto space-y-5">
      <div>
        <h1 className="text-2xl md:text-3xl font-serif text-ink">My digital assets</h1>
        <p className="text-sm text-ink-3 mt-1">Your domains, hosting, subscriptions and bills — in one place.</p>
      </div>
      <EmptyState
        icon="globe"
        title="No digital assets yet"
        body="Domains, hosting and subscriptions you buy from us will show here, with their renewal dates."
      />
    </div>
  );
}
