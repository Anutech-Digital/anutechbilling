/* eslint-disable */
// Setup Wizard — first-run experience for new ResellerOS customers
// 5 steps: Company → Razorpay → Google CSP → Import customers → Done
// Route: #/setup

const SETUP_STEPS = [
  { id: "company",    label: "Company",      icon: "building" },
  { id: "razorpay",   label: "Razorpay",     icon: "rupee" },
  { id: "csp",        label: "Google CSP",   icon: "globe" },
  { id: "import",     label: "Import",       icon: "upload" },
  { id: "done",       label: "All set",      icon: "rocket" },
];

function SetupWizardScreen() {
  const [step, setStep] = useState(0);
  const [data, setData] = useState({
    companyName: "",
    gstin: "",
    state: "",
    address: "",
    pinCode: "",
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    razorpayKey: "",
    razorpaySecret: "",
    cspId: "",
    cspApproved: false,
    importMode: "csv",  // csv | sample | skip
    completed: [],
  });
  const { toast } = useToast();
  const { go } = useRouter();

  const update = (k, v) => setData(d => ({ ...d, [k]: v }));
  const markComplete = (id) => setData(d => ({ ...d, completed: [...new Set([...d.completed, id])] }));

  const next = () => {
    markComplete(SETUP_STEPS[step].id);
    setStep(s => Math.min(SETUP_STEPS.length - 1, s + 1));
  };
  const back = () => setStep(s => Math.max(0, s - 1));
  const skip = () => setStep(s => Math.min(SETUP_STEPS.length - 1, s + 1));

  const stepProgress = ((step + 1) / SETUP_STEPS.length) * 100;

  return (
    <div style={{
      background: "linear-gradient(180deg, var(--paper) 0%, var(--paper-2) 100%)",
      minHeight: "100vh",
      padding: "40px 24px 80px",
    }}>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style={{ width: 40, height: 40, background: "var(--ink)", color: "var(--paper)", borderRadius: 8, display: "grid", placeItems: "center", fontFamily: "var(--serif)", fontSize: 22 }}>R</div>
            <div style={{ textAlign: "left" }}>
              <div style={{ fontFamily: "var(--serif)", fontSize: 18, lineHeight: 1 }}>ResellerOS</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Setup · 5 minutes</div>
            </div>
          </div>
          <h1 style={{ fontFamily: "var(--serif)", fontSize: 32, margin: "0 0 8px", letterSpacing: "-0.01em" }}>
            Welcome, {RESELLER.name.replace(" Pvt Ltd", "")}.
          </h1>
          <p style={{ fontSize: 14, color: "var(--ink-3)", margin: 0 }}>
            Let's get your reseller business operational in 5 quick steps.
          </p>
        </div>

        {/* Progress bar with step labels */}
        <div style={{ marginBottom: 32 }}>
          <div style={{
            display: "grid",
            gridTemplateColumns: `repeat(${SETUP_STEPS.length}, 1fr)`,
            gap: 4,
            marginBottom: 16,
          }}>
            {SETUP_STEPS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => i <= step + 1 && setStep(i)}
                disabled={i > step + 1}
                style={{
                  background: i <= step ? "var(--amber)" : i === step + 1 ? "var(--amber-soft)" : "var(--hairline)",
                  height: 4,
                  borderRadius: 999,
                  border: "none",
                  cursor: i <= step + 1 ? "pointer" : "default",
                  padding: 0,
                  transition: "background 200ms",
                }}
              />
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${SETUP_STEPS.length}, 1fr)`, gap: 4 }}>
            {SETUP_STEPS.map((s, i) => (
              <div key={s.id} style={{ textAlign: "center" }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  background: i < step ? "var(--emerald)" : i === step ? "var(--amber)" : "var(--paper)",
                  border: "1.5px solid " + (i < step ? "var(--emerald)" : i === step ? "var(--amber)" : "var(--hairline)"),
                  color: i <= step ? "#fff" : "var(--ink-3)",
                  display: "grid", placeItems: "center",
                  margin: "0 auto 6px",
                  fontSize: 11,
                  fontWeight: 600,
                }}>
                  {i < step ? <I name="check" size={12} /> : <I name={s.icon} size={12} />}
                </div>
                <div style={{ fontSize: 10, color: i === step ? "var(--ink)" : "var(--ink-3)", fontWeight: i === step ? 600 : 400 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Step body */}
        <Card>
          {step === 0 && (
            <StepCompany data={data} update={update} />
          )}
          {step === 1 && (
            <StepRazorpay data={data} update={update} />
          )}
          {step === 2 && (
            <StepCsp data={data} update={update} />
          )}
          {step === 3 && (
            <StepImport data={data} update={update} />
          )}
          {step === 4 && (
            <StepDone data={data} go={go} />
          )}
        </Card>

        {/* Footer actions */}
        {step < 4 && (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20, alignItems: "center" }}>
            <Btn kind="ghost" icon="arrow_left" onClick={back} disabled={step === 0}>Back</Btn>
            <div style={{ display: "flex", gap: 8 }}>
              {step > 0 && step < 4 && (
                <Btn kind="ghost" onClick={skip}>Skip for now</Btn>
              )}
              <Btn kind="primary" iconRight="arrow_right" onClick={next}>
                {step === 3 ? "Finish setup" : "Continue"}
              </Btn>
            </div>
          </div>
        )}

        {/* Trust footer */}
        <div style={{ textAlign: "center", marginTop: 40, fontSize: 11, color: "var(--ink-3)" }}>
          Your data stays on your tenant · DPDP Act 2023 compliant · ISO 27001 in progress
        </div>
      </div>
    </div>
  );
}

// ─────────── Step 1: Company details ───────────
function StepCompany({ data, update }) {
  return (
    <div className="stack-16">
      <div>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: "0 0 4px" }}>Your business details</h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
          These appear on every GST invoice you generate. You can edit later in Settings.
        </p>
      </div>
      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Legal company name">
          <input className="input" placeholder="Demo Co Pvt Ltd" defaultValue={RESELLER.name} onChange={(e) => update("companyName", e.target.value)} />
        </Field>
        <Field label="GSTIN">
          <input className="input mono" placeholder="27AABCE9876D1Z3" defaultValue={RESELLER.gstin} onChange={(e) => update("gstin", e.target.value)} />
        </Field>
        <Field label="State">
          <select className="input" defaultValue={RESELLER.state} onChange={(e) => update("state", e.target.value)}>
            <option>Maharashtra (27)</option>
            <option>Karnataka (29)</option>
            <option>Tamil Nadu (33)</option>
            <option>Delhi (07)</option>
            <option>Gujarat (24)</option>
          </select>
        </Field>
        <Field label="PIN code">
          <input className="input mono" placeholder="400001" onChange={(e) => update("pinCode", e.target.value)} />
        </Field>
        <Field label="Registered address" style={{ gridColumn: "span 2" }}>
          <input className="input" placeholder="Office address" defaultValue={RESELLER.address} onChange={(e) => update("address", e.target.value)} />
        </Field>
        <Field label="Owner / Contact name">
          <input className="input" placeholder="Your name" defaultValue="Pardeep A" onChange={(e) => update("contactName", e.target.value)} />
        </Field>
        <Field label="Contact email">
          <input className="input mono" type="email" placeholder="owner@yourcompany.in" defaultValue={RESELLER.email} onChange={(e) => update("contactEmail", e.target.value)} />
        </Field>
      </div>
      <div style={{ padding: 12, background: "var(--indigo-soft)", borderRadius: 8, fontSize: 12, color: "var(--ink-2)", display: "flex", gap: 10, alignItems: "flex-start" }}>
        <I name="info" size={14} style={{ color: "var(--indigo)", flexShrink: 0, marginTop: 2 }} />
        <div>We auto-verify your GSTIN against the government portal · Real production also pulls your registered business name for confirmation.</div>
      </div>
    </div>
  );
}

// ─────────── Step 2: Razorpay ───────────
function StepRazorpay({ data, update }) {
  const [connected, setConnected] = useState(false);
  return (
    <div className="stack-16">
      <div>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: "0 0 4px" }}>Connect Razorpay</h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
          So customers can pay you via UPI, cards, net banking — and the money lands in your bank within 2 days.
        </p>
      </div>

      {!connected ? (
        <>
          <div style={{
            padding: 20,
            background: "linear-gradient(135deg, #001A47 0%, #002B5C 100%)",
            borderRadius: 10,
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
          }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Razorpay</div>
              <div style={{ fontSize: 12, opacity: 0.8 }}>India's #1 payment gateway · 2% per transaction · T+2 settlement</div>
            </div>
            <Btn kind="primary" icon="external" onClick={() => setConnected(true)}>Connect with OAuth</Btn>
          </div>

          <div style={{ fontSize: 12, color: "var(--ink-3)", textAlign: "center" }}>or enter API keys manually</div>

          <div className="grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Razorpay Key ID">
              <input className="input mono" placeholder="rzp_live_xxxxxxxxxxxx" onChange={(e) => update("razorpayKey", e.target.value)} />
            </Field>
            <Field label="Razorpay Secret">
              <input className="input mono" type="password" placeholder="••••••••••••" onChange={(e) => update("razorpaySecret", e.target.value)} />
            </Field>
          </div>

          <div style={{ padding: 12, background: "var(--amber-soft)", borderRadius: 8, fontSize: 12, color: "var(--ink-2)", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <I name="info" size={14} style={{ color: "var(--amber)", flexShrink: 0, marginTop: 2 }} />
            <div>Get your keys from <span className="mono">dashboard.razorpay.com → Settings → API Keys</span>. We never see your secret — it's stored encrypted in your tenant only.</div>
          </div>
        </>
      ) : (
        <div style={{
          padding: 20,
          background: "var(--emerald-soft)",
          border: "1px solid var(--emerald)",
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--emerald)", color: "#fff", display: "grid", placeItems: "center" }}>
            <I name="check" size={20} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--emerald)" }}>Razorpay connected</div>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>Live mode · 2% transaction fee · T+2 settlement to HDFC ••4521</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────── Step 3: Google CSP ───────────
function StepCsp({ data, update }) {
  const [stage, setStage] = useState("intro"); // intro | applied | approved
  return (
    <div className="stack-16">
      <div>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: "0 0 4px" }}>Google CSP API access</h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
          Connect to Google's Cloud Solution Provider API so we can auto-provision Workspace tenants for your customers.
        </p>
      </div>

      {stage === "intro" && (
        <>
          <div style={{
            padding: 20,
            background: "var(--paper-2)",
            borderRadius: 10,
            border: "1px solid var(--hairline)",
          }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
              <svg width="40" height="40" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC04" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              <div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>Google Workspace Reseller</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Auto-provision tenants · sync subscriptions · pull billing</div>
              </div>
            </div>
            <ul style={{ fontSize: 13, color: "var(--ink-2)", paddingLeft: 18, lineHeight: 1.6, margin: 0 }}>
              <li>Application takes 5–7 business days for Google approval</li>
              <li>Required: existing Premier Partner status (✅ you have this)</li>
              <li>Required: 5+ customers already provisioned manually</li>
              <li>Required: business verification (PAN, GST, agreement)</li>
            </ul>
          </div>

          <Field label="Your Google Partner ID (CSP ID)">
            <input className="input mono" placeholder="C0xxxxxxxxx" onChange={(e) => update("cspId", e.target.value)} />
          </Field>

          <Btn kind="primary" icon="external" onClick={() => setStage("applied")}>Submit API access application</Btn>
        </>
      )}

      {stage === "applied" && (
        <div style={{
          padding: 20,
          background: "var(--amber-soft)",
          border: "1px solid var(--amber)",
          borderRadius: 10,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--amber)", color: "#fff", display: "grid", placeItems: "center" }}>
              <I name="clock" size={16} />
            </div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Application submitted</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)" }}>Google will email you in 5–7 days</div>
            </div>
          </div>
          <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.55 }}>
            In the meantime, you can still send quotes, accept payments, and manually provision tenants from your Partner Console.
            We'll notify you the moment approval comes through.
          </div>
          <div style={{ marginTop: 12 }}>
            <button onClick={() => setStage("approved")} style={{ background: "transparent", border: "none", color: "var(--indigo)", fontSize: 12, cursor: "pointer", textDecoration: "underline" }}>
              [Demo] Simulate approval received
            </button>
          </div>
        </div>
      )}

      {stage === "approved" && (
        <div style={{
          padding: 20,
          background: "var(--emerald-soft)",
          border: "1px solid var(--emerald)",
          borderRadius: 10,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "var(--emerald)", color: "#fff", display: "grid", placeItems: "center" }}>
            <I name="check" size={20} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--emerald)" }}>Google CSP API approved!</div>
            <div style={{ fontSize: 12, color: "var(--ink-2)" }}>Tenant provisioning is now fully automated · Sync runs every 15 minutes</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────── Step 4: Import customers ───────────
function StepImport({ data, update }) {
  return (
    <div className="stack-16">
      <div>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 22, margin: "0 0 4px" }}>Import your existing customers</h2>
        <p style={{ fontSize: 13, color: "var(--ink-3)", margin: 0 }}>
          Bring your spreadsheet over so renewal tracking and margin reports work from day 1.
        </p>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          { id: "csv",    icon: "upload",  title: "CSV Import",        body: "Upload Excel/CSV with customer + subscription data",  cta: "Choose file" },
          { id: "sample", icon: "sparkles", title: "Sample data",      body: "Pre-loaded with 7 demo customers · explore first",     cta: "Load sample" },
          { id: "skip",   icon: "plus",    title: "Start fresh",       body: "Add customers one-by-one as they come · cleanest",     cta: "I'll add manually" },
        ].map(opt => {
          const active = data.importMode === opt.id;
          return (
            <button key={opt.id} onClick={() => update("importMode", opt.id)} style={{
              background: active ? "var(--amber-soft)" : "var(--paper)",
              border: "1.5px solid " + (active ? "var(--amber)" : "var(--hairline)"),
              borderRadius: 10,
              padding: 16,
              cursor: "pointer",
              textAlign: "left",
              fontFamily: "inherit",
              transition: "all 120ms",
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: active ? "var(--amber)" : "var(--paper-2)",
                color: active ? "#fff" : "var(--ink-2)",
                display: "grid", placeItems: "center",
                marginBottom: 10,
              }}>
                <I name={opt.icon} size={16} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{opt.title}</div>
              <div style={{ fontSize: 12, color: "var(--ink-3)", lineHeight: 1.5, marginBottom: 10 }}>{opt.body}</div>
              <div style={{ fontSize: 11, color: active ? "var(--amber)" : "var(--ink-3)", fontWeight: 600 }}>
                {active ? "✓ Selected" : opt.cta}
              </div>
            </button>
          );
        })}
      </div>

      {data.importMode === "csv" && (
        <div style={{
          padding: 16, background: "var(--paper-2)", borderRadius: 8, fontSize: 12, color: "var(--ink-2)",
          display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between",
        }}>
          <span>📎 Need the template? Download our CSV template with sample rows.</span>
          <Btn size="sm" kind="ghost" icon="download">Download template</Btn>
        </div>
      )}
    </div>
  );
}

// ─────────── Step 5: Done ───────────
function StepDone({ data, go }) {
  return (
    <div style={{ textAlign: "center", padding: "20px 0" }}>
      <div style={{
        width: 80, height: 80, margin: "0 auto 20px",
        borderRadius: "50%",
        background: "linear-gradient(135deg, var(--emerald-soft) 0%, var(--amber-soft) 100%)",
        color: "var(--emerald)",
        display: "grid", placeItems: "center",
        boxShadow: "0 12px 32px rgba(22,101,52,0.18)",
      }}>
        <I name="rocket" size={36} />
      </div>
      <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, margin: "0 0 8px" }}>You're all set.</h2>
      <p style={{ fontSize: 14, color: "var(--ink-3)", margin: "0 0 24px", maxWidth: 440, marginLeft: "auto", marginRight: "auto", lineHeight: 1.55 }}>
        Your reseller workspace is live. Here's what's ready and what to do next.
      </p>

      {/* Status summary */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 24, textAlign: "left", maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>
        {[
          { label: "Company verified",          status: "done" },
          { label: "GST e-invoice ready",       status: "done" },
          { label: "Razorpay connected",        status: "done" },
          { label: "Google CSP API",            status: "pending", note: "Approval in 5-7 days" },
          { label: "Customer data imported",    status: "done" },
          { label: "WhatsApp Business API",     status: "todo",    note: "Set up later" },
        ].map((it, i) => (
          <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <span style={{
              width: 18, height: 18, borderRadius: "50%",
              background: it.status === "done" ? "var(--emerald)" : it.status === "pending" ? "var(--amber)" : "var(--hairline)",
              color: "#fff",
              display: "grid", placeItems: "center",
              flexShrink: 0,
            }}>
              {it.status === "done" ? <I name="check" size={10} /> : it.status === "pending" ? <I name="clock" size={10} /> : <I name="plus" size={10} />}
            </span>
            <div>
              <div style={{ color: "var(--ink)", fontWeight: 500 }}>{it.label}</div>
              {it.note && <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{it.note}</div>}
            </div>
          </div>
        ))}
      </div>

      {/* Next-steps checklist */}
      <div style={{
        textAlign: "left",
        maxWidth: 480,
        margin: "0 auto 24px",
        padding: 16,
        background: "var(--paper-2)",
        borderRadius: 10,
        border: "1px solid var(--hairline)",
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10 }}>
          Suggested first week
        </div>
        <div className="stack-8">
          {[
            "Send your first quote — open Quote Builder",
            "Set up WhatsApp Business API for customer chat",
            "Import your renewal calendar from existing system",
            "Configure email templates in Automations",
            "Invite your team — Sales rep, Accountant, Support",
          ].map((t, i) => (
            <div key={i} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" />
              <span>{t}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: "center", gap: 8, flexWrap: "wrap" }}>
        <Btn kind="primary" icon="home" onClick={() => go("dashboard")}>Open dashboard</Btn>
        <Btn icon="file" onClick={() => go("quote-builder")}>Send first quote</Btn>
        <Btn kind="ghost" icon="settings" onClick={() => go("settings")}>Settings</Btn>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS["setup"] = SetupWizardScreen;
