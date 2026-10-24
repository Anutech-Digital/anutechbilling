import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chaseSignature, tdsChaseMessage } from "./tds-detail-dialog";

/* R-1733: the TDS chase WhatsApp was signed "— Pardeep" from every user's account. It is now
   signed by the signed-in person and their company. */
describe("R-1733 TDS chase WhatsApp signature", () => {
  const tds = { status: "pending_cert", customer_name: "Thetaco Dentals", tds_amount: 2550, section: "194J", rate_pct: 10, fiscal_year: "2025-26" };

  it("signs with the signed-in person and company, never a hard-coded name", () => {
    const msg = tdsChaseMessage(tds, chaseSignature({ fullName: "Hitesh Kumar", tenantName: "Anutech Digital" }));
    expect(msg).toMatch(/— Hitesh Kumar, Anutech Digital$/);
    expect(msg).not.toMatch(/Pardeep/);
    expect(msg).toMatch(/Form 16A/);
  });

  it("falls back to whichever name is known, and to no sign-off at all", () => {
    expect(chaseSignature({ fullName: null, tenantName: "Anutech Digital" })).toBe("Anutech Digital");
    expect(chaseSignature({ fullName: "Hitesh", tenantName: "Workspace" })).toBe("Hitesh");
    expect(tdsChaseMessage({ ...tds, status: "disputed" }, chaseSignature(null))).toMatch(/Thank you$/);
  });

  it("the dialog source has no hard-coded sender name", () => {
    const src = readFileSync("src/components/features/accounting/tds-detail-dialog.tsx", "utf8");
    expect(src).not.toMatch(/— Pardeep/);
  });
});
