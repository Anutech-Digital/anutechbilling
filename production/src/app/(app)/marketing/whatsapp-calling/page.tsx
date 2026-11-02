import { MarketingActionLinks, MarketingPageHeader, MarketingToolCard, MarketingWorkspaceCard } from "@/components/features/marketing-hub/workspace-links";

export default function WhatsAppCallingPage() {
  return (
    <div className="mx-auto max-w-[1200px] space-y-7 p-4 md:p-6 lg:p-8">
      <MarketingPageHeader title="WhatsApp & calling" description="Reach leads, run calling campaigns and follow up on conversations." />
      <section aria-label="Messaging and calling tools" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <MarketingToolCard toolKey="whatsapp-business" />
        <MarketingWorkspaceCard title="Cold Calling" description="Run calling campaigns and send interested prospects to Sales & Pipeline." href="/marketing/cold-calling" action="Open Cold Calling" />
        <MarketingWorkspaceCard title="WhatsApp inbox" description="Read and reply to customer conversations." href="/whatsapp" action="Open inbox" />
      </section>
      <MarketingActionLinks title="More messaging tools" links={[
        { label: "WhatsApp reminders", href: "/marketing/whatsapp/reminders" },
        { label: "Automation", href: "/automation" },
      ]} />
    </div>
  );
}
