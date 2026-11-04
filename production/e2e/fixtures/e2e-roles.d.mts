/** Types for e2e-roles.mjs (tsconfig has allowJs: false). Keep in sync with the .mjs. */
export type E2ERole = "owner" | "manager" | "sales" | "accountant";
/** R-2318: local-only extra logins (a second owner); never required by CI. */
export type E2ELocalExtraRole = "owner2";

export declare const E2E_TENANT_NAME: string;
export declare const E2E_TENANT_EMAIL: string;
export declare const E2E_CUSTOMER_NAME: string;
export declare const E2E_BANK_NAME: string;
export declare const E2E_VENDOR_NAME: string;
export declare const E2E_VENDOR_GSTIN: string;
export declare const E2E_ROLES: readonly E2ERole[];
export declare const E2E_LOCAL_EXTRA_ROLES: readonly E2ELocalExtraRole[];

type Env = Record<string, string | undefined>;

export declare function roleDbRole(role: E2ERole | E2ELocalExtraRole): E2ERole;
export declare function roleEnvNames(role: E2ERole | E2ELocalExtraRole): { email: string; password: string };
export declare function roleCreds<R extends E2ERole | E2ELocalExtraRole = E2ERole>(
  role: R,
  env?: Env,
): { role: R; email: string; password: string | undefined };
export declare function missingEnvFor(roles: readonly E2ERole[], env?: Env): string[];
export declare function productionHostReason(urlOrHost: string | undefined | null): string | null;
