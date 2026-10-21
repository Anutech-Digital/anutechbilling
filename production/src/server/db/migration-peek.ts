/**
 * R-1721 (21 Oct 2026) — reads, read-only, whether each migration this build knows about is on
 * the DB. Used only by GET /api/health/migrations.
 *
 * Login: the server's own service login (app_service, SERVICE_DATABASE_URL) via withIdentity —
 * never a user's session. Nothing here takes SQL from outside: the only statement is built from
 * the build-time list in src/server/migrations-health/peeks.generated.ts.
 *
 * Safety: `set transaction read only` first (any write in a peek is refused by Postgres), a 5 s
 * statement timeout, and one select for all peeks. If that select errors (one peek naming
 * something that is not there yet), each peek is re-run on its own inside a savepoint, and an
 * erroring peek counts as "not there" — so one bad peek cannot blank the whole answer (the same
 * failure stopped the staging DB script at step 2 on 9 Oct).
 */
import "server-only";
import { withIdentity } from "./gateway";
import { MIGRATION_PEEKS } from "@/server/migrations-health/peeks.generated";
import { buildPeekSql } from "@/server/migrations-health/peek-sql";

export async function readMigrationPeeks(): Promise<boolean[]> {
  const all = buildPeekSql(MIGRATION_PEEKS);
  return withIdentity({ mode: "service" }, async (tx) => {
    await tx.$executeRawUnsafe("set transaction read only");
    await tx.$executeRawUnsafe("set local statement_timeout = '5s'");
    await tx.$executeRawUnsafe("savepoint r1721_all");
    try {
      const rows = await tx.$queryRawUnsafe<{ r: boolean[] | null }[]>(all);
      return (rows[0]?.r ?? []).map((v) => v === true);
    } catch {
      await tx.$executeRawUnsafe("rollback to savepoint r1721_all");
    }
    const out: boolean[] = [];
    for (const p of MIGRATION_PEEKS) {
      await tx.$executeRawUnsafe("savepoint r1721_one");
      try {
        const rows = await tx.$queryRawUnsafe<{ r: boolean[] | null }[]>(buildPeekSql([p]));
        out.push(rows[0]?.r?.[0] === true);
        await tx.$executeRawUnsafe("release savepoint r1721_one");
      } catch {
        await tx.$executeRawUnsafe("rollback to savepoint r1721_one");
        out.push(false);
      }
    }
    return out;
  });
}
