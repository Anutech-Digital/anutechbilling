/**
 * /unsubscribe — the page a campaign mail's "Unsubscribe" link opens.
 *
 * Shows the address and one button. Nothing is written on page load: mail scanners open
 * every link, so the opt-out happens only on the button's POST (api/public/unsubscribe).
 */
import type { Metadata } from "next";
import { PublicShell } from "../_components/public-shell";
import { UnsubscribeClient } from "./unsubscribe-client";
import { websiteTenantId } from "@/lib/website-tenant";
import { getWebsiteTheme } from "@/lib/website-theme.server";

export const metadata: Metadata = {
  title: "Unsubscribe",
  robots: { index: false, follow: false },
};

export default async function UnsubscribePage(
  props: { searchParams: Promise<Record<string, string | string[] | undefined>> }
) {
  const [searchParams, theme] = await Promise.all([props.searchParams, getWebsiteTheme(websiteTenantId())]);
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  return (
    // Warm website theme: the company header and footer surround the page (unsubscribe/layout.tsx), so no second bar.
    <PublicShell title="Unsubscribe" subtitle="Stop marketing emails" bars={theme !== "warm"}>
      <UnsubscribeClient t={one(searchParams.t)} e={one(searchParams.e)} s={one(searchParams.s)} c={one(searchParams.c)} />
    </PublicShell>
  );
}
