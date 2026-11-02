import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard, MarketingWorkspaceCard } from "@/components/features/marketing-hub/workspace-links";

export default function WebsiteTrackingPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Website & tracking" description="Track where visitors and leads come from, then improve the pages they land on." />
      <section aria-label="Website tracking tools" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingWorkspaceCard title="Tracking links" description="Create links that tag a lead with its source and campaign." href="/marketing/links" action="Open tracking links" />
        <MarketingWorkspaceCard title="Ads landing pages" description="Check the pages your ads send visitors to and the leads they generate." href="/marketing/landing-pages" action="Open landing pages" />
        <MarketingToolCard toolKey="search-console" />
        <MarketingToolCard toolKey="ga4" />
      </section>
      <MarketingActionLinks title="Review leads" links={[{ label: "Lead sources", href: "/lead-gen" }]} />
    </div>
  );
}
