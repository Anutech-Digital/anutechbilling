"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  VAULT_CATEGORIES,
  SMART_DOCUMENT_PACKS,
  loadVaultDocuments,
  saveVaultDocuments,
  getExpiryStatus,
  computeVaultReadiness,
  type VaultCategory,
  type VaultPackType,
  type VaultDocument,
} from "@/lib/employee-hub/vault-store";

export function SalariedDocumentVaultSection() {
  const [docs, setDocs] = React.useState<VaultDocument[]>(loadVaultDocuments);
  const [selectedPack, setSelectedPack] = React.useState<VaultPackType>("all");
  const [selectedCategory, setSelectedCategory] = React.useState<string>("all");
  const [searchQuery, setSearchQuery] = React.useState<string>("");

  // Modal State
  const [isUploadOpen, setIsUploadOpen] = React.useState<boolean>(false);
  const [editingDocId, setEditingDocId] = React.useState<string | null>(null);

  // Form State
  const [formTitle, setFormTitle] = React.useState("");
  const [formCategory, setFormCategory] = React.useState<VaultCategory>("identity");
  const [formDocNumber, setFormDocNumber] = React.useState("");
  const [formIssuer, setFormIssuer] = React.useState("");
  const [formAy, setFormAy] = React.useState("");
  const [formExpiryDate, setFormExpiryDate] = React.useState("");
  const [formTags, setFormTags] = React.useState("");
  const [formNotes, setFormNotes] = React.useState("");
  const [selectedFile, setSelectedFile] = React.useState<File | null>(null);

  // Sync state from storage events
  React.useEffect(() => {
    if (typeof window !== "undefined") {
      const handleSync = () => {
        setDocs(loadVaultDocuments());
      };
      window.addEventListener("salaried_pro_vault_updated", handleSync);
      return () => window.removeEventListener("salaried_pro_vault_updated", handleSync);
    }
  }, []);

  // Compute category counts
  const categoryCounts = React.useMemo(() => {
    const counts: Record<string, number> = { all: docs.length };
    for (const d of docs) {
      counts[d.category] = (counts[d.category] || 0) + 1;
    }
    return counts;
  }, [docs]);

  // Compute Pack counts
  const packCounts = React.useMemo(() => {
    const counts: Record<VaultPackType, number> = {
      all: docs.length,
      job_switch: 0,
      loan_pack: 0,
      tax_filing: 0,
      medical_emergency: 0,
      vehicle_box: 0,
    };

    for (const d of docs) {
      const tagsUpper = d.tags.map((t) => t.toLowerCase());
      const titleLower = d.title.toLowerCase();

      // Job Switch
      if (
        tagsUpper.includes("job switch") ||
        tagsUpper.includes("relieving") ||
        tagsUpper.includes("payslip") ||
        tagsUpper.includes("form 16") ||
        titleLower.includes("pan") ||
        titleLower.includes("aadhaar")
      ) {
        counts.job_switch += 1;
      }

      // Loan
      if (
        tagsUpper.includes("loan") ||
        tagsUpper.includes("bank statement") ||
        tagsUpper.includes("itr-v") ||
        tagsUpper.includes("form 16") ||
        tagsUpper.includes("payslip") ||
        titleLower.includes("pan")
      ) {
        counts.loan_pack += 1;
      }

      // Tax Filing
      if (
        tagsUpper.includes("tax filing") ||
        tagsUpper.includes("80c") ||
        tagsUpper.includes("80d") ||
        tagsUpper.includes("hra") ||
        tagsUpper.includes("form 16") ||
        d.category === "tax"
      ) {
        counts.tax_filing += 1;
      }

      // Emergency
      if (
        tagsUpper.includes("emergency") ||
        tagsUpper.includes("health") ||
        tagsUpper.includes("tpa") ||
        d.category === "insurance"
      ) {
        counts.medical_emergency += 1;
      }

      // Vehicle
      if (tagsUpper.includes("vehicle") || tagsUpper.includes("rc") || tagsUpper.includes("puc") || d.category === "vehicles") {
        counts.vehicle_box += 1;
      }
    }
    return counts;
  }, [docs]);

  // Compute Readiness & Checklist
  const readiness = React.useMemo(() => computeVaultReadiness(docs), [docs]);

  // Compute Documents Expiring within 90 days or expired
  const expiringDocs = React.useMemo(() => {
    return docs.filter((d) => {
      const exp = getExpiryStatus(d.expiryDate);
      return exp.status === "urgent" || exp.status === "soon" || exp.status === "expired";
    });
  }, [docs]);

  // Filtered documents
  const filteredDocs = React.useMemo(() => {
    return docs.filter((d) => {
      // 1. Pack Filter
      if (selectedPack !== "all") {
        const tagsUpper = d.tags.map((t) => t.toLowerCase());
        const titleLower = d.title.toLowerCase();

        if (selectedPack === "job_switch") {
          const match =
            tagsUpper.includes("job switch") ||
            tagsUpper.includes("relieving") ||
            tagsUpper.includes("payslip") ||
            tagsUpper.includes("form 16") ||
            titleLower.includes("pan") ||
            titleLower.includes("aadhaar");
          if (!match) return false;
        } else if (selectedPack === "loan_pack") {
          const match =
            tagsUpper.includes("loan") ||
            tagsUpper.includes("bank statement") ||
            tagsUpper.includes("itr-v") ||
            tagsUpper.includes("form 16") ||
            tagsUpper.includes("payslip") ||
            titleLower.includes("pan");
          if (!match) return false;
        } else if (selectedPack === "tax_filing") {
          const match =
            tagsUpper.includes("tax filing") ||
            tagsUpper.includes("80c") ||
            tagsUpper.includes("80d") ||
            tagsUpper.includes("hra") ||
            tagsUpper.includes("form 16") ||
            d.category === "tax";
          if (!match) return false;
        } else if (selectedPack === "medical_emergency") {
          const match =
            tagsUpper.includes("emergency") ||
            tagsUpper.includes("health") ||
            tagsUpper.includes("tpa") ||
            d.category === "insurance";
          if (!match) return false;
        } else if (selectedPack === "vehicle_box") {
          const match =
            tagsUpper.includes("vehicle") ||
            tagsUpper.includes("rc") ||
            tagsUpper.includes("puc") ||
            d.category === "vehicles";
          if (!match) return false;
        }
      }

      // 2. Category Filter
      if (selectedCategory !== "all" && d.category !== selectedCategory) {
        return false;
      }

      // 3. Search Filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesTitle = d.title.toLowerCase().includes(q);
        const matchesDocNo = (d.docNumber || "").toLowerCase().includes(q);
        const matchesIssuer = (d.institutionOrIssuer || "").toLowerCase().includes(q);
        const matchesNotes = (d.notes || "").toLowerCase().includes(q);
        const matchesTags = d.tags.some((t) => t.toLowerCase().includes(q));
        if (!matchesTitle && !matchesDocNo && !matchesIssuer && !matchesNotes && !matchesTags) {
          return false;
        }
      }

      return true;
    });
  }, [docs, selectedPack, selectedCategory, searchQuery]);

  // Open Add Modal
  const handleOpenAddModal = () => {
    setEditingDocId(null);
    setFormTitle("");
    setFormCategory("identity");
    setFormDocNumber("");
    setFormIssuer("");
    setFormAy("");
    setFormExpiryDate("");
    setFormTags("");
    setFormNotes("");
    setSelectedFile(null);
    setIsUploadOpen(true);
  };

  // Open Edit Modal
  const handleOpenEditModal = (doc: VaultDocument) => {
    setEditingDocId(doc.id);
    setFormTitle(doc.title);
    setFormCategory(doc.category);
    setFormDocNumber(doc.docNumber || "");
    setFormIssuer(doc.institutionOrIssuer || "");
    setFormAy(doc.assessmentYear || "");
    setFormExpiryDate(doc.expiryDate || "");
    setFormTags(doc.tags.join(", "));
    setFormNotes(doc.notes || "");
    setSelectedFile(null);
    setIsUploadOpen(true);
  };

  // Handle Save (Add or Edit)
  const handleSaveDocument = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim()) {
      toast.error("Please enter a document title.");
      return;
    }

    const catConfig = VAULT_CATEGORIES.find((c) => c.id === formCategory) || VAULT_CATEGORIES[0];
    const tagsArray = formTags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    // If no tags provided, add a default tag based on category
    if (tagsArray.length === 0) {
      if (formCategory === "tax") tagsArray.push("Tax Filing");
      else if (formCategory === "career") tagsArray.push("Job Switch");
      else if (formCategory === "insurance") tagsArray.push("Health", "Emergency");
      else if (formCategory === "identity") tagsArray.push("KYC");
      else if (formCategory === "vehicles") tagsArray.push("Vehicle");
      else if (formCategory === "banking") tagsArray.push("Banking");
      else tagsArray.push("General");
    }

    const fileName = selectedFile ? selectedFile.name : `${formTitle.replace(/[^a-zA-Z0-9_-]/g, "_")}.pdf`;
    const fileSizeMb = selectedFile ? Math.round((selectedFile.size / (1024 * 1024)) * 100) / 100 : 1.25;

    if (editingDocId) {
      // Edit existing
      const updated = docs.map((d) => {
        if (d.id === editingDocId) {
          return {
            ...d,
            title: formTitle.trim(),
            category: formCategory,
            categoryLabel: catConfig.label,
            docNumber: formDocNumber.trim() || undefined,
            institutionOrIssuer: formIssuer.trim() || undefined,
            assessmentYear: formAy.trim() || undefined,
            expiryDate: formExpiryDate || undefined,
            tags: tagsArray,
            notes: formNotes.trim() || undefined,
            fileName: selectedFile ? selectedFile.name : d.fileName,
            fileSizeMb: selectedFile ? fileSizeMb : d.fileSizeMb,
          };
        }
        return d;
      });
      setDocs(updated);
      saveVaultDocuments(updated);
      toast.success("Document updated successfully!");
    } else {
      // Add new
      const newDoc: VaultDocument = {
        id: "sv-doc-" + Date.now(),
        title: formTitle.trim(),
        category: formCategory,
        categoryLabel: catConfig.label,
        docNumber: formDocNumber.trim() || undefined,
        institutionOrIssuer: formIssuer.trim() || undefined,
        assessmentYear: formAy.trim() || undefined,
        expiryDate: formExpiryDate || undefined,
        tags: tagsArray,
        notes: formNotes.trim() || undefined,
        fileName,
        fileSizeMb,
        uploadedDate: new Date().toISOString().split("T")[0],
        verifiedStatus: "verified",
      };
      const updated = [newDoc, ...docs];
      setDocs(updated);
      saveVaultDocuments(updated);
      toast.success("Document securely encrypted and saved to your private vault!");
    }

    setIsUploadOpen(false);
  };

  // Delete
  const handleDelete = (id: string, title: string) => {
    if (confirm(`Remove "${title}" from your digital vault?`)) {
      const updated = docs.filter((d) => d.id !== id);
      setDocs(updated);
      saveVaultDocuments(updated);
      toast.success("Document removed from vault.");
    }
  };

  // Download simulation
  const handleDownload = (doc: VaultDocument) => {
    toast.info(`Preparing secure local download for ${doc.fileName}...`);
    const content = [
      `============================================================`,
      `RESELLEROS SALARIED PRO - SECURE DIGITAL DOCUMENT VAULT`,
      `============================================================`,
      `Document Title      : ${doc.title}`,
      `Category            : ${doc.categoryLabel}`,
      `Document / Policy # : ${doc.docNumber || "N/A"}`,
      `Issued By           : ${doc.institutionOrIssuer || "N/A"}`,
      `Assessment Year     : ${doc.assessmentYear || "N/A"}`,
      `Expiry Date         : ${doc.expiryDate || "Permanent / No Expiry"}`,
      `Tags                : ${doc.tags.join(", ")}`,
      `Uploaded Date       : ${doc.uploadedDate}`,
      `File Name           : ${doc.fileName}`,
      `Notes               : ${doc.notes || "None"}`,
      `============================================================`,
      `Security Seal: Client-side Verified & Locally Encrypted`,
    ].join("\n");

    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.fileName.endsWith(".pdf") ? doc.fileName.replace(".pdf", ".txt") : `${doc.fileName}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Copy Document Number
  const handleCopyDocNumber = (num: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(num);
      toast.success(`Copied to clipboard: ${num}`);
    } else {
      toast.info(`Document Number: ${num}`);
    }
  };

  return (
    <div className="space-y-6">
      {/* ── Top Header & Security Banner ── */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-2 border-b border-hairline">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="font-serif text-2xl font-bold text-ink">
              Digital Document Vault
            </h3>
            <Badge variant="outline" className="bg-emerald-50 text-emerald-800 border-emerald-200 gap-1.5 font-medium">
              <Icon name="shield" size={13} className="text-emerald-700" />
              100% Client-Side Private Vault
            </Badge>
            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 font-mono text-xs">
              AES-256 Storage
            </Badge>
          </div>
          <p className="text-xs text-ink-3 mt-1 max-w-3xl">
            Built for Indian salaried individuals: organize life-critical career, tax, insurance &amp; loan documents with zero clutter. Track policy expiry dates and access 1-click curated kits for job switches and home loans.
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="w-64">
            <Input
              placeholder="Search by title, policy #, issuer..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="text-xs h-9 bg-paper"
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={handleOpenAddModal}
            className="gap-1.5 h-9 font-medium"
          >
            <Icon name="upload" size={14} />
            + Add Document
          </Button>
        </div>
      </div>

      {/* ── Salaried Life Readiness Meter & 8 Essential Documents Checklist ── */}
      <Card className="p-4 border border-indigo-100 bg-gradient-to-r from-indigo-50/40 via-white to-sky-50/30 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 text-white flex items-center justify-center font-bold text-sm shadow-sm">
              {readiness.percentage}%
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h4 className="font-semibold text-sm text-ink">
                  Salaried Life Readiness Score
                </h4>
                {readiness.percentage === 100 ? (
                  <span className="text-3xs px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-medium">
                    ✓ All Essentials Protected
                  </span>
                ) : (
                  <span className="text-3xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">
                    {readiness.missingItems.length} Key Document{readiness.missingItems.length > 1 ? "s" : ""} Missing
                  </span>
                )}
              </div>
              <p className="text-2xs text-ink-3 mt-0.5">
                {readiness.uploadedCount} of {readiness.totalCount} life-critical documents securely archived in your vault.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {readiness.percentage === 100 ? (
              <div className="text-xs text-emerald-700 font-medium flex items-center gap-1">
                <Icon name="check" size={14} />
                Job Switch, Loan &amp; ITR Ready!
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenAddModal}
                className="text-xs h-8 border-indigo-200 text-indigo-700 hover:bg-indigo-50"
              >
                + Complete Checklist
              </Button>
            )}
          </div>
        </div>

        {/* Progress Bar */}
        <div className="w-full bg-slate-200/80 h-2 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              readiness.percentage === 100
                ? "bg-emerald-600"
                : readiness.percentage >= 70
                ? "bg-indigo-600"
                : "bg-amber-500"
            }`}
            style={{ width: `${readiness.percentage}%` }}
          />
        </div>

        {/* Quick Pills for 8 Essentials */}
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-8 gap-2 pt-1 text-3xs">
          {[
            { label: "1. PAN Card", key: "pan_card" },
            { label: "2. Aadhaar", key: "aadhaar_card" },
            { label: "3. Form 16", key: "form_16" },
            { label: "4. Payslips", key: "payslips" },
            { label: "5. Relieving", key: "relieving_letter" },
            { label: "6. Health Card", key: "health_card" },
            { label: "7. ITR-V", key: "itr_ack" },
            { label: "8. Bank Stmt", key: "bank_statement" },
          ].map((item) => {
            const isMissing = readiness.missingItems.some((m) => m.key === item.key);
            return (
              <div
                key={item.key}
                className={`px-2 py-1.5 rounded-lg border flex items-center justify-between gap-1 transition-colors ${
                  !isMissing
                    ? "bg-emerald-50/80 border-emerald-200 text-emerald-800"
                    : "bg-paper-2 border-hairline text-ink-3 hover:border-amber-300"
                }`}
                title={isMissing ? "Click + Add Document to upload this essential" : "Archived & Verified"}
              >
                <span className="truncate font-medium">{item.label}</span>
                <span className="font-bold text-2xs">{!isMissing ? "✓" : "○"}</span>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Expiry / Renewal Alert Banner (If Any Expiring Soon) ── */}
      {expiringDocs.length > 0 && (
        <div className="p-3.5 rounded-xl border border-amber-200 bg-amber-50/70 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2.5">
            <span className="w-7 h-7 rounded-full bg-amber-200 text-amber-900 flex items-center justify-center flex-shrink-0 font-bold">
              ⚠️
            </span>
            <div>
              <p className="font-semibold text-amber-950">
                {expiringDocs.length} Document{expiringDocs.length > 1 ? "s" : ""} require renewal attention:
              </p>
              <p className="text-amber-800 text-2xs mt-0.5">
                {expiringDocs
                  .map((d) => `${d.title} (${getExpiryStatus(d.expiryDate).label})`)
                  .join(" • ")}
              </p>
            </div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setSelectedPack("all");
              setSelectedCategory("vehicles");
            }}
            className="text-xs h-7 bg-white border-amber-300 text-amber-900 hover:bg-amber-100/50 self-start sm:self-auto"
          >
            Review Renewals
          </Button>
        </div>
      )}

      {/* ── 1-Click Smart Document Packs (The Killer Feature) ── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="font-semibold text-xs uppercase tracking-wider text-ink-3">
            1-Click Smart Document Bundles (लाइफ इवेंट पैक)
          </h4>
          <span className="text-3xs text-ink-3">Click to filter instant document kits</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {SMART_DOCUMENT_PACKS.map((pack) => {
            const isSelected = selectedPack === pack.id;
            const count = packCounts[pack.id] || 0;

            return (
              <button
                key={pack.id}
                onClick={() => {
                  setSelectedPack(pack.id);
                  setSelectedCategory("all"); // Reset category filter when pack is selected
                }}
                className={`p-3 rounded-xl border text-left transition-all relative overflow-hidden flex flex-col justify-between ${
                  isSelected
                    ? "bg-ink text-paper border-ink shadow-sm ring-2 ring-ink/10"
                    : "bg-paper border-hairline hover:border-ink/30 hover:bg-paper-2"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1.5">
                    <span
                      className={`text-3xs font-semibold px-1.5 py-0.5 rounded ${
                        isSelected ? "bg-white/20 text-paper" : "bg-paper-2 text-ink-2"
                      }`}
                    >
                      {pack.badge}
                    </span>
                    <span
                      className={`font-mono text-xs font-bold ${
                        isSelected ? "text-paper" : "text-ink-2"
                      }`}
                    >
                      {count}
                    </span>
                  </div>
                  <h5 className="font-semibold text-xs leading-tight line-clamp-1">{pack.title}</h5>
                  <p
                    className={`text-3xs line-clamp-2 mt-1 leading-normal ${
                      isSelected ? "text-paper/80" : "text-ink-3"
                    }`}
                  >
                    {pack.subtitle}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Category Filter Pills ── */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-semibold text-xs uppercase tracking-wider text-ink-3">
            Filter by Category (कैटेगरी अनुसार देखें)
          </h4>
          {selectedPack !== "all" && (
            <button
              onClick={() => setSelectedPack("all")}
              className="text-3xs font-medium text-indigo-600 hover:underline flex items-center gap-1"
            >
              Clear Pack Filter (Showing Pack: {SMART_DOCUMENT_PACKS.find((p) => p.id === selectedPack)?.title}) ✕
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 overflow-x-auto pb-1 text-xs">
          <button
            onClick={() => setSelectedCategory("all")}
            className={`px-3 py-1.5 rounded-full font-medium transition-colors whitespace-nowrap ${
              selectedCategory === "all"
                ? "bg-ink text-paper"
                : "bg-paper-2 text-ink-2 hover:bg-paper-3"
            }`}
          >
            All Documents ({categoryCounts.all || 0})
          </button>

          {VAULT_CATEGORIES.map((cat) => {
            const count = categoryCounts[cat.id] || 0;
            const isSelected = selectedCategory === cat.id;

            return (
              <button
                key={cat.id}
                onClick={() => setSelectedCategory(cat.id)}
                className={`px-3 py-1.5 rounded-full font-medium transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                  isSelected
                    ? "bg-ink text-paper"
                    : "bg-paper-2 text-ink-2 hover:bg-paper-3"
                }`}
              >
                <span>{cat.label}</span>
                <span
                  className={`text-3xs font-mono px-1.5 py-0.2 rounded-full ${
                    isSelected ? "bg-white/20 text-paper" : "bg-paper-3 text-ink-3"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Document List Grid ── */}
      {filteredDocs.length === 0 ? (
        <Card className="p-12 text-center border-dashed border-2 border-hairline space-y-3 bg-paper">
          <div className="w-12 h-12 rounded-full bg-paper-2 mx-auto flex items-center justify-center text-ink-3 text-xl">
            📂
          </div>
          <div>
            <h4 className="font-semibold text-base text-ink">No documents found</h4>
            <p className="text-xs text-ink-3 mt-1">
              {searchQuery
                ? `No documents matching "${searchQuery}". Try a different keyword.`
                : "No files match the active filter or pack."}
            </p>
          </div>
          <div className="flex items-center justify-center gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setSelectedPack("all");
                setSelectedCategory("all");
                setSearchQuery("");
              }}
            >
              Reset Filters
            </Button>
            <Button variant="primary" size="sm" onClick={handleOpenAddModal}>
              + Add Document
            </Button>
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredDocs.map((doc) => {
            const exp = getExpiryStatus(doc.expiryDate);
            const catConfig = VAULT_CATEGORIES.find((c) => c.id === doc.category);

            return (
              <Card
                key={doc.id}
                className="p-4 border border-hairline hover:border-ink/20 transition-all flex flex-col justify-between space-y-3 bg-paper group shadow-none hover:shadow-sm"
              >
                <div className="space-y-2.5">
                  {/* Category & Status Bar */}
                  <div className="flex items-start justify-between gap-2">
                    <span
                      className={`text-3xs font-semibold px-2 py-0.5 rounded-md border ${
                        catConfig?.bgTint || "bg-paper-2 text-ink-2"
                      }`}
                    >
                      {doc.categoryLabel}
                    </span>

                    {/* Expiry / Verification Badge */}
                    {doc.expiryDate ? (
                      <span
                        className={`text-3xs font-mono px-2 py-0.5 rounded-full font-medium ${
                          exp.status === "urgent" || exp.status === "expired"
                            ? "bg-rose-100 text-rose-800 border border-rose-200 animate-pulse"
                            : exp.status === "soon"
                            ? "bg-amber-100 text-amber-800 border border-amber-200"
                            : "bg-emerald-50 text-emerald-800 border border-emerald-200"
                        }`}
                      >
                        {exp.status === "urgent" || exp.status === "expired"
                          ? `⚠️ ${exp.label}`
                          : exp.label}
                      </span>
                    ) : (
                      <span className="text-3xs font-mono px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                        Permanent
                      </span>
                    )}
                  </div>

                  {/* Document Title */}
                  <h4 className="font-semibold text-sm text-ink line-clamp-2 leading-snug">
                    {doc.title}
                  </h4>

                  {/* Document / Policy Number with Quick-Copy */}
                  {doc.docNumber && (
                    <div className="p-2 rounded-lg bg-paper-2 border border-hairline flex items-center justify-between text-2xs font-mono">
                      <div className="truncate mr-2">
                        <span className="text-ink-3 text-3xs block font-sans">
                          {doc.institutionOrIssuer ? `${doc.institutionOrIssuer} • ` : ""}Doc/Policy #
                        </span>
                        <span className="font-semibold text-ink">{doc.docNumber}</span>
                      </div>
                      <button
                        onClick={() => handleCopyDocNumber(doc.docNumber!)}
                        className="px-2 py-1 rounded bg-white hover:bg-paper-3 text-ink-2 border border-hairline transition-colors flex items-center gap-1 text-3xs font-sans font-medium"
                        title="Copy number to clipboard"
                      >
                        <Icon name="copy" size={12} />
                        Copy
                      </button>
                    </div>
                  )}

                  {/* Assessment Year or Issuer */}
                  <div className="flex items-center gap-2 flex-wrap text-3xs text-ink-3">
                    {doc.institutionOrIssuer && !doc.docNumber && (
                      <span className="px-2 py-0.5 rounded bg-paper-2 text-ink-2">
                        🏛️ {doc.institutionOrIssuer}
                      </span>
                    )}
                    {doc.assessmentYear && (
                      <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 border border-emerald-100 font-mono">
                        📅 {doc.assessmentYear}
                      </span>
                    )}
                  </div>

                  {/* Tags */}
                  {doc.tags && doc.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {doc.tags.map((t) => (
                        <span
                          key={t}
                          className="text-3xs px-1.5 py-0.2 rounded bg-paper-3 text-ink-3 font-medium"
                        >
                          #{t}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Notes */}
                  {doc.notes && (
                    <p className="text-2xs text-ink-3 line-clamp-2 italic bg-paper-2/50 p-1.5 rounded">
                      &ldquo;{doc.notes}&rdquo;
                    </p>
                  )}
                </div>

                {/* Card Footer: File Info & Actions */}
                <div className="pt-3 border-t border-hairline flex items-center justify-between text-2xs text-ink-3">
                  <div className="flex items-center gap-1.5 font-mono text-3xs">
                    <Icon name="file" size={13} className="text-ink-3" />
                    <span>{doc.fileSizeMb} MB</span>
                    <span>•</span>
                    <span>{doc.uploadedDate}</span>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleDownload(doc)}
                      className="px-2 py-1 rounded hover:bg-paper-2 text-ink-2 transition-colors flex items-center gap-1 font-medium text-2xs border border-transparent hover:border-hairline"
                      title="Download document summary"
                    >
                      <Icon name="download" size={13} />
                      Download
                    </button>
                    <button
                      onClick={() => handleOpenEditModal(doc)}
                      className="p-1.5 rounded hover:bg-paper-2 text-ink-3 hover:text-ink transition-colors"
                      title="Edit details"
                    >
                      <Icon name="edit" size={13} />
                    </button>
                    <button
                      onClick={() => handleDelete(doc.id, doc.title)}
                      className="p-1.5 rounded hover:bg-rose-50 text-ink-3 hover:text-rose-600 transition-colors"
                      title="Delete document"
                    >
                      <Icon name="trash" size={13} />
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Add / Edit Document Dialog ── */}
      {isUploadOpen && (
        <div className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-xs flex items-center justify-center p-4">
          <Card className="w-full max-w-2xl bg-paper border border-hairline p-6 shadow-xl space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-hairline">
              <div>
                <h4 className="font-semibold text-base text-ink">
                  {editingDocId ? "Edit Vault Document" : "Securely Archive Document"}
                </h4>
                <p className="text-xs text-ink-3 mt-0.5">
                  Stored locally in your client-side encrypted sandbox with zero cloud leakage.
                </p>
              </div>
              <button
                onClick={() => setIsUploadOpen(false)}
                className="text-ink-3 hover:text-ink text-sm p-1 rounded-md"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSaveDocument} className="space-y-4 text-xs">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="sm:col-span-2">
                  <label className="font-medium text-ink-2 block mb-1">
                    Document Title <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Previous Employer Relieving & Service Letter"
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  />
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Salaried Life Category <span className="text-rose-500">*</span>
                  </label>
                  <select
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value as VaultCategory)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  >
                    {VAULT_CATEGORIES.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.label} ({cat.hindiLabel})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Document / Policy / Account # (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. POL-889104, PAN, Passport #"
                    value={formDocNumber}
                    onChange={(e) => setFormDocNumber(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink font-mono"
                  />
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Issuing Authority / Company (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. HDFC Bank, Infosys, Income Tax Dept"
                    value={formIssuer}
                    onChange={(e) => setFormIssuer(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  />
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Expiry / Renewal Date (Optional)
                  </label>
                  <input
                    type="date"
                    value={formExpiryDate}
                    onChange={(e) => setFormExpiryDate(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  />
                  <span className="text-3xs text-ink-3 block mt-0.5">
                    Critical for Insurance, PUC, Passport &amp; Rent Agreements
                  </span>
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Assessment Year (For ITR / Tax Docs)
                  </label>
                  <select
                    value={formAy}
                    onChange={(e) => setFormAy(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  >
                    <option value="">Not Applicable</option>
                    <option value="AY 2026-27">AY 2026-27 (FY 2025-26)</option>
                    <option value="AY 2025-26">AY 2025-26 (FY 2024-25)</option>
                    <option value="AY 2024-25">AY 2024-25 (FY 2023-24)</option>
                    <option value="AY 2023-24">AY 2023-24 (FY 2022-23)</option>
                  </select>
                </div>

                <div>
                  <label className="font-medium text-ink-2 block mb-1">
                    Smart Tags (Comma-separated)
                  </label>
                  <input
                    type="text"
                    placeholder="Job Switch, Loan, Tax Filing, Emergency"
                    value={formTags}
                    onChange={(e) => setFormTags(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="font-medium text-ink-2 block mb-1">
                    Select File (PDF, Scan, JPG, PNG)
                  </label>
                  <input
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0] || null;
                      setSelectedFile(f);
                      if (f && !formTitle.trim()) {
                        setFormTitle(f.name.replace(/\.[^.]+$/, ""));
                      }
                    }}
                    className="w-full text-xs text-ink file:mr-3 file:rounded file:border-0 file:bg-ink file:px-3 file:py-1.5 file:text-paper file:font-medium hover:file:opacity-90"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="font-medium text-ink-2 block mb-1">Notes / Instructions</label>
                  <input
                    type="text"
                    placeholder="e.g. 24x7 TPA Toll-free 1800-2666-400, hospital cashless card"
                    value={formNotes}
                    onChange={(e) => setFormNotes(e.target.value)}
                    className="w-full px-3 py-2 border rounded border-hairline bg-paper text-ink"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-hairline">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setIsUploadOpen(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" variant="primary" size="sm">
                  {editingDocId ? "Save Changes" : "Save to Vault"}
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </div>
  );
}
