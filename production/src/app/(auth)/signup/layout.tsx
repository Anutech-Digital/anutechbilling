import type { Metadata } from "next";

/**
 * R-1479: the sign-up page is a client component, so its title lives here.
 * robots.txt already keeps /signup out of search.
 */
export const metadata: Metadata = {
  title: "Create your workspace",
  description: "Create your ResellerOS workspace.",
  robots: { index: false, follow: true },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
