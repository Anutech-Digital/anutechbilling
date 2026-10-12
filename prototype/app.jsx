/* eslint-disable */
// App shell — sidebar, top bar, screen router

const APP_NAV = [
  { section: "Workspace", items: [
    { id: "dashboard",  label: "Dashboard",      icon: "home" },
    { id: "lead-gen",   label: "Lead Sources",   icon: "inbox" },
    { id: "leads",      label: "Lead Pipeline",  icon: "target",  badge: "23" },
    { id: "customers",  label: "Customers",      icon: "users" },
    { id: "items",      label: "Items Catalog",  icon: "package" },
  ]},
  { section: "Revenue", items: [
    { id: "online-orders", label: "Online Orders",  icon: "cart",    badge: "10" },
    { id: "quotes",        label: "Quotes",         icon: "file" },
    { id: "invoices",      label: "Invoices",       icon: "receipt", badge: "47" },
    { id: "subscriptions", label: "Subscriptions",  icon: "refresh" },
    { id: "renewals",      label: "Renewals",       icon: "clock",   badge: "12" },
  ]},
  { section: "Engage", items: [
    { id: "whatsapp",    label: "WhatsApp Inbox", icon: "whatsapp", badge: "6" },
    { id: "automations", label: "Automations",  icon: "zap" },
    { id: "campaigns",   label: "Campaigns",    icon: "send" },
    { id: "reports",     label: "Reports",      icon: "chart" },
    { id: "support",     label: "Support",      icon: "ticket", badge: "12" },
  ]},
  { section: "System", items: [
    { id: "setup",      label: "Setup Wizard",    icon: "rocket" },
    { id: "settings",   label: "Settings & Team", icon: "settings" },
    { id: "mobile",     label: "Mobile (PWA)",    icon: "mobile" },
  ]},
];

const CUSTOMER_FACING = [
  { id: "landing",          label: "Marketing Landing",   icon: "globe" },
  { id: "buy-workspace-v2", label: "Buy · Workspace",     icon: "sparkles" },
  { id: "buy-m365",         label: "Buy · Microsoft 365", icon: "package" },
  { id: "buy-zoho",         label: "Buy · Zoho",          icon: "package" },
  { id: "portal",           label: "Customer Portal",     icon: "layout" },
  { id: "quote-accept",     label: "Quote Accept & Pay",  icon: "check_circle" },
  { id: "onboarding",       label: "Onboarding Wizard",   icon: "rocket" },
  { id: "support-customer", label: "Customer Support",    icon: "question" },
];

const PROJECT_BRIEF = [
  { id: "welcome",    label: "Welcome",            icon: "sparkles" },
  { id: "timeline",   label: "Plan & Timeline",    icon: "calendar" },
  { id: "pricing",    label: "Investment",         icon: "rupee" },
  { id: "comparison", label: "Before vs After",    icon: "layers" },
  { id: "faq",        label: "FAQ",                icon: "question" },
];

// ============================================================
// Sidebar
// ============================================================
function Sidebar({ mobileOpen, onClose }) {
  const { route, go } = useRouter();
  const [view, setView] = useState("internal"); // internal | customer | brief

  const groups = view === "internal" ? APP_NAV
              : view === "customer" ? [{ section: "Customer-facing", items: CUSTOMER_FACING }]
              : [{ section: "Client Demo", items: PROJECT_BRIEF }];

  // Auto-close sidebar on mobile when navigating
  const handleGo = (id) => {
    go(id);
    if (onClose) onClose();
  };

  return (
    <aside className={`rail ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="rail-brand">
        <div className="rail-mark">R</div>
        <div>
          <div className="rail-brand-name">ResellerOS</div>
          <div className="rail-brand-sub">Demo Co</div>
        </div>
      </div>

      <div style={{ padding: "10px 10px 0" }}>
        <div className="seg" style={{ width: "100%" }}>
          <button className={view === "internal" ? "active" : ""} onClick={() => setView("internal")} style={{ flex: 1 }}>Internal</button>
          <button className={view === "customer" ? "active" : ""} onClick={() => setView("customer")} style={{ flex: 1 }}>Customer</button>
          <button className={view === "brief" ? "active" : ""} onClick={() => setView("brief")} style={{ flex: 1 }}>Demo</button>
        </div>
      </div>

      <div className="rail-scroll">
        {groups.map((g, i) => (
          <div key={i} className="rail-section">
            <div className="rail-label">{g.section}</div>
            {g.items.map(it => (
              <button key={it.id}
                className={`nav-item ${route === it.id ? "active" : ""}`}
                onClick={() => handleGo(it.id)}>
                <I name={it.icon} className="ico" />
                <span>{it.label}</span>
                {it.badge && <span className="badge-mini tnum">{it.badge}</span>}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className="rail-user">
        <Avatar initials="PA" color="amber" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 500 }}>Pardeep A</div>
          <div style={{ fontSize: 11, color: "var(--ink-3)" }}>Owner · Demo Co</div>
        </div>
        <IconBtn icon="logout" title="Sign out" />
      </div>
    </aside>
  );
}

// ============================================================
// Top bar — breadcrumb + search + theme toggle + actions
// ============================================================
// Sample notifications stream — simulates real events from across the system
const NOTIFICATIONS_STREAM = [
  { id: "n1",  type: "payment", title: "Payment received · ₹3.05L from Acme Corp",      meta: "2 min ago · Invoice INV-2026-0156 · Razorpay",         icon: "rupee",       color: "emerald", unread: true,  link: "invoices" },
  { id: "n2",  type: "order",   title: "New paid order · Echo Pharma · 60 seats Plus",   meta: "18 min ago · ORD-2026-0088 · ₹11.7L total",            icon: "cart",        color: "indigo",  unread: true,  link: "online-orders" },
  { id: "n3",  type: "trial",   title: "Trial started · Beta Industries · 15 seats",    meta: "1 hour ago · TRL-2026-0042 · Day 1 of 14",            icon: "rocket",      color: "amber",   unread: true,  link: "online-orders" },
  { id: "n4",  type: "issue",   title: "Provisioning failed · Hotel Asia Mumbai",       meta: "2 hours ago · Domain conflict · Needs manual fix",     icon: "alert",       color: "rose",    unread: true,  link: "online-orders" },
  { id: "n5",  type: "renewal", title: "Renewal in 2 days · Cosmo Tech · ₹16.5K MRR",   meta: "Sent reminder email · No response yet",                icon: "clock",       color: "amber",   unread: false, link: "renewals" },
  { id: "n6",  type: "risk",    title: "High-risk renewal flagged · Hotel Royal Group", meta: "Low usage 65% · NPS 4/10 · 5 support tickets",         icon: "alert",       color: "rose",    unread: false, link: "renewals" },
  { id: "n7",  type: "quote",   title: "Quote viewed · Acme Corp opened Q-2026-0042",   meta: "3rd time in 24h · Strong buying signal",               icon: "file",        color: "indigo",  unread: false, link: "quotes" },
  { id: "n8",  type: "lead",    title: "New lead · Maple Studios · 12 seats Workspace", meta: "Came via marketing landing · Auto-assigned to Priya",  icon: "target",      color: "amber",   unread: false, link: "leads" },
  { id: "n9",  type: "whatsapp",title: "WhatsApp · Karthik N replied",                  meta: "\"Can we schedule migration for Saturday?\"",          icon: "whatsapp",    color: "emerald", unread: false, link: "whatsapp" },
  { id: "n10", type: "support", title: "Support ticket #SUP-1247 resolved",             meta: "Rajesh marked as helpful · 5★ rating",                 icon: "ticket",      color: "emerald", unread: false, link: "support" },
];

function NotificationPanel({ open, onClose }) {
  const { go } = useRouter();
  const { toast } = useToast();
  const [items, setItems] = useState(NOTIFICATIONS_STREAM);
  const unreadCount = items.filter(n => n.unread).length;

  if (!open) return null;

  const markAllRead = () => {
    setItems(items.map(n => ({ ...n, unread: false })));
    toast("All notifications marked as read");
  };
  const openItem = (n) => {
    setItems(items.map(x => x.id === n.id ? { ...x, unread: false } : x));
    onClose();
    go(n.link);
  };

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 80 }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        position: "fixed",
        top: 56,
        right: 16,
        width: 400,
        maxHeight: "calc(100vh - 80px)",
        background: "var(--paper)",
        border: "1px solid var(--hairline)",
        borderRadius: 12,
        boxShadow: "0 20px 60px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.08)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        zIndex: 81,
      }}>
        {/* Header */}
        <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--hairline)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Notifications</div>
            <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
              {unreadCount > 0 ? `${unreadCount} unread · ${items.length} total` : `All caught up · ${items.length} total`}
            </div>
          </div>
          <button onClick={markAllRead} disabled={unreadCount === 0} style={{
            background: "transparent",
            border: "none",
            color: unreadCount === 0 ? "var(--ink-3)" : "var(--indigo)",
            fontSize: 12,
            fontWeight: 500,
            cursor: unreadCount === 0 ? "default" : "pointer",
          }}>Mark all read</button>
        </div>

        {/* Items */}
        <div style={{ overflowY: "auto", flex: 1 }}>
          {items.map(n => (
            <button key={n.id} onClick={() => openItem(n)} style={{
              width: "100%",
              padding: "12px 16px",
              borderBottom: "1px solid var(--hairline)",
              background: n.unread ? "var(--paper-2)" : "transparent",
              display: "flex",
              gap: 10,
              alignItems: "flex-start",
              textAlign: "left",
              border: "none",
              borderBottom: "1px solid var(--hairline)",
              cursor: "pointer",
              fontFamily: "inherit",
              transition: "background 100ms",
            }}
              onMouseEnter={(e) => e.currentTarget.style.background = "var(--paper-2)"}
              onMouseLeave={(e) => e.currentTarget.style.background = n.unread ? "var(--paper-2)" : "transparent"}
            >
              <div style={{
                flexShrink: 0,
                width: 32,
                height: 32,
                borderRadius: "50%",
                background: `var(--${n.color}-soft)`,
                color: `var(--${n.color})`,
                display: "grid",
                placeItems: "center",
              }}>
                <I name={n.icon} size={14} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: n.unread ? 600 : 400, lineHeight: 1.4, color: "var(--ink)" }}>
                  {n.title}
                </div>
                <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.4 }}>
                  {n.meta}
                </div>
              </div>
              {n.unread && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--indigo)", flexShrink: 0, marginTop: 6 }} />}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--hairline)", display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--paper-2)" }}>
          <button onClick={() => { onClose(); go("automations"); }} style={{ background: "transparent", border: "none", color: "var(--ink-3)", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <I name="settings" size={11} /> Notification settings
          </button>
          <button onClick={() => toast("Notification history opened")} style={{ background: "transparent", border: "none", color: "var(--indigo)", fontSize: 12, cursor: "pointer", fontWeight: 500 }}>View all →</button>
        </div>
      </div>
    </div>
  );
}

function TopBar({ crumb, onMobileToggle }) {
  const { theme, setTheme } = useTheme();
  const [notifOpen, setNotifOpen] = useState(false);
  const unreadCount = NOTIFICATIONS_STREAM.filter(n => n.unread).length;

  return (
    <div className="topbar">
      <IconBtn icon="list" title="Menu" onClick={onMobileToggle} />
      <style>{`.topbar > .icon-btn:first-child { display: none } @media (max-width: 900px) { .topbar > .icon-btn:first-child { display: inline-flex } }`}</style>
      <div className="crumb">
        <I name="home" size={13} />
        <span className="sep">/</span>
        {crumb.map((c, i) => (
          <React.Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
          </React.Fragment>
        ))}
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-search" onClick={() => { window.dispatchEvent(new CustomEvent("open-cmdk")); }}>
        <I name="search" size={14} />
        <input placeholder="Search customers, invoices, leads…" readOnly style={{ cursor: "pointer" }} />
        <span className="kbd">⌘K</span>
      </div>
      <IconBtn icon={theme === "dark" ? "sun" : "moon"} title="Toggle theme" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} />
      <div style={{ position: "relative" }}>
        <IconBtn icon="bell" title="Notifications" onClick={() => setNotifOpen(!notifOpen)} />
        {unreadCount > 0 && (
          <span style={{
            position: "absolute",
            top: 4,
            right: 4,
            minWidth: 16,
            height: 16,
            padding: "0 4px",
            borderRadius: 999,
            background: "var(--rose)",
            color: "#fff",
            fontSize: 9,
            fontWeight: 700,
            display: "grid",
            placeItems: "center",
            border: "2px solid var(--paper)",
            pointerEvents: "none",
          }}>{unreadCount}</span>
        )}
      </div>
      <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
    </div>
  );
}

// ============================================================
// Screen registry & shell
// ============================================================
const SCREEN_TITLES = {
  dashboard:        ["Workspace", "Dashboard"],
  "lead-gen":       ["Workspace", "Lead Sources"],
  leads:            ["Workspace", "Lead Pipeline"],
  customers:        ["Workspace", "Customers"],
  items:            ["Workspace", "Items Catalog"],
  "online-orders":  ["Revenue", "Online Orders"],
  quotes:           ["Revenue", "Quotes"],
  "quote-builder":  ["Revenue", "Quotes", "Builder"],
  invoices:         ["Revenue", "Invoices"],
  subscriptions:    ["Revenue", "Subscriptions"],
  renewals:         ["Revenue", "Renewals"],
  whatsapp:         ["Engage", "WhatsApp Inbox"],
  automations:      ["Engage", "Automations"],
  campaigns:        ["Engage", "Campaigns"],
  reports:          ["Engage", "Reports"],
  support:          ["Engage", "Support"],
  setup:            ["System", "Setup Wizard"],
  settings:         ["System", "Settings & Team"],
  mobile:           ["System", "Mobile (PWA)"],
  landing:          ["Customer-facing", "Landing Page"],
  "buy-workspace":     ["Customer-facing", "Buy Workspace"],
  "buy-workspace-v2":  ["Customer-facing", "Buy Workspace V2 (clean)"],
  "buy-m365":       ["Customer-facing", "Buy Microsoft 365"],
  "buy-zoho":       ["Customer-facing", "Buy Zoho"],
  portal:           ["Customer-facing", "Customer Portal"],
  "quote-accept":   ["Customer-facing", "Quote Accept & Pay"],
  onboarding:       ["Customer-facing", "Onboarding Wizard"],
  "support-customer":["Customer-facing", "Customer Support"],
  welcome:          ["Client Demo", "Welcome"],
  timeline:         ["Client Demo", "Plan & Timeline"],
  pricing:          ["Client Demo", "Investment & Pricing"],
  comparison:       ["Client Demo", "Before vs After"],
  faq:              ["Client Demo", "FAQ"],
};

// ============================================================
// Command Palette (⌘K) — global search + quick actions
// ============================================================
function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const { go } = useRouter();
  const { toast } = useToast();
  const inputRef = useRef(null);

  // Listen for ⌘K / Ctrl+K + the topbar click event
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen(o => !o);
      }
      if (e.key === "Escape" && open) setOpen(false);
    };
    const onCustom = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-cmdk", onCustom);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-cmdk", onCustom);
    };
  }, [open]);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQ("");
      setActiveIdx(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Build the search index — pages + entities + actions
  const allItems = useMemo(() => {
    const pages = Object.entries(SCREEN_TITLES).map(([id, crumb]) => ({
      type: "page", group: "Pages", id, title: crumb[crumb.length - 1], sub: crumb.join(" · "), icon: "layout", action: () => go(id),
    }));
    const customers = (window.CUSTOMERS || []).map(c => ({
      type: "customer", group: "Customers", id: "cust-" + c.id, title: c.name, sub: c.domain + " · " + c.contact.name, icon: "users", action: () => { window.__currentCustomer = c.id; go("customers"); },
    }));
    const leads = (window.LEADS || []).map(l => ({
      type: "lead", group: "Leads", id: "lead-" + l.id, title: l.company, sub: `${l.plan} · ${l.seats} seats · ${l.stage}`, icon: "target", action: () => go("leads"),
    }));
    const quotes = (window.QUOTES || []).map(q => ({
      type: "quote", group: "Quotes", id: "q-" + q.id, title: `${q.id} — ${q.customer}`, sub: `${q.plan} · ${q.seats} seats · ${q.status}`, icon: "file", action: () => { window.__quoteFromList = q; go("quote-builder"); },
    }));
    const invoices = (window.INVOICES || []).map(i => ({
      type: "invoice", group: "Invoices", id: "inv-" + i.id, title: `${i.id} — ${i.cust}`, sub: `${i.status} · due ${i.due}`, icon: "receipt", action: () => go("invoices"),
    }));
    const actions = [
      { type: "action", group: "Quick Actions", id: "act-new-lead",   title: "Create new lead",      sub: "Add to Lead Pipeline",      icon: "plus",  action: () => { go("lead-gen"); toast("New lead form opening…"); } },
      { type: "action", group: "Quick Actions", id: "act-new-quote",  title: "Create new quote",     sub: "Open Quote Builder fresh",  icon: "file",  action: () => { delete window.__quoteFromLead; delete window.__quoteFromList; go("quote-builder"); } },
      { type: "action", group: "Quick Actions", id: "act-new-cust",   title: "Add new customer",     sub: "Create customer record",    icon: "users", action: () => { go("customers"); toast("New customer form opening…"); } },
      { type: "action", group: "Quick Actions", id: "act-new-camp",   title: "Launch new campaign",  sub: "Email or WhatsApp blast",   icon: "send",  action: () => { go("campaigns"); toast("Campaign builder opening…"); } },
      { type: "action", group: "Quick Actions", id: "act-sync",       title: "Sync vendor portals",  sub: "Google CSP + M365 + Zoho",  icon: "refresh", action: () => toast("Syncing all vendor portals…") },
      { type: "action", group: "Quick Actions", id: "act-bulk-renew", title: "Send renewal reminders", sub: "To customers expiring in 30d", icon: "mail", action: () => toast("Sent renewal reminders to 12 customers") },
      { type: "action", group: "Settings", id: "act-toggle-theme", title: "Toggle dark mode", sub: "Light ⇄ Dark", icon: "moon", action: () => { document.documentElement.dataset.theme = (document.documentElement.dataset.theme === "dark" ? "light" : "dark"); toast("Theme toggled"); } },
    ];
    return [...actions, ...pages, ...customers, ...leads, ...quotes, ...invoices];
  }, []);

  // Fuzzy filter — score each by token-match in title + sub
  const filtered = useMemo(() => {
    if (!q.trim()) return allItems.slice(0, 50);
    const lc = q.toLowerCase();
    return allItems
      .map(it => {
        const haystack = (it.title + " " + it.sub).toLowerCase();
        if (!haystack.includes(lc)) return null;
        // Score: title-match > sub-match, prefix > middle
        let score = 0;
        if (it.title.toLowerCase().startsWith(lc)) score += 100;
        else if (it.title.toLowerCase().includes(lc)) score += 50;
        if (it.sub.toLowerCase().includes(lc)) score += 10;
        return { ...it, _score: score };
      })
      .filter(Boolean)
      .sort((a, b) => b._score - a._score)
      .slice(0, 50);
  }, [q, allItems]);

  // Group results
  const groups = useMemo(() => {
    const m = {};
    filtered.forEach(it => {
      if (!m[it.group]) m[it.group] = [];
      m[it.group].push(it);
    });
    return m;
  }, [filtered]);

  // Reset active idx when filter changes
  useEffect(() => { setActiveIdx(0); }, [q]);

  const runItem = (it) => { setOpen(false); it.action(); };

  // Keyboard nav
  const onKey = (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx(i => Math.min(filtered.length - 1, i + 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIdx(i => Math.max(0, i - 1)); }
    if (e.key === "Enter")     { e.preventDefault(); if (filtered[activeIdx]) runItem(filtered[activeIdx]); }
  };

  if (!open) return null;

  let flatIdx = -1; // for tracking active item across groups

  return (
    <div onClick={() => setOpen(false)} style={{
      position: "fixed",
      inset: 0,
      background: "rgba(15,15,15,0.45)",
      zIndex: 200,
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
      paddingTop: "12vh",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: "min(640px, 92vw)",
        background: "var(--paper)",
        borderRadius: 14,
        boxShadow: "0 24px 70px rgba(0,0,0,0.30), 0 4px 12px rgba(0,0,0,0.10)",
        border: "1px solid var(--hairline)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        maxHeight: "70vh",
      }}>
        {/* Search input */}
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--hairline)", display: "flex", alignItems: "center", gap: 12 }}>
          <I name="search" size={18} className="ico" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Search customers, leads, quotes, invoices, or run an action…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              background: "transparent",
              fontSize: 15,
              color: "var(--ink)",
              fontFamily: "inherit",
            }}
          />
          <span className="kbd" style={{ fontSize: 10 }}>ESC</span>
        </div>

        {/* Results */}
        <div style={{ overflowY: "auto", flex: 1, padding: "8px 0" }}>
          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: "var(--ink-3)", fontSize: 13 }}>
              No matches for "<b>{q}</b>"
            </div>
          )}
          {Object.entries(groups).map(([groupName, items]) => (
            <div key={groupName}>
              <div style={{ padding: "8px 18px 4px", fontSize: 10, fontWeight: 700, color: "var(--ink-3)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                {groupName}
              </div>
              {items.map((it) => {
                flatIdx += 1;
                const isActive = flatIdx === activeIdx;
                return (
                  <button key={it.id} onClick={() => runItem(it)} onMouseEnter={() => setActiveIdx(flatIdx)} style={{
                    width: "100%",
                    padding: "10px 18px",
                    background: isActive ? "var(--paper-2)" : "transparent",
                    border: "none",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    textAlign: "left",
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}>
                    <I name={it.icon} size={15} className="ico" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.title}</div>
                      <div style={{ fontSize: 11, color: "var(--ink-3)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.sub}</div>
                    </div>
                    {isActive && (
                      <span style={{ fontSize: 10, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 4 }}>
                        ↵ <span className="kbd" style={{ fontSize: 10 }}>Enter</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hint */}
        <div style={{ padding: "8px 16px", borderTop: "1px solid var(--hairline)", background: "var(--paper-2)", display: "flex", gap: 14, fontSize: 11, color: "var(--ink-3)" }}>
          <span><span className="kbd" style={{ fontSize: 10 }}>↑</span> <span className="kbd" style={{ fontSize: 10 }}>↓</span> navigate</span>
          <span><span className="kbd" style={{ fontSize: 10 }}>↵</span> select</span>
          <span><span className="kbd" style={{ fontSize: 10 }}>ESC</span> close</span>
          <div style={{ flex: 1 }} />
          <span>{filtered.length} {filtered.length === 1 ? "result" : "results"}</span>
        </div>
      </div>
    </div>
  );
}

function Shell() {
  const { route } = useRouter();
  const Screen = window.SCREENS[route] || window.SCREENS.dashboard;
  const crumb = SCREEN_TITLES[route] || ["Workspace", "Dashboard"];
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Customer-facing & brief screens get a chromeless layout (no topbar)
  const chromeless = ["landing", "portal", "quote-accept", "onboarding", "support-customer",
                      "welcome", "timeline", "pricing", "comparison", "faq",
                      "buy-workspace", "buy-m365", "buy-zoho", "buy-workspace-v2",
                      "setup"].includes(route);

  // Close mobile nav on route change
  useEffect(() => { setMobileNavOpen(false); }, [route]);

  return (
    <div className="app">
      <Sidebar mobileOpen={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className={`rail-backdrop ${mobileNavOpen ? "show" : ""}`} onClick={() => setMobileNavOpen(false)} />
      <main className="main">
        {!chromeless && <TopBar crumb={crumb} onMobileToggle={() => setMobileNavOpen(o => !o)} />}
        <div key={route} className="screen-enter" data-screen-label={route}>
          <Screen />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
}

// ============================================================
// Tweaks integration
// ============================================================
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": false,
  "accent": "#C2410C",
  "density": "regular"
}/*EDITMODE-END*/;

function TweaksWrapper() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const { setTheme } = useTheme();
  useEffect(() => { setTheme(t.dark ? "dark" : "light"); }, [t.dark]);
  useEffect(() => {
    document.documentElement.style.setProperty("--amber", t.accent);
  }, [t.accent]);
  useEffect(() => {
    document.documentElement.dataset.density = t.density;
  }, [t.density]);
  return (
    <TweaksPanel>
      <TweakSection label="Appearance" />
      <TweakToggle label="Dark mode" value={t.dark} onChange={(v) => setTweak("dark", v)} />
      <TweakColor  label="Accent" value={t.accent}
        options={["#C2410C", "#3730A3", "#166534", "#B91C1C", "#1A73E8", "#D946EF"]}
        onChange={(v) => setTweak("accent", v)} />
      <TweakRadio  label="Density" value={t.density}
        options={["compact", "regular"]}
        onChange={(v) => setTweak("density", v)} />
    </TweaksPanel>
  );
}

function App() {
  return (
    <ThemeProvider>
      <RouterProvider>
        <ToastProvider>
          <Shell />
          <TweaksWrapper />
        </ToastProvider>
      </RouterProvider>
    </ThemeProvider>
  );
}

window.App = App;
