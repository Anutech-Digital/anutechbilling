/**
 * Bulk-order helpers — pure, unit-tested. A bulk order is one quote line that
 * covers MANY domains (e.g. Google Workspace on 1000 domains). On payment, the
 * record_payment RPC expands it into one subscription per domain.
 *
 * MONEY-CORRECTNESS: `splitMrr` is a faithful TypeScript twin of the pl/pgSQL in
 * migration 0075_record_payment_bulk_expand.sql. Both use the same largest-
 * remainder method so the per-domain MRR shares always sum to EXACTLY the pool
 * (no rounding leak). Keep the two implementations textually identical.
 */
import type { QuoteLineItem, LineCommitment } from "@/lib/supabase/database.types";

export interface DomainSeat {
  domain: string;
  seats: number;
}

/** Lowercase + strip protocol/www/path so the same domain always matches. */
export function normDomain(s: string): string {
  return (s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

/**
 * Normalize a raw list of (domain, seats) into a clean, deduped list:
 * lowercased domains, blanks dropped, seats floored to >= 0, and duplicate
 * domains MERGED by summing their seats (prevents the per-(quote,domain) unique
 * index from colliding on payment).
 */
export function dedupeDomains(rows: Array<{ domain: string; seats: number }>): DomainSeat[] {
  const byDomain = new Map<string, number>();
  const order: string[] = [];
  for (const r of rows) {
    const d = normDomain(r.domain);
    const seats = Math.max(0, Math.floor(Number(r.seats) || 0));
    if (!d) continue;
    if (!byDomain.has(d)) order.push(d);
    byDomain.set(d, (byDomain.get(d) ?? 0) + seats);
  }
  return order.map((d) => ({ domain: d, seats: byDomain.get(d) ?? 0 }));
}

/**
 * Build ONE bulk quote line covering many domains. qty = sum of all seats so the
 * builder's existing `qty × rate` totals math needs no change.
 */
export function buildBulkLine(
  plan: { id: string; item_id?: string; name: string; cost: number },
  rate: number,
  rawDomains: Array<{ domain: string; seats: number }>,
  commitment: LineCommitment = "annual_yearly",
): QuoteLineItem {
  const domains = dedupeDomains(rawDomains);
  const qty = domains.reduce((s, d) => s + d.seats, 0);
  return {
    id: plan.id,
    item_id: plan.item_id,
    name: plan.name,
    qty,
    rate,
    cost: plan.cost,
    commitment,
    bulk: true,
    domains,
  };
}

/**
 * Split an integer `pool` (e.g. the bulk line's monthly MRR) across domains by
 * their seat proportion, so the shares sum to EXACTLY `pool`.
 *
 * Largest-remainder / Hamilton method: every domain except the last gets
 * floor(pool × seats / totalSeats); the LAST domain absorbs the rounding
 * remainder. Guarantees Σ(shares) === pool, every share >= 0, deterministic.
 *
 * @returns array aligned to `domains` (same order, same length).
 */
export function splitMrr(pool: number, domains: DomainSeat[]): number[] {
  const n = domains.length;
  if (n === 0) return [];
  const totalSeats = domains.reduce((s, d) => s + d.seats, 0);
  const out: number[] = new Array(n).fill(0);
  if (pool <= 0 || totalSeats <= 0) return out;   // nothing to split (also avoids /0)

  let running = 0;
  for (let i = 0; i < n; i++) {
    if (i < n - 1) {
      const share = Math.floor((pool * domains[i].seats) / totalSeats);
      out[i] = share;
      running += share;
    } else {
      out[i] = pool - running;   // last domain absorbs the remainder → exact sum
    }
  }
  return out;
}

/**
 * R-482 / board R-469 (3): rows the bulk dialog must refuse before adding — a name that is
 * not a domain ("kapoor global") and the same domain typed twice were both accepted silently
 * (the duplicate's seats were just added together).
 */
const BULK_DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function bulkDomainProblems(rows: ReadonlyArray<{ domain: string }>): { invalid: string[]; duplicates: string[] } {
  const invalid: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const raw = (r.domain ?? "").trim();
    if (!raw) continue;
    const d = normDomain(raw);
    if (!BULK_DOMAIN_RE.test(d)) { invalid.push(raw); continue; }
    if (seen.has(d)) { if (!duplicates.includes(d)) duplicates.push(d); continue; }
    seen.add(d);
  }
  return { invalid, duplicates };
}
