/**
 * Marketing route group — the Anutech Digital public site, ported into
 * ResellerOS (merge brick #5) so there is ONE app. It keeps its OWN design
 * (Archivo + IBM Plex Mono, the site's blue) entirely separate from the app's
 * Tailwind shell: everything is wrapped in `.anutech-site`, and site.css is
 * scoped under that class, so the two design systems never touch.
 *
 * This is a NESTED layout — the root layout still owns <html>/<body>. Here we
 * only set the font variables on the wrapper (so `--font-sans` = Archivo inside
 * the marketing subtree, overriding the app's Plus Jakarta just for these
 * pages) and render the site chrome around the page.
 *
 * Collisions with existing app routes (/, /pricing, /about, /login, …) are
 * deliberately NOT ported yet — which page wins there is its own decision.
 */
import type { Metadata } from "next";
import { archivoSans as archivo, plexMono } from "@/lib/fonts";
import "@/site/site.css";
import { SITE_URL } from "@/site/lib/config";

/**
 * The public site is Anutech Digital's — not ResellerOS's. The root layout's
 * title template appends "· ResellerOS" to every page, which on the marketing
 * pages reads as a second, confusing brand ("Anutech Digital … · ResellerOS").
 * This nested metadata re-brands the whole marketing subtree: every page title
 * ends "· Anutech Digital", and the OpenGraph site name matches. ResellerOS is
 * one product Anutech sells (it has its own /reselleros page); it is not the
 * name of this website.
 *
 * R-520 (9 Oct 2026): this subtree is the company site, anutech.in. Every page's canonical
 * resolves to anutech.in/<its path> ("./" + metadataBase), unless the page sets its own.
 */
export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: "./" },
  title: {
    default: "Anutech Digital — Google Workspace, Microsoft 365, Zoho, Domains & Hosting in India",
    template: "%s · Anutech Digital",
  },
  openGraph: { siteName: "Anutech Digital" },
};
import { CartProvider } from "@/site/components/cart/CartProvider";
import { CartDrawer } from "@/site/components/cart/CartDrawer";
import { Header } from "@/site/components/chrome/Header";
import { UtilityBar, CtaBand, Footer, WhatsAppButton, ConsentBanner } from "@/site/components/chrome/Chrome";
import { AgentChat } from "@/site/components/agent/AgentChat";
import { emailFromRate, fetchLiveWorkspace, mergeEditions } from "@/site/lib/live-catalog";


export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  /* R-076: the header's "Mailboxes from ₹…" teaser reads the live catalogue (10-min cache,
     typed fallback if the app is unreachable) — the same figure the home page shows. */
  const emailFrom = emailFromRate(mergeEditions(await fetchLiveWorkspace()));
  return (
    <div className={`anutech-site ${archivo.variable} ${plexMono.variable}`}>
      <CartProvider>
        <a href="#main" className="skip-link">Skip to content</a>
        <UtilityBar />
        <Header emailFrom={emailFrom} />
        <main id="main">{children}</main>
        <CtaBand />
        <Footer />
        <WhatsAppButton />
        <AgentChat />
        <ConsentBanner />
        <CartDrawer />
      </CartProvider>
    </div>
  );
}
