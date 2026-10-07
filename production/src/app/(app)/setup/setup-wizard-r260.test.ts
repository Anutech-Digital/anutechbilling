// R-260 — setup wizard: Skip finishes setup, Done statuses from real data,
// no false claims, phone (375px) single column.
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { buildDoneChecklist, NEXT_STEPS, type DoneInputs } from "./done-checklist";
import { paymentDetailsPatch, paymentDetailsProblem } from "./payment-details";
import { DONE_STEP, wizardMove } from "./wizard-nav";

// page.tsx + done-screen.tsx: the wizard and its Done screen
const page = ["page.tsx", "done-screen.tsx"].map((f) => fs.readFileSync(path.join(__dirname, f), "utf8")).join("\n");

describe("R-260 wizard moves", () => {
  it("Skip / Continue on the last content step finishes setup", () => {
    expect(wizardMove(3)).toBe("finish");
    expect(wizardMove(3, DONE_STEP)).toBe("finish");
  });
  it("leaving step 1 forward always saves the company", () => {
    expect(wizardMove(0)).toBe("save-company");
    expect(wizardMove(0, 1)).toBe("save-company");
  });
  it("middle steps just advance", () => {
    expect(wizardMove(1)).toBe("advance");
    expect(wizardMove(2)).toBe("advance");
  });
  it("page wires Skip through the same move as Continue (no bare setStep skip)", () => {
    expect(page).toMatch(/const skip = \(\) => goTo\(step \+ 1\)/);
    expect(page).not.toMatch(/const skip = \(\) => setStep/);
  });
});

const empty: DoneInputs = {
  gstin: null, gstinVerifiedAt: null, stateCode: null, upiVpa: null, remitAccountNumber: null,
  customerCount: 0, catalogCount: 0,
  razorpay: { configured: false, readiness: { state: "not_configured" } },
  whatsapp: { configured: false },
  googleReseller: { connected: false },
};
const byId = (inp: DoneInputs) => Object.fromEntries(buildDoneChecklist(inp).map((i) => [i.id, i]));

describe("R-260 Done checklist is data-backed", () => {
  it("connected integrations show done (they were hard-coded todo/pending)", () => {
    const r = byId({
      ...empty,
      razorpay: { configured: true, readiness: { state: "ready" } },
      whatsapp: { configured: true },
      googleReseller: { connected: true },
    });
    expect(r.razorpay.status).toBe("done");
    expect(r.whatsapp.status).toBe("done");
    expect(r.google.status).toBe("done");
  });

  it("nothing connected → todo with a link, never 'pending approval'", () => {
    const r = byId(empty);
    expect(r.razorpay.status).toBe("todo");
    expect(r.google.status).toBe("todo");
    expect(r.whatsapp.status).toBe("todo");
    for (const it of buildDoneChecklist(empty)) {
      if (it.status !== "done") expect(it.href).toBeTruthy();
      expect(`${it.label} ${it.note ?? ""}`).not.toMatch(/5.7 days|approval/i);
    }
  });

  it("Razorpay keys without webhook secret is 'pending', not done", () => {
    expect(byId({ ...empty, razorpay: { configured: true, readiness: { state: "collect_only" } } }).razorpay.status).toBe("pending");
  });

  it("loading → checking; failed GET → unknown (no guess)", () => {
    const loading = byId({ ...empty, razorpay: undefined, whatsapp: undefined, googleReseller: undefined, customerCount: undefined, catalogCount: undefined });
    expect([loading.razorpay.status, loading.whatsapp.status, loading.google.status, loading.customers.status, loading.catalog.status])
      .toEqual(["checking", "checking", "checking", "checking", "checking"]);
    const failed = byId({ ...empty, razorpay: null, whatsapp: null });
    expect(failed.razorpay.status).toBe("unknown");
    expect(failed.whatsapp.status).toBe("unknown");
  });

  it("Google probe codes give the actionable note", () => {
    expect(byId({ ...empty, googleReseller: { connected: false, code: "api_disabled" } }).google.note).toMatch(/Enable the Reseller API/);
  });

  it("tenant fields drive GSTIN / state / payment / customers / catalog", () => {
    const r = byId({
      ...empty, gstin: "07ABDCA0298H1ZP", gstinVerifiedAt: "2026-10-01T00:00:00Z", stateCode: "07",
      upiVpa: "shop@okhdfcbank", customerCount: 3, catalogCount: 7,
    });
    expect([r.gstin.status, r.invoice.status, r.payout.status, r.customers.status, r.catalog.status])
      .toEqual(["done", "done", "done", "done", "done"]);
    expect(r.customers.label).toBe("3 customers added");
    expect(byId({ ...empty, gstin: "07ABDCA0298H1ZP" }).gstin.status).toBe("pending");
  });

  it("Done screen no longer hard-codes statuses", () => {
    expect(page).not.toMatch(/status:\s*"(todo|pending|done)"/);
    expect(page).toMatch(/buildDoneChecklist\(/);
  });

  it("next steps are links to real pages", () => {
    for (const s of NEXT_STEPS) expect(s.href.startsWith("/")).toBe(true);
    expect(page).not.toMatch(/type="checkbox"/);
  });
});

describe("R-260 no false claims", () => {
  it("drops 'auto-verify GSTIN', '#1 gateway', CSP approval, compliance claims", () => {
    expect(page).not.toMatch(/auto-verify/i);
    expect(page).not.toMatch(/#1/);
    expect(page).not.toMatch(/5–7 (business )?days/);
    expect(page).not.toMatch(/DPDP|ISO 27001/);
  });
});

describe("R-260 phone 375px", () => {
  it("every 2-column grid collapses to 1 column below sm", () => {
    const bare = page.match(/className="[^"]*(?<!sm:|md:|lg:)grid-cols-2[^"]*"/g) ?? [];
    expect(bare).toEqual([]);
    expect(page).not.toMatch(/(?<!sm:)col-span-2/);
  });
});

describe("R-260 optional UPI / bank on step 1", () => {
  const blank = { upiVpa: "", bankName: "", accountName: "", accountNumber: "", ifsc: "" };
  it("blank is fine and saves nulls", () => {
    expect(paymentDetailsProblem(blank)).toBeNull();
    expect(paymentDetailsPatch(blank)).toEqual({
      upi_vpa: null, remit_bank_name: null, remit_account_name: null, remit_account_number: null, remit_ifsc: null,
    });
  });
  it("bad UPI ID / IFSC are refused; account number needs IFSC", () => {
    expect(paymentDetailsProblem({ ...blank, upiVpa: "not-a-upi" })).toMatch(/UPI/);
    expect(paymentDetailsProblem({ ...blank, ifsc: "HDFC1234" })).toMatch(/IFSC/);
    expect(paymentDetailsProblem({ ...blank, accountNumber: "1234567890" })).toMatch(/IFSC/);
    expect(paymentDetailsProblem({ ...blank, upiVpa: "shop@okhdfcbank", accountNumber: "1234567890", ifsc: "hdfc0001234" })).toBeNull();
  });
  it("IFSC saves upper-case", () => {
    expect(paymentDetailsPatch({ ...blank, ifsc: "hdfc0001234" }).remit_ifsc).toBe("HDFC0001234");
  });
});
