/* eslint-disable */
// Lead Generation — capture sources, public form, manual add, CSV import

const LEAD_SOURCES = [
  { id: "whatsapp",  label: "WhatsApp Business",   icon: "whatsapp", count: 12, conv: 33, status: "active",   note: "Highest volume source" },
  { id: "website",   label: "Website form",        icon: "globe",    count: 8,  conv: 25, status: "active",   note: "example.test/get-quote" },
  { id: "referral",  label: "Referral program",    icon: "award",    count: 5,  conv: 60, status: "active",   note: "Best conversion · ₹5K credit per ref" },
  { id: "cold",      label: "Cold outreach",       icon: "send",     count: 4,  conv: 20, status: "active",   note: "Apollo + Lemlist sequences" },
  { id: "ads",       label: "Google Ads",          icon: "target",   count: 3,  conv: 13, status: "active",   note: "₹15K/mo spend · ₹5K/lead" },
  { id: "linkedin",  label: "LinkedIn outbound",   icon: "users",    count: 2,  conv: 50, status: "paused",   note: "Manual DMs by Rahul" },
];

const WEBHOOKS = [
  {
    id: "website",
    method: "POST", path: "/api/leads/website",
    label: "Website form",
    sub: "Public form on example.test/get-quote",
    icon: "globe", count: 18, lastFired: "2h ago", live: true,
    sample: `{
  "company": "Acme Corp Pvt Ltd",
  "contact": "Rajesh Kumar",
  "email": "rajesh@acmecorp.com",
  "phone": "+919876543210",
  "seats": 25,
  "interested_in": "workspace-plus",
  "source": "website",
  "utm_campaign": "diwali-2026"
}`,
  },
  {
    id: "whatsapp",
    method: "POST", path: "/api/leads/whatsapp",
    label: "WhatsApp Business",
    sub: "Interakt / Wati / Gupshup webhook",
    icon: "whatsapp", count: 12, lastFired: "8m ago", live: true,
    sample: `{
  "event": "message",
  "contact": { "name": "Vishal Mehra", "phone": "+919123456789" },
  "message": { "type": "text", "body": "Aapka Workspace Plus ka price kya hai?" },
  "intent": "pricing_inquiry",
  "source": "whatsapp"
}`,
  },
  {
    id: "email",
    method: "POST", path: "/api/leads/email",
    label: "Email parser",
    sub: "IMAP poll on sales@example.test",
    icon: "mail", count: 4, lastFired: "1d ago", live: true,
    sample: `{
  "from": { "name": "Suresh P", "email": "suresh@novaprint.in" },
  "subject": "Inquiry: Google Workspace for 8 users",
  "snippet": "Hi, we're a printing company in Pune…",
  "parsed_signature": { "company": "Nova Print Co.", "title": "Founder" },
  "source": "email"
}`,
  },
  {
    id: "referral",
    method: "POST", path: "/api/leads/referral",
    label: "Customer referrals",
    sub: "Portal links — example.test/r/{customer-slug}",
    icon: "award", count: 5, lastFired: "3d ago", live: true,
    sample: `{
  "company": "Maple Studios",
  "contact": "Anita M",
  "email": "anita@maple.studio",
  "referred_by": "acme-corp",
  "referral_credit": 5000,
  "source": "referral"
}`,
  },
  {
    id: "ads",
    method: "POST", path: "/api/leads/ads",
    label: "Google + Meta lead ads",
    sub: "Zapier bridge from Lead Form extension",
    icon: "target", count: 3, lastFired: "5h ago", live: true,
    sample: `{
  "ad_id": "google-ads-789",
  "campaign": "Workspace Mumbai SME",
  "contact": "Dr. Verma",
  "company": "Lumen Diagnostics",
  "phone": "+919012345678",
  "lead_cost": 4500,
  "source": "ads"
}`,
  },
];

const INBOUND_LEADS = [
  { id: "L1",  company: "TechBrand Pvt Ltd",   source: "whatsapp",  contact: "Vikram S",    when: "2d ago",  status: "new",       owner: "priya" },
  { id: "L4",  company: "Maple Studios",       source: "referral",  contact: "Anita M",     when: "5d ago",  status: "new",       owner: "priya" },
  { id: "L5",  company: "Nova Print Co.",      source: "website",   contact: "Suresh P",    when: "6d ago",  status: "new",       owner: "rahul" },
  { id: "L7",  company: "Patel & Sons",        source: "whatsapp",  contact: "Rohit P",     when: "2d ago",  status: "contacted", owner: "priya" },
  { id: "L11", company: "Tata Crafts",         source: "referral",  contact: "Meena T",     when: "3d ago",  status: "qualifying",owner: "priya" },
  { id: "L18", company: "Zephyr Networks",     source: "cold",      contact: "Karan K",     when: "2d ago",  status: "demo",      owner: "priya" },
  { id: "X1",  company: "Lumen Diagnostics",   source: "ads",       contact: "Dr. Verma",   when: "1d ago",  status: "new",       owner: "rahul" },
  { id: "X2",  company: "Pinewood Hospitality",source: "linkedin",  contact: "Asha B",      when: "3d ago",  status: "new",       owner: "rahul" },
];

function LeadGenScreen() {
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [addLeadSeed, setAddLeadSeed] = useState(null);
  const [expandedWebhook, setExpandedWebhook] = useState(null);
  const { toast } = useToast();
  const { go } = useRouter();

  useEffect(() => {
    if (window.__addLeadSeed) {
      setAddLeadSeed(window.__addLeadSeed);
      setShowAdd(true);
      delete window.__addLeadSeed;
    } else if (window.__openAddLeadOnMount) {
      setShowAdd(true);
      delete window.__openAddLeadOnMount;
    } else if (window.__openImportLeadsOnMount) {
      setShowImport(true);
      delete window.__openImportLeadsOnMount;
    }
  }, []);

  const total = LEAD_SOURCES.reduce((s, x) => s + x.count, 0);
  const avgConv = Math.round(LEAD_SOURCES.reduce((s, x) => s + x.count * x.conv, 0) / Math.max(1, total));
  const topSource = LEAD_SOURCES.reduce((a, b) => b.count > a.count ? b : a);

  const sourceMeta = (id) => LEAD_SOURCES.find(s => s.id === id) || { label: id, icon: "inbox" };
  const statusBadge = (s) => {
    if (s === "new")        return <Badge kind="info"    dot>New</Badge>;
    if (s === "contacted")  return <Badge kind="warning" dot>Contacted</Badge>;
    if (s === "qualifying") return <Badge kind="info"    dot>Qualifying</Badge>;
    if (s === "demo")       return <Badge kind="success" dot>Demo done</Badge>;
    return <Badge kind="muted">—</Badge>;
  };

  return (
    <div className="content wide" style={{ padding: "28px 32px 80px" }}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Sales</div>
            <h1 className="page-title">Lead Sources</h1>
            <p className="page-sub">Where new leads come from · capture forms · manual entry · bulk import</p>
          </div>
          <div className="page-head-actions">
            <Btn icon="link" onClick={() => setShowShare(true)}>Share form</Btn>
            <Btn icon="download" onClick={() => setShowImport(true)}>Import CSV</Btn>
            <Btn icon="plus" kind="primary" onClick={() => setShowAdd(true)}>Add Lead</Btn>
          </div>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 24 }}>
        <KPI label="Leads · MTD"    value={total}                    trend="+8 vs last month" trendKind="up" trendIcon="trending_up" icon="inbox" />
        <KPI label="Avg conversion" value={avgConv} unit="%"         trend="lead → won"       trendKind="up" trendIcon="trending_up" icon="target" />
        <KPI label="Top source"     value={topSource.label.split(" ")[0]} trend={`${topSource.count} this month`} icon={topSource.icon} />
        <KPI label="Avg response"   value="2.4" unit="h"             trend="−1.1h vs last mo" trendKind="up" trendIcon="trending_down" icon="clock" />
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1.4fr 1fr", gap: 20, marginBottom: 24 }}>
        {/* Source channels */}
        <Card title="Capture channels" sub="Sources of new leads this month" actions={<Btn size="sm" icon="plus">Add channel</Btn>}>
          <div className="stack-12">
            {LEAD_SOURCES.map(s => (
              <div key={s.id} style={{ display: "grid", gridTemplateColumns: "32px 1fr 90px 90px 80px", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid var(--hairline)" }}>
                <div style={{ width: 32, height: 32, borderRadius: 8, background: s.status === "active" ? "var(--indigo-soft)" : "var(--paper-2)", color: s.status === "active" ? "var(--indigo)" : "var(--ink-3)", display: "grid", placeItems: "center" }}>
                  <I name={s.icon} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{s.note}</div>
                </div>
                <div className="tnum serif" style={{ fontSize: 18, textAlign: "right" }}>{s.count}</div>
                <div style={{ textAlign: "right" }}>
                  <div className="tnum" style={{ fontSize: 12, fontWeight: 500 }}>{s.conv}%</div>
                  <div style={{ fontSize: 10, color: "var(--ink-3)" }}>conv rate</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  {s.status === "active"
                    ? <Badge kind="success" dot>Active</Badge>
                    : <Badge kind="muted"   dot>Paused</Badge>}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Public form preview */}
        <Card title="Public capture form" sub="Embed on website or share link" actions={
          <Btn size="sm" icon="external" onClick={() => setShowShare(true)}>Share</Btn>
        }>
          <div style={{ background: "var(--paper-2)", padding: 16, borderRadius: 8, fontSize: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <div style={{ width: 24, height: 24, background: "var(--ink)", color: "var(--paper)", borderRadius: 4, display: "grid", placeItems: "center", fontFamily: "var(--font-serif)", fontSize: 13 }}>R</div>
              <div className="serif" style={{ fontSize: 15 }}>Get a quote in 24 hours</div>
            </div>
            <FormField label="Company name *" placeholder="Acme Corp Pvt Ltd" />
            <FormField label="Your name *"    placeholder="Rajesh Kumar" />
            <FormField label="Email *"        placeholder="rajesh@acme.com" />
            <FormField label="Phone"          placeholder="+91 98765 43210" mono />
            <div style={{ marginBottom: 10 }}>
              <div className="field-label">Team size</div>
              <select className="select" disabled style={{ fontSize: 12 }}>
                <option>5–25</option>
                <option>25–100</option>
                <option>100+</option>
              </select>
            </div>
            <div style={{ marginBottom: 10 }}>
              <div className="field-label">Interested in</div>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {["Workspace", "M365", "Zoho", "Help me choose"].map(o => (
                  <span key={o} className="badge muted" style={{ fontSize: 11 }}>{o}</span>
                ))}
              </div>
            </div>
            <button className="btn primary" style={{ width: "100%", marginTop: 4, justifyContent: "center" }} disabled>
              Get my quote
            </button>
            <div style={{ fontSize: 10, color: "var(--ink-3)", textAlign: "center", marginTop: 8 }}>
              Live at <span className="mono">example.test/get-quote</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Webhook endpoints */}
      <div style={{ marginBottom: 24 }}>
      <Card title="Webhook endpoints" sub="Auto-create leads from external sources · all live"
        actions={<>
          <Btn size="sm" icon="book">Docs</Btn>
          <Btn size="sm" icon="lock">Rotate key</Btn>
        </>} >
        <div className="stack-8">
          {WEBHOOKS.map(w => {
            const isOpen = expandedWebhook === w.id;
            return (
              <div key={w.id} style={{ border: "1px solid var(--hairline)", borderRadius: 8, overflow: "hidden" }}>
                <div
                  onClick={() => setExpandedWebhook(isOpen ? null : w.id)}
                  style={{ display: "grid", gridTemplateColumns: "32px 1fr auto auto auto 24px", alignItems: "center", gap: 12, padding: "10px 12px", cursor: "pointer", background: isOpen ? "var(--paper-2)" : "transparent" }}>
                  <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--indigo-soft)", color: "var(--indigo)", display: "grid", placeItems: "center" }}>
                    <I name={w.icon} size={14} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500, display: "flex", alignItems: "center", gap: 8 }}>
                      <span className="mono" style={{ fontSize: 11, background: "var(--ink)", color: "var(--paper)", padding: "1px 6px", borderRadius: 4, fontWeight: 600 }}>{w.method}</span>
                      <span className="mono" style={{ fontSize: 12 }}>{w.path}</span>
                    </div>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{w.sub}</div>
                  </div>
                  <Badge kind="success" dot>Live</Badge>
                  <div style={{ textAlign: "right" }}>
                    <div className="tnum" style={{ fontSize: 13, fontWeight: 500 }}>{w.count}</div>
                    <div style={{ fontSize: 10, color: "var(--ink-3)" }}>leads · MTD</div>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>last: {w.lastFired}</div>
                  <I name={isOpen ? "chevron_up" : "chevron_down"} size={14} />
                </div>
                {isOpen && (
                  <div style={{ padding: "12px 16px", borderTop: "1px solid var(--hairline)", background: "var(--paper-2)" }}>
                    <div style={{ fontSize: 11, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, fontWeight: 600 }}>Sample payload</div>
                    <pre className="mono" style={{ fontSize: 11, background: "var(--paper)", padding: 12, borderRadius: 6, overflowX: "auto", margin: 0, border: "1px solid var(--hairline)" }}>{w.sample}</pre>
                    <div className="row" style={{ gap: 6, marginTop: 8, justifyContent: "space-between", alignItems: "center" }}>
                      <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                        Endpoint: <span className="mono">https://api.resellersos.in{w.path}</span>
                      </div>
                      <div className="row" style={{ gap: 6 }}>
                        <Btn size="sm" icon="copy" onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(w.sample); toast("Payload copied"); }}>Copy</Btn>
                        <Btn size="sm" kind="primary" icon="zap" onClick={(e) => { e.stopPropagation(); toast(`Test webhook fired → 1 mock lead created via ${w.label}`); }}>Test webhook</Btn>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 12, display: "flex", alignItems: "center", gap: 6 }}>
          <I name="info" size={11} />
          All endpoints accept HMAC-SHA256 signed requests · Bearer auth · idempotency keys supported
        </div>
      </Card>
      </div>

      {/* Recent inbound leads */}
      <Card flush title="Recent inbound" sub="Last 7 days · sorted by recency"
        actions={<Btn size="sm" icon="arrow_right" onClick={() => go("leads")}>Open Pipeline</Btn>}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Source</th>
              <th>Contact</th>
              <th>Captured</th>
              <th>Status</th>
              <th>Owner</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {INBOUND_LEADS.map(l => {
              const src = sourceMeta(l.source);
              const owner = TEAM[l.owner];
              return (
                <tr key={l.id}>
                  <td>
                    <b>{l.company}</b>
                    <div className="sub mono" style={{ fontSize: 11 }}>{l.id}</div>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <I name={src.icon} size={14} />
                      <span style={{ fontSize: 12 }}>{src.label}</span>
                    </div>
                  </td>
                  <td>{l.contact}</td>
                  <td>{l.when}</td>
                  <td>{statusBadge(l.status)}</td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <Avatar initials={owner.initials} color={owner.color} size="sm" />
                      <span style={{ fontSize: 12 }}>{owner.name.split(" ")[0]}</span>
                    </div>
                  </td>
                  <td>
                    <Btn size="sm" icon="arrow_right" onClick={() => go("leads")}>Open</Btn>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {showAdd     && <AddLeadModal     onClose={() => { setShowAdd(false); setAddLeadSeed(null); }} seed={addLeadSeed} onSaved={(name) => toast(`Lead added: ${name}`)} />}
      {showImport  && <ImportLeadsModal onClose={() => setShowImport(false)}  onImported={(n)  => toast(`Imported ${n} leads`)} />}
      {showShare   && <ShareFormModal   onClose={() => setShowShare(false)}   onCopy={() => toast("Link copied to clipboard")} />}
    </div>
  );
}

function FormField({ label, placeholder, mono }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="field-label">{label}</div>
      <input className={`input ${mono ? "mono" : ""}`} placeholder={placeholder} disabled style={{ background: "var(--paper)", fontSize: 12 }} />
    </div>
  );
}

function AddLeadModal({ onClose, onSaved, seed }) {
  const [company, setCompany] = useState(seed?.company || "");
  const [contact, setContact] = useState(seed?.contact || "");
  const [email, setEmail]   = useState(seed?.email || "");
  const [phone, setPhone]   = useState(seed?.phone || "");
  const [seats, setSeats]   = useState(seed?.seats || 25);
  const [plan, setPlan]     = useState(seed?.plan || "Workspace Std");
  const [source, setSource] = useState(seed?.source || "manual");
  const [owner, setOwner]   = useState(seed?.owner || "auto");
  const [stage, setStage]   = useState(seed?.stage || "new");
  const [notes, setNotes]   = useState(seed?.notes || "");

  const canSave = company.trim() && contact.trim() && email.trim();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="page-eyebrow">Lead capture</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Add a lead</div>
          </div>
          <IconBtn icon="x" onClick={onClose} />
        </div>
        <div className="modal-body stack-12" style={{ overflowY: "auto", maxHeight: "calc(100vh - 220px)" }}>
          <Field label="Company name *">
            <input className="input" placeholder="Acme Corp Pvt Ltd" value={company} onChange={(e) => setCompany(e.target.value)} />
          </Field>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Contact name *">
              <input className="input" placeholder="Rajesh Kumar" value={contact} onChange={(e) => setContact(e.target.value)} />
            </Field>
            <Field label="Email *">
              <input className="input" type="email" placeholder="rajesh@acme.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Phone">
              <input className="input mono" placeholder="+91 98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </Field>
            <Field label="Team size (seats)">
              <input className="input tnum" type="number" min={1} value={seats} onChange={(e) => setSeats(+e.target.value || 1)} />
            </Field>
          </div>
          <Field label="Interested in">
            <select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}>
              <option>Workspace Starter</option>
              <option>Workspace Std</option>
              <option>Workspace Plus</option>
              <option>Workspace Enterprise</option>
              <option>Microsoft 365</option>
              <option>Zoho Workplace</option>
              <option>Help me choose</option>
            </select>
          </Field>
          <div className="grid grid-2" style={{ gap: 12 }}>
            <Field label="Source">
              <select className="select" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="manual">Manual (just me)</option>
                <option value="whatsapp">WhatsApp Business</option>
                <option value="website">Website form</option>
                <option value="referral">Referral</option>
                <option value="cold">Cold outreach</option>
                <option value="ads">Google Ads</option>
                <option value="linkedin">LinkedIn</option>
              </select>
            </Field>
            <Field label="Assign to">
              <select className="select" value={owner} onChange={(e) => setOwner(e.target.value)}>
                <option value="auto">Auto-assign (round robin)</option>
                <option value="pardeep">Pardeep A (Owner)</option>
                <option value="rahul">Rahul B (Sales)</option>
                <option value="priya">Priya R (Sales)</option>
                <option value="amit">Amit M (Accountant)</option>
              </select>
            </Field>
          </div>
          <Field label="Initial stage">
            <Segmented value={stage} onChange={setStage} options={[
              { value: "new",     label: "New" },
              { value: "contact", label: "Contacted" },
              { value: "demo",    label: "Demo" },
            ]} />
          </Field>
          <Field label="Notes">
            <textarea className="textarea" rows={3} placeholder="Anything we should know? Budget hints, decision-makers, urgency, etc." value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <div className="modal-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderTop: "1px solid var(--hairline)" }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 6 }}>
            <I name="info" size={11} />
            Saved leads land in the Lead Pipeline kanban
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn kind="primary" icon="check" onClick={() => {
              if (!canSave) return;
              onSaved(company);
              onClose();
            }}>Save lead</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function ImportLeadsModal({ onClose, onImported }) {
  const [step, setStep] = useState("upload"); // upload | mapping | done
  const sampleRows = [
    ["Acme Corp Pvt Ltd",    "Rajesh K",  "rajesh@acmecorp.com",     "+91 98765 43210", "25", "Workspace Plus"],
    ["Beta Industries",      "Sneha M",   "sneha@betaind.in",        "+91 99887 76655", "15", "Workspace Std"],
    ["Cosmo Tech",           "Vikram S",  "vikram@cosmotech.in",     "+91 98123 45678", "12", "Workspace Plus"],
    ["Delta Pvt Ltd",        "Anita G",   "anita@deltapl.com",       "+91 99100 22334", "50", "Workspace Plus"],
  ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="page-eyebrow">Bulk import</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Import leads from CSV</div>
          </div>
          <IconBtn icon="x" onClick={onClose} />
        </div>
        <div className="modal-body" style={{ padding: "16px 20px" }}>
          {step === "upload" && (
            <div>
              <div onClick={() => setStep("mapping")} style={{ border: "2px dashed var(--hairline-strong)", borderRadius: 10, padding: "40px 20px", textAlign: "center", cursor: "pointer", background: "var(--paper-2)" }}>
                <I name="upload" size={32} />
                <div style={{ fontSize: 14, fontWeight: 500, marginTop: 10 }}>Drop CSV here or click to browse</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 4 }}>Max 5 MB · UTF-8 encoded · First row should be headers</div>
              </div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 16 }}>
                <div style={{ fontWeight: 500, color: "var(--ink)", marginBottom: 6 }}>Required columns:</div>
                <div className="mono" style={{ fontSize: 11, background: "var(--paper-2)", padding: 10, borderRadius: 6 }}>
                  company, contact_name, email, phone, seats, plan
                </div>
                <a href="#" style={{ fontSize: 11, color: "var(--amber)", marginTop: 8, display: "inline-block" }} onClick={(e) => e.preventDefault()}>
                  ↓ Download sample CSV
                </a>
              </div>
            </div>
          )}

          {step === "mapping" && (
            <div>
              <div style={{ fontSize: 13, marginBottom: 12 }}>
                <I name="check_circle" size={13} /> <b>leads-may-batch.csv</b> · 23 rows detected · all columns matched
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th className="right">Seats</th><th>Plan</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleRows.map((r, i) => (
                    <tr key={i}>
                      <td><b>{r[0]}</b></td>
                      <td>{r[1]}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{r[2]}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{r[3]}</td>
                      <td className="right tnum">{r[4]}</td>
                      <td>{r[5]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 8 }}>
                Showing 4 of 23 · all leads will be assigned via round-robin to active sales reps
              </div>
            </div>
          )}
        </div>
        <div className="modal-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid var(--hairline)" }}>
          <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
          {step === "mapping" && (
            <Btn kind="primary" icon="check" onClick={() => { onImported(23); onClose(); }}>Import 23 leads</Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function ShareFormModal({ onClose, onCopy }) {
  const url = "https://example.test/get-quote";
  const embed = `<iframe src="${url}?embed=1" width="100%" height="640" frameborder="0"></iframe>`;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="page-eyebrow">Public form</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>Share or embed</div>
          </div>
          <IconBtn icon="x" onClick={onClose} />
        </div>
        <div className="modal-body stack-16" style={{ padding: "16px 20px" }}>
          <div>
            <div className="field-label">Public link</div>
            <div style={{ display: "flex", gap: 6 }}>
              <input className="input mono" value={url} readOnly style={{ flex: 1, fontSize: 12 }} />
              <Btn icon="copy" onClick={() => { navigator.clipboard?.writeText(url); onCopy(); }}>Copy</Btn>
            </div>
          </div>
          <div>
            <div className="field-label">Embed on your website</div>
            <textarea className="textarea mono" rows={3} readOnly value={embed} style={{ fontSize: 11 }} />
            <Btn icon="copy" size="sm" style={{ marginTop: 6 }} onClick={() => { navigator.clipboard?.writeText(embed); onCopy(); }}>Copy embed code</Btn>
          </div>
          <div>
            <div className="field-label">Send via</div>
            <div className="row" style={{ gap: 8 }}>
              <Btn icon="mail">Email link</Btn>
              <Btn icon="whatsapp" style={{ color: "#25D366", borderColor: "#25D366" }}>WhatsApp</Btn>
              <Btn icon="message">SMS</Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS["lead-gen"] = LeadGenScreen;
