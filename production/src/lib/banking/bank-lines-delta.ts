/**
 * R-2524 — after a reconcile save, read only the bank lines that CHANGED, not the whole account.
 *
 * 6 Nov 2026: HDFC ··4523 has 5,170 lines and every save re-read all of them. Since migration
 * *_r2524_bank_lines_touch_updated_at every UPDATE moves a line's updated_at (inserts keep their
 * now() default), so a refetch can ask for "lines of this account with updated_at >= newest seen
 * − 10 min" plus the account's row count, and merge:
 *   - changed / new lines replace or join the old ones (unchanged lines keep their OBJECT, so the
 *     page's per-line answers stay cached — lib/banking/line-memo);
 *   - the merged count must equal the server's count — a deleted line (or a line moved to another
 *     account) breaks that, and the whole account is read again;
 *   - and the whole account is read again at least every FULL_EVERY_MS anyway.
 * Order is the full read's: txn_date newest first, then id.
 */
export interface DeltaLine { id: string; txn_date: string; updated_at: string }

/** Lines changed this long before the newest one we hold are read again (slow transactions). */
export const DELTA_MARGIN_MS = 10 * 60_000;
/** A full read at least this often, whatever the deltas say. */
export const FULL_EVERY_MS = 10 * 60_000;

/** The `updated_at >=` bound for the delta read, or null when a full read is needed. */
export function deltaSince(prev: readonly DeltaLine[]): string | null {
  let newest = Number.NEGATIVE_INFINITY;
  for (const l of prev) {
    const t = Date.parse(l.updated_at);
    if (Number.isFinite(t) && t > newest) newest = t;
  }
  if (!Number.isFinite(newest)) return null;
  return new Date(newest - DELTA_MARGIN_MS).toISOString();
}

/** Same order as fetchBankTransactions: txn_date desc, then id asc. */
export function byLedgerReadOrder(a: DeltaLine, b: DeltaLine): number {
  if (a.txn_date !== b.txn_date) return a.txn_date < b.txn_date ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * prev + changed → the account's lines, or null when the result cannot be trusted (count differs)
 * and the caller must read everything. Unchanged lines are the same objects as in `prev`.
 */
export function mergeDelta<T extends DeltaLine>(prev: readonly T[], changed: readonly T[], serverCount: number): T[] | null {
  if (changed.length === 0) return prev.length === serverCount ? (prev as T[]) : null;
  const byId = new Map(prev.map((l) => [l.id, l]));
  let reorder = false;
  for (const c of changed) {
    const old = byId.get(c.id);
    if (!old || old.txn_date !== c.txn_date) reorder = true;
    byId.set(c.id, c);
  }
  if (byId.size !== serverCount) return null;
  if (!reorder) return prev.map((l) => byId.get(l.id) as T);
  return [...byId.values()].sort(byLedgerReadOrder);
}

/** Per account: when the last full read finished (ms). */
const lastFull = new Map<string, number>();

/**
 * One refetch of an account's lines. `prev` is what the cache holds (undefined on first load).
 * The three reads are given by the caller (bank.ts) so this file has no Supabase import.
 */
export async function readBankLines<T extends DeltaLine>(
  accountId: string,
  prev: readonly T[] | undefined,
  io: {
    full: () => Promise<T[]>;
    changedSince: (sinceIso: string) => Promise<T[]>;
    count: () => Promise<number>;
  },
  now = Date.now(),
): Promise<T[]> {
  const fullRead = async () => {
    const rows = await io.full();
    lastFull.set(accountId, Date.now());
    return rows;
  };
  const since = prev && prev.length > 0 ? deltaSince(prev) : null;
  const last = lastFull.get(accountId);
  if (!prev || since === null || last === undefined || now - last > FULL_EVERY_MS) return fullRead();
  const [changed, count] = await Promise.all([io.changedSince(since), io.count()]);
  return mergeDelta(prev, changed, count) ?? fullRead();
}

/** Tests only: forget the full-read times. */
export function resetDeltaState(): void {
  lastFull.clear();
}
