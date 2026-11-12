/**
 * R-2351 (G-DPDP) — seal the OAuth / provider tokens that are still PLAINTEXT in the database.
 *
 * Since R-051 / R-1884 / R-2351 the app writes every token as a `rosv1:` envelope
 * (lib/crypto/vault.ts, SECRETS_MASTER_KEY) and reads legacy plaintext through, sealing a row
 * only when it is next written. Rows nobody touches stay plain for ever — this seals them in
 * one pass. Same column, same envelope: the app needs no change to read the result.
 *
 * SAFETY
 *   - Dry run by default: COUNTS only (per table.column: total / sealed / plain). Never a value.
 *   - --apply needs a valid SECRETS_MASTER_KEY that PROVABLY is the app's key: it must open the
 *     envelopes already in the table before anything is written (wrong key → stop, 0 rows
 *     written). With no envelope anywhere to prove it against, --first-seal is required.
 *   - Each value is sealed, opened again and compared before its UPDATE, and the UPDATE only
 *     lands when the column still holds the plaintext it read (`and col = $old`) — a row the app
 *     re-wrote in the meantime is skipped, never overwritten.
 *   - Running it twice is harmless: the second run finds 0 plain values.
 *
 * The envelope code below is byte-compatible with lib/crypto/vault.ts (tests/ops/
 * reseal-oauth-tokens.test.ts seals with each and opens with the other). It is repeated here
 * because ops scripts are plain Node (CI runs Node 20, which cannot import .ts).
 */
import crypto from "node:crypto";

/**
 * Every column that holds a provider credential. tenant_secrets' list must equal SECRET_COLUMNS
 * in src/lib/crypto/tenant-secrets.ts (the test fails when they drift).
 */
export const TARGETS = [
  { table: "user_google_tokens", key: "user_id", columns: ["access_token", "refresh_token"] },
  { table: "ad_accounts", key: "id", columns: ["access_token"] },
  {
    table: "tenant_secrets", key: "tenant_id", columns: [
      "razorpay_key_secret", "razorpay_webhook_secret", "gemini_api_key",
      "whatsapp_access_token", "whatsapp_app_secret", "whatsapp_verify_token",
      "sandbox_api_secret", "resend_api_key", "indiamart_crm_key",
      "zoho_books_refresh_token", "zoho_books_access_token", "meta_capi_token",
      "linkedin_access_token", "linkedin_ads_client_secret",
      "facebook_page_pending_token", "facebook_page_access_token",
    ],
  },
];

const PREFIX = "rosv1";
const ALGO = "aes-256-gcm";
const b64 = (b) => b.toString("base64url");
const ub64 = (s) => Buffer.from(s, "base64url");

export const KEY_MISSING_MESSAGE =
  "SECRETS_MASTER_KEY is not set (or is not 32 bytes of base64) — nothing was written. "
  + "Use the SAME key the app uses on this server (Secret Manager), never a new one.";
export const WRONG_KEY_MESSAGE =
  "SECRETS_MASTER_KEY does not open the tokens already sealed in this database — it is not this "
  + "server's key. Nothing was written. Use the key the app runs with.";

export class ResealRefused extends Error {
  constructor(message, exitCode) { super(message); this.name = "ResealRefused"; this.exitCode = exitCode; }
}

/** 32-byte key from base64, or null. Same rule as vault.ts masterKey(). */
export function parseMasterKey(raw) {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!s) return null;
  const key = Buffer.from(s, "base64");
  return key.length === 32 ? key : null;
}

export const isSealed = (v) => typeof v === "string" && v.startsWith(`${PREFIX}:`);

/** Seal exactly like vault.ts encryptSecret (per-value DEK wrapped by the master key). */
export function seal(plaintext, master) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c1 = crypto.createCipheriv(ALGO, dek, iv);
  const ct = Buffer.concat([c1.update(plaintext, "utf8"), c1.final()]);
  const tag = c1.getAuthTag();
  const wIv = crypto.randomBytes(12);
  const c2 = crypto.createCipheriv(ALGO, master, wIv);
  const wrapped = Buffer.concat([c2.update(dek), c2.final()]);
  const wTag = c2.getAuthTag();
  return [PREFIX, b64(wIv), b64(wTag), b64(wrapped), b64(iv), b64(tag), b64(ct)].join(":");
}

/** Open an envelope (throws on a wrong key / tampering). Plaintext passes through. */
export function open(stored, master) {
  if (!isSealed(stored)) return stored;
  const parts = stored.split(":");
  if (parts.length !== 7) throw new Error("malformed envelope");
  const [, wIvB, wTagB, wrappedB, ivB, tagB, ctB] = parts;
  const d2 = crypto.createDecipheriv(ALGO, master, ub64(wIvB));
  d2.setAuthTag(ub64(wTagB));
  const dek = Buffer.concat([d2.update(ub64(wrappedB)), d2.final()]);
  const d1 = crypto.createDecipheriv(ALGO, dek, ub64(ivB));
  d1.setAuthTag(ub64(tagB));
  return Buffer.concat([d1.update(ub64(ctB)), d1.final()]).toString("utf8");
}

/**
 * db adapter (the CLI wires it to pg; tests use an in-memory fake):
 *   hasColumn(table, col)                 → boolean
 *   counts(table, col)                    → { total, sealed }   (non-empty values only)
 *   sampleSealed(table, col, n)           → string[]            (up to n envelopes)
 *   plainBatch(table, key, col, limit)    → [{ id, value }]     (non-empty, not rosv1:)
 *   updateIf(table, key, col, id, old, next) → boolean          (true when the row changed)
 */
export async function countReport(db) {
  const rows = [];
  for (const t of TARGETS) {
    for (const col of t.columns) {
      if (!(await db.hasColumn(t.table, col))) { rows.push({ table: t.table, column: col, missing: true }); continue; }
      const { total, sealed } = await db.counts(t.table, col);
      rows.push({ table: t.table, column: col, total, sealed, plain: total - sealed });
    }
  }
  return rows;
}

/** Does `master` open the envelopes already stored? → { checked, failed }. */
export async function checkKey(db, master, perColumn = 3) {
  let checked = 0, failed = 0;
  for (const t of TARGETS) {
    for (const col of t.columns) {
      if (!(await db.hasColumn(t.table, col))) continue;
      for (const v of await db.sampleSealed(t.table, col, perColumn)) {
        checked++;
        try { open(v, master); } catch { failed++; }
      }
    }
  }
  return { checked, failed };
}

export async function resealAll(db, master, { batchSize = 100, maxBatches = 10_000 } = {}) {
  const result = [];
  for (const t of TARGETS) {
    for (const col of t.columns) {
      if (!(await db.hasColumn(t.table, col))) continue;
      let sealedNow = 0, skipped = 0, batches = 0;
      const seen = new Set();
      for (;;) {
        if (++batches > maxBatches) throw new Error(`${t.table}.${col}: more than ${maxBatches} batches — stopped`);
        const batch = (await db.plainBatch(t.table, t.key, col, batchSize)).filter((r) => !seen.has(String(r.id)));
        if (!batch.length) break;
        for (const { id, value } of batch) {
          seen.add(String(id));
          const next = seal(value, master);
          if (open(next, master) !== value) throw new Error(`${t.table}.${col}: seal did not round-trip — stopped`);
          if (await db.updateIf(t.table, t.key, col, id, value, next)) sealedNow++; else skipped++;
        }
      }
      result.push({ table: t.table, column: col, sealed: sealedNow, skippedChanged: skipped });
    }
  }
  return result;
}

export function parseArgs(argv) {
  const get = (name) => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : true;
  };
  return {
    apply: get("apply") === true,
    confirm: typeof get("confirm") === "string" ? get("confirm") : null,
    firstSeal: get("first-seal") === true,
    batch: Number(get("batch") ?? 100) || 100,
    dbUrlEnv: typeof get("db-url-env") === "string" ? get("db-url-env") : "DATABASE_URL",
  };
}

export const CONFIRM_WORD = "RESEAL";

/**
 * The whole run, minus the connection. Returns the exit code; `log` gets counts only.
 * Exit: 0 ok · 2 refused (no/invalid key, no --confirm, unprovable key) · 3 wrong key.
 */
export async function run({ argv, env, db, log }) {
  const a = parseArgs(argv);
  const report = await countReport(db);
  log(`${a.apply ? "APPLY" : "DRY RUN"} — plaintext tokens per column (counts only, never values):`);
  for (const r of report) {
    log(r.missing
      ? `  ${r.table}.${r.column}: column not in this database — skipped`
      : `  ${r.table}.${r.column}: total ${r.total}, sealed ${r.sealed}, plain ${r.plain}`);
  }
  const plainTotal = report.reduce((s, r) => s + (r.plain ?? 0), 0);
  log(`  => ${plainTotal} plaintext value(s) to seal`);

  const master = parseMasterKey(env.SECRETS_MASTER_KEY);
  if (!a.apply) {
    if (master) {
      const k = await checkKey(db, master);
      log(k.failed ? `  key check: WRONG KEY (${k.failed}/${k.checked} envelopes do not open)`
        : k.checked ? `  key check: ok (${k.checked} envelopes open)` : "  key check: no envelopes yet to prove the key against");
    } else {
      log("  key check: SECRETS_MASTER_KEY not set — fine for a dry run, required for --apply");
    }
    log("Nothing was written (dry run). To seal: add --apply --confirm=RESEAL (with Pardeep's OK).");
    return 0;
  }

  if (a.confirm !== CONFIRM_WORD) throw new ResealRefused(`--apply needs --confirm=${CONFIRM_WORD}. Nothing was written.`, 2);
  if (!master) throw new ResealRefused(KEY_MISSING_MESSAGE, 2);
  const k = await checkKey(db, master);
  if (k.failed) throw new ResealRefused(WRONG_KEY_MESSAGE, 3);
  if (!k.checked && !a.firstSeal) {
    throw new ResealRefused("No sealed token exists yet to prove this is the app's key. Re-run with --first-seal only if you are sure it is. Nothing was written.", 2);
  }
  if (!plainTotal) { log("Nothing to seal."); return 0; }
  const done = await resealAll(db, master, { batchSize: a.batch });
  for (const r of done) log(`  sealed ${r.table}.${r.column}: ${r.sealed}${r.skippedChanged ? ` (skipped ${r.skippedChanged} changed meanwhile)` : ""}`);
  const after = await countReport(db);
  const left = after.reduce((s, r) => s + (r.plain ?? 0), 0);
  log(`  => plaintext left: ${left}`);
  return 0;
}
