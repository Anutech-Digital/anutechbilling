/**
 * Demo data for testing (R-201, 6 Oct 2026).
 *
 * Pardeep: staging looked "wiped" because it is an empty copy by design (no customer data
 * leaves live), and the tester asked for a "Generate Dummy Data" button. This builds a small,
 * realistic set — customers across GST states (with and without GSTIN, one with no state, one
 * export) and deals in every stage — all named "DEMO · …" so they are obvious on screen and the
 * clear action can find exactly them and nothing else.
 *
 * Pure: the route inserts what this returns, through the person's own login (RLS).
 */
export const DEMO_PREFIX = "DEMO · ";

/** Only where test data belongs. Production builds have NEXT_PUBLIC_APP_ENV "" — refused. */
export function demoDataAllowed(appEnv: string | undefined): boolean {
  return appEnv === "staging" || appEnv === "local";
}

export interface DemoCustomer {
  name: string; contact_name: string; contact_email: string; contact_phone: string;
  city: string; state: string | null; state_code: string | null; gstin: string | null; country: string;
}
export interface DemoLead {
  id: string; company: string; contact_name: string; contact_email: string; contact_phone: string;
  stage: "new" | "contact" | "demo" | "trial" | "quote" | "won" | "lost";
  plan: string | null; seats: number | null; value: number | null;
  priority: "low" | "medium" | "high"; source: string; enquiry_type: "subscription" | "project";
  expected_close_date: string | null;
}

const CUSTOMERS: Omit<DemoCustomer, "name">[] = [
  { contact_name: "Rohit Mehra",  contact_email: "rohit@demo-delhi.example",  contact_phone: "+919800000101", city: "New Delhi", state: "Delhi",       state_code: "07", gstin: "07AABCD1234E1Z5", country: "India" },
  { contact_name: "Sneha Patil",  contact_email: "sneha@demo-pune.example",   contact_phone: "+919800000102", city: "Pune",      state: "Maharashtra", state_code: "27", gstin: "27AABCP4321F1Z2", country: "India" },
  { contact_name: "Arjun Reddy",  contact_email: "arjun@demo-blr.example",    contact_phone: "+919800000103", city: "Bengaluru", state: "Karnataka",   state_code: "29", gstin: null,              country: "India" },
  { contact_name: "Priya Nair",   contact_email: "priya@demo-kochi.example",  contact_phone: "+919800000104", city: "Kochi",     state: "Kerala",      state_code: "32", gstin: null,              country: "India" },
  { contact_name: "Vikas Gupta",  contact_email: "vikas@demo-nostate.example", contact_phone: "+919800000105", city: "",         state: null,          state_code: null, gstin: null,              country: "India" },
  { contact_name: "Emma Clarke",  contact_email: "emma@demo-uk.example",      contact_phone: "+447700900106", city: "London",    state: null,          state_code: null, gstin: null,              country: "United Kingdom" },
];
const CUSTOMER_NAMES = ["Delhi Traders Pvt Ltd", "Pune Software LLP", "Bengaluru Retail Co", "Kochi Exports", "No-State Enterprises", "London Consulting Ltd"];

const STAGES: DemoLead["stage"][] = ["new", "new", "contact", "demo", "trial", "quote", "quote", "won", "won", "lost"];
const PLANS = ["Google Workspace Business Starter", "Google Workspace Business Standard", "Microsoft 365 Business Basic", "Zoho Workplace Standard"];

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function demoRows(today: string, stamp: number): { customers: DemoCustomer[]; leads: DemoLead[] } {
  const customers = CUSTOMERS.map((c, i) => ({ ...c, name: `${DEMO_PREFIX}${CUSTOMER_NAMES[i]}` }));
  const leads: DemoLead[] = STAGES.map((stage, i) => {
    const seats = [5, 12, 25, 8, 50, 15, 3, 20, 10, 6][i];
    const isProject = i === 6;
    const plan = isProject ? null : PLANS[i % PLANS.length];
    const value = stage === "new" ? null : isProject ? 250000 : seats * 1500 * 12;
    return {
      id: `L-DEMO-${stamp.toString(36).toUpperCase()}-${i + 1}`,
      company: `${DEMO_PREFIX}Prospect ${i + 1} (${stage})`,
      contact_name: `Demo Contact ${i + 1}`,
      contact_email: `contact${i + 1}@demo-prospect.example`,
      contact_phone: `+9198000002${String(i + 1).padStart(2, "0")}`,
      stage, plan, seats: isProject ? null : seats, value,
      priority: (["high", "medium", "low"] as const)[i % 3],
      source: "Demo data",
      enquiry_type: isProject ? "project" : "subscription",
      expected_close_date: stage === "new" || stage === "contact" ? null : addDays(today, 7 + i * 3),
    };
  });
  return { customers, leads };
}
