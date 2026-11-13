/**
 * ResellerOS Pluggable Architecture — Commercial Module Registry
 *
 * Defines the 5 distinct, independently sellable SaaS modules that plug into
 * the central shared Core Database (Auth, Multi-Tenancy, Customers, Audit Logs).
 */

export interface SystemModule {
  id: string;
  tierLevel: number;
  tierLabel: string;
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
  inheritedFromSummary?: string;
}

export const SYSTEM_MODULES: SystemModule[] = [
  {
    id: "salaried_pro",
    tierLevel: 1,
    tierLabel: "Tier 1: Personal Career & Tax Hub",
    name: "Salaried Pro — Individual Career & Tax Hub",
    badge: "Free Forever",
    tagline: "Personal Spends, Savings Bank Statement Importer (CSV), Tax Slabs & Rent Receipts",
    description: "Built for individual salaried employees and job professionals. Track personal expenses across Indian categories (Rent, Groceries, Fuel, EMIs), import Savings Bank Statements (HDFC, SBI, ICICI CSV) to auto-detect salary credits & UPI spends, compare Old vs New Tax Regimes (FY 2025–26), and generate HRA rent receipts.",
    priceMonthlyRupees: 0,
    iconName: "user",
    accentColor: "#6366F1", // Indigo
    isFreeTier: true,
    coreRoutes: ["/employee-hub"],
    features: [
      "Personal Daily Spends Tracker & Monthly Savings Rate (%) Analyzer",
      "Savings Bank Statement Importer (HDFC, SBI, ICICI, Axis & Kotak CSV)",
      "Auto-Detection of Salary Credits & UPI Outflow Categorization",
      "1-Click Bank Statement Debit to Personal Expense Sync",
      "Old vs New Tax Regime Comparator (FY 2025–26 Rules)",
      "1-Click 12-Month HRA Rent Receipt Generator (PDF/Print)",
      "Form 16 & Career Document Vault Checklist",
      "100% Free Forever for Salaried Individuals — Zero Fees",
    ],
    dbTables: ["employee_tax_profiles", "reimbursement_claims", "rent_receipts", "employee_documents"],
    commercialTarget: "Individual salaried employees, IT professionals, corporate executives, and job holders who need personal tax planning and expense management without running a business.",
  },
  {
    id: "solo_free",
    tierLevel: 2,
    tierLabel: "Tier 2: Solo Freelancer & Invoicing",
    name: "Individual & Solo Freelancer Pack",
    badge: "Free Forever",
    tagline: "Essential Invoicing, UPI QR Payments & Client Contacts for Solo Creators",
    description: "Built specifically for individual professionals, solo consultants, and freelancers. Create professional estimates and GST/non-GST invoices, collect direct UPI payments via QR code, and manage client contacts at ₹0 cost forever.",
    priceMonthlyRupees: 0,
    iconName: "invoices",
    accentColor: "#10B981", // Emerald
    isFreeTier: true,
    inheritedFromSummary: "Includes everything in Tier 1 (Personal Tax Hub & Expense Tools)",
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
    id: "invoicing",
    tierLevel: 3,
    tierLabel: "Tier 3: GST Business & Accounting",
    name: "GST Invoicing & Indian Finance",
    badge: "Finance & Tax",
    tagline: "100% GST-Compliant Billing, Quotes, UPI & Razorpay Checkout",
    description: "Generate tax-compliant GST invoices, estimates/quotes, track customer payments, vendor purchase orders, and export GSTR-1 reports.",
    priceMonthlyRupees: 499,
    iconName: "invoices",
    accentColor: "#10B981", // Emerald
    inheritedFromSummary: "Includes all Tier 1 & 2 features (Tax Hub, Invoicing, Quotes, UPI QR Payments)",
    coreRoutes: ["/invoices", "/quotes", "/payments", "/purchases", "/purchase-orders", "/accounting", "/reports", "/compliance"],
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
    id: "crm",
    tierLevel: 4,
    tierLabel: "Tier 4: Sales Pipeline & Growth CRM",
    name: "Reseller CRM & Sales Pipeline",
    badge: "Sales & Growth",
    tagline: "High-velocity B2B Sales, Lead Tracking & WhatsApp Automation",
    description: "Capture enquiries, nurture leads across Kanban stages, manage customer deals, and run WhatsApp broadcasts.",
    priceMonthlyRupees: 499,
    iconName: "leads",
    accentColor: "#3B82F6", // Blue
    inheritedFromSummary: "Includes all Tier 1, 2 & 3 features (Tax Hub, GST Invoicing, Ledger, Accounting)",
    coreRoutes: ["/leads", "/deals", "/contacts", "/enquiries", "/whatsapp", "/campaigns", "/lead-gen", "/marketing-hub", "/referrals", "/partners", "/online-orders"],
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
    id: "subscriptions",
    tierLevel: 5,
    tierLabel: "Tier 5: Recurring SaaS & Retainers",
    name: "SubFlow — Recurring Billing Engine",
    badge: "Automation",
    tagline: "Automated Renewals, Proration & Dunning for Recurring Services",
    description: "Manage monthly & annual recurring contracts, automated renewal quotes, expiry reminders, and mid-cycle proration.",
    priceMonthlyRupees: 399,
    iconName: "subscriptions",
    accentColor: "#8B5CF6", // Purple
    inheritedFromSummary: "Includes all Tier 1 to 4 features (CRM Pipeline, WhatsApp, GST Billing, Accounting)",
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
    id: "teamops",
    tierLevel: 6,
    tierLabel: "Tier 6: Workforce HRMS & Payroll",
    name: "TeamOps — HR, Attendance & Payroll",
    badge: "Workforce",
    tagline: "Attendance Tracking, Indian Statutory Payroll (PF, ESI, TDS) & Tasks",
    description: "Keep your workforce productive. Geo-verified attendance, employee performance scorecards, internal tasks, and compliant Indian payroll.",
    priceMonthlyRupees: 499,
    iconName: "team",
    accentColor: "#EC4899", // Pink
    inheritedFromSummary: "Includes all Tier 1 to 5 features (Subscriptions, CRM, WhatsApp, GST Billing)",
    coreRoutes: ["/team", "/attendance", "/performance", "/scorecard", "/tasks", "/support", "/accounting/payroll", "/accounting/employees", "/accounting/attendance", "/accounting/leave", "/accounting/loans", "/accounting/salary-register", "/assessments", "/academy"],
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
  {
    id: "provisioning",
    tierLevel: 7,
    tierLabel: "Tier 7: Cloud & Hosting Enterprise Suite",
    name: "Cloud & Web Hosting Orchestrator",
    badge: "Infrastructure",
    tagline: "Automated DirectAdmin, ResellerClub Domain & Server Provisioning",
    description: "Sell web hosting and domains with zero manual touch. Direct connection to DirectAdmin servers and ResellerClub registrar APIs.",
    priceMonthlyRupees: 999,
    iconName: "cloud",
    accentColor: "#F59E0B", // Amber
    inheritedFromSummary: "Includes all Tier 1 to 6 features (Full ResellerOS Commercial Suite)",
    coreRoutes: ["/hosting-domains", "/provisioning", "/products", "/items", "/projects"],
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

/** Return all modules up to a given tier level (inclusive, progressive hierarchy) */
export function getModulesUpToTier(tierLevel: number): SystemModule[] {
  return SYSTEM_MODULES.filter((m) => m.tierLevel <= tierLevel);
}

/** Return all module IDs up to a given tier level (inclusive) */
export function getModuleIdsUpToTier(tierLevel: number): string[] {
  return SYSTEM_MODULES.filter((m) => m.tierLevel <= tierLevel).map((m) => m.id);
}

/** Calculate the highest active tier given a list of active module IDs */
export function getHighestActiveTier(activeModuleIds: string[]): number {
  const activeTiers = SYSTEM_MODULES.filter((m) => activeModuleIds.includes(m.id)).map(
    (m) => m.tierLevel,
  );
  return activeTiers.length > 0 ? Math.max(...activeTiers) : 0;
}

/** Calculate the cumulative monthly price for all modules up to tierLevel */
export function getTierCumulativePriceRupees(tierLevel: number): number {
  if (tierLevel <= 2) return 0;
  if (tierLevel >= 7) return 1999; // Full Enterprise Suite bundle cap
  return SYSTEM_MODULES.filter((m) => m.tierLevel <= tierLevel).reduce(
    (sum, m) => sum + m.priceMonthlyRupees,
    0,
  );
}

/** Default active modules for all tenants in strict ascending tier sequence */
export const DEFAULT_ACTIVE_MODULE_IDS = [
  "salaried_pro",
  "solo_free",
  "invoicing",
  "crm",
  "subscriptions",
  "teamops",
  "provisioning",
];
