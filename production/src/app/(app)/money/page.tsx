/**
 * /money — the personal login's Money row (GP-07a, R-2115).
 *
 * The money screens themselves already exist at /vault/personal (Overview, Banking, Expenses,
 * Wealth — per-user RLS on personal_*). This route is the short, plain name the Personal menu
 * and ROLE_HOME.personal use; it only forwards there. nav.ts's Money row `covers`
 * /vault/personal, so a personal login may open those pages and never the company /vault.
 *
 * The query goes along (R-2115 checker, 30 Oct 2026): middleware sends a refused URL to
 * /money?denied=<path>, and the "You don't have access" toast (denied-route-toast.tsx) reads
 * that param on the page it lands on — dropping it here meant the toast never showed.
 */
import { redirect } from "next/navigation";

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MoneyPage({ searchParams }: { searchParams: Promise<SearchParams> }): Promise<never> {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) qs.append(key, v);
  }
  const query = qs.toString();
  redirect(query ? `/vault/personal?${query}` : "/vault/personal");
}
