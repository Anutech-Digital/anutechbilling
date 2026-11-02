import { notFound, redirect } from "next/navigation";
import { MARKETING_HUB_SECTIONS } from "@/lib/marketing/tool-catalog";

/** Keep previously shared section links working. */
export default async function OldMarketingHubLink({ params }: { params: Promise<{ group: string }> }) {
  const { group } = await params;
  const page = MARKETING_HUB_SECTIONS.find((item) => item.group === group);
  if (!page) notFound();
  redirect(page.href);
}
