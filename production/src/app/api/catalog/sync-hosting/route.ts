import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/with-route";
import { daConfigured, daAllPackages } from "@/lib/directadmin";
import { LANDING_PLANS } from "@/site/lib/data/hosting-landing";

/**
 * POST /api/catalog/sync-hosting — seed/refresh THIS tenant's hosting catalogue
 * from the two directly-connected sources of truth (merge, 2 Sep 2026):
 *
 *   • SPECS (disk + bandwidth)  ← DirectAdmin, read live from the server that
 *     actually provisions the account (lib/directadmin). This is authoritative:
 *     it is the quota the customer really gets. Verified 2 Sep — the disk quotas
 *     matched the marketing page exactly, but bandwidth did NOT (page promised
 *     100/200/Unmetered GB while the packages enforce 20/30/40 GB). Pardeep's
 *     ruling: the server is the truth, so the page was corrected to match, and
 *     the catalogue takes its specs from here, never from the page.
 *   • PRICE + name + features   ← LANDING_PLANS (hosting-landing.ts), Anutech's
 *     own numbers. DirectAdmin holds no selling price, so price can only come
 *     from our own config.
 *
 * This replaces the previous version, which fetched the DMS engine
 * (app.anutech.in) — undeployable since its GCP owner account was lost. Same
 * atomic, owner-only RPC underneath (`sync_hosting_catalog`); this route only
 * authenticates, reads DA, merges, and hands the plans over. It NEVER writes to
 * DirectAdmin — creating/altering an account is a separate, gated module.
 *
 * A DA package with no matching priced plan is SKIPPED (never seeded at ₹0) and
 * named in the response, so nothing is ever put on sale without a real price.
 */
/* R-732: owner / manager at the door — the RPC is owner-only as well; a seller's session must
   not even reach DirectAdmin. */
export const POST = withRoute({
  route: "api/catalog/sync-hosting",
  roles: ["owner", "manager"],
  roleHint: "Only an owner or manager can sync the catalogue.",
}, async ({ supabase }) => {

  if (!daConfigured()) {
    return NextResponse.json(
      { error: "DirectAdmin is not connected on this server yet." },
      { status: 400 },
    );
  }

  // 1. Read the real package specs from DirectAdmin (read-only).
  const packages = await daAllPackages();
  if (!packages) {
    return NextResponse.json(
      {
        error:
          "DirectAdmin didn't answer with data. The server's IP (34.14.190.227) may not be " +
          "on the DirectAdmin allowlist, or the credentials are wrong.",
      },
      { status: 502 },
    );
  }

  // 2. Merge each package's specs with its priced plan from our own config.
  const priced = new Map(LANDING_PLANS.map((p) => [p.name.trim().toLowerCase(), p]));
  const plans: Array<Record<string, unknown>> = [];
  const skipped: string[] = [];

  for (const pkg of packages) {
    const plan = priced.get(pkg.name.trim().toLowerCase());
    if (!plan) {
      skipped.push(pkg.name); // a package we have no price for — never seed at ₹0
      continue;
    }
    plans.push({
      planId: plan.planId,
      name: plan.name,
      description: plan.description,
      price: plan.price, // ₹/mo billed yearly — a seed the owner can edit
      currency: plan.currency,
      period: "/mo",
      features: plan.features,
      quotaMB: pkg.quotaMB, // ← DirectAdmin truth
      bandwidthMB: pkg.bandwidthMB, // ← DirectAdmin truth
      popular: plan.isPopular,
    });
  }

  if (plans.length === 0) {
    return NextResponse.json({
      synced: 0,
      skipped,
      message:
        "No DirectAdmin package matched a priced plan. Add a price for these in hosting-landing.ts: " +
        skipped.join(", "),
    });
  }

  // 3. Hand the merged plans to the atomic, owner-only RPC.
  const { data: count, error } = await supabase.rpc("sync_hosting_catalog", {
    p_plans: plans as unknown as never,
  });
  if (error) {
    const status = error.message.toLowerCase().includes("owner") ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ synced: count ?? 0, skipped, source: "directadmin+config" });
});
