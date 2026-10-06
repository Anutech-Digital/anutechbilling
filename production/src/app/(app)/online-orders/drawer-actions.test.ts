import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { orderDrawerActions, type DrawerActionInput } from "./drawer-actions";

const base: DrawerActionInput = {
  type: "paid",
  status: "active",
  trialDay: null,
  leadId: "L-42",
  company: "Acme Pvt Ltd",
  plan: "Business Starter",
  seats: 5,
  contact: { name: "Ravi", email: "ravi@acme.in", phone: "98765 43210" },
};

const keys = (i: DrawerActionInput) => orderDrawerActions(i).map((a) => a.key);
const find = (i: DrawerActionInput, k: string) => orderDrawerActions(i).find((a) => a.key === k);

describe("R-236 order drawer actions do real work", () => {
  it("WhatsApp, Call and Email are real links to the contact", () => {
    expect(find(base, "whatsapp")?.href).toBe("https://wa.me/919876543210");
    expect(find(base, "call")?.href).toBe("tel:+919876543210");
    expect(find(base, "email")?.href).toBe("mailto:ravi@acme.in");
  });

  it("hides contact buttons when the contact is missing (no dead button)", () => {
    const k = keys({ ...base, contact: { name: "—", email: "—", phone: "—" } });
    expect(k).not.toContain("whatsapp");
    expect(k).not.toContain("call");
    expect(k).not.toContain("email");
  });

  it("a short phone is not dialled", () => {
    expect(keys({ ...base, contact: { ...base.contact, phone: "12345" } })).not.toContain("call");
  });

  it("buttons with no backend are gone: retry, DNS guide, escalate, winback", () => {
    for (const status of ["provisioning", "dns-pending", "issue", "active"] as const) {
      const k = keys({ ...base, status });
      expect(k).not.toContain("retry");
      expect(k).not.toContain("dns-guide");
      expect(k).not.toContain("escalate");
    }
    expect(keys({ ...base, type: "trial", status: "trial-expired" })).not.toContain("winback");
  });

  it("convert quote opens the quote builder for this lead", () => {
    const a = find({ ...base, type: "trial", status: "trial-active", trialDay: 9 }, "convert-quote");
    expect(a?.kind).toBe("link");
    const url = new URL(a!.href!, "https://x.test");
    expect(url.pathname).toBe("/quotes/new");
    expect(url.searchParams.get("leadId")).toBe("L-42");
    expect(url.searchParams.get("company")).toBe("Acme Pvt Ltd");
    expect(url.searchParams.get("seats")).toBe("5");
    expect(url.searchParams.get("email")).toBe("ravi@acme.in");
  });

  it("early trial gets Log call (opens the call-log popup), not a fake toast", () => {
    const a = find({ ...base, type: "trial", status: "trial-active", trialDay: 3 }, "log-call");
    expect(a?.kind).toBe("call-log");
    expect(keys({ ...base, type: "trial", status: "trial-active", trialDay: 3 })).not.toContain("convert-quote");
  });

  it("Admin console is a real external link", () => {
    const a = find(base, "admin-console");
    expect(a?.kind).toBe("external");
    expect(a?.href).toBe("https://admin.google.com");
  });

  it("every action has a link or opens the call-log popup", () => {
    for (const i of [base, { ...base, type: "trial" as const, status: "trial-active" as const, trialDay: 2 }]) {
      for (const a of orderDrawerActions(i)) {
        expect(a.kind === "call-log" || Boolean(a.href)).toBe(true);
      }
    }
  });
});

describe("R-236 page source", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");
  it("drawer fits a phone (no fixed 520px width)", () => {
    expect(src).not.toMatch(/className="w-\[520px\]/);
    expect(src).toMatch(/w-full sm:max-w-\[520px\]/);
  });
  it("no success/info toast stands in for an action", () => {
    expect(src).not.toMatch(/toast\.(success|info)\(/);
  });
});
