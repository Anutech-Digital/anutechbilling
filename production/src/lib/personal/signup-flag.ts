/**
 * R-2119 (GP-05, goal G-PERSONAL): the switch for the free personal account.
 *
 * PERSONAL_SIGNUP_ENABLED = "1" / "true" opens both doors (password signup kind 'personal',
 * and new-tenant kind 'personal'). Anything else — including not set — keeps them shut: the
 * routes answer 404 as if the feature did not exist. Default OFF until the owner turns it on.
 *
 * Pure: no I/O.
 */
export function personalSignupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.PERSONAL_SIGNUP_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Where a personal login lands (nav.ts ROLE_HOME.personal; /money redirects to /vault/personal). */
export const PERSONAL_HOME = "/money" as const;

/** The 404 body both doors give when the switch is off. */
export const PERSONAL_SIGNUP_OFF = { error: "Not found" } as const;
