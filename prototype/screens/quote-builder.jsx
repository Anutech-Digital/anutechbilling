/* eslint-disable */
// C5 — Quote Builder (interactive)

function QuoteBuilderScreen() {
  const [mode, setMode] = useState("cycle"); // "cycle" | "prorata"
  const [cycle, setCycle] = useState("annual");
  const [startDate, setStartDate] = useState("2026-05-20");
  const [endDate, setEndDate] = useState("2026-09-15"); // co-term with Acme's existing renewal
  const [discountPct, setDiscountPct] = useState(10);
  const [items, setItems] = useState([
    { id: "GW-PLS", name: "Google Workspace Plus",  sub: "Annual commitment", hsn: "998313", qty: 25, rate: 1380 },
    { id: "GV-STD", name: "Google Voice Standard",  sub: "Add-on",            hsn: "998313", qty: 5,  rate: 800 },
  ]);
  const [customerName, setCustomerName] = useState("Acme Corp Pvt Ltd");
  const [quoteId, setQuoteId] = useState("Q-2026-0042");
  const [fromLead, setFromLead] = useState(null);
  const [validity, setValidity] = useState(30);
  const [customerState, setCustomerState] = useState("Maharashtra (27)");
  const [showAdd, setShowAdd] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    const fromLeadStash = window.__quoteFromLead;
    const fromListStash = window.__quoteFromList;
    if (fromLeadStash) {
      setCustomerName(fromLeadStash.company);
      setItems(fromLeadStash.items);
      setFromLead(fromLeadStash.leadId);
      setQuoteId(`Q-2026-${String(43 + Math.floor(Math.random() * 50)).padStart(4, "0")}`);
      delete window.__quoteFromLead;
    } else if (fromListStash) {
      setCustomerName(fromListStash.customer);
      setItems(planToItems(fromListStash.plan, fromListStash.seats));
      setQuoteId(fromListStash.id);
      if (fromListStash.leadId) setFromLead(fromListStash.leadId);
      delete window.__quoteFromList;
    }
  }, []);

  const months = cycle === "annual" ? 12 : cycle === "quarterly" ? 3 : 1;
  const monthlySubtotal = items.reduce((s, it) => s + it.qty * it.rate, 0);

  // Pro-rata calc: per-day rate = (monthly × 12) / 365, then × days
  const days = Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / 86400000));
  const proRataSubtotal = Math.round((monthlySubtotal * 12 * days) / 365);

  const subtotal = mode === "prorata" ? proRataSubtotal : monthlySubtotal * months;
  const periodLabel = mode === "prorata"
    ? `${fmtDate(startDate)} → ${fmtDate(endDate)} · ${days} days`
    : `${months} months`;

  const discount = Math.round(subtotal * (discountPct / 100));
  const taxable = subtotal - discount;
  const interState = customerState !== RESELLER.state;
  const taxRate = 18;
  const tax = Math.round(taxable * (taxRate / 100));
  const total = taxable + tax;

  const updateQty = (id, q) => setItems(items.map(i => i.id === id ? { ...i, qty: Math.max(1, q) } : i));
  const removeItem = (id) => setItems(items.filter(i => i.id !== id));
  const addItem = (item) => {
    setItems([...items, { ...item, qty: 10, name: item.name, rate: item.msrp, sub: "" }]);
    setShowAdd(false);
    toast(`Added ${item.name}`);
  };

  return (
    <div className="content" style={{ maxWidth: 1240, padding: "28px 32px 80px" }}>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <div className="page-eyebrow">
              Quotation · Auto-generated
              {fromLead && <span style={{ marginLeft: 8, color: "var(--amber)" }}>· From lead {fromLead}</span>}
            </div>
            <h1 className="page-title">{quoteId}</h1>
            <p className="page-sub">For <b>{customerName}</b> · Created by Rahul B · Draft</p>
          </div>
          <div className="page-head-actions">
            <Btn kind="ghost" icon="copy">Save draft</Btn>
            <Btn kind="default" icon="file" onClick={() => setShowPreview(true)}>Preview PDF</Btn>
            <Btn kind="primary" icon="send" onClick={() => toast("Quote sent to rajesh@acmecorp.com")}>Send quote</Btn>
          </div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <Card title="Customer Details">
          <div className="stack-12">
            <Field label="Customer">
              <input className="input" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
            </Field>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label="Domain"><input className="input" defaultValue="acmecorp.com" /></Field>
              <Field label="GSTIN"><input className="input mono" defaultValue="27AABCS1234D1Z5" /></Field>
            </div>
            <Field label="Place of supply">
              <select className="select" value={customerState} onChange={(e) => setCustomerState(e.target.value)}>
                <option>Maharashtra (27)</option>
                <option>Delhi (07)</option>
                <option>Karnataka (29)</option>
                <option>Tamil Nadu (33)</option>
              </select>
            </Field>
          </div>
        </Card>

        <Card title="Quote Settings">
          <div className="stack-12">
            <Field label="Valid for (days)">
              <input className="input tnum" type="number" value={validity} onChange={(e) => setValidity(+e.target.value)} />
            </Field>
            <Field label="Pricing mode">
              <Segmented value={mode} onChange={setMode} options={[
                { value: "cycle",   label: "Full cycle" },
                { value: "prorata", label: "Pro-rata" },
              ]} />
            </Field>
            {mode === "cycle" ? (
              <>
                <Field label="Billing cycle">
                  <Segmented value={cycle} onChange={setCycle} options={[
                    { value: "annual", label: "Annual" },
                    { value: "quarterly", label: "Quarterly" },
                    { value: "monthly", label: "Monthly" },
                  ]} />
                </Field>
                <Field label="Commitment">
                  <div className="input" style={{ background: "var(--paper-2)", color: "var(--ink-2)" }}>
                    {months} months <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-3)" }}>(auto-calc)</span>
                  </div>
                </Field>
              </>
            ) : (
              <>
                <div className="grid grid-2" style={{ gap: 12 }}>
                  <Field label="Start date">
                    <input className="input mono" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                  </Field>
                  <Field label="End date (co-term)">
                    <input className="input mono" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                  </Field>
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", fontStyle: "italic", padding: "2px 0", display: "flex", alignItems: "center", gap: 6 }}>
                  <I name="info" size={11} />
                  {days} days · co-term to Acme's existing renewal (15 Sep 2026). Per-day rate = monthly × 12 ÷ 365.
                </div>
              </>
            )}
          </div>
        </Card>
      </div>

      <Card title="Line Items" actions={
        <Btn size="sm" icon="plus" onClick={() => setShowAdd(true)}>Add item</Btn>
      }>
        <table className="tbl" style={{ marginTop: 0 }}>
          <thead>
            <tr>
              <th>Description</th>
              <th>HSN</th>
              <th className="right">Qty</th>
              <th className="right">Rate</th>
              <th className="right">Amount</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map(it => (
              <tr key={it.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{it.name}</div>
                  {it.sub && <div className="sub">{it.sub}</div>}
                </td>
                <td className="mono" style={{ fontSize: 12, color: "var(--ink-3)" }}>{it.hsn}</td>
                <td className="right">
                  <input
                    className="input tnum"
                    type="number"
                    value={it.qty}
                    onChange={(e) => updateQty(it.id, +e.target.value)}
                    style={{ width: 70, textAlign: "right", padding: "4px 8px" }}
                  />
                </td>
                <td className="right tnum">{rupee(it.rate)}/mo</td>
                <td className="right tnum" style={{ fontWeight: 500 }}>{rupee(it.qty * it.rate)}/mo</td>
                <td><IconBtn icon="trash" onClick={() => removeItem(it.id)} /></td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 360px", marginTop: 24, gap: 24 }}>
          <div>
            <Field label="Notes for customer">
              <textarea className="textarea" defaultValue="Pricing valid for 30 days. Onboarding includes DNS, MX, SPF, DKIM, DMARC setup. Free training (2 sessions)." />
            </Field>
          </div>
          <div className="stack-8" style={{ background: "var(--paper-2)", padding: 16, borderRadius: 10 }}>
            <TotalRow label={`Subtotal (${periodLabel})`} value={rupee(subtotal)} />
            {mode === "prorata" && (
              <div style={{ fontSize: 11, color: "var(--ink-3)", fontStyle: "italic", padding: "0 0 4px", display: "flex", alignItems: "center", gap: 6 }}>
                <I name="info" size={11} /> Pro-rata · {rupee(Math.round((monthlySubtotal * 12) / 365))}/day × {days}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                Discount
                <input
                  className="input tnum"
                  type="number"
                  value={discountPct}
                  onChange={(e) => setDiscountPct(Math.max(0, Math.min(100, +e.target.value)))}
                  style={{ width: 50, padding: "2px 6px", fontSize: 11 }}
                />
                <span>%</span>
              </div>
              <span className="tnum" style={{ color: "var(--emerald)" }}>−{rupee(discount)}</span>
            </div>
            <TotalRow label="Taxable amount" value={rupee(taxable)} />
            <div style={{ fontSize: 11, color: "var(--ink-3)", fontStyle: "italic", padding: "4px 0" }}>
              <I name="info" size={11} /> {interState ? "Different state → IGST applicable" : "Same state → CGST + SGST applicable"} @ {taxRate}%
            </div>
            <TotalRow label={interState ? "IGST (18%)" : "CGST + SGST (9+9%)"} value={rupee(tax)} />
            <div style={{ borderTop: "1px solid var(--hairline-strong)", paddingTop: 12, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.1em", color: "var(--ink-3)", fontWeight: 600 }}>Grand total</span>
                <span className="serif tnum" style={{ fontSize: 28, color: "var(--amber)" }}>{rupee(total)}</span>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <div className="row" style={{ marginTop: 16, gap: 8, justifyContent: "flex-end" }}>
        <Btn kind="ghost" icon="copy">Duplicate</Btn>
        <Btn kind="default" icon="mail">Send via email</Btn>
        <Btn kind="default" icon="whatsapp" style={{ color: "#25D366", borderColor: "#25D366" }}>Send via WhatsApp</Btn>
        <Btn kind="primary" icon="check_circle">Finalize quote</Btn>
      </div>

      {/* PDF Preview modal */}
      {showPreview && (
        <QuotePreview
          onClose={() => setShowPreview(false)}
          quoteId={quoteId}
          customerName={customerName}
          customerState={customerState}
          items={items}
          mode={mode}
          startDate={startDate}
          endDate={endDate}
          days={days}
          months={months}
          discount={discount}
          discountPct={discountPct}
          subtotal={subtotal}
          taxable={taxable}
          tax={tax}
          total={total}
          interState={interState}
          taxRate={taxRate}
          validity={validity}
          fromLead={fromLead}
          onSend={() => { setShowPreview(false); toast(`${quoteId} sent to ${customerName}`); }}
        />
      )}

      {/* Add item modal */}
      {showAdd && (
        <div className="modal-backdrop" onClick={() => setShowAdd(false)}>
          <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <div style={{ fontSize: 16, fontWeight: 600 }}>Add an item</div>
              <IconBtn icon="x" onClick={() => setShowAdd(false)} />
            </div>
            <div className="modal-body" style={{ padding: 0, maxHeight: 380, overflowY: "auto" }}>
              <table className="tbl">
                <thead><tr><th>Item</th><th>Vendor</th><th className="right">MSRP</th><th></th></tr></thead>
                <tbody>
                  {ITEMS.map(it => (
                    <tr key={it.id}>
                      <td><b>{it.name}</b><div className="sub mono">{it.id}</div></td>
                      <td><Vendor name={it.vendor} /></td>
                      <td className="right tnum">{rupee(it.msrp)}/mo</td>
                      <td><Btn size="sm" onClick={() => addItem(it)}>Add</Btn></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function QuotePreview(props) {
  const {
    onClose, onSend, quoteId, customerName, customerState, items,
    mode, startDate, endDate, days, months,
    discount, discountPct, subtotal, taxable, tax, total,
    interState, taxRate, validity, fromLead,
  } = props;

  const today = new Date("2026-05-20");
  const validUntil = new Date(today.getTime() + validity * 86400000);
  const fmtNice = (d) => d.toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  const cgst = Math.round(tax / 2);
  const sgst = tax - cgst;

  const periodText = mode === "prorata"
    ? `${fmtDate(startDate)} → ${fmtDate(endDate)} (${days} days · pro-rata)`
    : `${months} ${months === 1 ? "month" : "months"} commitment`;

  // PDF paper styles — forced light regardless of theme
  const paper = {
    background: "#ffffff",
    color: "#1A1815",
    width: 760,
    maxHeight: "calc(100vh - 80px)",
    overflowY: "auto",
    borderRadius: 6,
    boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
    border: "1px solid #E8E2D4",
    fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
  };
  const hair = { borderTop: "1px solid #E8E2D4" };
  const muted = { color: "#6B6457", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 };

  return (
    <div className="modal-backdrop" onClick={onClose} style={{ alignItems: "flex-start", paddingTop: 40 }}>
      <div onClick={(e) => e.stopPropagation()} style={paper}>
        {/* Letterhead band */}
        <div style={{ padding: "32px 48px 24px", borderBottom: "3px double #E8E2D4", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
              <div style={{ width: 36, height: 36, background: "#1A1815", color: "#FAF8F2", borderRadius: 6, display: "grid", placeItems: "center", fontFamily: "'DM Serif Display', serif", fontSize: 20 }}>R</div>
              <div>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, lineHeight: 1 }}>Demo Co</div>
                <div style={{ fontSize: 11, color: "#6B6457", marginTop: 2 }}>Cloud Reseller · Authorised Partner</div>
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#6B6457", lineHeight: 1.6, marginTop: 8 }}>
              Mumbai, Maharashtra 400001 · India<br />
              GSTIN: <span className="mono">27AABCE9876D1Z3</span> · pardeep@example.test · +91 98765 00000
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, lineHeight: 1, letterSpacing: "0.04em" }}>QUOTATION</div>
            <div className="mono" style={{ fontSize: 13, marginTop: 6, color: "#6B6457" }}>{quoteId}</div>
            {fromLead && <div style={{ fontSize: 11, color: "#C2410C", marginTop: 4 }}>From lead {fromLead}</div>}
          </div>
        </div>

        {/* Quote meta + parties */}
        <div style={{ padding: "20px 48px 0", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 20, fontSize: 12 }}>
          <div>
            <div style={muted}>Date issued</div>
            <div style={{ marginTop: 4, fontWeight: 500 }}>{fmtNice(today)}</div>
          </div>
          <div>
            <div style={muted}>Valid until</div>
            <div style={{ marginTop: 4, fontWeight: 500 }}>{fmtNice(validUntil)}</div>
          </div>
          <div>
            <div style={muted}>Period</div>
            <div style={{ marginTop: 4, fontWeight: 500 }}>{periodText}</div>
          </div>
        </div>

        <div style={{ padding: "16px 48px 0" }}>
          <div style={muted}>Bill to</div>
          <div style={{ marginTop: 6, fontFamily: "'DM Serif Display', serif", fontSize: 20 }}>{customerName}</div>
          <div style={{ fontSize: 11, color: "#6B6457", marginTop: 4 }}>
            Place of supply: {customerState} · GSTIN: <span className="mono">27AABCS1234D1Z5</span>
          </div>
        </div>

        {/* Line items */}
        <div style={{ padding: "20px 48px 0" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ background: "#FAF8F2" }}>
                <th style={{ padding: "10px 12px", textAlign: "left", ...muted, fontSize: 10 }}>Description</th>
                <th style={{ padding: "10px 8px", textAlign: "left", ...muted, fontSize: 10 }}>HSN</th>
                <th style={{ padding: "10px 8px", textAlign: "right", ...muted, fontSize: 10 }}>Qty</th>
                <th style={{ padding: "10px 8px", textAlign: "right", ...muted, fontSize: 10 }}>Rate</th>
                <th style={{ padding: "10px 12px", textAlign: "right", ...muted, fontSize: 10 }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it) => {
                const monthly = it.qty * it.rate;
                const lineAmount = mode === "prorata"
                  ? Math.round((monthly * 12 * days) / 365)
                  : monthly * months;
                return (
                  <tr key={it.id} style={hair}>
                    <td style={{ padding: "12px", verticalAlign: "top" }}>
                      <div style={{ fontWeight: 500 }}>{it.name}</div>
                      {it.sub && <div style={{ fontSize: 11, color: "#6B6457", marginTop: 2 }}>{it.sub}</div>}
                    </td>
                    <td style={{ padding: "12px 8px", verticalAlign: "top", fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#6B6457" }}>{it.hsn}</td>
                    <td style={{ padding: "12px 8px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{it.qty}</td>
                    <td style={{ padding: "12px 8px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums" }}>{rupee(it.rate)}/mo</td>
                    <td style={{ padding: "12px", textAlign: "right", verticalAlign: "top", fontVariantNumeric: "tabular-nums", fontWeight: 500 }}>{rupee(lineAmount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Totals */}
        <div style={{ padding: "12px 48px 0", display: "flex", justifyContent: "flex-end" }}>
          <div style={{ width: 320, fontSize: 12 }}>
            <PdfRow label={`Subtotal (${mode === "prorata" ? `${days} days` : `${months} mo`})`} value={rupee(subtotal)} />
            {discountPct > 0 && (
              <PdfRow label={`Discount (${discountPct}%)`} value={`−${rupee(discount)}`} color="#166534" />
            )}
            <PdfRow label="Taxable amount" value={rupee(taxable)} />
            {interState ? (
              <PdfRow label={`IGST @ ${taxRate}%`} value={rupee(tax)} />
            ) : (
              <>
                <PdfRow label={`CGST @ ${taxRate / 2}%`} value={rupee(cgst)} />
                <PdfRow label={`SGST @ ${taxRate / 2}%`} value={rupee(sgst)} />
              </>
            )}
            <div style={{ borderTop: "1.5px solid #1A1815", marginTop: 8, paddingTop: 10, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ ...muted, fontSize: 11 }}>Grand total</span>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, color: "#C2410C", fontVariantNumeric: "tabular-nums" }}>{rupee(total)}</span>
            </div>
            <div style={{ fontSize: 10, color: "#6B6457", textAlign: "right", marginTop: 4, fontStyle: "italic" }}>
              Amount in words: {numToWords(total)} only
            </div>
          </div>
        </div>

        {/* Terms */}
        <div style={{ padding: "24px 48px 0" }}>
          <div style={muted}>Terms & Conditions</div>
          <ol style={{ fontSize: 11, color: "#6B6457", lineHeight: 1.7, marginTop: 8, paddingLeft: 18 }}>
            <li>Pricing valid for {validity} days from date of issue.</li>
            <li>Payment terms: 100% advance against invoice. Net 15 for annual contracts above ₹5L.</li>
            <li>Onboarding includes DNS, MX, SPF, DKIM, DMARC setup + 2 training sessions (free).</li>
            <li>GST applicable as per place of supply. {interState ? "IGST" : "CGST + SGST"} computed at {taxRate}%.</li>
            <li>Subject to Mumbai jurisdiction. E. & O.E.</li>
          </ol>
        </div>

        {/* Signature */}
        <div style={{ padding: "32px 48px 32px", display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
          <div style={{ fontSize: 11, color: "#6B6457", maxWidth: 280, lineHeight: 1.5 }}>
            Thank you for considering Demo Co. For any clarifications, please contact <b>Rahul B.</b> at <span className="mono">rahul@example.test</span> or call <span className="mono">+91 98765 11111</span>.
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 14, fontStyle: "italic", color: "#1A1815", paddingBottom: 4 }}>Pardeep A.</div>
            <div style={{ borderTop: "1px solid #1A1815", width: 200, paddingTop: 4, fontSize: 10, color: "#6B6457", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Authorised Signatory
            </div>
          </div>
        </div>

        {/* Modal action bar (not part of the "PDF") */}
        <div style={{ background: "#FAF8F2", padding: "12px 48px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #E8E2D4", position: "sticky", bottom: 0 }}>
          <div style={{ fontSize: 11, color: "#6B6457" }}>
            <I name="info" size={11} /> This is a preview · Final PDF will use Demo Co letterhead
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Btn kind="ghost" onClick={onClose}>Close</Btn>
            <Btn kind="default" icon="download" onClick={() => window.print()}>Download</Btn>
            <Btn kind="primary" icon="send" onClick={onSend}>Send to customer</Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

function PdfRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
      <span style={{ color: "#6B6457" }}>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums", color: color || "#1A1815" }}>{value}</span>
    </div>
  );
}

function numToWords(n) {
  // Simplified Indian-style number-to-words for amounts up to crores
  if (!n || n < 0) return "Zero rupees";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (x) => x < 20 ? ones[x] : tens[Math.floor(x / 10)] + (x % 10 ? " " + ones[x % 10] : "");
  const three = (x) => (x >= 100 ? ones[Math.floor(x / 100)] + " Hundred" + (x % 100 ? " " + two(x % 100) : "") : two(x));
  const cr = Math.floor(n / 10000000); n %= 10000000;
  const lk = Math.floor(n / 100000);   n %= 100000;
  const th = Math.floor(n / 1000);     n %= 1000;
  const hu = n;
  const parts = [];
  if (cr) parts.push(two(cr) + " Crore");
  if (lk) parts.push(two(lk) + " Lakh");
  if (th) parts.push(two(th) + " Thousand");
  if (hu) parts.push(three(hu));
  return (parts.join(" ") || "Zero") + " Rupees";
}

function TotalRow({ label, value }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
      <span style={{ color: "var(--ink-3)" }}>{label}</span>
      <span className="tnum">{value}</span>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS["quote-builder"] = QuoteBuilderScreen;
