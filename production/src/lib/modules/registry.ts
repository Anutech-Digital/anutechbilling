/**
 * ResellerOS Pluggable Architecture — Commercial Module Registry
 *
 * Defines the 5 distinct, independently sellable SaaS modules that plug into
 * the central shared Core Database (Auth, Multi-Tenancy, Customers, Audit Logs).
 */

export interface SystemModule {
  id: string;
  name: string;
  badge: string;
  tagline: string;
  description: string;
  priceMonthlyRupees: number;
  iconName: string;
  accentColor: string;
  coreRoutes: string[];
  features: string[];
  dbTables: string[];
  commercialTarget: string;
  isFreeTier?: boolean;
}

export const SYSTEM_MODULES: SystemModule[] = [
  {
    id: "solo_free",
    name: "Individual & Solo Freelancer Pack",
    badge: "Free Forever",
    tagline: "Essential Invoicing, UPI QR Payments & Client Contacts for Solo Creators",
    description: "Built specifically for individual professionals, solo consultants, and freelancers. Create professional estimates and GST/non-GST invoices, collect direct UPI payments via QR code, and manage client contacts at ₹0 cost forever.",
    priceMonthlyRupees: 0,
    iconName: "invoices",
    accentColor: "#10B981", // Emerald
    isFreeTier: true,
    coreRoutes: ["/invoices", "/quotes", "/payments", "/contacts", "/customers"],
    features: [
      "Tax Invoices & Proforma Estimates",
      "Direct UPI QR Code & Online Payment Links",
      "1-Click WhatsApp Document & Invoice Sharing",
      "Client Master Directory (Individual & Business)",
      "Automated 1% / 2% TDS Calculation (Sec 194C)",
      "100% Free Forever — Zero Monthly Fees",
    ],
    dbTables: ["invoices", "quotes", "payments", "customers", "contacts"],
    commercialTarget: "Individual freelancers, solo consultants, independent contractors, and micro-entrepreneurs who need clean billing without monthly subscription fees.",
  },
  {
    id: "crm",
    name: "Reseller CRM & Sales Pipeline",
    badge: "Sales & Growth",
    tagline: "High-velocity B2B Sales, Lead Tracking & WhatsApp Automation",
    description: "Capture enquiries, nurture leads across Kanban stages, manage customer deals, and run WhatsApp broadcasts.",
    priceMonthlyRupees: 499,
    iconName: "leads",
    accentColor: "#3B82F6", // Blue
    coreRoutes: ["/leads", "/deals", "/contacts", "/enquiries", "/whatsapp", "/campaigns", "/lead-gen"],
    features: [
      "Visual Kanban Deal Pipeline",
      "WhatsApp Business API Integration",
      "Lead Source Attribution & Tracking",
      "Enquiry Capture & Quick-Reply Forms",
      "Contact & Interaction History",
    ],
    dbTables: ["leads", "deals", "contacts", "enquiries", "whatsapp_logs", "campaigns"],
    commercialTarget: "Indian SMBs, Agencies, B2B sales teams requiring dedicated CRM without complex ERP bloat.",
  },
  {
    id: "invoicing",
    name: "GST Invoicing & Indian Finance",
    badge: "Finance & Tax",
    tagline: "100% GST-Compliant Billing, Quotes, UPI & Razorpay Checkout",
    description: "Generate tax-compliant GST invoices, estimates/quotes, track customer payments, vendor purchase orders, and export GSTR-1 reports.",
    priceMonthlyRupees: 499,
    iconName: "invoices",
    accentColor: "#10B981", // Emerald
    coreRoutes: ["/invoices", "/quotes", "/payments", "/purchases", "/purchase-orders", "/accounting"],
    features: [
      "GST Tax Invoices & Proforma Quotes",
      "Instant Razorpay & UPI Payment Links",
      "Vendor Expense & Purchase Orders",
      "Automated Double-entry Accounting Ledger",
      "GSTR-1, GSTR-3B & TDS Export Readiness",
    ],
    dbTables: ["invoices", "quotes", "payments", "purchases", "purchase_orders", "ledger_entries"],
    commercialTarget: "Freelancers, MSMEs, IT service companies wanting clean GST billing with payment gateway sync.",
  },
  {
    id: "subscriptions",
    name: "SubFlow — Recurring Billing Engine",
    badge: "Automation",
    tagline: "Automated Renewals, Proration & Dunning for Recurring Services",
    description: "Manage monthly & annual recurring contracts, automated renewal quotes, expiry reminders, and mid-cycle proration.",
    priceMonthlyRupees: 399,
    iconName: "subscriptions",
    accentColor: "#8B5CF6", // Purple
    coreRoutes: ["/subscriptions", "/renewals"],
    features: [
      "Automated Monthly & Annual Billing Cycles",
      "Proration Calculator for Plan Upgrades",
      "Smart Expiry Warnings via Email/WhatsApp",
      "1-Click Renewal Invoice Dispatch",
      "Churn & Retention Analytics",
    ],
    dbTables: ["subscriptions", "renewals", "plans", "proration_events"],
    commercialTarget: "SaaS providers, retainer marketing agencies, IT AMC businesses.",
  },
  {
    id: "provisioning",
    name: "Cloud & Web Hosting Orchestrator",
    badge: "Infrastructure",
    tagline: "Automated DirectAdmin, ResellerClub Domain & Server Provisioning",
    description: "Sell web hosting and domains with zero manual touch. Direct connection to DirectAdmin servers and ResellerClub registrar APIs.",
    priceMonthlyRupees: 999,
    iconName: "cloud",
    accentColor: "#F59E0B", // Amber
    coreRoutes: ["/hosting-domains", "/provisioning", "/products", "/items"],
    features: [
      "Live ResellerClub Domain Search & Registration",
      "DirectAdmin Automated Account Provisioning",
      "Domain Management System (DMS) Engine Sync",
      "Instant Server Health & Resource Allocation",
      "Automated Hosting Trial Activation",
    ],
    dbTables: ["provisioning_jobs", "domains", "servers", "hosting_plans", "vendor_api_configs"],
    commercialTarget: "Web hosting resellers, MSPs, and digital agencies selling hosting bundles.",
  },
  {
    id: "teamops",
    name: "TeamOps — HR, Attendance & Payroll",
    badge: "Workforce",
    tagline: "Attendance Tracking, Indian Statutory Payroll (PF, ESI, TDS) & Tasks",
    description: "Keep your workforce productive. Geo-verified attendance, employee performance scorecards, internal tasks, and compliant Indian payroll.",
    priceMonthlyRupees: 499,
    iconName: "team",
    accentColor: "#EC4899", // Pink
    coreRoutes: ["/team", "/attendance", "/performance", "/scorecard", "/tasks", "/support", "/accounting/payroll"],
    features: [
      "Office & Remote Geo-Fenced Attendance",
      "Indian Statutory Payroll (PF, ESI, TDS, ECR file output)",
      "Employee Daily Scorecards & KPI Completion",
      "Internal Team Task Board & Priority Queues",
      "Customer Support Helpdesk & Ticketing",
    ],
    dbTables: ["team_members", "attendance", "payroll_runs", "tasks", "support_tickets", "scorecards"],
    commercialTarget: "Growing Indian businesses with 5–100 employees needing HR + task tracking without expensive HRMS tools.",
  },
];

/** Return all modules corresponding to a given URL pathname */
export function getModulesForRoute(pathname: string): SystemModule[] {
  return SYSTEM_MODULES.filter((m) =>
    m.coreRoutes.some((route) => pathname === route || pathname.startsWith(route + "/")),
  );
}

/** Return primary module corresponding to a given URL pathname */
export function getModuleForRoute(pathname: string): SystemModule | undefined {
  return SYSTEM_MODULES.find((m) =>
    m.coreRoutes.some((route) => pathname === route || pathname.startsWith(route + "/")),
  );
}

/** Default active modules for all tenants (includes Individual Free Pack) */
export const DEFAULT_ACTIVE_MODULE_IDS = ["solo_free", "crm", "invoicing", "subscriptions", "provisioning", "teamops"];
