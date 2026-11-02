import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard } from "@/components/features/marketing-hub/workspace-links";

export default function ListingsPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Listings & marketplaces" description="Manage places where people discover your business and send enquiries." />
      <section aria-label="Listing platforms" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingToolCard toolKey="google-business" />
        <MarketingToolCard toolKey="indiamart" />
        <MarketingToolCard toolKey="justdial" />
      </section>
      <MarketingActionLinks title="Follow up" links={[
        { label: "Lead sources", href: "/lead-gen" },
        { label: "Google reviews", href: "/marketing/reviews" },
        { label: "Tracking links", href: "/marketing/links" },
      ]} />
    </div>
  );
}
