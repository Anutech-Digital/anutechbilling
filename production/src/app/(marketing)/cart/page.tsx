"use client";
/**
 * The full cart page. Empty state with a dashed border and a CTA; otherwise 1.5fr .8fr —
 * lines with unit line + cycle label + stepper on the left, the coupon/summary card on the
 * right. The critical line from the handoff: whenever recurring items exist, say plainly
 * "Then ₹X/month from next month, GST included" — a cart that hides the recurring half of
 * the price is the dark pattern this whole site positions against.
 */
import Link from "@/site/components/ui/SiteLink";
import { useRouter } from "next/navigation";
import { useCart } from "@/site/components/cart/CartProvider";
import { rupee, cycleLabel, couponRate, isSingleUnit, isTrialLine, singleUnitNote } from "@/site/lib/money";
import { DomainYears } from "@/site/components/cart/DomainYears";
import { hostingLimitWarning } from "@/lib/checkout/hosting-limit";

export default function CartPage() {
  const cart = useCart();
  const router = useRouter();
  const t = cart.totals;
  const hostingWarning = hostingLimitWarning(cart.lines);
  const code = cart.coupon.trim().toUpperCase();
  const couponValid = couponRate(code) > 0;

  if (cart.lines.length === 0) {
    return (
      <section className="section rise">
        <div className="wrap" style={{ maxWidth: 720 }}>
          <h1 className="h1-narrow" style={{ marginBottom: 24 }}>Your cart</h1>
          <div style={{ border: "1px dashed var(--border-strong)", borderRadius: 10, padding: 48, textAlign: "center" }}>
            <p className="body-lg" style={{ margin: "0 0 18px" }}>Nothing in it yet.</p>
            <Link href="/email" className="btn btn-primary">See the catalogue</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section rise">
      <div className="wrap" style={{ display: "grid", gridTemplateColumns: "1.5fr .8fr", gap: 40, alignItems: "start" }} data-grid>
        <div>
          <h1 className="h1-narrow" style={{ marginBottom: 24 }}>Your cart</h1>
          {cart.lines.map((l) => (
            <div key={l.key} style={{ display: "flex", gap: 16, padding: "18px 0", borderBottom: "1px solid var(--border-hairline)", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 240px" }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{l.label}</div>
                <div className="meta" style={{ margin: "2px 0" }}>{l.detail}</div>
                {!isTrialLine(l) && (
                  (l.years ?? 1) > 1
                    ? <div className="meta">{rupee(l.unitPrice)} for {l.years} years</div>
                    : <div className="meta">{l.qty} × {rupee(l.unitPrice)} per {l.unit}</div>
                )}
                <DomainYears line={l} />
                <div style={{ fontSize: 13, marginTop: 2, color: l.cycle === "monthly" ? "var(--primary)" : "var(--text-muted)" }}>
                  {isTrialLine(l) ? `Free for 15 days · one trial per customer` : (l.years ?? 1) > 1 ? `Renews after ${l.years} years, then yearly` : cycleLabel(l.cycle)}
                </div>
              </div>
              {/* Every line shows the quantity control; a single-unit line shows it LOCKED
                  at 1, with the reason underneath (a locked control with no reason is the
                  silent-disabled shape guarded by src/site/silent-disabled-buttons.test.ts). */}
              {(() => {
                const locked = isSingleUnit(l);
                return (
                  <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", alignSelf: "center", gap: 3 }}>
                    <span style={{ display: "inline-flex", border: "1px solid var(--border-strong)", borderRadius: 6, background: locked ? "var(--surface-muted, #F4F6F8)" : undefined }}>
                      <button onClick={() => cart.setQty(l.key, -1)} disabled={locked} aria-label={`Fewer ${l.label}`} style={locked ? stepLocked : step}>−</button>
                      <span style={{ padding: "6px 12px", fontSize: 15, minWidth: 30, textAlign: "center" }}>{locked ? 1 : l.qty}</span>
                      <button onClick={() => cart.setQty(l.key, 1)} disabled={locked} aria-label={`More ${l.label}`} style={locked ? stepLocked : step}>+</button>
                    </span>
                    {locked && <span className="meta" style={{ fontSize: 12 }}>{singleUnitNote(l)}</span>}
                  </span>
                );
              })()}
              <div style={{ alignSelf: "center", fontSize: 17, fontWeight: 700, minWidth: 90, textAlign: "right" }}>
                {rupee(l.unitPrice * l.qty)}
              </div>
              <button
                onClick={() => cart.remove(l.key)}
                style={{ alignSelf: "center", background: "none", border: "none", color: "var(--danger)", fontSize: 14, cursor: "pointer" }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>

        {/* Sticky, quote page ke estimate jaisa — lambi cart me total hamesha dikhe. */}
        <aside className="card" style={{ position: "sticky", top: 84 }}>
          <label htmlFor="cart-coupon" className="mono-label" style={{ color: "var(--text-muted)", display: "block", marginBottom: 8 }}>COUPON</label>
          <input
            id="cart-coupon"
            value={cart.coupon}
            onChange={(e) => cart.setCoupon(e.target.value)}
            placeholder="Enter code"
            aria-label="Coupon code"
            style={{ width: "100%", border: "1px solid var(--border-strong)", borderRadius: 6, padding: "10px 12px", fontSize: 15, fontFamily: "var(--font-mono)", textTransform: "uppercase" }}
          />
          {/* R-225: never name a code here — coupons are given out, not advertised. */}
          <div className="meta" style={{ margin: "6px 0 16px", color: code && !couponValid ? "var(--danger)" : "var(--text-muted)" }}>
            {code && !couponValid
              ? "That code is not valid."
              : couponValid && t.discount === 0
                ? "Coupons don't apply to domain names."
                : "Have a coupon code?"}
          </div>

          {t.discount > 0 && <Row label={`${code} — ${Math.round(t.discountRate * 100)}% off`} value={`−${rupee(t.discount)}`} color="var(--success)" />}
          <Row label="Subtotal" value={rupee(t.subtotal)} />
          <Row label="GST 18%" value={rupee(t.gst)} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 0" }}>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Payable now</span>
            <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>{rupee(t.payable)}</span>
          </div>
          {t.recurring > 0 && (
            <div className="meta" style={{ marginBottom: 10 }}>
              Then {rupee(t.recurring * 1.18)}/month from next month, GST included
            </div>
          )}
          {hostingWarning && (
            <div role="alert" style={{ background: "#FFFBEB", border: "1px solid #FDE68A", color: "#92400E", borderRadius: 8, padding: "11px 14px", fontSize: 14, marginBottom: 12 }}>
              {hostingWarning}
            </div>
          )}
          <button className="btn btn-primary" style={{ width: "100%" }} onClick={() => router.push("/checkout" as never)}>
            Checkout
          </button>
        </aside>
      </div>
    </section>
  );
}

const step: React.CSSProperties = { background: "none", border: "none", width: 32, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" };
const stepLocked: React.CSSProperties = { ...step, cursor: "not-allowed", opacity: 0.35 };

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, padding: "3px 0", color: color ?? "var(--text-secondary)" }}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}
