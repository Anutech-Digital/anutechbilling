import type { Metadata } from "next";

/**
 * R-1479: the cart page is a client component, so its title lives here (it showed only the
 * bare site title). It is per-visitor, and robots.txt already keeps /cart out of search.
 */
export const metadata: Metadata = {
  title: "Your cart",
  description: "Review the items in your cart before checkout.",
  robots: { index: false, follow: true },
};

export default function CartLayout({ children }: { children: React.ReactNode }) {
  return children;
}
