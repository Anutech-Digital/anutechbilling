/* eslint-disable */
// E1 — Welcome / Project Overview

function WelcomeScreen() {
  const { go } = useRouter();

  const solves = [
    {
      n: 1, title: "Lead confusion eliminated",
      body: "Sales team Excel chodke ek Kanban pe leads track karega. Kisi lead ka status pata nahi hai? Yeh problem khatam.",
    },
    {
      n: 2, title: "Quote → invoice → payment, fully automated",
      body: "GST auto-calculate, PDF auto-generate, WhatsApp pe send, Razorpay se pay, Zoho me sync — sab ek click me.",
    },
    {
      n: 3, title: "Renewals kabhi miss nahi honge",
      body: "T-90, T-60, T-30, T-7 din pehle automatic alerts. ARR risk dashboard pe live dikhega. 15–20% revenue loss bachega.",
    },
    {
      n: 4, title: "Customer self-service portal",
      body: "Customer khud login karke subscriptions manage, invoices download, tickets raise kare. Support load 40% kam.",
    },
    {
      n: 5, title: "Team productivity 3x",
      body: "Role-based dashboards, mobile app, activity timeline, automation rules — har team member ko exactly jo chahiye wahi dikhe.",
    },
  ];

  return (
    <div className="content" style={{ maxWidth: 1000, margin: "0 auto", padding: "40px 32px 80px" }}>
      <div style={{ background: "var(--paper-2)", border: "1px solid var(--hairline)", borderRadius: 10, padding: 12, marginBottom: 28, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
        <span><b>Client demo view</b> · The cover page for your client walkthrough</span>
        <Badge kind="info">E1 · Welcome</Badge>
      </div>

      <div style={{ textAlign: "center", padding: "32px 0 56px" }}>
        <div className="landing-eyebrow" style={{
          display: "inline-block",
          fontSize: 11, textTransform: "uppercase", letterSpacing: "0.16em",
          color: "var(--amber)", fontWeight: 600,
          border: "1px solid var(--amber)", padding: "3px 10px", borderRadius: 999, marginBottom: 18,
        }}>
          Project Demo · Demo Co × Anutech
        </div>
        <h1 className="serif" style={{ fontSize: 72, letterSpacing: "-0.025em", lineHeight: 1.02, margin: "0 0 20px" }}>
          Welcome to <em style={{ fontStyle: "italic", color: "var(--amber)" }}>ResellerOS.</em>
        </h1>
        <p style={{ fontSize: 17, color: "var(--ink-3)", maxWidth: 640, margin: "0 auto 28px", lineHeight: 1.5 }}>
          Your complete Google Workspace, Microsoft 365 and Zoho reseller business — automated end-to-end.
          From lead to renewal collection, on one platform.
        </p>
        <div className="row" style={{ justifyContent: "center", gap: 10 }}>
          <Btn kind="primary" size="lg" icon="calendar" onClick={() => go("timeline")}>See timeline</Btn>
          <Btn kind="default" size="lg" icon="rupee" onClick={() => go("pricing")}>View investment</Btn>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 48 }}>
        {[
          ["24", "Screens / modules"],
          ["8",  "Weeks to launch"],
          ["30+", "Hours/week saved"],
          ["5",  "Team roles supported"],
        ].map(([n, l]) => (
          <div key={l} style={{ textAlign: "center", padding: "20px 8px", border: "1px solid var(--hairline)", borderRadius: 12 }}>
            <div className="serif" style={{ fontSize: 56, color: "var(--amber)", lineHeight: 1 }}>{n}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 8, textTransform: "uppercase", letterSpacing: "0.1em" }}>{l}</div>
          </div>
        ))}
      </div>

      <Card title="What this project solves" style={{ marginBottom: 32 }}>
        <div className="stack-16">
          {solves.map(s => (
            <div key={s.n} className="row" style={{ gap: 18, alignItems: "flex-start", padding: 12, borderTop: s.n > 1 ? "1px solid var(--hairline)" : "none" }}>
              <div className="serif" style={{
                width: 42, height: 42, borderRadius: 999, flexShrink: 0,
                background: "var(--amber)", color: "#fff",
                display: "grid", placeItems: "center", fontSize: 20,
              }}>{s.n}</div>
              <div>
                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 4 }}>{s.title}</div>
                <div style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.5 }}>{s.body}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="How to review this demo">
        <ol style={{ margin: 0, paddingLeft: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            "Project brief section dekho (Timeline, Investment, Before/After, FAQ)",
            "Customer-facing screens dekho (Landing, Portal, Quote, Onboarding, Support)",
            "Internal CRM screens dekho (Dashboard, Leads, Customers, Quotes, Invoices, Renewals)",
            "Power features dekho (Automations, Campaigns, Reports, Mobile)",
            "Questions? WhatsApp / call karein anytime",
          ].map((t, i) => (
            <li key={i} className="row" style={{ alignItems: "flex-start", gap: 12, fontSize: 14 }}>
              <span className="serif tnum" style={{ width: 26, height: 26, borderRadius: 999, background: "var(--paper-2)", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 15 }}>{i+1}</span>
              {t}
            </li>
          ))}
        </ol>
        <div style={{ marginTop: 24, textAlign: "center" }}>
          <Btn kind="primary" size="lg" iconRight="arrow_right" onClick={() => go("timeline")}>Start the tour</Btn>
        </div>
      </Card>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.welcome = WelcomeScreen;
