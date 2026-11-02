import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard } from "@/components/features/marketing-hub/workspace-links";

export default function SocialOrganicPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Social (organic)" description="Manage company pages and track leads from unpaid posts." />
      <section aria-label="Social platforms" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingToolCard toolKey="linkedin-page" />
        <MarketingToolCard toolKey="facebook-page" />
      </section>
      <MarketingActionLinks title="Measure posts" links={[{ label: "Tracking links for posts", href: "/marketing/links" }]} />
    </div>
  );
}
