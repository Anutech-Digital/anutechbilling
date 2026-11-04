"use client";

/**
 * R-2396 (G-PERSONAL): carries PERSONAL_SIGNUP_ENABLED from the server to the /signup page.
 *
 * The flag is a SERVER env var (lib/personal/signup-flag.ts) — never a NEXT_PUBLIC one, so it is
 * not baked into the browser bundle at build time. signup/layout.tsx (a server component, read per
 * request) passes the boolean down here; the page only learns on/off, nothing else. When it is off
 * the page shows the business form exactly as before, and the API still answers 404 for kind
 * 'personal' (R-2119) — this flag only decides what is SHOWN.
 */
import * as React from "react";

const PersonalSignupFlag = React.createContext(false);

export function PersonalSignupFlagProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  return <PersonalSignupFlag.Provider value={enabled}>{children}</PersonalSignupFlag.Provider>;
}

export function usePersonalSignupEnabled(): boolean {
  return React.useContext(PersonalSignupFlag);
}
