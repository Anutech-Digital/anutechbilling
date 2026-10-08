import type { Metadata } from "next";
import { LpCategoryPage, type LpSearchParams } from "@/site/lib/lp-plan-page";

/** /lp/google-workspace-1 — Google Ads landing page 1 for the whole Google Workspace category (R-154). */
export const metadata: Metadata = {
  title: "Google Workspace — all plans",
  description: "Google Workspace by ANUTECH Digital — Business Starter, Standard, Plus and Enterprise. 14-day free trial, GST invoice, setup and migration included.",
};
export const revalidate = 600;

export default function Page({ searchParams }: { searchParams: LpSearchParams }) {
  return <LpCategoryPage searchParams={searchParams} />;
}
