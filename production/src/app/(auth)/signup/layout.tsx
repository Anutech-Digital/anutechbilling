import type { Metadata } from "next";

import { personalSignupEnabled } from "@/lib/personal/signup-flag";
import { PersonalSignupFlagProvider } from "./signup-flag-context";

/**
 * R-1479: the sign-up page is a client component, so its title lives here.
 * robots.txt already keeps /signup out of search.
 */
export const metadata: Metadata = {
  title: "Create your account",
  description: "Create your ResellerOS account.",
  robots: { index: false, follow: true },
};

/* R-2396: PERSONAL_SIGNUP_ENABLED is read per request (not frozen at build time), so turning the
   switch on or off needs no rebuild. */
export const dynamic = "force-dynamic";

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return <PersonalSignupFlagProvider enabled={personalSignupEnabled()}>{children}</PersonalSignupFlagProvider>;
}
