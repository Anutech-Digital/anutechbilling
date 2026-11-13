"use client";

// ============================================================================
// Salaried Pro Digital Vault - Data Types & Architecture
// ============================================================================

export type VaultCategory =
  | "identity"
  | "career"
  | "tax"
  | "insurance"
  | "banking"
  | "vehicles"
  | "family";

export type VaultPackType =
  | "all"
  | "job_switch"
  | "loan_pack"
  | "tax_filing"
  | "medical_emergency"
  | "vehicle_box";

export interface VaultDocument {
  id: string;
  title: string;
  category: VaultCategory;
  categoryLabel: string;
  docNumber?: string; // e.g. Policy #, Passport #, PAN, Account #, UAN
  fileName: string;
  fileSizeMb: number;
  uploadedDate: string; // YYYY-MM-DD
  assessmentYear?: string; // For Tax/ITR docs e.g. "AY 2025-26"
  expiryDate?: string; // For Passport, Insurance, PUC, License
  tags: string[]; // e.g. ["Job Switch", "Loan", "Tax Filing", "Emergency"]
  notes?: string;
  verifiedStatus?: "verified" | "pending" | "permanent";
  institutionOrIssuer?: string; // e.g. "HDFC ERGO", "Income Tax Dept", "Infosys Ltd"
}

// Category Configuration with Icons, Colors & Descriptions
export const VAULT_CATEGORIES: {
  id: VaultCategory;
  label: string;
  hindiLabel: string;
  icon: string;
  color: string;
  bgTint: string;
  description: string;
}[] = [
  {
    id: "identity",
    label: "Identity & KYC",
    hindiLabel: "पहचान व पते का प्रमाण",
    icon: "shield",
    color: "#6366F1",
    bgTint: "bg-indigo-50 border-indigo-200 text-indigo-700",
    description: "PAN Card, Aadhaar Card, Passport, Driving License, Voter ID",
  },
  {
    id: "career",
    label: "Career & Employment",
    hindiLabel: "नौकरी व पूर्व कंपनी BGV",
    icon: "briefcase",
    color: "#0284C7",
    bgTint: "bg-sky-50 border-sky-200 text-sky-700",
    description: "Offer/Relieving Letters, Experience Certs, Payslips, UAN & Increment Letters",
  },
  {
    id: "tax",
    label: "Tax & ITR Filing",
    hindiLabel: "टैक्स, फॉर्म 16 व कटौती",
    icon: "file",
    color: "#059669",
    bgTint: "bg-emerald-50 border-emerald-200 text-emerald-700",
    description: "Form 16 (Part A/B), ITR-V Ack, AIS/26AS, Rent Agreements & 80C/80D Proofs",
  },
  {
    id: "insurance",
    label: "Health & Life Insurance",
    hindiLabel: "हेल्थ कार्ड व टर्म पॉलिसी",
    icon: "heart",
    color: "#E11D48",
    bgTint: "bg-rose-50 border-rose-200 text-rose-700",
    description: "Cashless TPA Health Cards, Mediclaim Policy, Term Insurance & Nominee forms",
  },
  {
    id: "banking",
    label: "Banking & Loans",
    hindiLabel: "बैंक, लोन NOC व चेक",
    icon: "building",
    color: "#D97706",
    bgTint: "bg-amber-50 border-amber-200 text-amber-700",
    description: "Cancelled Cheques, Bank Statements, Home/Personal Loan Sanction & NOC Letters",
  },
  {
    id: "vehicles",
    label: "Vehicles & Property",
    hindiLabel: "गाड़ी बीमा, RC व संपत्ति",
    icon: "truck",
    color: "#7C3AED",
    bgTint: "bg-purple-50 border-purple-200 text-purple-700",
    description: "Car/Bike RC, Motor Comprehensive Insurance, PUC Certificate & Flat Sale Deed",
  },
  {
    id: "family",
    label: "Family & Legal",
    hindiLabel: "परिवार व वसीयत",
    icon: "users",
    color: "#475569",
    bgTint: "bg-slate-50 border-slate-200 text-slate-700",
    description: "Marriage Certificate, Children Birth Certificates & Master Nominee Records",
  },
];

// Smart Document Packs for 1-Click Salaried Life Events
export const SMART_DOCUMENT_PACKS: {
  id: VaultPackType;
  title: string;
  subtitle: string;
  badge: string;
  icon: string;
  requiredTags: string[];
  suggestedDocs: string;
}[] = [
  {
    id: "all",
    title: "All Documents",
    subtitle: "Complete repository of all personal & career files",
    badge: "Master Vault",
    icon: "layers",
    requiredTags: [],
    suggestedDocs: "View everything stored in your encrypted vault",
  },
  {
    id: "job_switch",
    title: "Job Switch Kit",
    subtitle: "Everything a new employer HR or BGV team demands",
    badge: "Career Switch",
    icon: "briefcase",
    requiredTags: ["Job Switch", "Relieving", "Payslip", "Form 16"],
    suggestedDocs: "Relieving Letters + Last 3 Payslips + Latest Form 16 + PAN/Aadhaar",
  },
  {
    id: "loan_pack",
    title: "Loan Application Pack",
    subtitle: "Essential bundle for Home Loan, Car Loan or Visa",
    badge: "Loan / Visa Ready",
    icon: "building",
    requiredTags: ["Loan", "Bank Statement", "ITR-V", "Form 16"],
    suggestedDocs: "6-Month Bank Statement + 2-3 Yr Form 16s + ITR-V Ack + PAN/Aadhaar",
  },
  {
    id: "tax_filing",
    title: "ITR Filing Pack",
    subtitle: "All proofs needed by your CA or ITR e-filing portal",
    badge: "Tax Season",
    icon: "file",
    requiredTags: ["Tax Filing", "80C", "80D", "HRA", "AIS"],
    suggestedDocs: "Form 16 + AIS/26AS + 80C Receipts + 80D Health + Rent Agreement",
  },
  {
    id: "medical_emergency",
    title: "Emergency Medical Kit",
    subtitle: "Instant hospital TPA cashless admission card & policy",
    badge: "Urgent 24x7",
    icon: "heart",
    requiredTags: ["Emergency", "Health", "TPA", "Insurance"],
    suggestedDocs: "Cashless Health TPA Card + Policy Number + Toll-Free Hospital Desk",
  },
  {
    id: "vehicle_box",
    title: "Vehicle Glove Box",
    subtitle: "Traffic police & RTO check readiness on phone",
    badge: "On the Road",
    icon: "truck",
    requiredTags: ["Vehicle", "RC", "Insurance", "PUC"],
    suggestedDocs: "Car/Bike RC Book + Active Motor Insurance Policy + PUC Certificate",
  },
];

// 8 Essential Salaried Life Documents Checklist
export const ESSENTIAL_SALARIED_CHECKLIST: {
  key: string;
  title: string;
  category: VaultCategory;
  whyNeeded: string;
}[] = [
  {
    key: "pan_card",
    title: "PAN Card (e-PAN)",
    category: "identity",
    whyNeeded: "Mandatory for salary credit, TDS matching, and bank KYC.",
  },
  {
    key: "aadhaar_card",
    title: "Aadhaar Card",
    category: "identity",
    whyNeeded: "Crucial for UAN EPF e-nomination & instant e-verifications.",
  },
  {
    key: "form_16",
    title: "Latest Form 16 (Part A & B)",
    category: "tax",
    whyNeeded: "Required for annual ITR filing and proof of salary/TDS.",
  },
  {
    key: "payslips",
    title: "Recent 3 Months Payslips",
    category: "career",
    whyNeeded: "Mandatory for job switches, credit card approvals & loans.",
  },
  {
    key: "relieving_letter",
    title: "Relieving & Experience Letter",
    category: "career",
    whyNeeded: "Critical for clean BGV (Background Verification) when switching jobs.",
  },
  {
    key: "health_card",
    title: "Health Insurance TPA Card",
    category: "insurance",
    whyNeeded: "Must-have at 2 AM for instant cashless hospital admissions.",
  },
  {
    key: "itr_ack",
    title: "ITR-V Acknowledgement",
    category: "tax",
    whyNeeded: "Official government proof of income for home loans & foreign visas.",
  },
  {
    key: "bank_statement",
    title: "Bank Account Statement",
    category: "banking",
    whyNeeded: "Needed to verify salary credits and personal financial health.",
  },
];

// Initial Curated Real-World Documents for a Salaried Individual
export const DEFAULT_SALARIED_VAULT_DOCS: VaultDocument[] = [
  {
    id: "sv-doc-1",
    title: "Permanent Account Number (e-PAN Card)",
    category: "identity",
    categoryLabel: "Identity & KYC",
    docNumber: "ABCDE1234F",
    fileName: "ePAN_Card_Signed.pdf",
    fileSizeMb: 0.42,
    uploadedDate: "2026-01-10",
    tags: ["KYC", "Job Switch", "Loan", "Permanent"],
    verifiedStatus: "permanent",
    institutionOrIssuer: "Income Tax Department",
    notes: "Linked with Aadhaar and primary salary bank account.",
  },
  {
    id: "sv-doc-2",
    title: "Aadhaar Card (Masked e-Aadhaar)",
    category: "identity",
    categoryLabel: "Identity & KYC",
    docNumber: "XXXX-XXXX-8921",
    fileName: "eAadhaar_Masked.pdf",
    fileSizeMb: 1.15,
    uploadedDate: "2026-01-10",
    tags: ["KYC", "Job Switch", "Loan", "Permanent"],
    verifiedStatus: "permanent",
    institutionOrIssuer: "UIDAI Government of India",
    notes: "Password is first 4 letters of name in CAPS + Birth Year.",
  },
  {
    id: "sv-doc-3",
    title: "Republic of India Passport (36 Pages)",
    category: "identity",
    categoryLabel: "Identity & KYC",
    docNumber: "Z9482103",
    fileName: "Indian_Passport_Scan.pdf",
    fileSizeMb: 2.3,
    uploadedDate: "2026-02-15",
    expiryDate: "2032-05-20",
    tags: ["KYC", "Travel", "Visa"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Ministry of External Affairs",
    notes: "Valid for travel. Renewal due in May 2032.",
  },
  {
    id: "sv-doc-4",
    title: "Relieving Letter & Service Certificate - Previous Employer",
    category: "career",
    categoryLabel: "Career & Employment",
    docNumber: "REL-INF-2023-882",
    fileName: "Infosys_Relieving_Experience_Letter.pdf",
    fileSizeMb: 0.85,
    uploadedDate: "2026-03-01",
    tags: ["Job Switch", "Relieving", "BGV", "Career"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Infosys Ltd",
    notes: "Tenure: 15 July 2021 to 31 Jan 2024. Clean BGV record.",
  },
  {
    id: "sv-doc-5",
    title: "Latest 3 Months Salary Payslips (Oct, Nov, Dec 2026)",
    category: "career",
    categoryLabel: "Career & Employment",
    docNumber: "EMP-ANUT-4091",
    fileName: "Combined_Payslips_Q4_2026.pdf",
    fileSizeMb: 1.6,
    uploadedDate: "2026-11-05",
    tags: ["Job Switch", "Payslip", "Loan"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Anutech Digital Pvt Ltd",
    notes: "Gross ₹95,000 / In-Hand ₹85,000 credited to HDFC Bank.",
  },
  {
    id: "sv-doc-6",
    title: "Form 16 Part A & B (TDS Certificate FY 2024–25)",
    category: "tax",
    categoryLabel: "Tax & ITR Filing",
    docNumber: "TRACES-2425-99812",
    fileName: "Form16_FY2024_25_TRACES.pdf",
    fileSizeMb: 1.45,
    uploadedDate: "2026-06-15",
    assessmentYear: "AY 2025-26",
    tags: ["Tax Filing", "Form 16", "Job Switch", "Loan"],
    verifiedStatus: "verified",
    institutionOrIssuer: "TRACES / Employer",
    notes: "Digitally signed with 100% tax credit verified in 26AS.",
  },
  {
    id: "sv-doc-7",
    title: "ITR-V Acknowledgement Receipt (AY 2025-26)",
    category: "tax",
    categoryLabel: "Tax & ITR Filing",
    docNumber: "ACK-94810294812",
    fileName: "ITR_V_Ack_AY202526.pdf",
    fileSizeMb: 0.38,
    uploadedDate: "2026-07-28",
    assessmentYear: "AY 2025-26",
    tags: ["Tax Filing", "ITR-V", "Loan", "Visa"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Income Tax Department",
    notes: "Filed u/s 139(1) and verified via Aadhaar OTP on 28 July 2026.",
  },
  {
    id: "sv-doc-8",
    title: "Registered Rent Agreement & Landlord PAN",
    category: "tax",
    categoryLabel: "Tax & ITR Filing",
    docNumber: "REG-GUR-2026-441",
    fileName: "Rent_Agreement_Sector48_Gurugram.pdf",
    fileSizeMb: 3.2,
    uploadedDate: "2026-04-05",
    assessmentYear: "AY 2026-27",
    expiryDate: "2027-03-31",
    tags: ["Tax Filing", "HRA", "Rent"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Sub-Registrar Gurugram",
    notes: "Rent ₹28,000/mo. Landlord PAN provided for HRA deduction.",
  },
  {
    id: "sv-doc-9",
    title: "Family Cashless Health Insurance Card & Policy",
    category: "insurance",
    categoryLabel: "Health & Life Insurance",
    docNumber: "POL-HDFC-889104",
    fileName: "HDFC_ERGO_OptimaSecure_Policy.pdf",
    fileSizeMb: 1.8,
    uploadedDate: "2026-04-12",
    expiryDate: "2027-04-11",
    tags: ["Emergency", "Health", "TPA", "Insurance", "80D"],
    verifiedStatus: "verified",
    institutionOrIssuer: "HDFC ERGO General Insurance",
    notes: "₹10L Base + 4X Secure Benefit. 24x7 TPA Toll-Free: 1800-2666-400.",
  },
  {
    id: "sv-doc-10",
    title: "Term Life Insurance Policy (₹1.5 Cr Cover)",
    category: "insurance",
    categoryLabel: "Health & Life Insurance",
    docNumber: "MAX-LIFE-992100",
    fileName: "MaxLife_TermPlan_PolicyDoc.pdf",
    fileSizeMb: 2.1,
    uploadedDate: "2026-02-10",
    expiryDate: "2055-02-09",
    tags: ["Insurance", "Term Life", "80C", "Family"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Max Life Insurance",
    notes: "Primary nominee: Spouse (100% share). Premium ₹14,200/year.",
  },
  {
    id: "sv-doc-11",
    title: "Salary Account Cancelled Cheque (HDFC Bank)",
    category: "banking",
    categoryLabel: "Banking & Loans",
    docNumber: "CHQ-002144",
    fileName: "Cancelled_Cheque_HDFC_Salary.pdf",
    fileSizeMb: 0.55,
    uploadedDate: "2026-01-20",
    tags: ["Banking", "Job Switch", "Mandate", "Permanent"],
    verifiedStatus: "permanent",
    institutionOrIssuer: "HDFC Bank Ltd",
    notes: "Account # ending 4410, IFSC HDFC0001234. Name printed clearly.",
  },
  {
    id: "sv-doc-12",
    title: "Car Comprehensive Motor Insurance Policy",
    category: "vehicles",
    categoryLabel: "Vehicles & Property",
    docNumber: "BAJAJ-MOTOR-7712",
    fileName: "BajajAllianz_Car_Insurance_HR26.pdf",
    fileSizeMb: 1.25,
    uploadedDate: "2026-08-10",
    expiryDate: "2027-08-09",
    tags: ["Vehicle", "Insurance", "Car"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Bajaj Allianz General Insurance",
    notes: "Car: Hyundai Creta (HR26 DX 4901). Zero-Depreciation cover.",
  },
  {
    id: "sv-doc-13",
    title: "Pollution Under Control (PUC) Certificate",
    category: "vehicles",
    categoryLabel: "Vehicles & Property",
    docNumber: "PUC-DL-2026-89",
    fileName: "PUC_Certificate_Creta.pdf",
    fileSizeMb: 0.35,
    uploadedDate: "2026-09-01",
    expiryDate: "2027-03-01", // Expiring relatively soon
    tags: ["Vehicle", "PUC"],
    verifiedStatus: "verified",
    institutionOrIssuer: "Parivahan Sewa / Delhi RTO",
    notes: "Valid for 6 months. Renewal alert active.",
  },
];

// Storage Keys
export const STORAGE_VAULT_DOCS_KEY = "salaried_pro_digital_vault_docs_v1";

// ============================================================================
// Storage & Helper Methods
// ============================================================================

export function loadVaultDocuments(): VaultDocument[] {
  if (typeof window === "undefined") return DEFAULT_SALARIED_VAULT_DOCS;
  try {
    const raw = localStorage.getItem(STORAGE_VAULT_DOCS_KEY);
    if (!raw) {
      localStorage.setItem(STORAGE_VAULT_DOCS_KEY, JSON.stringify(DEFAULT_SALARIED_VAULT_DOCS));
      return DEFAULT_SALARIED_VAULT_DOCS;
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_SALARIED_VAULT_DOCS;
  } catch {
    return DEFAULT_SALARIED_VAULT_DOCS;
  }
}

export function saveVaultDocuments(docs: VaultDocument[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_VAULT_DOCS_KEY, JSON.stringify(docs));
    window.dispatchEvent(new Event("salaried_pro_vault_updated"));
  } catch (err) {
    console.error("Failed to save vault docs to localStorage", err);
  }
}

// Calculate Days Remaining Until Expiry
export function getExpiryStatus(expiryDateStr?: string): {
  status: "expired" | "urgent" | "soon" | "valid" | "none";
  daysLeft?: number;
  label: string;
} {
  if (!expiryDateStr) return { status: "none", label: "Permanent / No Expiry" };

  const targetDate = new Date(expiryDateStr);
  const now = new Date();
  const diffMs = targetDate.getTime() - now.getTime();
  const daysLeft = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (daysLeft < 0) {
    return { status: "expired", daysLeft, label: `Expired ${Math.abs(daysLeft)} days ago` };
  }
  if (daysLeft <= 30) {
    return { status: "urgent", daysLeft, label: `Expires in ${daysLeft} days!` };
  }
  if (daysLeft <= 90) {
    return { status: "soon", daysLeft, label: `Renewal in ${daysLeft} days` };
  }
  return { status: "valid", daysLeft, label: `Valid until ${expiryDateStr}` };
}

// Check Readiness of Salaried Essential 8 Documents
export function computeVaultReadiness(docs: VaultDocument[]): {
  uploadedCount: number;
  totalCount: number;
  percentage: number;
  missingItems: typeof ESSENTIAL_SALARIED_CHECKLIST;
} {
  const missing: typeof ESSENTIAL_SALARIED_CHECKLIST = [];

  for (const item of ESSENTIAL_SALARIED_CHECKLIST) {
    let hasMatch = false;
    if (item.key === "pan_card") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("pan") || d.category === "identity" && d.docNumber?.length === 10);
    } else if (item.key === "aadhaar_card") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("aadhaar"));
    } else if (item.key === "form_16") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("form 16") || d.category === "tax");
    } else if (item.key === "payslips") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("payslip") || d.tags.includes("Payslip"));
    } else if (item.key === "relieving_letter") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("relieving") || d.title.toLowerCase().includes("experience"));
    } else if (item.key === "health_card") {
      hasMatch = docs.some((d) => d.category === "insurance" && (d.title.toLowerCase().includes("health") || d.tags.includes("Health")));
    } else if (item.key === "itr_ack") {
      hasMatch = docs.some((d) => d.title.toLowerCase().includes("itr") || d.tags.includes("ITR-V"));
    } else if (item.key === "bank_statement") {
      hasMatch = docs.some((d) => d.category === "banking" || d.title.toLowerCase().includes("statement") || d.title.toLowerCase().includes("cheque"));
    }

    if (!hasMatch) {
      missing.push(item);
    }
  }

  const uploadedCount = ESSENTIAL_SALARIED_CHECKLIST.length - missing.length;
  const percentage = Math.round((uploadedCount / ESSENTIAL_SALARIED_CHECKLIST.length) * 100);

  return {
    uploadedCount,
    totalCount: ESSENTIAL_SALARIED_CHECKLIST.length,
    percentage,
    missingItems: missing,
  };
}
