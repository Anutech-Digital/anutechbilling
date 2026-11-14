/**
 * R-520: the ResellerOS product site (reselleros.anutech.in). Its own short header and footer,
 * none of the company site's chrome (no 7-menu header, no cart, no floating buttons — R-464).
 * Canonical URLs resolve against the product origin, so this page never claims anutech.in.
 */
import type { Metadata } from "next";
import { PRODUCT_ORIGIN } from "@/site/lib/site-split";
import { ProductHeader, ProductFooter } from "@/site/components/product/ProductChrome";
import { SitePreviewBar } from "@/site/components/chrome/SitePreviewBar";
import { siteWarmBody, siteWarmHeading } from "@/lib/fonts";
import { websiteTenantId } from "@/lib/website-tenant";
import { getWebsiteTheme } from "@/lib/website-theme.server";
import "@/site/warm/product.css";

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCT_ORIGIN),
  alternates: { canonical: "./" },
  openGraph: { siteName: "ResellerOS", locale: "en_IN", type: "website" },
};

export default async function ProductLayout({ children }: { children: React.ReactNode }) {
  /* Website theme (Settings → Branding): the product page follows the company site's switch.
     "classic" draws exactly as before; "warm" turns on site/warm/product.css. */
  const theme = await getWebsiteTheme(websiteTenantId());
  return (
    <div
      className={`anutech-product min-h-screen bg-paper text-ink ${siteWarmBody.variable} ${siteWarmHeading.variable}`}
      data-site-theme={theme}
    >
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      {/* R-1508: signed-in team member previewing the site — Back to dashboard + Report a problem. */}
      <SitePreviewBar />
      <ProductHeader />
      <main id="main">{children}</main>
      <ProductFooter />
    </div>
  );
}
