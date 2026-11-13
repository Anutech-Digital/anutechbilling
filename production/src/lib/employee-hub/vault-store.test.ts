import { describe, it, expect } from "vitest";
import {
  DEFAULT_SALARIED_VAULT_DOCS,
  VAULT_CATEGORIES,
  SMART_DOCUMENT_PACKS,
  ESSENTIAL_SALARIED_CHECKLIST,
  getExpiryStatus,
  computeVaultReadiness,
  type VaultDocument,
} from "./vault-store";

describe("Salaried Pro Vault Store", () => {
  it("should have all 7 core categories configured", () => {
    expect(VAULT_CATEGORIES).toHaveLength(7);
    const categoryIds = VAULT_CATEGORIES.map((c) => c.id);
    expect(categoryIds).toContain("identity");
    expect(categoryIds).toContain("career");
    expect(categoryIds).toContain("tax");
    expect(categoryIds).toContain("insurance");
    expect(categoryIds).toContain("banking");
    expect(categoryIds).toContain("vehicles");
    expect(categoryIds).toContain("family");
  });

  it("should have 6 smart document packs defined", () => {
    expect(SMART_DOCUMENT_PACKS).toHaveLength(6);
    const packIds = SMART_DOCUMENT_PACKS.map((p) => p.id);
    expect(packIds).toContain("all");
    expect(packIds).toContain("job_switch");
    expect(packIds).toContain("loan_pack");
    expect(packIds).toContain("tax_filing");
    expect(packIds).toContain("medical_emergency");
    expect(packIds).toContain("vehicle_box");
  });

  it("should have 8 essential salaried checklist items", () => {
    expect(ESSENTIAL_SALARIED_CHECKLIST).toHaveLength(8);
    const keys = ESSENTIAL_SALARIED_CHECKLIST.map((i) => i.key);
    expect(keys).toContain("pan_card");
    expect(keys).toContain("aadhaar_card");
    expect(keys).toContain("form_16");
    expect(keys).toContain("payslips");
    expect(keys).toContain("relieving_letter");
    expect(keys).toContain("health_card");
    expect(keys).toContain("itr_ack");
    expect(keys).toContain("bank_statement");
  });

  it("should correctly calculate expiry status for past, soon, and future dates", () => {
    // Past date (expired)
    const expiredRes = getExpiryStatus("2020-01-01");
    expect(expiredRes.status).toBe("expired");
    expect(expiredRes.daysLeft).toBeLessThan(0);

    // No date
    const noDateRes = getExpiryStatus(undefined);
    expect(noDateRes.status).toBe("none");

    // Distant future
    const distantFuture = getExpiryStatus("2099-12-31");
    expect(distantFuture.status).toBe("valid");
    expect(distantFuture.daysLeft).toBeGreaterThan(100);
  });

  it("should accurately compute vault readiness for default seeded documents", () => {
    const readiness = computeVaultReadiness(DEFAULT_SALARIED_VAULT_DOCS);
    expect(readiness.totalCount).toBe(8);
    // The default docs cover all 8 essentials
    expect(readiness.uploadedCount).toBe(8);
    expect(readiness.percentage).toBe(100);
    expect(readiness.missingItems).toHaveLength(0);
  });

  it("should flag missing documents when items are omitted", () => {
    const onlyPan: VaultDocument[] = [DEFAULT_SALARIED_VAULT_DOCS[0]];
    const readiness = computeVaultReadiness(onlyPan);
    expect(readiness.uploadedCount).toBe(1);
    expect(readiness.totalCount).toBe(8);
    expect(readiness.percentage).toBe(13); // 1 / 8 = 12.5 rounded to 13
    expect(readiness.missingItems.length).toBe(7);
  });
});
