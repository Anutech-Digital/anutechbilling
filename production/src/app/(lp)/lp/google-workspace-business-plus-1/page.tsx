import { LpPlanPage, lpPlanMetadata, type LpSearchParams } from "@/site/lib/lp-plan-page";

/** /lp/google-workspace-business-plus-1 — Google Ads landing page 1 for this plan (lib/lp-plans.ts). noindex via (lp)/layout. */
export const metadata = lpPlanMetadata("plus");
export const revalidate = 600;

export default function Page({ searchParams }: { searchParams: LpSearchParams }) {
  return <LpPlanPage planKey="plus" searchParams={searchParams} />;
}
