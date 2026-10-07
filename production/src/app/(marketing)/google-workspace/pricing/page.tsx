import type { Metadata } from "next";
import { WorkspacePricing, WorkspaceWordmark, WorkspaceAppIcons, type PricedPlan, type PlanKey } from "@/site/components/email/WorkspacePricing";
import { fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { floorWorkspacePrice } from "@/lib/catalog/workspace-floor";
import { PLUS_EDITION } from "@/lib/catalog/public-price-policy";

export const metadata: Metadata = {
  title: "Google Workspace plans and pricing in India",
  description: "Google Workspace Business Starter, Standard, Plus and Enterprise in INR with a GST invoice — from an authorised Google Workspace reseller, with free setup and migration.",
};

/* Live prices from the app, re-read every 10 minutes — see lib/live-catalog.ts. */
export const revalidate = 600;

const MATCH: [PlanKey, RegExp][] = [["starter", /starter/i], ["standard", /standard/i]];

export default async function WorkspacePricingPage() {
  const editions = mergeEditions(await fetchLiveWorkspace()).filter((e) => /^GW /i.test(e.name));
  const plans: PricedPlan[] = [];
  for (const [key, re] of MATCH) {
    const e = editions.find((x) => re.test(x.name));
    /* A flexible price at or below the annual one is a stale catalogue row (Starter flexible
       was ₹170 against ₹270 annual on 4 Oct 2026) — show "annual only", never a wrong price. */
    const m = e?.monthlyOrNull ?? null;
    /* R-205: never below the list price (Starter ₹270), whatever the catalogue row says. */
    const annual = e ? floorWorkspacePrice(e.name, e.annual) : 0;
    if (e) plans.push({ key, edition: e.name, annual, monthly: m != null && m > annual ? m : null });
  }
  /* R-328: Business Plus — "Contact us for pricing", no figure (Google publishes none either). */
  plans.push({ key: "plus", edition: PLUS_EDITION, annual: null, monthly: null });
  plans.push({ key: "enterprise", edition: null, annual: null, monthly: null });

  return (
    <section className="section rise" style={{ paddingTop: 8 }}>
      <div className="wrap">
        <WorkspacePricing
          plans={plans}
          head={<>
            <WorkspaceAppIcons />
            <h1 className="h1-page"><WorkspaceWordmark /> plans and pricing</h1>
          </>}
          intro={
            <p className="body-lg" style={{ margin: "8px 0 0", maxWidth: 760 }}>
              The same Google plans, billed in INR with a GST invoice — plus free setup, free
              migration and a team you can call.
            </p>
          }
        />
      </div>
    </section>
  );
}
