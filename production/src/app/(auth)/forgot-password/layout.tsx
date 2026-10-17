import type { Metadata } from "next";

/**
 * R-1479: the forgot-password page is a client component, so its title lives here.
 * robots.txt already keeps /forgot-password out of search.
 */
export const metadata: Metadata = {
  title: "Forgot your password?",
  description: "Get a link to set a new password.",
  robots: { index: false, follow: true },
};

export default function ForgotPasswordLayout({ children }: { children: React.ReactNode }) {
  return children;
}
