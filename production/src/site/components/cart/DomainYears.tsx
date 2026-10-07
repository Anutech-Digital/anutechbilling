"use client";
/**
 * Registration term picker on a domain cart line (R-156): 1, 2, 3 or 5 years — only the
 * terms the registry priced for this name (the search put them on the line). With one
 * term known it renders nothing, so a domain the registry prices for a year only stays a
 * plain one-year line. The checkout re-prices the chosen term; this is the visitor's view.
 */
import { useCart } from "@/site/components/cart/CartProvider";
import { domainTermPrice, rupee, type CartLine } from "@/site/lib/money";

export function DomainYears({ line, compact = false }: { line: CartLine; compact?: boolean }) {
  const cart = useCart();
  if (!(line.sku ?? "").startsWith("domain:")) return null;
  const terms = Object.keys(line.yearPrices ?? {}).map(Number).filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
  if (terms.length < 2) return null;
  const current = line.years ?? 1;
  const id = `years-${line.key}`;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, marginTop: compact ? 6 : 8 }}>
      <label htmlFor={id} style={{ fontSize: 13, color: "var(--text-muted)" }}>Register for</label>
      <select
        id={id}
        value={current}
        onChange={(e) => cart.setYears(line.key, Number(e.target.value))}
        style={{ border: "1px solid var(--border-strong)", borderRadius: 6, padding: compact ? "4px 8px" : "6px 10px", minHeight: compact ? undefined : 44, fontSize: 14, background: "#fff" }}
      >
        {terms.map((t) => {
          const price = domainTermPrice(line.yearPrices, t, line.bundleFree);
          return (
            <option key={t} value={t}>
              {t} year{t === 1 ? "" : "s"}{price !== null ? ` — ${rupee(price)}` : ""}
            </option>
          );
        })}
      </select>
    </span>
  );
}
