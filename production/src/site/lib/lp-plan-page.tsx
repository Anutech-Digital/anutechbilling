import type { Metadata } from "next";
import { WorkspaceAdLanding } from "@/site/components/lp/WorkspaceAdLanding";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { LP_CATEGORY, LP_PLAN_ORDER, LP_PLANS, type LpPlanKey } from "@/site/lib/lp-plans";
import { parseLpLang, LP_DEFAULT_LANG } from "@/site/components/lp/lp-copy";

/** The page's searchParams (Next 15: a promise). Only `lang` is read here. */
export type LpSearchParams = Promise<Record<string, string | string[] | undefined>>;

/** `?lang=hi` / `?lang=hinglish` → Hinglish; anything else → English (R-396). */
async function langOf(searchParams?: LpSearchParams) {
  const sp = searchParams ? await searchParams : {};
  return parseLpLang(sp.lang) ?? LP_DEFAULT_LANG;
}

/**
 * Shared body of the per-plan Google Ads landing pages under (lp)/lp/ (4 Oct 2026). The price
 * is the live catalogue's yearly rate for the plan — the same figure checkout charges (falls
 * back to LICENCE_EDITIONS if the catalogue is down). Enterprise has no list price: talk to us.
 */
export function lpPlanMetadata(key: LpPlanKey): Metadata {
  const plan = LP_PLANS[key];
  return {
    title: `Google Workspace ${plan.name}`,
    description: `Google Workspace ${plan.name} by ANUTECH Digital — ${plan.storage}, ${plan.meetPeople.toLowerCase()} meetings, professional email. 14-day free trial, GST invoice, setup and migration included.`,
  };
}

export async function LpPlanPage({ planKey, searchParams }: { planKey: LpPlanKey; searchParams?: LpSearchParams }) {
  const plan = LP_PLANS[planKey];
  let price: number | null = null;
  if (plan.edition) {
    const editions = mergeEditions(await fetchLiveWorkspace());
    const ed = editions.find((e) => e.name === plan.edition);
    price = ed?.annual && ed.annual > 0 ? ed.annual : null;
  }
  return <WorkspaceAdLanding plan={plan} annualPerSeatMo={price} lang={await langOf(searchParams)} />;
}

/** The all-plans category page (R-154): Starter's offer up top, every plan's live price below. */
export async function LpCategoryPage({ searchParams }: { searchParams?: LpSearchParams } = {}) {
  const editions = mergeEditions(await fetchLiveWorkspace());
  const priceOf = (edition: string | null) => {
    const ed = edition ? editions.find((e) => e.name === edition) : undefined;
    return ed?.annual && ed.annual > 0 ? ed.annual : null;
  };
  const allPlans = LP_PLAN_ORDER.map((k) => ({ plan: LP_PLANS[k], annual: priceOf(LP_PLANS[k].edition) }));
  return <WorkspaceAdLanding plan={LP_CATEGORY} annualPerSeatMo={priceOf(LP_CATEGORY.edition)} allPlans={allPlans} lang={await langOf(searchParams)} />;
}
