/**
 * WarmScope — puts a page that lives OUTSIDE the website's own layouts under the website theme
 * switch (Settings → Branding, docs/WEBSITE-THEME.md): the Workspace/Support checkouts, the ad
 * landing pages, the ResellerOS product pages, the privacy-request and unsubscribe pages, "not found".
 *
 * Renders one wrapper with `display: contents`, so it never creates a box: on Classic the page lays
 * out exactly as before. It carries `data-site-theme` (what the warm stylesheets and the w-only gate
 * key on) and the Warm fonts' CSS variables, and on Warm it applies a saved light/dark choice before
 * paint, like the website's own layout.
 *
 * Pages shared by every reseller (quote accept/view, enquiry, project quote) are deliberately NOT
 * wrapped: they show other resellers' customers, and the Warm design is Anutech's own.
 */
import { siteWarmBody, siteWarmHeading } from "@/lib/fonts";
import { websiteTenantId } from "@/lib/website-tenant";
import { getWebsiteTheme } from "@/lib/website-theme.server";
import { THEME_BOOT_SCRIPT } from "@/site/components/chrome/ThemeSwitch";
import "@/site/warm-only.css";
import "@/site/site-warm.css";
// One file per page group, each scoped under .w-scope[data-site-theme="warm"] (site-warm-scope.test.ts).
import "@/site/warm/extra-checkout.css";
import "@/site/warm/extra-lp.css";
import "@/site/warm/extra-product-pages.css";
import "@/site/warm/extra-forms.css";
import "@/site/warm/whatsapp.css"; // last: WhatsApp keeps its green

interface WarmScopeProps {
  children: React.ReactNode;
  /** Which page family, for the warm stylesheet to target (company site vs ResellerOS product site). */
  kind: "site" | "product";
}

export async function WarmScope({ children, kind }: WarmScopeProps) {
  const theme = await getWebsiteTheme(websiteTenantId());
  return (
    <div
      className={`w-scope w-scope-${kind} ${siteWarmBody.variable} ${siteWarmHeading.variable}`}
      data-site-theme={theme}
      style={{ display: "contents" }}
    >
      {theme === "warm" && <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />}
      {children}
    </div>
  );
}
