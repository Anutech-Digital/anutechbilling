/**
 * Strangler switch: a route moved to Prisma uses it only where the database login for it
 * exists (DATABASE_URL = app_runtime). Until production has that secret, the same route keeps
 * its old Supabase path, so merging a moved route can never break the live site. Once every
 * environment has DATABASE_URL, the old branches are deleted (plan Phase 8).
 */
export function prismaPathEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
