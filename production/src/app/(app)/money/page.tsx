/**
 * /money — the personal login's Money row (GP-07a, R-2115).
 *
 * The money screens themselves already exist at /vault/personal (Overview, Banking, Expenses,
 * Wealth — per-user RLS on personal_*). This route is the short, plain name the Personal menu
 * and ROLE_HOME.personal use; it only forwards there. nav.ts's Money row `covers`
 * /vault/personal, so a personal login may open those pages and never the company /vault.
 */
import { redirect } from "next/navigation";

export default function MoneyPage(): never {
  redirect("/vault/personal");
}
