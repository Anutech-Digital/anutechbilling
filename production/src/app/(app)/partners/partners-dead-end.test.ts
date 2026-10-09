/**
 * R-472 — no dead ends on Partners / Referrals (CLAUDE.md §24).
 * Partners told every plain reseller to change a "DB-only setting" that has no screen, with no
 * button; Referrals had no way to add a partner from its own page.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(process.cwd(), "src", "app", "(app)");
const partners = readFileSync(join(APP, "partners", "page.tsx"), "utf8");
const referrals = readFileSync(join(APP, "referrals", "page.tsx"), "utf8");

describe("/partners for a non-distributor", () => {
  it("no longer points to a setting that does not exist", () => {
    expect(partners).not.toMatch(/DB-only setting/);
    expect(partners).not.toMatch(/Reseller tier \(currently/);
  });
  it("explains and offers a next step with a button", () => {
    expect(partners).toMatch(/title="Partners is for distributors"/);
    expect(partners).toMatch(/action=\{<Button[^}]*><Link href="\/referrals">Open Referrals<\/Link>/);
  });
  it("sits under Sales, not Settings", () => {
    expect(partners).toMatch(/font-semibold mb-1">Sales<\/p>/);
  });
});

describe("/referrals", () => {
  it("has an Add partner button in the header and in the empty Partners tab", () => {
    expect((referrals.match(/setAddPartnerOpen\(true\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(referrals).toMatch(/<AddPartnerDialog open=\{addPartnerOpen\}/);
  });
  it("every empty state carries an action", () => {
    const empties = referrals.match(/<EmptyState[\s\S]*?\/>/g) ?? [];
    expect(empties.length).toBeGreaterThanOrEqual(2);
    for (const e of empties) expect(e).toMatch(/action=/);
  });
});

describe("Add referral / Add partner forms", () => {
  const dir = join(process.cwd(), "src", "components", "features", "referrals");
  const addReferral = readFileSync(join(dir, "add-referral-dialog.tsx"), "utf8");
  const addPartner = readFileSync(join(dir, "add-partner-dialog.tsx"), "utf8");
  it("check PAN before saving", () => {
    for (const src of [addReferral, addPartner]) expect(src).toMatch(/panProblem\(/);
  });
  it("commission % starts empty (10 is only the placeholder)", () => {
    expect(addReferral).toMatch(/const \[percent, setPercent\] = React\.useState\(""\)/);
    expect(addReferral).not.toMatch(/setPercent\("10"\)/);
    expect(addPartner).toMatch(/const \[percent, setPercent\] = React\.useState\(""\)/);
  });
});
