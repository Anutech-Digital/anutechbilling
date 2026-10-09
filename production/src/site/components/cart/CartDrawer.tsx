"use client";
/**
 * The right-hand cart drawer — opens on every add-to-cart (README "Cart drawer").
 *
 * Backdrop rgba(12,17,22,.34) at z-98, panel 400px / max 92vw at z-99, wSlide in. Header
 * carries the green "<item> added" line — the confirmation that the click did something,
 * on the same surface as the next step, which is the whole reason a drawer beats a toast.
 */
import Link from "@/site/components/ui/SiteLink";
import { useRouter } from "next/navigation";
import { useCart } from "./CartProvider";
import { rupee, cycleLabel, addsAnotherLine, isSingleUnit, isTrialLine, lineDisplayLabel, singleUnitNote } from "@/site/lib/money";
import { DomainYears } from "@/site/components/cart/DomainYears";
import { hostingLimitWarning } from "@/lib/checkout/hosting-limit";

export function CartDrawer() {
  const cart = useCart();
  const router = useRouter();
  if (!cart.drawerOpen || cart.lines.length === 0) return null;

  const t = cart.totals;
  const hostingWarning = hostingLimitWarning(cart.lines);
  const cta =
    cart.lines.length === 1
      ? `Checkout · ${rupee(t.payable)}`
      : `Checkout ${cart.lines.length} items · ${rupee(t.payable)}`;

  return (
    <>
      <div
        onClick={cart.closeDrawer}
        style={{ position: "fixed", inset: 0, background: "rgba(12,17,22,.34)", zIndex: 98, animation: "wFade .18s ease" }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label="Cart"
        style={{
          position: "fixed", top: 0, right: 0, bottom: 0, width: 400, maxWidth: "92vw",
          background: "#fff", zIndex: 99, display: "flex", flexDirection: "column",
          boxShadow: "var(--shadow-drawer)", animation: "wSlide .22s ease",
        }}
      >
        <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border-light)", display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ flex: 1 }}>
            {cart.justAdded && (
              <div className="mono-label" style={{ color: "var(--success)", marginBottom: 4 }}>
                {cart.justAdded} added
              </div>
            )}
            <div style={{ fontSize: 18, fontWeight: 700 }}>Your cart</div>
          </div>
          <button
            onClick={cart.closeDrawer}
            aria-label="Close cart"
            style={{ background: "none", border: "none", fontSize: 18, cursor: "pointer", color: "var(--text-muted)" }}
          >
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "14px 22px" }}>
          {cart.lines.map((l) => (
            <div key={l.key} style={{ padding: "14px 0", borderBottom: "1px solid var(--border-hairline)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{lineDisplayLabel(cart.lines, l)}</div>
                <div style={{ fontSize: 15, fontWeight: 600 }}>{rupee(l.unitPrice * l.qty)}</div>
              </div>
              <div className="meta" style={{ margin: "3px 0 8px" }}>{l.detail}</div>
              <DomainYears line={l} compact />
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span style={{ fontSize: 13, color: l.cycle === "monthly" ? "var(--primary)" : "var(--text-muted)" }}>
                  {isTrialLine(l) ? "Free for 15 days" : (l.years ?? 1) > 1 ? `Renews after ${l.years} years` : cycleLabel(l.cycle)}
                </span>
                <span style={{ flex: 1 }} />
                {/* Locked at 1 for a single-unit line, with the reason beside it (see cart page). */}
                {(() => {
                  const locked = isSingleUnit(l);
                  const another = addsAnotherLine(l); // hosting: "+" adds another plan for another website
                  return (
                    <>
                      {locked && <span className="meta" style={{ fontSize: 12 }}>{singleUnitNote(l)}</span>}
                      <span style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 6 }}>
                        <button onClick={() => cart.setQty(l.key, -1)} disabled={locked} aria-label={`Fewer ${l.label}`} style={locked ? stepBtnLocked : stepBtn}>−</button>
                        <span style={{ padding: "4px 10px", fontSize: 14, minWidth: 26, textAlign: "center" }}>{locked ? 1 : l.qty}</span>
                        <button onClick={() => (another ? cart.addAnother(l.key) : cart.setQty(l.key, 1))} disabled={locked && !another} aria-label={another ? `Add another ${l.label} for another website` : `More ${l.label}`} title={another ? "Add another — for another website" : undefined} style={locked && !another ? stepBtnLocked : stepBtn}>+</button>
                      </span>
                    </>
                  );
                })()}
                <button
                  onClick={() => cart.remove(l.key)}
                  style={{ background: "none", border: "none", color: "var(--danger)", fontSize: 13, cursor: "pointer", minHeight: 44, padding: "0 6px" }}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          <p className="meta" style={{ marginTop: 14 }}>
            Migration from your current provider is free on every plan — we do it, outside your business hours.
          </p>
        </div>

        <div style={{ background: "var(--tint-2)", borderTop: "1px solid var(--border-light)", padding: "16px 22px" }}>
          {t.discount > 0 && (
            <Row label="Discount" value={`−${rupee(t.discount)}`} color="var(--success)" />
          )}
          <Row label="Subtotal" value={rupee(t.subtotal)} />
          <Row label="GST 18%" value={rupee(t.gst)} />
          <Row label="Payable" value={rupee(t.payable)} bold />
          {t.recurring > 0 && (
            <div className="meta" style={{ margin: "6px 0 4px" }}>
              Then {rupee(t.recurring * 1.18)}/month from next month, GST included
            </div>
          )}
          {hostingWarning && (
            <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "10px 12px", fontSize: 13, marginTop: 10 }}>
              {hostingWarning}
            </div>
          )}
          <button
            className="btn btn-primary"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => {
              cart.closeDrawer();
              router.push("/checkout" as never);
            }}
          >
            {cta}
          </button>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
            <Link href="/cart" onClick={cart.closeDrawer} style={{ fontSize: 14, color: "var(--primary)", fontWeight: 500 }}>
              View full cart
            </Link>
            <button
              onClick={cart.closeDrawer}
              style={{ background: "none", border: "none", fontSize: 14, color: "var(--text-muted)", cursor: "pointer" }}
            >
              Keep shopping
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

// 44px tap targets (CLAUDE.md §20, 9 Oct 2026) — the drawer's stepper was 28px wide.
const stepBtn: React.CSSProperties = {
  background: "none",
  border: "none",
  width: 44,
  minHeight: 44,
  fontSize: 17,
  cursor: "pointer",
  color: "var(--text-secondary)",
};
const stepBtnLocked: React.CSSProperties = { ...stepBtn, cursor: "not-allowed", opacity: 0.35 };

function Row({ label, value, color, bold }: { label: string; value: string; color?: string; bold?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: bold ? 17 : 14, fontWeight: bold ? 700 : 400, color: color ?? (bold ? "var(--text)" : "var(--text-secondary)"), padding: "2px 0" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
