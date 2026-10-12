/* eslint-disable */
// D4 — Settings & Team

function SettingsScreen() {
  const [tab, setTab] = useState("company");
  const tabs = [
    { id: "company",      label: "Company" },
    { id: "team",         label: "Team" },
    { id: "integrations", label: "Integrations" },
    { id: "branding",     label: "Branding" },
    { id: "notifications",label: "Notifications" },
    { id: "security",     label: "Security" },
  ];

  return (
    <div className="content wide" style={{ padding: "28px 32px 80px" }}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">System</div>
            <h1 className="page-title">Settings & Team</h1>
            <p className="page-sub">Configure your reseller business</p>
          </div>
          <Btn kind="primary" icon="check">Save changes</Btn>
        </div>
      </div>

      <Tabs tabs={tabs} value={tab} onChange={setTab} />

      {(tab === "company" || tab === "team") && (
        <div className="grid grid-2" style={{ marginBottom: 24 }}>
          <Card title="Company information">
            <div className="stack-12">
              <Field label="Legal name"><input className="input" defaultValue="Demo Co Pvt Ltd" /></Field>
              <div className="grid grid-2" style={{ gap: 12 }}>
                <Field label="GSTIN"><input className="input mono" defaultValue="07AABCE1234D1Z9" /></Field>
                <Field label="PAN"><input className="input mono" defaultValue="AABCE1234D" /></Field>
              </div>
              <Field label="Registered state"><select className="select" defaultValue="Delhi (07)"><option>Delhi (07)</option><option>Maharashtra (27)</option></select></Field>
              <Field label="Currency"><select className="select"><option>INR (₹)</option></select></Field>
              <Field label="Address"><textarea className="textarea" defaultValue="Plot 14, Sector 7, Industrial Area, Delhi 110085" /></Field>
            </div>
          </Card>

          <Card title="Team members" sub="5 active · 3 seats remaining">
            <table className="tbl" style={{ marginTop: -8 }}>
              <thead><tr><th>Name</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {Object.values(TEAM).map(p => (
                  <tr key={p.name}>
                    <td>
                      <div className="row" style={{ gap: 10 }}>
                        <Avatar initials={p.initials} color={p.color} />
                        <span style={{ fontWeight: 500 }}>{p.name}</span>
                      </div>
                    </td>
                    <td>
                      <Badge kind={p.role === "Owner" ? "info" : "muted"}>{p.role}</Badge>
                    </td>
                    <td><Badge kind="success" dot>Online</Badge></td>
                    <td><IconBtn icon="more_h" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ marginTop: 12 }}>
              <Btn icon="plus">Invite member</Btn>
            </div>
          </Card>
        </div>
      )}

      <Card title="Integrations" sub="Connected services" style={{ marginBottom: 16 }}>
        <div className="grid grid-3">
          {[
            { name: "Gmail API",              sub: "Last synced 5 min ago",   status: "ok",   icon: "mail" },
            { name: "Razorpay",                sub: "Live mode",                status: "ok",   icon: "rupee" },
            { name: "Zoho Books",              sub: "Auto-sync ON",             status: "ok",   icon: "receipt" },
            { name: "Google Reseller API",    sub: "Auth valid",               status: "ok",   icon: "package" },
            { name: "Microsoft Partner",       sub: "Not configured",           status: "warn", icon: "shield" },
            { name: "WhatsApp Business",       sub: "Verified",                 status: "ok",   icon: "whatsapp" },
          ].map(it => (
            <div key={it.name} className="card tight row" style={{ gap: 12, justifyContent: "space-between" }}>
              <div className="row" style={{ gap: 10 }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--paper-2)", color: "var(--ink-2)", display: "grid", placeItems: "center" }}>
                  <I name={it.icon} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{it.name}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{it.sub}</div>
                </div>
              </div>
              {it.status === "ok" ? <Badge kind="success" dot>Connected</Badge> : <Btn size="sm">Setup</Btn>}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.settings = SettingsScreen;
