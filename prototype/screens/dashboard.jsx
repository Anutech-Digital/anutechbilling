/* eslint-disable */
// C1 — Owner Dashboard
function DashboardScreen() {
  const { go } = useRouter();
  const { toast } = useToast();

  const focus = [
    { icon: "alert",   tone: "rose",    title: "3 renewals due this week", action: "Review", cta: "renewals", note: "Action needed" },
    { icon: "receipt", tone: "rose",    title: "5 overdue invoices — total ₹3.5L", action: "Follow up", cta: "invoices", note: "Aging > 14d" },
    { icon: "check",   tone: "amber",   title: "8 tasks pending — 2 yours", action: "View", cta: "dashboard", note: "Today" },
    { icon: "flame",   tone: "emerald", title: "4 new leads since yesterday", action: "Hot", cta: "leads", note: "Worth ₹7.2L" },
    { icon: "ticket",  tone: "amber",   title: "2 open support tickets", action: "In progress", cta: "support", note: "SLA OK" },
  ];

  const activity = [
    { icon: "rupee",  tone: "emerald", title: "Rahul closed Acme Corp deal — ₹2.4L", time: "10:32 AM today" },
    { icon: "target", tone: "indigo",  title: "New lead: TechBrand Pvt Ltd (Referral)", time: "09:15 AM · Assigned Priya" },
    { icon: "file",   tone: "amber",   title: "3 invoices auto-generated for renewals", time: "Yesterday 9:00 AM" },
    { icon: "mail",   tone: "slate",   title: "Renewal reminder sent to Cosmo Tech", time: "Yesterday 4:20 PM" },
  ];

  const leaderboard = [
    { rank: 1, name: "Rahul B",  amount: 820000, deals: 12, color: "indigo" },
    { rank: 2, name: "Priya R",  amount: 560000, deals: 8,  color: "amber" },
    { rank: 3, name: "Amit M",   amount: 310000, deals: 6,  color: "emerald" },
    { rank: 4, name: "Sneha K",  amount: 180000, deals: 4,  color: "rose" },
  ];

  const upcoming = [
    { type: "Demo", who: "TechBrand", time: "Today 2:30 PM", color: "indigo" },
    { type: "Call", who: "Cosmo (renewal)", time: "Today 4:00 PM", color: "amber" },
    { type: "Demo", who: "Beta Industries", time: "Tomorrow 11 AM", color: "indigo" },
  ];

  return (
    <div className="content wide" style={{ padding: "28px 40px 80px" }}>
      {/* Header */}
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Tuesday · 20 May 2026</div>
            <h1 className="page-title">Good morning, Pardeep.</h1>
            <p className="page-sub">Here's what's happening at Demo Co today.</p>
          </div>
          <div className="page-head-actions">
            <Btn icon="plus" kind="primary" onClick={() => toast("Quick-add opened")}>Quick add</Btn>
          </div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-6" style={{ marginBottom: 24 }}>
        {KPIS_DASHBOARD.map(k => <KPI key={k.id} {...k} />)}
      </div>

      {/* Main grid */}
      <div className="grid" style={{ gridTemplateColumns: "1.55fr 1fr", alignItems: "flex-start" }}>
        {/* LEFT */}
        <div className="stack-16">
          <Card title="Today's Focus" sub="What needs your attention now" actions={
            <Btn size="sm" icon="filter" kind="ghost">All</Btn>
          }>
            <div className="stack-8" style={{ marginTop: -4 }}>
              {focus.map((f, i) => (
                <div key={i} className="focus-row" style={{
                  display: "grid",
                  gridTemplateColumns: "32px 1fr auto",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 4px",
                  borderBottom: i < focus.length - 1 ? "1px solid var(--hairline)" : "none",
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: 7,
                    background: `var(--${f.tone}-soft)`,
                    color: `var(--${f.tone})`,
                    display: "grid", placeItems: "center",
                  }}>
                    <I name={f.icon} size={14} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{f.note}</div>
                  </div>
                  <Btn size="sm" kind="ghost" iconRight="arrow_right" onClick={() => go(f.cta)}>{f.action}</Btn>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Recent Activity" sub="Last 24 hours" actions={
            <Btn size="sm" kind="ghost" iconRight="external">Full feed</Btn>
          }>
            <div className="stack-12" style={{ marginTop: 4 }}>
              {activity.map((a, i) => (
                <div key={i} style={{
                  display: "grid",
                  gridTemplateColumns: "28px 1fr auto",
                  alignItems: "center",
                  gap: 12,
                }}>
                  <div style={{
                    width: 24, height: 24, borderRadius: 999,
                    background: `var(--${a.tone}-soft)`,
                    color: `var(--${a.tone})`,
                    display: "grid", placeItems: "center",
                  }}>
                    <I name={a.icon} size={12} />
                  </div>
                  <div style={{ fontSize: 13 }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{a.time}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Pipeline by stage visualization */}
          <Card title="Pipeline by Stage" sub="₹18L across 23 deals">
            <div className="stack-12">
              {LEAD_STAGES.map(s => {
                const leadsInStage = LEADS.filter(l => l.stage === s.id);
                const value = leadsInStage.reduce((sum, l) => sum + l.value, 0);
                const max = 2000000;
                const pct = Math.min(100, (value / max) * 100);
                return (
                  <div key={s.id} style={{ display: "grid", gridTemplateColumns: "120px 1fr 110px 50px", alignItems: "center", gap: 12 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                      <span className={`dot ${s.dot}`} />
                      {s.label}
                    </div>
                    <div className="bar"><i style={{ width: pct + "%", background: s.color }} /></div>
                    <div className="tnum" style={{ fontSize: 13, color: "var(--ink-2)", textAlign: "right" }}>{rupee(value, { compact: true })}</div>
                    <div className="tnum" style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "right" }}>{leadsInStage.length}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* RIGHT */}
        <div className="stack-16">
          <Card title="Sales Leaderboard" sub="This month">
            <div className="stack-12">
              {leaderboard.map(p => (
                <div key={p.rank} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 12 }}>
                  <div className="serif" style={{
                    width: 26, height: 26, borderRadius: 999,
                    background: p.rank === 1 ? "var(--amber)" : "var(--paper-2)",
                    color: p.rank === 1 ? "#fff" : "var(--ink-2)",
                    display: "grid", placeItems: "center",
                    fontSize: 14, fontWeight: 500,
                  }}>{p.rank}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{p.deals} deals closed</div>
                  </div>
                  <div className="serif tnum" style={{ fontSize: 18 }}>{rupee(p.amount, { compact: true })}</div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Coming Up" sub="Next 24 hours">
            <div className="stack-12">
              {upcoming.map((u, i) => (
                <div key={i} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 12 }}>
                  <div style={{
                    width: 32, height: 32, borderRadius: 7,
                    border: "1px solid var(--hairline)",
                    display: "grid", placeItems: "center",
                    color: `var(--${u.color})`,
                  }}>
                    <I name={u.type === "Demo" ? "users" : "phone"} size={14} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{u.type}: {u.who}</div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{u.time}</div>
                  </div>
                  <IconBtn icon="arrow_right" />
                </div>
              ))}
            </div>
          </Card>

          <Card title="Health" sub="System & integrations">
            <div className="stack-8">
              {[
                ["Google Reseller API",  "5 min ago", "ok"],
                ["Razorpay",              "Live",      "ok"],
                ["Zoho Books sync",      "Auto",      "ok"],
                ["Microsoft Partner",     "Setup",     "warn"],
              ].map(([name, sub, status]) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`dot ${status === "ok" ? "emerald" : "amber"}`} />
                    {name}
                  </div>
                  <span style={{ color: "var(--ink-3)" }}>{sub}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.dashboard = DashboardScreen;
