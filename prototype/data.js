/* eslint-disable */
// Sample data for ResellerOS — from the brief, expanded for realism

const RESELLER = {
  name: "Demo Co Pvt Ltd",
  gstin: "27AABCE9876D1Z3",
  state: "Maharashtra (27)",
  stateCode: "27",
  address: "Mumbai, Maharashtra 400001",
  email: "pardeep@example.test",
  phone: "+91 98765 00000",
};

const TEAM = {
  pardeep: { name: "Pardeep A", initials: "PA", role: "Owner", color: "ink" },
  rahul:   { name: "Rahul B",  initials: "RB", role: "Sales", color: "indigo" },
  priya:   { name: "Priya R",  initials: "PR", role: "Sales", color: "amber" },
  amit:    { name: "Amit M",   initials: "AM", role: "Accountant", color: "emerald" },
  sneha:   { name: "Sneha K",  initials: "SK", role: "Support", color: "rose" },
};

const KPIS_DASHBOARD = [
  { id: "mrr",      label: "MRR",            value: "₹4.2L",  trend: "+12% vs last month",  trendKind: "up",   trendIcon: "trending_up",   icon: "rupee" },
  { id: "pipeline", label: "Pipeline",       value: "₹18L",   trend: "23 deals in motion", trendKind: "neutral", icon: "target" },
  { id: "renewals", label: "Renewals Due",   value: "12",     trend: "5 in next 30 days",  trendKind: "down", trendIcon: "alert", icon: "clock" },
  { id: "overdue",  label: "Overdue",        value: "₹3.5L",  trend: "7 invoices pending", trendKind: "down", trendIcon: "alert", icon: "receipt" },
  { id: "csat",     label: "CSAT",           value: "4.8",    unit: "/ 5", trend: "+0.2 this quarter",  trendKind: "up", trendIcon: "trending_up", icon: "smile" },
  { id: "churn",    label: "Churn (annual)", value: "8",      unit: "%",   trend: "−3% improved",       trendKind: "up", trendIcon: "trending_down", icon: "refresh" },
];

const LEAD_STAGES = [
  { id: "new",      label: "New",        dot: "slate",   color: "var(--slate)" },
  { id: "contact",  label: "Contacted",  dot: "amber",   color: "var(--amber)" },
  { id: "demo",     label: "Demo Done",  dot: "indigo",  color: "var(--indigo)" },
  { id: "trial",    label: "Trial Active", dot: "rose",  color: "var(--rose)" },
  { id: "quote",    label: "Quote Sent", dot: "indigo",  color: "var(--indigo)" },
  { id: "won",      label: "Won",        dot: "emerald", color: "var(--emerald)" },
];

const LEADS = [
  // New
  { id: "L1",  stage: "new", company: "TechBrand Pvt Ltd",   plan: "Workspace Std",   seats: 25, value: 200000, age: "2d ago", owner: "priya" },
  { id: "L2",  stage: "new", company: "Hotel Royal Group",   plan: "Mixed plans",      seats: 40, value: 400000, age: "3d ago", owner: "rahul" },
  { id: "L3",  stage: "new", company: "Kilo Foods Ltd",      plan: "Starter",          seats: 15, value: 300000, age: "4d ago", owner: "amit" },
  { id: "L4",  stage: "new", company: "Maple Studios",       plan: "Workspace Plus",   seats: 12, value: 180000, age: "5d ago", owner: "priya" },
  { id: "L5",  stage: "new", company: "Nova Print Co.",      plan: "Starter",          seats: 8,  value: 80000,  age: "6d ago", owner: "rahul" },
  // Contacted
  { id: "L6",  stage: "contact", company: "Orbit Logistics", plan: "Workspace Std",    seats: 30, value: 260000, age: "1d ago", owner: "rahul" },
  { id: "L7",  stage: "contact", company: "Patel & Sons",     plan: "Voice + Std",      seats: 18, value: 160000, age: "2d ago", owner: "priya" },
  { id: "L8",  stage: "contact", company: "Quantum Labs",     plan: "Plus",             seats: 22, value: 320000, age: "3d ago", owner: "amit" },
  { id: "L9",  stage: "contact", company: "Riverside Hotels", plan: "Std",              seats: 35, value: 290000, age: "4d ago", owner: "priya" },
  // Demo
  { id: "L10", stage: "demo", company: "Sapphire Exports",    plan: "Plus + Voice",     seats: 28, value: 410000, age: "1d ago", owner: "rahul" },
  { id: "L11", stage: "demo", company: "Tata Crafts",         plan: "Std",              seats: 16, value: 140000, age: "3d ago", owner: "priya" },
  { id: "L12", stage: "demo", company: "Urban Wear Co.",      plan: "Plus",             seats: 24, value: 340000, age: "5d ago", owner: "amit" },
  // Trial
  { id: "L13", stage: "trial", company: "Vintage Motors",     plan: "Std",              seats: 12, value: 100000, age: "2d ago", owner: "rahul" },
  { id: "L14", stage: "trial", company: "Whitestone Pharma",  plan: "Plus",             seats: 32, value: 460000, age: "4d ago", owner: "priya" },
  { id: "L15", stage: "trial", company: "Xenon Foods",        plan: "Starter",          seats: 10, value: 90000,  age: "6d ago", owner: "amit" },
  { id: "L16", stage: "trial", company: "Yara Tea",           plan: "Std",              seats: 20, value: 180000, age: "8d ago", owner: "rahul" },
  // Quote
  { id: "L17", stage: "quote", company: "Acme Corp Pvt Ltd",  plan: "Plus (upgrade)",   seats: 25, value: 490644, age: "1d ago", owner: "rahul" },
  { id: "L18", stage: "quote", company: "Zephyr Networks",    plan: "Plus + Voice",     seats: 28, value: 380000, age: "2d ago", owner: "priya" },
  // Won
  { id: "L19", stage: "won", company: "Anvil Heavy Industries", plan: "Plus",          seats: 50, value: 820000, age: "Closed", owner: "rahul" },
  { id: "L20", stage: "won", company: "Beta Industries",      plan: "Std",              seats: 15, value: 132480, age: "Closed", owner: "priya" },
  { id: "L21", stage: "won", company: "Chinar Resorts",       plan: "Std",              seats: 22, value: 240000, age: "Closed", owner: "amit" },
];

const CUSTOMER_ACME = {
  id: "acme",
  name: "Acme Corp Pvt Ltd",
  domain: "acmecorp.com",
  since: "15 Sep 2023",
  gstin: "27AABCS1234D1Z5",
  state: "Maharashtra (27)",
  contact: { name: "Rajesh K", title: "CTO", email: "rajesh@acmecorp.com", phone: "+91 98765 43210" },
  health: 85,
  mrr: 38500,
  arr: 462000,
  renewal: "15 Sep 2026",
  manager: "rahul",
};

const CUSTOMERS = [
  CUSTOMER_ACME,
  { id: "cosmo",   name: "Cosmo Tech",         domain: "cosmotech.in",  since: "21 May 2025", gstin: "27AABCC3456E2F7", state: "Maharashtra (27)", contact: { name: "Sneha M",   title: "IT Head",          email: "sneha@cosmotech.in",   phone: "+91 98123 11111" }, health: 72, mrr: 16560,  arr: 198720,  renewal: "21 May 2026", manager: "rahul"  },
  { id: "delta",   name: "Delta Pvt Ltd",      domain: "deltapl.com",   since: "22 Jun 2024", gstin: "27AABCD5678F3G9", state: "Maharashtra (27)", contact: { name: "Arjun S",   title: "CTO",              email: "arjun@deltapl.com",     phone: "+91 99100 22334" }, health: 91, mrr: 69000,  arr: 828000,  renewal: "22 Jun 2026", manager: "rahul"  },
  { id: "echo",    name: "Echo Pharma",        domain: "echopharma.in", since: "10 Jan 2024", gstin: "29AABCE8765H4J1", state: "Karnataka (29)",   contact: { name: "Dr. Verma", title: "CEO",              email: "verma@echopharma.in",   phone: "+91 98765 33445" }, health: 95, mrr: 115200, arr: 1382400, renewal: "10 Jan 2027", manager: "amit"   },
  { id: "beta",    name: "Beta Industries",    domain: "betaind.in",    since: "18 Jun 2024", gstin: "27AABCB1234K5L6", state: "Maharashtra (27)", contact: { name: "Priya M",   title: "Operations Head",  email: "priya@betaind.in",      phone: "+91 99887 11223" }, health: 88, mrr: 11040,  arr: 132480,  renewal: "18 Jun 2026", manager: "priya"  },
  { id: "foxtrot", name: "Foxtrot Logistics",  domain: "foxtrot.in",    since: "02 Apr 2024", gstin: "27AABCF7890M6N7", state: "Maharashtra (27)", contact: { name: "Karan K",   title: "Director",         email: "karan@foxtrot.in",      phone: "+91 98765 44556" }, health: 82, mrr: 34650,  arr: 415800,  renewal: "02 Apr 2027", manager: "priya"  },
  { id: "hotel",   name: "Hotel Royal Group",  domain: "hrgroup.com",   since: "24 May 2025", gstin: "27AABCH2345P7Q8", state: "Maharashtra (27)", contact: { name: "Anita G",   title: "GM Operations",    email: "anita@hrgroup.com",     phone: "+91 99887 88990" }, health: 65, mrr: 5888,   arr: 70656,   renewal: "24 May 2026", manager: "rahul"  },
];

const INVOICES = [
  { id: "INV-2026-0089", cust: "Acme Corp",            date: "15 May 2026", due: "15 Jun 2026", amt: 490644,  status: "pending" },
  { id: "INV-2026-0088", cust: "Beta Industries",      date: "14 May 2026", due: "14 Jun 2026", amt: 132480,  status: "paid"    },
  { id: "INV-2026-0087", cust: "Cosmo Tech",           date: "12 May 2026", due: "12 Jun 2026", amt: 198720,  status: "pending" },
  { id: "INV-2026-0086", cust: "Delta Pvt Ltd",        date: "10 May 2026", due: "10 Jun 2026", amt: 828000,  status: "paid"    },
  { id: "INV-2026-0085", cust: "Echo Pharma",          date: "05 Apr 2026", due: "05 May 2026", amt: 215640,  status: "overdue", overdueDays: 14 },
  { id: "INV-2026-0084", cust: "Foxtrot Logistics",    date: "02 Apr 2026", due: "02 May 2026", amt: 472000,  status: "overdue", overdueDays: 17 },
  { id: "INV-2026-0083", cust: "Golf Resorts",         date: "28 Mar 2026", due: "28 Apr 2026", amt: 589400,  status: "paid"    },
  { id: "INV-2026-0082", cust: "Hi-Tech Solutions",    date: "20 Mar 2026", due: "20 Apr 2026", amt: 312000,  status: "paid"    },
  { id: "INV-2026-0081", cust: "Indigo Apparel",       date: "12 Mar 2026", due: "12 Apr 2026", amt: 198000,  status: "paid"    },
  { id: "INV-2026-0080", cust: "Jasmin Logistics",     date: "01 Mar 2026", due: "01 Apr 2026", amt: 156000,  status: "overdue", overdueDays: 49 },
];

const ITEMS = [
  { id: "GW-STR",   name: "Google Workspace Starter",    vendor: "google",    hsn: "998313", msrp: 136,   wholesale: 110,  margin: 19 },
  { id: "GW-STD",   name: "Google Workspace Standard",   vendor: "google",    hsn: "998313", msrp: 736,   wholesale: 620,  margin: 16 },
  { id: "GW-PLS",   name: "Google Workspace Plus",       vendor: "google",    hsn: "998313", msrp: 1380,  wholesale: 1150, margin: 17 },
  { id: "GW-ENT",   name: "Google Workspace Enterprise", vendor: "google",    hsn: "998313", msrp: 2400,  wholesale: 2050, margin: 15 },
  { id: "GV-STD",   name: "Google Voice Standard",       vendor: "google",    hsn: "998313", msrp: 800,   wholesale: 680,  margin: 15 },
  { id: "GV-PRM",   name: "Google Voice Premier",        vendor: "google",    hsn: "998313", msrp: 1600,  wholesale: 1380, margin: 14 },
  { id: "M365-BB",  name: "Microsoft 365 Business Basic",   vendor: "microsoft", hsn: "998313", msrp: 200,   wholesale: 165,  margin: 18 },
  { id: "M365-BS",  name: "Microsoft 365 Business Standard", vendor: "microsoft", hsn: "998313", msrp: 990,   wholesale: 820,  margin: 17 },
  { id: "M365-BP",  name: "Microsoft 365 Business Premium",  vendor: "microsoft", hsn: "998313", msrp: 1900,  wholesale: 1620, margin: 15 },
  { id: "ZW-STD",   name: "Zoho Workplace Standard",     vendor: "zoho",      hsn: "998313", msrp: 120,   wholesale: 95,   margin: 21 },
  { id: "ZW-PRO",   name: "Zoho Workplace Professional", vendor: "zoho",      hsn: "998313", msrp: 280,   wholesale: 220,  margin: 21 },
  { id: "GW-APP-C", name: "AppSheet Core",               vendor: "google",    hsn: "998313", msrp: 830,   wholesale: 720,  margin: 13 },
];

const SUBS = [
  { id: "S1",  cust: "Acme Corp",         dom: "acmecorp.com",   plan: "Workspace Plus", vendor: "google",    seats: 25, used: 22, mrr: 34500, start: "15 Sep 2023", renewal: "15 Sep 2026", days: 118, status: "active" },
  { id: "S2",  cust: "Acme Corp",         dom: "Add-on",         plan: "Voice Standard", vendor: "google",    seats: 5,  used: 5,  mrr: 4000,  start: "15 Sep 2023", renewal: "15 Sep 2026", days: 118, status: "active" },
  { id: "S3",  cust: "Cosmo Tech",        dom: "cosmotech.in",   plan: "Workspace Plus", vendor: "google",    seats: 12, used: 12, mrr: 16560, start: "21 May 2025", renewal: "21 May 2026", days: 2,   status: "active", urgent: true },
  { id: "S4",  cust: "Delta Pvt Ltd",     dom: "deltapl.com",    plan: "Workspace Plus", vendor: "google",    seats: 50, used: 48, mrr: 69000, start: "22 Jun 2024", renewal: "22 Jun 2026", days: 33,  status: "active" },
  { id: "S5",  cust: "Echo Pharma",       dom: "echopharma.in",  plan: "Enterprise",     vendor: "google",    seats: 80, used: 78, mrr: 115200,start: "10 Jan 2024", renewal: "10 Jan 2027", days: 235, status: "active" },
  { id: "S6",  cust: "Hotel Royal Group", dom: "hrgroup.com",    plan: "Workspace Std",  vendor: "google",    seats: 8,  used: 8,  mrr: 5888,  start: "24 May 2025", renewal: "24 May 2026", days: 5,   status: "active", urgent: true },
  { id: "S7",  cust: "Foxtrot Logistics", dom: "foxtrot.in",     plan: "M365 Business Std", vendor: "microsoft", seats: 35, used: 33, mrr: 34650, start: "02 Apr 2024", renewal: "02 Apr 2027", days: 317, status: "active" },
  { id: "S8",  cust: "Golf Resorts",      dom: "golfresorts.in", plan: "Zoho Workplace Std", vendor: "zoho",  seats: 22, used: 22, mrr: 2640,  start: "28 Mar 2025", renewal: "28 Mar 2026", days: -52, status: "expired" },
  { id: "S9",  cust: "Kilo Foods Ltd",    dom: "kilofoods.in",   plan: "Starter",        vendor: "google",    seats: 30, used: 28, mrr: 4080,  start: "25 May 2024", renewal: "25 May 2026", days: 6,   status: "active", urgent: true },
  { id: "S10", cust: "Beta Industries",   dom: "betaind.in",     plan: "Workspace Std",  vendor: "google",    seats: 15, used: 14, mrr: 11040, start: "18 Jun 2024", renewal: "18 Jun 2026", days: 30 },
];

const RENEWALS_URGENT = SUBS.filter(s => s.urgent);

const ACTIVITIES = [
  { group: "today", icon: "phone",  iconBg: "indigo", title: "Call with Rajesh — Discussed Plus upgrade",
    meta: "11:30 AM · Outcome: Positive · Next: Send revised quote by 2 PM · By Rahul B" },
  { group: "today", icon: "mail",   iconBg: "amber",  title: "Email received: \"Re: Workspace upgrade query\"",
    meta: "09:45 AM · From rajesh@acmecorp.com" },
  { group: "yesterday", icon: "refresh", iconBg: "emerald", title: "Status changed: Trial Active → Quote Sent",
    meta: "04:15 PM · Quote #Q-2026-0042 sent for ₹4.9L" },
  { group: "yesterday", icon: "file", iconBg: "slate", title: "Quote Q-2026-0042 generated",
    meta: "03:50 PM · 2 line items · Validity 30 days" },
  { group: "last_week", icon: "users", iconBg: "indigo", title: "Demo scheduled — 2 hours @ Mumbai office",
    meta: "4 attendees · Outcome: Strong interest in Plus" },
  { group: "last_week", icon: "edit", iconBg: "amber", title: "Note added",
    meta: "\"Decision maker = CTO Rajesh, not founder. Budget approved ₹3L.\"" },
];

const QUOTES = [
  { id: "Q-2026-0042", customer: "Acme Corp Pvt Ltd",      plan: "Plus + Voice (upgrade)", seats: 30, amount: 490644, status: "sent",     created: "19 May 2026", expires: "18 Jun 2026", owner: "rahul", leadId: "L17" },
  { id: "Q-2026-0041", customer: "Beta Industries",        plan: "Workspace Std",          seats: 15, amount: 132480, status: "accepted", created: "12 May 2026", expires: "11 Jun 2026", owner: "priya", leadId: "L20" },
  { id: "Q-2026-0040", customer: "Anvil Heavy Industries", plan: "Plus",                   seats: 50, amount: 820000, status: "accepted", created: "08 May 2026", expires: "07 Jun 2026", owner: "rahul", leadId: "L19" },
  { id: "Q-2026-0039", customer: "Zephyr Networks",        plan: "Plus + Voice",           seats: 28, amount: 380000, status: "viewed",   created: "18 May 2026", expires: "17 Jun 2026", owner: "priya", leadId: "L18" },
  { id: "Q-2026-0038", customer: "Sapphire Exports",       plan: "Plus + Voice",           seats: 28, amount: 410000, status: "draft",    created: "20 May 2026", expires: "19 Jun 2026", owner: "rahul", leadId: "L10" },
  { id: "Q-2026-0037", customer: "Whitestone Pharma",      plan: "Plus",                   seats: 32, amount: 460000, status: "viewed",   created: "16 May 2026", expires: "15 Jun 2026", owner: "priya", leadId: "L14" },
  { id: "Q-2026-0036", customer: "Chinar Resorts",         plan: "Workspace Std",          seats: 22, amount: 240000, status: "accepted", created: "01 May 2026", expires: "31 May 2026", owner: "amit",  leadId: "L21" },
  { id: "Q-2026-0035", customer: "Quantum Labs",           plan: "Plus",                   seats: 22, amount: 320000, status: "sent",     created: "10 May 2026", expires: "09 Jun 2026", owner: "amit",  leadId: "L8"  },
  { id: "Q-2026-0034", customer: "Hotel Royal Group",      plan: "Mixed plans",            seats: 40, amount: 400000, status: "expired",  created: "15 Apr 2026", expires: "15 May 2026", owner: "rahul", leadId: "L2"  },
  { id: "Q-2026-0033", customer: "Yara Tea",               plan: "Workspace Std",          seats: 20, amount: 180000, status: "sent",     created: "17 May 2026", expires: "16 Jun 2026", owner: "rahul", leadId: "L16" },
  { id: "Q-2026-0032", customer: "Urban Wear Co.",         plan: "Plus",                   seats: 24, amount: 340000, status: "viewed",   created: "14 May 2026", expires: "13 Jun 2026", owner: "amit",  leadId: "L12" },
  { id: "Q-2026-0031", customer: "Riverside Hotels",       plan: "Workspace Std",          seats: 35, amount: 290000, status: "rejected", created: "05 May 2026", expires: "04 Jun 2026", owner: "priya", leadId: "L9"  },
];

// Margin calculation — reseller's edge over generic CRM
// Given a plan name/code + seats, returns the cost/price/margin breakdown.
function marginFor(planOrItemId, seats = 1) {
  const item = ITEMS.find(i => i.id === planOrItemId)
            || ITEMS.find(i => planOrItemId && (planOrItemId.toLowerCase().includes(i.name.toLowerCase().split(" ")[2] || "_")));
  if (!item) return { cost: 0, price: 0, margin: 0, marginPct: 0, unitCost: 0, unitPrice: 0 };
  const unitCost  = item.wholesale;
  const unitPrice = item.msrp;
  const cost   = unitCost * seats;
  const price  = unitPrice * seats;
  const margin = price - cost;
  const marginPct = unitPrice ? Math.round((margin / price) * 100) : 0;
  return { cost, price, margin, marginPct, unitCost, unitPrice, item };
}

// Aggregate margin across multiple line items (annual figure)
function marginAnnual(items) {
  return items.reduce((acc, it) => {
    const m = marginFor(it.itemId || it.id, it.qty);
    return {
      cost:   acc.cost   + m.cost   * 12,
      price:  acc.price  + m.price  * 12,
      margin: acc.margin + m.margin * 12,
    };
  }, { cost: 0, price: 0, margin: 0 });
}

// Quick subscription margin (assumes SUBS row with seats + a heuristic plan-to-item match)
function subMargin(sub) {
  // Heuristic mapping from plan name → ITEMS id
  const p = (sub.plan || "").toLowerCase();
  let id;
  if (p.includes("plus") || p.includes("plus + voice")) id = "GW-PLS";
  else if (p.includes("enterprise"))   id = "GW-ENT";
  else if (p.includes("starter"))      id = "GW-STR";
  else if (p.includes("std") || p.includes("standard")) id = "GW-STD";
  else if (p.includes("m365") && p.includes("std"))     id = "M365-BS";
  else if (p.includes("m365") && p.includes("premium")) id = "M365-BP";
  else if (p.includes("m365") && p.includes("basic"))   id = "M365-BB";
  else if (p.includes("zoho") && p.includes("pro"))     id = "ZW-PRO";
  else if (p.includes("zoho"))                          id = "ZW-STD";
  else if (p.includes("voice"))                         id = "GV-STD";
  else id = "GW-STD";
  return marginFor(id, sub.seats);
}

function planToItems(plan, seats) {
  const lower = (plan || "").toLowerCase();
  const items = [];
  const pick = (id, qty, sub) => {
    const cat = ITEMS.find(i => i.id === id);
    if (cat) items.push({ id: cat.id, name: cat.name, sub, hsn: cat.hsn, qty, rate: cat.msrp });
  };
  if (lower.includes("plus"))            pick("GW-PLS", seats, lower.includes("upgrade") ? "Upgrade from Std" : "Annual commitment");
  else if (lower.includes("enterprise")) pick("GW-ENT", seats, "Annual commitment");
  else if (lower.includes("starter"))    pick("GW-STR", seats, "Annual commitment");
  else                                   pick("GW-STD", seats, "Annual commitment");
  if (lower.includes("voice")) pick("GV-STD", Math.max(1, Math.ceil(seats / 5)), "Voice add-on");
  return items;
}

Object.assign(window, {
  RESELLER,
  TEAM, KPIS_DASHBOARD, LEAD_STAGES, LEADS,
  CUSTOMER_ACME, CUSTOMERS, INVOICES, ITEMS, SUBS, RENEWALS_URGENT, ACTIVITIES,
  QUOTES, planToItems, marginFor, marginAnnual, subMargin,
});
