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

/**
 * R-2695 (12 Nov 2026) — `information_schema.columns` lists only the columns the CURRENT login
 * holds a privilege on (or owns). The deploy-db script runs every peek as the table owner
 * (resellersos_migration); the app runs them as app_service (member of service_role). On Cloud
 * SQL a table created without an explicit GRANT gives service_role nothing (cloudsql/09 grants
 * only authenticated/anon), so the column is there, the DB step says true — and the app's own
 * check says the migration is missing. Staging 3afa13f, key `paidcampaignplatformlinks`
 * (marketing_campaigns.ads_manager_url): DB step all true, smoke red.
 *
 * So the app reads the same facts from pg_catalog, which does not filter by privilege: same
 * column names and values as information_schema.columns for the five fields peeks use
 * (table_schema, table_name, column_name, data_type, column_default). Proven equal, for every
 * public column as seen by a login that can see them all (the deploy script's owner login), and
 * the staging failure reproduced, by supabase/tests/r2695_migration_peek_login_blind.test.sql —
 * it carries this exact text (peek-sql.test.ts keeps the copies identical). The peek text in
 * each migration is unchanged; only the app swaps the view, so the app's answer no longer
 * depends on which grants its own login happens to hold. (It does not check grants — that a
 * migration is in, not who may use it.)
 */
export const CATALOG_COLUMNS_SQL =
  "(select nc.nspname::text as table_schema, c.relname::text as table_name, a.attname::text as column_name," +
  " case when t.typtype = 'd' then case when bt.typelem <> 0 and bt.typlen = -1 then 'ARRAY'" +
  " when nbt.nspname = 'pg_catalog' then format_type(t.typbasetype, null) else 'USER-DEFINED' end" +
  " else case when t.typelem <> 0 and t.typlen = -1 then 'ARRAY'" +
  " when nt.nspname = 'pg_catalog' then format_type(a.atttypid, null) else 'USER-DEFINED' end end as data_type," +
  " case when a.attgenerated = '' then pg_get_expr(ad.adbin, ad.adrelid) end as column_default" +
  " from pg_catalog.pg_attribute a" +
  " join pg_catalog.pg_class c on c.oid = a.attrelid" +
  " join pg_catalog.pg_namespace nc on nc.oid = c.relnamespace" +
  " join pg_catalog.pg_type t on t.oid = a.atttypid" +
  " join pg_catalog.pg_namespace nt on nt.oid = t.typnamespace" +
  " left join pg_catalog.pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype" +
  " left join pg_catalog.pg_namespace nbt on nbt.oid = bt.typnamespace" +
  " left join pg_catalog.pg_attrdef ad on ad.adrelid = a.attrelid and ad.adnum = a.attnum" +
  " where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'v', 'f', 'p'))";

/* The only shape a peek may use it in — `from information_schema.columns where …` — and only the
   five fields the stand-in has. peek-sql.test.ts holds every generated peek to this, so a new
   peek written another way fails CI instead of turning into a false "missing" on staging. */
const INFO_SCHEMA_COLUMNS = /\bfrom information_schema\.columns where\b/gi;
export const CATALOG_COLUMN_FIELDS = ["table_schema", "table_name", "column_name", "data_type", "column_default"] as const;

export function buildPeekSql(peeks: ReadonlyArray<MigrationPeek>): string {
  for (const p of peeks) {
    if (UNSAFE.test(p.peek)) throw new Error(`migration peek "${p.key}" is not a single expression`);
  }
  const body = peeks.map((p) => `(${p.peek.replace(INFO_SCHEMA_COLUMNS, "from isc_columns where")})`);
  /* Defined once (planned once, materialised once) rather than pasted into ~140 peeks; only when
     a peek uses it, so a list without one is the plain select it always was. */
  const uses = body.some((b) => b.includes("from isc_columns where"));
  const withCatalog = uses ? `with isc_columns as ${CATALOG_COLUMNS_SQL} ` : "";
  return `${withCatalog}select array[${body.join(", ")}]::boolean[] as r`;
}

/** Keys whose answer is not exactly `true` — false, null, or no answer at all. */
export function missingKeys(peeks: ReadonlyArray<MigrationPeek>, values: ReadonlyArray<unknown>): string[] {
  return peeks.filter((_, i) => values[i] !== true).map((p) => p.key);
}
