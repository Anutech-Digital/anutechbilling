import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard, MarketingWorkspaceCard } from "@/components/features/marketing-hub/workspace-links";

export default function MarketingEmailPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Email" description="Create campaigns, prepare templates and send offers to customers and leads." />
      <section aria-label="Email tools" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingToolCard toolKey="email-campaigns" />
        <MarketingWorkspaceCard title="Email templates" description="Create reusable messages for marketing emails." href="/marketing/templates" action="Open templates" />
      </section>
      <MarketingActionLinks title="Offers" links={[{ label: "Coupons", href: "/coupons" }]} />
    </div>
  );
}
