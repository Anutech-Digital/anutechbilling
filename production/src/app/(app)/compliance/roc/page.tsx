"use client";

import { ComplianceView } from "@/components/features/compliance/compliance-view";

export default function RocCompliancePage() {
  return (
    <ComplianceView
      title="ROC / MCA Filings"
      subtitle="Annual Registrar of Companies filings — AOC-4, MGT-7, DIR-3 KYC, DPT-3, ADT-1 and the AGM."
      fixedCategories={["roc"]}
    />
  );
}
