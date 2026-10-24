/**
 * R-1798 (R-1129 follow-up) — the setup wizard writes the `tenants` row, and RLS
 * `tenants_self_update` lets only the OWNER do that. A manager can still open /setup
 * (nav.ts OM_ONLY), so the wizard goes read-only for anyone else instead of failing
 * on every save. Pure — unit-tested in setup-owner-only-r1798.test.ts.
 */

export function canSaveSetup(role: string | null | undefined): boolean {
  return role === "owner";
}

export function ownerOnlySetupNote(ownerName: string | null | undefined): string {
  const who = ownerName?.trim() || "the workspace owner";
  return `Only the owner can finish setup — ask ${who}.`;
}
