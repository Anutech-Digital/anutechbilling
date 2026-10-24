/**
 * While tenants.business_type is empty the whole app reads it as Pvt Ltd (resolveBusinessType in
 * lib/compliance/entity.ts — coordinator decision, 24 Oct 2026), so a proprietor would see director
 * choices instead of drawings. This small amber prompt asks the owner to set the type, with a button
 * to Settings → Company → Compliance profile. Shown on the Balance Sheet equity card and in
 * Settings → Company. Nothing while loading, once a type is set, or before the column exists.
 */
"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useComplianceProfile } from "@/lib/compliance/profile";

export const COMPLIANCE_PROFILE_HREF = "/settings?tab=company#compliance-profile";

export function BusinessTypePrompt({ className = "" }: { className?: string }) {
  const { data } = useComplianceProfile();
  if (!data || data.columnsMissing || data.businessType) return null;
  return (
    <div role="status"
      className={`flex flex-wrap items-center gap-2 rounded-md border border-amber/50 bg-amber-soft/40 px-3 py-2 text-xs text-amber-ink ${className}`}>
      <Icon name="info" size={14} className="shrink-0" />
      <p className="min-w-0 flex-1 basis-48">Set your business type — owner/partner/director options depend on it</p>
      <Button asChild size="sm">
        <Link href={COMPLIANCE_PROFILE_HREF as never}>Set business type</Link>
      </Button>
    </div>
  );
}
