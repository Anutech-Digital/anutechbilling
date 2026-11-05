import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard } from "@/components/features/marketing-hub/workspace-links";
import Link from "next/link";

export default function SocialOrganicPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="Social (organic)" description="Manage company pages and track leads from unpaid posts." />
      <Link href="/marketing/social-content" className="block rounded-xl border border-hairline bg-paper p-5 transition hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"><p className="font-semibold text-ink">Social content studio →</p><p className="mt-1 text-sm text-ink-3">Create Facebook and Instagram posts, prepare AI drafts, review, and publish.</p></Link>
      <section aria-label="Social platforms" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingToolCard toolKey="linkedin-page" />
        <MarketingToolCard toolKey="facebook-page" />
      </section>
      <MarketingActionLinks title="Measure posts" links={[{ label: "Tracking links for posts", href: "/marketing/links" }]} />
    </div>
  );
}
