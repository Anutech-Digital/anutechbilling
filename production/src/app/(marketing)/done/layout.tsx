import type { Metadata } from "next";

/**
 * R-1479: the confirmation page is a client component, so its title lives here. It is
 * per-visitor, and robots.txt already keeps /done out of search.
 */
export const metadata: Metadata = {
  title: "Confirmation",
  description: "What happens next after your order or trial request.",
  robots: { index: false, follow: true },
};

export default function DoneLayout({ children }: { children: React.ReactNode }) {
  return children;
}
