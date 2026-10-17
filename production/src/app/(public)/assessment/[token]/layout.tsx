import type { Metadata } from "next";

/**
 * R-1479: the test page is a client component opened from a private link, so its title
 * lives here and it stays out of search.
 */
export const metadata: Metadata = {
  title: "Reasoning test",
  description: "A reasoning test shared with you by your employer.",
  robots: { index: false, follow: false },
};

export default function AssessmentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
