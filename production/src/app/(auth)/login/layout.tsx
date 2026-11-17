import type { Metadata } from "next";

/**
 * R-1479: the sign-in page is a client component, so its title lives here (the (auth)
 * layout's template adds the site name). robots.txt already keeps /login out of search.
 */
export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to your account.",
  robots: { index: false, follow: true },
};

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  /* data-auth-page: the Warm theme styles this page (extra-forms.css); display: contents, no box. */
  return <div data-auth-page="login" style={{ display: "contents" }}>{children}</div>;
}
