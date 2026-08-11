"use client";

import { ComplianceView } from "@/components/features/compliance/compliance-view";

export default function GstCompliancePage() {
  return (
    <ComplianceView
      title="GST Returns"
      subtitle="GSTR-1 (sales), GSTR-3B (summary + tax) and the annual GSTR-9 — with due dates, penalties and one-tap 'How to file'."
      fixedCategories={["gst"]}
    />
  );
}
