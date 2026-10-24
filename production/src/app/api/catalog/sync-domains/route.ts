import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/with-route";
import { rcConfigured, rcTldPricing } from "@/lib/resellerclub";

/**
 * POST /api/catalog/sync-domains — pull the domain rate card from the DMS engine
 * (app.anutech.in, GET /api/public/tld-pricing) into THIS tenant's catalogue.
 *
 * Sibling of sync-hosting. The tld-pricing feed already exists (it powers the
 * marketing site's rate card), so there is no new engine work — this route
 * fetches it and hands the rows to the atomic, owner-only sync_domain_catalog
 * RPC. Each priced TLD becomes a one-time catalogue item.
 *
 * Live only once the DMS is deployed; until then the fetch fails and we return
 * a clear 502, never a half-written catalogue.
 */

const DMS_BASE = (process.env.DOMAINS_APP_URL ?? "https://app.anutech.in").replace(/\/+$/, "");
const TLD_PRICING_API = `${DMS_BASE}/api/public/tld-pricing`;

interface TldRow {
  tld: string;
  register: number | null;
  renew: number | null;
  transfer: number | null;
  currency: string;
}

/* R-732: owner / manager at the door — the RPC is owner-only as well; a seller's session must
   not even reach the engine. */
export const POST = withRoute({
  route: "api/catalog/sync-domains",
  roles: ["owner", "manager"],
  roleHint: "Only an owner or manager can sync the catalogue.",
}, async ({ supabase }) => {

  // 1. Fetch the rate card — direct from ResellerClub when the credentials are
  //    on this server (Plan B, 2 Sep 2026: the engine can't be redeployed), else
  //    the engine's public API as before.
  let tlds: TldRow[];
  if (rcConfigured()) {
    const rows = await rcTldPricing(["in", "com", "co.in", "org", "net", "shop", "store", "io"]);
    if (!rows) {
      return NextResponse.json(
        { error: "ResellerClub didn't answer — check that this server's IP (34.14.190.227) is whitelisted in the ResellerClub panel, then try again." },
        { status: 502 },
      );
    }
    tlds = rows;
  } else {
    try {
      const res = await fetch(TLD_PRICING_API, {
        cache: "no-store",
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        return NextResponse.json(
          { error: `Domain engine returned ${res.status}. Is app.anutech.in deployed?` },
          { status: 502 },
        );
      }
      const body = (await res.json()) as { tlds?: unknown };
      if (!Array.isArray(body.tlds)) {
        return NextResponse.json({ error: "Domain engine sent no pricing." }, { status: 502 });
      }
      tlds = body.tlds as TldRow[];
    } catch {
      return NextResponse.json(
        { error: "Couldn't reach the domain engine (app.anutech.in). Try again once it's deployed." },
        { status: 502 },
      );
    }
  }

  const priced = tlds.filter((t) => typeof t.register === "number" && (t.register ?? 0) > 0);
  if (priced.length === 0) {
    return NextResponse.json({ synced: 0, message: "The engine returned no priced TLDs." });
  }

  // 2. Hand them to the atomic, owner-only RPC.
  const { data: count, error } = await supabase.rpc("sync_domain_catalog", {
    p_tlds: priced as unknown as never,
  });
  if (error) {
    const status = error.message.toLowerCase().includes("owner") ? 403 : 400;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ synced: count ?? 0 });
});
