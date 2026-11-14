import type { Metadata } from "next";
import { headers } from "next/headers";
import { NotFoundView } from "@/components/shared/not-found-view";
import { brandForHost, hostFromHeaders } from "@/site/lib/host-brand";
import { WarmScope } from "@/site/components/chrome/WarmScope";

/** R-1458: on anutech.in the 404 is Anutech-branded (title and screen); elsewhere unchanged. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = brandForHost(hostFromHeaders(await headers()));
  return brand.site === "company"
    ? { title: { absolute: `Page not found · ${brand.name}` } }
    : { title: "Page not found" };
}

export default async function NotFound() {
  const brand = brandForHost(hostFromHeaders(await headers()));
  // Website theme (docs/WEBSITE-THEME.md) only on Anutech's own domains, never on the app's hosts.
  if (brand.site !== "company") return <NotFoundView brand={brand} />;
  return (
    <WarmScope kind="site" siteChrome>
      <NotFoundView brand={brand} />
    </WarmScope>
  );
}
