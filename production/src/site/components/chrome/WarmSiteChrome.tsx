/**
 * The company website's header and footer around a page that does not live in the website's own
 * layout ("page not found", privacy request, unsubscribe, Buy Support) — on the WARM theme only
 * (owner, 14 Nov 2026: the designs put these pages inside the site's header and footer).
 * On Classic, WarmScope never renders this, so those pages look exactly as before.
 *
 * Each `.anutech-site` wrapper is `display: contents`: it carries the site's scope, fonts and theme
 * for site.css / chrome.css but draws no box of its own, so the sticky header stays sticky for the
 * whole page and the page in between keeps its own layout.
 */
import { archivoSans as archivo, plexMono, siteWarmBody, siteWarmHeading } from "@/lib/fonts";
import { CartProvider } from "@/site/components/cart/CartProvider";
import { CartDrawer } from "@/site/components/cart/CartDrawer";
import { Header } from "@/site/components/chrome/Header";
import { UtilityBar, Footer } from "@/site/components/chrome/Chrome";
import { emailFromRate, fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";
import { bookMailboxMonthly } from "@/lib/catalog/catalog-prices";
import { getPriceBook } from "@/lib/catalog/catalog-prices.server";
import { websiteTenantId } from "@/lib/website-tenant";
import { getWebsiteTheme } from "@/lib/website-theme.server";
import { getSiteTldPrices } from "@/site/lib/live-tld-pricing";
import { domainTeaser } from "@/site/lib/data/domain-teaser";
import { domainRenewals } from "@/site/lib/renewal-line";
import "@/site/site.css";
import "@/site/site-warm.css";
import "@/site/warm/chrome.css";
import "@/site/warm/switch.css";
import "@/site/warm/whatsapp.css";

export async function WarmSiteChrome({ children }: { children: React.ReactNode }) {
  // The same live figures the website's own layout shows in its header (each read is cached and capped).
  const [workspace, tlds, book] = await Promise.all([fetchLiveWorkspace(), getSiteTldPrices(), getPriceBook(websiteTenantId())]);
  const emailFrom = emailFromRate(mergeEditions(workspace), bookMailboxMonthly(book));
  const site = `anutech-site w-site-chrome ${archivo.variable} ${plexMono.variable} ${siteWarmBody.variable} ${siteWarmHeading.variable}`;
  return (
    <>
      <div className={site} data-site-theme="warm" style={{ display: "contents" }}>
        <CartProvider domainRenewals={domainRenewals(tlds)}>
          <UtilityBar />
          <Header emailFrom={emailFrom} domainTeaser={domainTeaser(tlds)} warm />
          <CartDrawer />
        </CartProvider>
      </div>
      {children}
      <div className={site} data-site-theme="warm" style={{ display: "contents" }}>
        <Footer />
      </div>
    </>
  );
}

/** For a route segment nested inside a WarmScope (e.g. /buy/support under /buy): the same header
 *  and footer, only when the website theme is Warm. */
export async function SiteChromeOnWarm({ children }: { children: React.ReactNode }) {
  const theme = await getWebsiteTheme(websiteTenantId());
  return theme === "warm" ? <WarmSiteChrome>{children}</WarmSiteChrome> : <>{children}</>;
}
