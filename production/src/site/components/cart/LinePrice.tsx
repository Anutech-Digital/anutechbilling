/**
 * A cart line's price as charged NOW (R-1601) — the drawer, the cart page and the checkout
 * summary show the same figure, from priceCart() in site/lib/money: the yearly-hosting bundle
 * is worked out from the current cart on every render, so the line's own full price is shown
 * struck through beside the bundle price, with the reason underneath.
 */
import { rupee, type PricedLine } from "@/site/lib/money";

export function LinePrice({ p, size = 15 }: { p: PricedLine; size?: number }) {
  const full = p.line.unitPrice * p.line.qty;
  return (
    <span style={{ fontSize: size, fontWeight: 600, whiteSpace: "nowrap" }}>
      {p.total < full && (
        <span style={{ fontWeight: 400, color: "var(--text-muted)", textDecoration: "line-through", marginRight: 6 }}>{rupee(full)}</span>
      )}
      {rupee(p.total)}
    </span>
  );
}

/** "Free with yearly hosting" under a line's detail, or nothing. */
export function BundleNote({ p }: { p: PricedLine }) {
  if (!p.freeNote) return null;
  return (
    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--success)", margin: "2px 0" }}>{p.freeNote}</div>
  );
}
