/**
 * R-1797 — one line on the cart page and checkout when a saved line's price moved to the
 * price book's (CartProvider re-prices on open): "Price changed: Starter hosting ₹600 → ₹610.
 * The total below is what you will pay." Nothing when nothing changed.
 */
import { priceChangeNotice, type PriceChange } from "@/site/lib/cart-reprice";

export function PriceChangeNotice({ changes }: { changes?: readonly PriceChange[] }) {
  const text = priceChangeNotice(changes ?? []);
  if (!text) return null;
  return (
    /* The same amber box the cart's hosting-limit alert uses. */
    <p role="status" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, margin: "0 0 16px" }}>
      {text}
    </p>
  );
}
