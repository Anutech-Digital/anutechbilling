import type { Metadata } from "next";

/**
 * R-1479: the checkout page is a client component, so its title lives here. It is
 * per-visitor, and robots.txt already keeps /checkout out of search.
 */
export const metadata: Metadata = {
  title: "Checkout",
  description: "Who the invoice is for, then payment.",
  robots: { index: false, follow: true },
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
