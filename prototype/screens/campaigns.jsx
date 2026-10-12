/* eslint-disable */
// D2 — Campaigns

const CAMPAIGN_AUDIENCES = [
  { id: "all",           label: "All active customers",       count: 47 },
  { id: "renewals_30",   label: "Renewals due in 30 days",    count: 5  },
  { id: "renewals_60",   label: "Renewals due in 30–60 days", count: 12 },
  { id: "expired",       label: "Recently expired",           count: 4  },
  { id: "churned",       label: "Churned in last 90 days",    count: 23 },
  { id: "high_value",    label: "High value (>₹50K MRR)",     count: 8  },
  { id: "new_30",        label: "New customers (last 30d)",   count: 6  },
];

const CAMPAIGN_TEMPLATES = {
  feature: {
    name: "Workspace Feature Update — May",
    channel: "email",
    audience: "all",
    subject: "What's new in Google Workspace this month",
    body: "Hi {{customer_name}},\n\nGoogle has rolled out new features for Workspace this month: improved Gemini integration in Docs, faster Meet recording, and enhanced admin policies.\n\nWant a 15-min walkthrough? Reply to this email and we'll set it up.\n\n— Team Demo Co",
  },
  festive: {
    name: "Diwali Special — 15% off renewals",
    channel: "both",
    audience: "renewals_60",
    subject: "Diwali offer — extend now, save 15%",
    body: "Hi {{customer_name}},\n\nYour {{plan}} renewal is on {{renewal_date}}. Renew before Diwali (12 Nov) and get 15% off the full annual amount — that's ₹{{discount_amount}} saved.\n\nReply YES to lock it in. Offer valid till 8 Nov.\n\n— Pardeep, Demo Co",
  },
  nps: {
    name: "NPS Q2 2026 Survey",
    channel: "email",
    audience: "all",
    subject: "Quick question — how are we doing?",
    body: "Hi {{customer_name}},\n\nOn a scale of 0–10, how likely are you to recommend Demo Co to a peer?\n\n[ 0 ][ 1 ][ 2 ][ 3 ][ 4 ][ 5 ][ 6 ][ 7 ][ 8 ][ 9 ][ 10 ]\n\nOne click. We read every response.\n\n— Pardeep",
  },
  referral: {
    name: "Referral Program — Earn ₹5,000",
    channel: "both",
    audience: "high_value",
    subject: "Refer a peer — earn ₹5,000",
    body: "Hi {{customer_name}},\n\nKnow another business that's spending too much on cloud licenses or struggling with vendor support?\n\nRefer them. When they sign up, you get ₹5,000 credit on your next renewal — they get free onboarding.\n\nReply with the contact, or share this link: example.test/refer\n\n— Pardeep",
  },
};

function CampaignsScreen() {
  const [tab, setTab] = useState("active");
  const [builderOpen, setBuilderOpen] = useState(false);
  const [builderSeed, setBuilderSeed] = useState(null);

  const openBuilder = (templateKey) => {
    setBuilderSeed(templateKey ? CAMPAIGN_TEMPLATES[templateKey] : null);
    setBuilderOpen(true);
  };

  return (
    <div className="content wide" style={{ padding: "28px 32px 80px" }}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">Engage</div>
            <h1 className="page-title">Campaigns</h1>
            <p className="page-sub">Bulk email and WhatsApp messaging to customer segments</p>
          </div>
          <div className="page-head-actions">
            <Btn icon="copy" onClick={() => document.getElementById("quick-templates")?.scrollIntoView({ behavior: "smooth" })}>Templates</Btn>
            <Btn kind="primary" icon="plus" onClick={() => openBuilder(null)}>New campaign</Btn>
          </div>
        </div>
      </div>

      <div className="grid grid-5" style={{ marginBottom: 24 }}>
        <KPI label="Sent · MTD"      value="14" trend="+3 vs last month" trendKind="up" trendIcon="trending_up" />
        <KPI label="Total messages"  value="2,847" />
        <KPI label="Open rate"       value="42" unit="%" trend="+3pp" trendKind="up" />
        <KPI label="Click rate"      value="18" unit="%" trend="+2pp" trendKind="up" />
        <KPI label="Replies"         value="156" />
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: "active",    label: "Active",    count: 3 },
        { id: "scheduled", label: "Scheduled", count: 2 },
        { id: "sent",      label: "Sent",      count: 47 },
        { id: "drafts",    label: "Drafts",    count: 5 },
      ]} />

      <div className="stack-16" style={{ marginBottom: 32 }}>
        <CampaignCard
          icon="mail"
          name="Renewal Reminder — May Batch"
          sub="Email + WhatsApp combo · Target: 12 customers with renewals in 30–60 days"
          status="running"
          stats={[
            ["Sent", "12 / 12"],
            ["Opens", "8 (66%)"],
            ["Clicks", "5 (41%)"],
            ["Replies", "3"],
            ["Conversions", "2 (16%)"],
          ]}
        />
        <CampaignCard
          icon="whatsapp"
          name="Win-Back — Churned Customers"
          sub="WhatsApp only · Target: 23 customers churned in last 90 days"
          status="paused"
          stats={[
            ["Sent", "23 / 23"],
            ["Read", "18 (78%)"],
            ["Replies", "6"],
            ["Won back", "2 (8%)"],
            ["ARR recovered", "₹2.4L"],
          ]}
        />
        <CampaignCard
          icon="send"
          name="NPS Q1 Survey"
          sub="Email only · Quarterly cycle · Target: all active customers (47)"
          status="running"
          stats={[
            ["Sent", "47 / 47"],
            ["Responses", "19 (40%)"],
            ["Avg score", "8.6 / 10"],
            ["Promoters", "11"],
            ["Detractors", "1"],
          ]}
        />
      </div>

      <div id="quick-templates" />
      <Card title="Quick campaign templates" sub="Start from a pre-built recipe">
        <div className="grid grid-2">
          {[
            { key: "feature",  icon: "sparkles", title: "New feature announcement",   sub: "Notify customers about Workspace updates" },
            { key: "festive",  icon: "spark",    title: "Festive offer (Diwali / EoY)", sub: "Limited-time discount campaigns" },
            { key: "nps",      icon: "chart",    title: "NPS survey",                  sub: "Quarterly customer satisfaction" },
            { key: "referral", icon: "award",    title: "Referral program",            sub: "Ask happy customers for referrals" },
          ].map(t => (
            <div key={t.key} className="card tight row" style={{ cursor: "pointer", gap: 12, alignItems: "flex-start" }}
              onClick={() => openBuilder(t.key)}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--paper-2)"}
              onMouseLeave={(e) => e.currentTarget.style.background = ""}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--indigo-soft)", color: "var(--indigo)", display: "grid", placeItems: "center" }}>
                <I name={t.icon} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{t.title}</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{t.sub}</div>
              </div>
              <I name="arrow_right" size={14} style={{ color: "var(--ink-3)" }} />
            </div>
          ))}
        </div>
      </Card>

      {builderOpen && <CampaignBuilder seed={builderSeed} onClose={() => setBuilderOpen(false)} />}
    </div>
  );
}

function CampaignBuilder({ seed, onClose }) {
  const { toast } = useToast();
  const [name, setName] = useState(seed?.name || "");
  const [channel, setChannel] = useState(seed?.channel || "email");
  const [audienceId, setAudienceId] = useState(seed?.audience || "all");
  const [subject, setSubject] = useState(seed?.subject || "");
  const [body, setBody] = useState(seed?.body || "Hi {{customer_name}},\n\n");
  const [schedule, setSchedule] = useState("now");
  const [sendDate, setSendDate] = useState("2026-05-21");
  const [sendTime, setSendTime] = useState("10:00");

  const audience = CAMPAIGN_AUDIENCES.find(a => a.id === audienceId);
  const isEmail = channel === "email" || channel === "both";
  const isWA = channel === "whatsapp" || channel === "both";

  const bodyRef = useRef(null);
  const insertToken = (tok) => {
    const ta = bodyRef.current;
    if (!ta) { setBody(b => b + tok); return; }
    const start = ta.selectionStart || body.length;
    const end = ta.selectionEnd || body.length;
    setBody(body.slice(0, start) + tok + body.slice(end));
    setTimeout(() => { ta.focus(); ta.selectionStart = ta.selectionEnd = start + tok.length; }, 0);
  };

  const canSend = name.trim() && audience && body.trim() && (!isEmail || subject.trim());

  const submit = (asDraft) => {
    if (!asDraft && !canSend) { toast("Add a name, subject, and message first"); return; }
    const verb = asDraft ? "Saved as draft" : schedule === "now" ? "Sent" : `Scheduled for ${sendDate} ${sendTime}`;
    toast(`${verb} · ${name || "Untitled"} · ${audience.count} recipients`);
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: 32 }}>
      <div className="modal" style={{ width: 720, maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="page-eyebrow">New campaign</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{seed ? "From template" : "From scratch"}</div>
          </div>
          <IconBtn icon="x" onClick={onClose} />
        </div>

        <div className="modal-body stack-16" style={{ overflowY: "auto", flex: 1 }}>
          <Field label="Campaign name">
            <input className="input" placeholder="e.g. May renewal nudge" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field label="Channel">
            <Segmented value={channel} onChange={setChannel} options={[
              { value: "email",    label: "Email" },
              { value: "whatsapp", label: "WhatsApp" },
              { value: "both",     label: "Email + WhatsApp" },
            ]} />
          </Field>

          <Field label="Audience">
            <select className="select" value={audienceId} onChange={(e) => setAudienceId(e.target.value)}>
              {CAMPAIGN_AUDIENCES.map(a => (
                <option key={a.id} value={a.id}>{a.label} · {a.count} customers</option>
              ))}
            </select>
          </Field>

          <div style={{ background: "var(--paper-2)", padding: 12, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <I name="users" size={14} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>Estimated reach</div>
                <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {audience.count} {channel === "both" ? "× 2 messages" : "messages"} · {isEmail && "via email"}{isEmail && isWA && " + "}{isWA && "via WhatsApp"}
                </div>
              </div>
            </div>
            <div className="serif tnum" style={{ fontSize: 22 }}>
              {channel === "both" ? audience.count * 2 : audience.count}
            </div>
          </div>

          {isEmail && (
            <Field label="Subject line">
              <input className="input" placeholder="Keep it under 60 characters" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={80} />
            </Field>
          )}

          <Field label="Message">
            <textarea
              ref={bodyRef}
              className="textarea"
              rows={8}
              style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              <span style={{ fontSize: 11, color: "var(--ink-3)", alignSelf: "center", marginRight: 4 }}>Insert:</span>
              {["{{customer_name}}", "{{plan}}", "{{renewal_date}}", "{{seats}}", "{{amount}}", "{{discount_amount}}"].map(tok => (
                <button key={tok} className="badge muted mono" style={{ cursor: "pointer", border: "1px solid var(--hairline)", fontSize: 11, padding: "2px 6px" }} onClick={() => insertToken(tok)}>{tok}</button>
              ))}
            </div>
          </Field>

          <Field label="Schedule">
            <Segmented value={schedule} onChange={setSchedule} options={[
              { value: "now",   label: "Send now" },
              { value: "later", label: "Schedule for later" },
            ]} />
            {schedule === "later" && (
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <input className="input mono" type="date" value={sendDate} onChange={(e) => setSendDate(e.target.value)} style={{ width: 160 }} />
                <input className="input mono" type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} style={{ width: 110 }} />
                <span style={{ fontSize: 11, color: "var(--ink-3)", alignSelf: "center" }}>IST</span>
              </div>
            )}
          </Field>
        </div>

        <div className="modal-foot" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid var(--hairline)", padding: "12px 20px" }}>
          <div style={{ fontSize: 11, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 6 }}>
            <I name="info" size={11} />
            Tokens auto-resolve per customer · Unsubscribe link appended for email
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="ghost" onClick={onClose}>Cancel</Btn>
            <Btn kind="default" icon="file" onClick={() => submit(true)}>Save draft</Btn>
            <Btn kind="primary" icon="send" onClick={() => submit(false)}>
              {schedule === "now" ? "Send now" : "Schedule"}
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function CampaignCard({ icon, name, sub, status, stats }) {
  return (
    <Card>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div className="row" style={{ gap: 12 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--indigo-soft)", color: "var(--indigo)", display: "grid", placeItems: "center" }}>
            <I name={icon} />
          </div>
          <div>
            <div style={{ fontWeight: 600 }}>{name}</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</div>
          </div>
        </div>
        {status === "running" && <Badge kind="success" dot>Running</Badge>}
        {status === "paused"  && <Badge kind="warning" dot>Paused</Badge>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", paddingTop: 14, borderTop: "1px solid var(--hairline)" }}>
        {stats.map(([k, v]) => (
          <div key={k}>
            <div className="field-label">{k}</div>
            <div className="serif tnum" style={{ fontSize: 18, marginTop: 2 }}>{v}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS.campaigns = CampaignsScreen;
