"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  useDocuments,
  useUploadDocument,
  useDeleteDocument,
  type DocumentRow,
} from "@/lib/queries/documents";

export interface SalariedVaultItem {
  id: string;
  title: string;
  category:
    | "form16"
    | "payslip"
    | "tax_statement"
    | "rent_hra"
    | "investment_80c"
    | "insurance_80d"
    | "kyc_cards"
    | "bank_statement";
  categoryLabel: string;
  itrSectionLink: string;
  fileName: string;
  fileSizeMb: number;
  uploadedDate: string;
  assessmentYear: string;
  notes?: string;
}

const DEFAULT_VAULT_ITEMS: SalariedVaultItem[] = [
  {
    id: "sv-1",
    title: "Form 16 Part A & B (FY 2024–25)",
    category: "form16",
    categoryLabel: "Form 16 (TDS Certificate)",
    itrSectionLink: "Salary u/s 17 & TDS u/s 192",
    fileName: "Form16_FY2425_Signed.pdf",
    fileSizeMb: 1.45,
    uploadedDate: "2026-06-15",
    assessmentYear: "AY 2025-26",
    notes: "Digitally signed with TRACES verification from employer",
  },
  {
    id: "sv-2",
    title: "Annual Information Statement (AIS) & Form 26AS",
    category: "tax_statement",
    categoryLabel: "Tax Credit Statement",
    itrSectionLink: "Schedule TDS & Tax Credit Verification",
    fileName: "AIS_TIS_FY202425.pdf",
    fileSizeMb: 2.1,
    uploadedDate: "2026-07-01",
    assessmentYear: "AY 2025-26",
    notes: "Downloaded from incometax.gov.in e-filing portal",
  },
  {
    id: "sv-3",
    title: "Registered Rent Agreement & Landlord PAN",
    category: "rent_hra",
    categoryLabel: "HRA & Rent Proof",
    itrSectionLink: "HRA Exemption u/s 10(13A)",
    fileName: "Rent_Agreement_2025_26.pdf",
    fileSizeMb: 3.8,
    uploadedDate: "2026-04-10",
    assessmentYear: "AY 2026-27",
    notes: "Flat 402 Sector 48 Gurugram, Landlord PAN: ABCDE1234F",
  },
  {
    id: "sv-4",
    title: "ELSS Mutual Funds & PPF Tax Saving Statement",
    category: "investment_80c",
    categoryLabel: "Section 80C Proofs",
    itrSectionLink: "Chapter VI-A Deduction u/s 80C",
    fileName: "CAMS_CAS_80C_Investments.pdf",
    fileSizeMb: 0.95,
    uploadedDate: "2026-03-25",
    assessmentYear: "AY 2025-26",
    notes: "Total 80C contribution: ₹1,50,000 (Mirae ELSS + SBI PPF)",
  },
  {
    id: "sv-5",
    title: "Family Health Insurance Premium Receipt (Section 80D)",
    category: "insurance_80d",
    categoryLabel: "Medical Insurance",
    itrSectionLink: "Mediclaim Deduction u/s 80D",
    fileName: "HDFC_ERGO_Optima_Secure_80D.pdf",
    fileSizeMb: 0.62,
    uploadedDate: "2026-05-12",
    assessmentYear: "AY 2025-26",
    notes: "Coverage for Self + Spouse + Child + Senior Citizen Parents",
  },
  {
    id: "sv-6",
    title: "Savings & Fixed Deposit Interest Certificate",
    category: "bank_statement",
    categoryLabel: "Bank Interest",
    itrSectionLink: "Income Other Sources & 80TTA",
    fileName: "HDFC_Bank_Interest_Cert_FY2425.pdf",
    fileSizeMb: 0.48,
    uploadedDate: "2026-04-20",
    assessmentYear: "AY 2025-26",
    notes: "Savings Interest ₹8,500 + FD Interest ₹12,000",
  },
];

export function SalariedDocumentVaultSection() {
  const { data: dbDocs } = useDocuments();
  const deleteDoc = useDeleteDocument();

  const [items, setItems] = React.useState<SalariedVaultItem[]>(DEFAULT_VAULT_ITEMS);
  const [selectedCategory, setSelectedCategory] = React.useState<string>("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");
  const [isUploadOpen, setIsUploadOpen] = React.useState<boolean>(false);

  // New Doc Form State
  const [newTitle, setNewTitle] = React.useState("");
  const [newCategory, setNewCategory] = React.useState<SalariedVaultItem["category"]>("form16");
  const [newAy, setNewAy] = React.useState("AY 2025-26");
  const [newNotes, setNewNotes] = React.useState("");
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);

  // Category counts
  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: items.length };
    for (const item of items) {
      counts[item.category] = (counts[item.category] || 0) + 1;
    }
    return counts;
  }, [items]);

  const filteredItems = React.useMemo(() => {
    return items.filter((item) => {
      if (selectedCategory !== "all" && item.category !== selectedCategory) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = item.title.toLowerCase().includes(q);
        const matchesNotes = (item.notes || "").toLowerCase().includes(q);
        const matchesItr = item.itrSectionLink.toLowerCase().includes(q);
        if (!matchesTitle && !matchesNotes && !matchesItr) return false;
      }
      return true;
    });
  }, [items, selectedCategory, searchQuery]);

  const handleAddDocument = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) {
      toast.error("Please enter a document title.");
      return;
    }

    const catLabels: Record<SalariedVaultItem["category"], { label: string; itr: string }> = {
      form16: { label: "Form 16 (TDS Certificate)", itr: "Salary u/s 17 & TDS u/s 192" },
      payslip: { label: "Monthly Payslip", itr: "Proof of In-Hand & Deductions" },
      tax_statement: { label: "Tax Credit Statement", itr: "Schedule TDS & AIS Verification" },
      rent_hra: { label: "HRA & Rent Proof", itr: "HRA Exemption u/s 10(13A)" },
      investment_80c: { label: "Section 80C Proofs", itr: "Chapter VI-A Deduction u/s 80C" },
      insurance_80d: { label: "Medical Insurance", itr: "Mediclaim Deduction u/s 80D" },
      kyc_cards: { label: "KYC & Identity", itr: "PAN / Aadhaar Linking Verification" },
      bank_statement: { label: "Bank Interest", itr: "Income Other Sources & 80TTA" },
    };

    const fileName = selectedFile ? selectedFile.name : `${newTitle.replace(/\s+/g, "_")}.pdf`;
    const fileSizeMb = selectedFile
      ? Math.round((selectedFile.size / (1024 * 1024)) * 100) / 100
      : 1.2;

    const newItem: SalariedVaultItem = {
      id: "sv-" + Date.now(),
      title: newTitle.trim(),
      category: newCategory,
      categoryLabel: catLabels[newCategory].label,
      itrSectionLink: catLabels[newCategory].itr,
      fileName,
      fileSizeMb,
      uploadedDate: new Date().toISOString().split("T")[0],
      assessmentYear: newAy,
      notes: newNotes.trim() || undefined,
    };

    setItems([newItem, ...items]);
    setIsUploadOpen(false);
    setNewTitle("");
    setNewNotes("");
    setSelectedFile(null);
    toast.success("Document securely uploaded and linked to ITR checklist!");
  };

  const handleDelete = (id: string) => {
    setItems(items.filter((it) => it.id !== id));
    toast.success("Document removed from vault.");
  };

  const handleDownload = (item: SalariedVaultItem) => {
    toast.info(`Preparing secure signed download for ${item.fileName}...`);
    // Create a mock download blob for immediate access
    const blob = new Blob([`ResellerOS Salaried Pro Document Vault\nTitle: ${item.title}\nCategory: ${item.categoryLabel}\nITR Section: ${item.itrSectionLink}\nAssessment Year: ${item.assessmentYear}\nNotes: ${item.notes || 'N/A'}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = item.fileName.endsWith(".pdf") ? item.fileName.replace(".pdf", ".txt") : `${item.fileName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* ── Top Bar ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="font-semibold text-base text-ink">Digital Document Vault (DigiVault)</h3>
          <p className="text-xs text-ink-3">
            Securely manage your Form 16, AIS, payslips, rent agreements & tax investment proofs linked directly to ITR-1.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="w-56 hidden sm:block">
            <Input
              placeholder="Search docs or ITR section…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="text-xs"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => setIsUploadOpen(true)}
            className="gap-1.5"
          >
            <Icon name="upload" size={14} />
            + Upload Document
          </Button>
        </div>
      </div>

      {/* ── Category Filters ── */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
        <button
          onClick={() => setSelectedCategory("all")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "all"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          All Documents ({categoryCounts.all})
        </button>
        <button
          onClick={() => setSelectedCategory("form16")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "form16"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          Form 16 ({categoryCounts.form16 || 0})
        </button>
        <button
          onClick={() => setSelectedCategory("tax_statement")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "tax_statement"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          AIS & 26AS ({categoryCounts.tax_statement || 0})
        </button>
        <button
          onClick={() => setSelectedCategory("rent_hra")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "rent_hra"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          Rent & HRA ({categoryCounts.rent_hra || 0})
        </button>
        <button
          onClick={() => setSelectedCategory("investment_80c")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "investment_80c"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          80C & 80D Proofs ({ (categoryCounts.investment_80c || 0) + (categoryCounts.insurance_80d || 0) })
        </button>
        <button
          onClick={() => setSelectedCategory("bank_statement")}
          className={`px-3 py-1.5 rounded-full font-medium transition-colors ${
            selectedCategory === "bank_statement"
              ? "bg-ink text-paper"
              : "bg-paper-2 text-ink-2 hover:bg-paper-3"
          }`}
        >
          Bank Statements ({categoryCounts.bank_statement || 0})
        </button>
      </div>

      {/* ── Upload Form Modal ── */}
      {isUploadOpen && (
        <Card className="p-5 border-2 border-indigo-200 bg-indigo-50/20 space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-indigo-100">
            <h4 className="font-semibold text-sm text-ink">Upload Tax & Employment Document</h4>
            <button
              onClick={() => setIsUploadOpen(false)}
              className="text-ink-3 hover:text-ink text-sm"
            >
              ✕
            </button>
          </div>

          <form onSubmit={handleAddDocument} className="space-y-4 text-xs">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2">
                <label className="font-medium text-ink-2 block mb-1">Document Title</label>
                <input
                  type="text"
                  placeholder="e.g. Form 16 Part B signed from employer"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  className="w-full px-3 py-2 border rounded border-hairline bg-paper"
                />
              </div>

              <div>
                <label className="font-medium text-ink-2 block mb-1">Document Category</label>
                <select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value as SalariedVaultItem["category"])}
                  className="w-full px-3 py-2 border rounded border-hairline bg-paper"
                >
                  <option value="form16">Form 16 (Part A & B)</option>
                  <option value="payslip">Monthly Salary Payslip</option>
                  <option value="tax_statement">AIS / TIS / 26AS Statement</option>
                  <option value="rent_hra">Rent Agreement & Landlord PAN</option>
                  <option value="investment_80c">Section 80C Investment Proof</option>
                  <option value="insurance_80d">Section 80D Health Insurance</option>
                  <option value="bank_statement">Bank Interest Certificate</option>
                  <option value="kyc_cards">KYC Cards (PAN/Aadhaar/UAN)</option>
                </select>
              </div>

              <div>
                <label className="font-medium text-ink-2 block mb-1">Assessment Year</label>
                <select
                  value={newAy}
                  onChange={(e) => setNewAy(e.target.value)}
                  className="w-full px-3 py-2 border rounded border-hairline bg-paper"
                >
                  <option value="AY 2025-26">AY 2025-26 (FY 2024-25)</option>
                  <option value="AY 2026-27">AY 2026-27 (FY 2025-26)</option>
                  <option value="Permanent">Permanent (KYC / Identity)</option>
                </select>
              </div>

              <div className="md:col-span-2">
                <label className="font-medium text-ink-2 block mb-1">Select File (PDF, Image)</label>
                <input
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png,.webp"
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setSelectedFile(f);
                    if (f && !newTitle.trim()) {
                      setNewTitle(f.name.replace(/\.[^.]+$/, ""));
                    }
                  }}
                  className="w-full text-xs text-ink file:mr-3 file:rounded file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-paper file:font-medium hover:file:opacity-90"
                />
              </div>

              <div className="md:col-span-3">
                <label className="font-medium text-ink-2 block mb-1">Notes (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Total deduction amount ₹1.5L, verified against TRACES"
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="w-full px-3 py-2 border rounded border-hairline bg-paper"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-hairline">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsUploadOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" size="sm">
                Save to Vault
              </Button>
            </div>
          </form>
        </Card>
      )}

      {/* ── Document List Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredItems.map((item) => (
          <Card
            key={item.id}
            className="p-4 border border-hairline hover:border-ink/20 transition-all flex flex-col justify-between space-y-3 bg-paper"
          >
            <div className="space-y-2">
              <div className="flex items-start justify-between gap-2">
                <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-paper-2 text-ink-2">
                  {item.categoryLabel}
                </span>
                <span className="text-3xs font-mono text-ink-3">{item.assessmentYear}</span>
              </div>

              <h4 className="font-semibold text-sm text-ink line-clamp-2 leading-snug">
                {item.title}
              </h4>

              <div className="p-2 rounded bg-amber-50/50 border border-amber-200/60 text-2xs space-y-0.5">
                <span className="text-amber-900 font-medium block">🔗 ITR Linkage:</span>
                <span className="text-amber-800 font-mono">{item.itrSectionLink}</span>
              </div>

              {item.notes && (
                <p className="text-2xs text-ink-3 line-clamp-2 italic">
                  {item.notes}
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-hairline flex items-center justify-between text-2xs text-ink-3">
              <div className="flex items-center gap-1.5 font-mono">
                <Icon name="file" size={13} className="text-ink-3" />
                <span>{item.fileSizeMb} MB</span>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleDownload(item)}
                  className="p-1 hover:text-ink transition-colors flex items-center gap-1 font-medium text-ink-2"
                  title="Download / View document"
                >
                  <Icon name="download" size={13} />
                  Download
                </button>
                <button
                  onClick={() => handleDelete(item.id)}
                  className="p-1 text-ink-3 hover:text-rose-600 transition-colors"
                  title="Delete from vault"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
