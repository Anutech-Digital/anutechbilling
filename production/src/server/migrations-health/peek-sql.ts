/**
 * R-1721 (21 Oct 2026) — the one query behind GET /api/health/migrations.
 *
 * 21 Oct: the staging DB step stopped after its backup (gcloud login expired), an old "DB READY"
 * was taken as done, the train ran with --db-done, and new code ran on staging ~1 hour without 4
 * migrations. The app now checks itself: every `-- deploy-peek:` of the migrations it was BUILT
 * with (peeks.generated.ts, written by scripts/ops/gen-deploy-db.mjs) is run in one read-only
 * select, one boolean each. The SQL is made only from that build-time list — never from a request.
 */

export interface MigrationPeek {
  readonly key: string;
  readonly peek: string;
}

/* A peek is one boolean expression. `;` or a comment could end it and start something else —
   gen-deploy-db never writes one, and this refuses it if a hand edit ever did. */
const UNSAFE = /;|--|\/\*/;

export function buildPeekSql(peeks: ReadonlyArray<MigrationPeek>): string {
  for (const p of peeks) {
    if (UNSAFE.test(p.peek)) throw new Error(`migration peek "${p.key}" is not a single expression`);
  }
  return `select array[${peeks.map((p) => `(${p.peek})`).join(", ")}]::boolean[] as r`;
}

/** Keys whose answer is not exactly `true` — false, null, or no answer at all. */
export function missingKeys(peeks: ReadonlyArray<MigrationPeek>, values: ReadonlyArray<unknown>): string[] {
  return peeks.filter((_, i) => values[i] !== true).map((p) => p.key);
}
