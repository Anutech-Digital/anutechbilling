"use client";

import { ComplianceView } from "@/components/features/compliance/compliance-view";

export default function IncomeTaxCompliancePage() {
  return (
    <ComplianceView
      title="Income Tax & TDS"
      subtitle="Company ITR, tax audit, advance-tax instalments, and TDS deposits + quarterly returns."
      fixedCategories={["income_tax", "tds"]}
    />
  );
}
