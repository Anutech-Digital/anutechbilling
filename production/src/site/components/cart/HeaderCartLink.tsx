"use client";
/**
 * R-1966: the cart link for a page OUTSIDE the (marketing) layout that still uses the website
 * cart (/buy/workspace) — the count of lines, like the website header (chrome/Header.tsx).
 * Drawn in the app's Tailwind tokens, since that page is.
 */
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { useCart } from "./CartProvider";

export function HeaderCartLink() {
  const cart = useCart();
  const n = cart.lines.length;
  return (
    <Link
      href="/cart"
      aria-label={`Cart, ${n} item${n === 1 ? "" : "s"}`}
      className="inline-flex items-center gap-2 h-9 px-3 rounded-md border border-hairline text-sm font-semibold text-ink hover:bg-paper-2 transition-colors shrink-0"
    >
      <Icon name="cart" size={16} />
      <span className="hidden sm:inline">Cart</span>
      <span
        data-testid="header-cart-count"
        className={`font-mono text-xs min-w-[20px] text-center px-1.5 rounded-full ${n ? "bg-amber text-paper" : "bg-paper-2 text-ink-3"}`}
      >
        {n}
      </span>
    </Link>
  );
}
