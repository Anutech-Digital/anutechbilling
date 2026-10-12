/* eslint-disable */
// B1 — Marketing Landing

function LandingScreen() {
  const { go } = useRouter();
  const { toast } = useToast();

  return (
    <div className="landing-root">
      {/* Top nav */}
      <div className="landing-nav">
        <div className="landing-brand">
          <div className="rail-mark">R</div>
          <span className="serif" style={{ fontSize: 20 }}>ResellerOS</span>
        </div>
        <div className="row" style={{ gap: 6 }}>
          <Btn kind="ghost">Pricing</Btn>
          <Btn kind="ghost">Customers</Btn>
          <Btn kind="ghost">Docs</Btn>
          <Btn kind="default">Sign in</Btn>
          <Btn kind="primary" icon="play" onClick={() => toast("Demo video coming up")}>Watch demo</Btn>
        </div>
      </div>

      {/* Hero */}
      <section className="landing-hero">
        <div className="landing-eyebrow">For Indian SaaS resellers</div>
        <h1 className="landing-h1">
          Your reseller business,<br />
          <em className="serif" style={{ fontStyle: "italic" }}>on autopilot.</em>
        </h1>
        <p className="landing-sub">
          Sell, provision, bill and renew Google Workspace, Microsoft 365 and Zoho — all in one platform.
          Built for Indian resellers with GST, WhatsApp and Razorpay baked in.
        </p>
        <div className="row" style={{ gap: 10, justifyContent: "center" }}>
          <Btn kind="primary" size="lg" iconRight="arrow_right" onClick={() => go("dashboard")}>Start free trial</Btn>
          <Btn kind="default" size="lg" icon="play">Watch 2-min demo</Btn>
        </div>
        <div style={{ marginTop: 16, fontSize: 12, color: "var(--ink-3)" }}>
          No credit card · 14-day trial · Bring your existing data
        </div>
      </section>

      {/* Vendor cards */}
      <section className="landing-section">
        <div className="rail-label" style={{ textAlign: "center", padding: 0, marginBottom: 14 }}>Choose your vendor</div>
        <div className="grid grid-3" style={{ maxWidth: 920, margin: "0 auto" }}>
          {[
            { v: "google",    name: "Google Workspace", price: 136, sub: "Starter" },
            { v: "microsoft", name: "Microsoft 365",    price: 200, sub: "Business Basic" },
            { v: "zoho",      name: "Zoho Workplace",   price: 120, sub: "Standard" },
          ].map(p => (
            <div key={p.v} className="card vendor-card">
              <div className={`vendor-square ${p.v}`}>
                <span className="v-letter">{p.v[0].toUpperCase()}</span>
              </div>
              <h3 className="serif" style={{ fontSize: 22, margin: "12px 0 4px" }}>{p.name}</h3>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{p.sub}</div>
              <div className="serif tnum" style={{ fontSize: 30, color: "var(--amber)", marginTop: 16 }}>
                {rupee(p.price)}<span style={{ fontSize: 13, color: "var(--ink-3)", fontFamily: "var(--font-sans)" }}> /user/mo</span>
              </div>
              <Btn kind="default" iconRight="arrow_right" style={{ marginTop: 14 }}>Explore plans</Btn>
            </div>
          ))}
        </div>
      </section>

      {/* Why us */}
      <section className="landing-section surface-paper" style={{ background: "var(--paper-2)", padding: "64px 24px" }}>
        <div style={{ maxWidth: 920, margin: "0 auto" }}>
          <div className="rail-label" style={{ padding: 0, marginBottom: 6 }}>Why Demo Co</div>
          <h2 className="serif" style={{ fontSize: 40, margin: "0 0 28px", letterSpacing: "-0.02em" }}>
            Authorized. Local. Reliable.
          </h2>
          <div className="grid grid-2" style={{ gap: 18 }}>
            {[
              "Google Authorized Reseller — 10+ years",
              "500+ Indian businesses migrated",
              "24×7 India-based support",
              "Free DNS, MX, SPF, DKIM setup",
              "GST-compliant invoicing",
              "WhatsApp & Razorpay billing",
            ].map(t => (
              <div key={t} className="row" style={{ alignItems: "flex-start", gap: 10, fontSize: 15 }}>
                <div style={{ width: 22, height: 22, borderRadius: 999, background: "var(--emerald-soft)", color: "var(--emerald)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <I name="check" size={13} />
                </div>
                {t}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social proof */}
      <section className="landing-section">
        <div style={{ textAlign: "center", fontSize: 12, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.14em", marginBottom: 24 }}>
          Trusted by 500+ businesses
        </div>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", justifyContent: "center", maxWidth: 920, margin: "0 auto" }}>
          {["Acme Corp", "Beta Industries", "Cosmo Tech", "Delta Pvt Ltd", "Echo Pharma", "Foxtrot Logistics"].map(n => (
            <div key={n} style={{ padding: "12px 20px", border: "1px solid var(--hairline)", borderRadius: 8, color: "var(--ink-3)", fontSize: 13, fontWeight: 500, background: "var(--paper)" }}>{n}</div>
          ))}
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="landing-section">
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div className="rail-label" style={{ padding: 0 }}>Pricing</div>
          <h2 className="serif" style={{ fontSize: 40, margin: "8px 0 8px", letterSpacing: "-0.02em" }}>
            Simple, transparent pricing.
          </h2>
          <p style={{ color: "var(--ink-3)", maxWidth: 480, margin: "0 auto" }}>One-time setup, support included. Annual savings up to 20%.</p>
        </div>

        <div className="grid grid-3" style={{ maxWidth: 1020, margin: "0 auto" }}>
          {[
            { name: "Starter",  price: "₹1.2L",  sub: "+3 months support",  feats: ["Foundation + sales pipeline", "Basic automation (3 rules)", "Single vendor"], highlighted: false },
            { name: "Complete", price: "₹2.5L",  sub: "+6 months support",  feats: ["Everything in Starter", "12+ automation rules", "WhatsApp + Customer Portal", "Bulk campaigns + Reports"], highlighted: true },
            { name: "Enterprise", price: "₹4.5L", sub: "+12 months support", feats: ["Everything in Complete", "Multi-vendor", "White-label", "AI analyst + 4hr SLA"], highlighted: false },
          ].map(p => (
            <div key={p.name} className="card" style={{
              border: p.highlighted ? "2px solid var(--amber)" : "1px solid var(--hairline)",
              padding: 24,
              position: "relative",
            }}>
              {p.highlighted && (
                <Badge kind="warning" style={{ position: "absolute", top: -10, left: 24 }}>Recommended</Badge>
              )}
              <div className="rail-label" style={{ padding: 0 }}>{p.name}</div>
              <div className="serif tnum" style={{ fontSize: 44, margin: "8px 0 4px" }}>{p.price}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginBottom: 16 }}>{p.sub}</div>
              <div className="stack-8" style={{ marginBottom: 16 }}>
                {p.feats.map(f => (
                  <div key={f} className="row" style={{ alignItems: "flex-start", gap: 8, fontSize: 13 }}>
                    <I name="check" size={14} style={{ color: "var(--emerald)", marginTop: 2 }} />
                    {f}
                  </div>
                ))}
              </div>
              <Btn kind={p.highlighted ? "primary" : "default"} style={{ width: "100%", justifyContent: "center" }}>Choose {p.name}</Btn>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="row" style={{ justifyContent: "space-between", padding: "32px 32px", maxWidth: 1100, margin: "0 auto", flexWrap: "wrap", gap: 16 }}>
          <div>
            <div className="landing-brand" style={{ marginBottom: 8 }}>
              <div className="rail-mark">R</div>
              <span className="serif" style={{ fontSize: 18 }}>ResellerOS</span>
            </div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>
              © 2026 Demo Co Pvt Ltd · A Google Authorized Reseller
            </div>
          </div>
          <div className="row" style={{ gap: 24, fontSize: 12, color: "var(--ink-3)" }}>
            <a>Privacy</a><a>Terms</a><a>Status</a><a>Docs</a>
          </div>
        </div>
      </footer>

      {/* Styles local to landing */}
      <style>{`
        .landing-root { background: var(--paper); min-height: 100vh; }
        .landing-nav {
          height: 64px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 32px;
          border-bottom: 1px solid var(--hairline);
          position: sticky;
          top: 0;
          background: var(--paper);
          z-index: 5;
        }
        .landing-brand { display: flex; align-items: center; gap: 10px; }
        .landing-hero {
          text-align: center;
          padding: 88px 24px 64px;
          max-width: 760px;
          margin: 0 auto;
        }
        .landing-eyebrow {
          display: inline-block;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.16em;
          color: var(--amber);
          font-weight: 600;
          border: 1px solid var(--amber);
          padding: 3px 10px;
          border-radius: 999px;
          margin-bottom: 16px;
        }
        .landing-h1 {
          font-family: var(--font-display);
          font-size: 72px;
          line-height: 1.02;
          letter-spacing: -0.025em;
          margin: 0 0 20px;
        }
        .landing-h1 em { color: var(--amber); }
        .landing-sub {
          font-size: 17px;
          color: var(--ink-3);
          max-width: 580px;
          margin: 0 auto 28px;
          line-height: 1.5;
        }
        .landing-section { padding: 72px 24px; }
        .vendor-card {
          padding: 28px;
          transition: transform 200ms, border-color 200ms;
        }
        .vendor-card:hover { transform: translateY(-2px); border-color: var(--ink); }
        .vendor-square {
          width: 56px; height: 56px;
          border-radius: 12px;
          display: grid; place-items: center;
          color: #fff;
          font-family: var(--font-display);
          font-size: 28px;
        }
        .vendor-square.google { background: var(--google); }
        .vendor-square.microsoft { background: var(--microsoft); }
        .vendor-square.zoho { background: var(--zoho); }
        .landing-footer { border-top: 1px solid var(--hairline); margin-top: 48px; }
      `}</style>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.landing = LandingScreen;
