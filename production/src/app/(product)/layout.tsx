/**
 * R-520: the ResellerOS product site (reselleros.anutech.in). Its own short header and footer,
 * none of the company site's chrome (no 7-menu header, no cart, no floating buttons — R-464).
 * Canonical URLs resolve against the product origin, so this page never claims anutech.in.
 */
import type { Metadata } from "next";
import { PRODUCT_ORIGIN } from "@/site/lib/site-split";
import { ProductHeader, ProductFooter } from "@/site/components/product/ProductChrome";

export const metadata: Metadata = {
  metadataBase: new URL(PRODUCT_ORIGIN),
  alternates: { canonical: "./" },
  openGraph: { siteName: "ResellerOS", locale: "en_IN", type: "website" },
};

export default function ProductLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-paper focus:px-3 focus:py-2">
        Skip to content
      </a>
      <ProductHeader />
      <main id="main">{children}</main>
      <ProductFooter />
    </div>
  );
}
