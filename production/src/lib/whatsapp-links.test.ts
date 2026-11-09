/**
 * R-2641 (R-2639 follow-up): every WhatsApp link left outside R-2639 goes through lib/phone,
 * so the dialling code comes from the customer's / lead's country — and no file keeps its
 * own "91 in front of 10 digits" rule.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { whatsAppLink } from "./phone";
import { waFrom } from "@/components/features/leads/lead-row-actions";
import { orderDrawerActions, type DrawerActionInput } from "@/app/(app)/online-orders/drawer-actions";
import { invoiceCustomerCountry, openInvoiceWhatsApp } from "@/app/(app)/invoices/invoice-whatsapp";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("whatsAppLink", () => {
  it("India / empty country: a bare 10-digit number gets 91", () => {
    expect(whatsAppLink("98765 43210", "India")).toBe("https://wa.me/919876543210");
    expect(whatsAppLink("9876543210", null)).toBe("https://wa.me/919876543210");
  });
  it("a US customer's number gets 1, not 91", () => {
    expect(whatsAppLink("5551234567", "United States")).toBe("https://wa.me/15551234567");
  });
  it("a number written with its code keeps it", () => {
    expect(whatsAppLink("+44 7911 123456", "India")).toBe("https://wa.me/447911123456");
  });
  it("adds the message as ?text=", () => {
    expect(whatsAppLink("9876543210", "India", "Hi & bye")).toBe("https://wa.me/919876543210?text=Hi%20%26%20bye");
  });
  it("no usable number → null (no blind wa.me link)", () => {
    expect(whatsAppLink("", "India")).toBeNull();
    expect(whatsAppLink(null, "India")).toBeNull();
    expect(whatsAppLink("12345", "India")).toBeNull();
  });
});

describe("lead row waFrom", () => {
  it("uses the helper: India default, country when known", () => {
    expect(waFrom("98765 43210")).toBe("919876543210");
    expect(waFrom("5551234567", "United States")).toBe("15551234567");
  });
  it("an Indian mobile starting with 91 still gets the code (old rule kept it bare)", () => {
    expect(waFrom("9123456789")).toBe("919123456789");
  });
});

describe("online order drawer", () => {
  const base: DrawerActionInput = {
    type: "paid", status: "active", trialDay: null, leadId: "L-1", company: "Acme", plan: null, seats: null,
    contact: { name: "Sam", email: "sam@acme.com", phone: "555 123 4567", country: "United States" },
  };
  it("a US lead's WhatsApp + Call use +1", () => {
    const a = orderDrawerActions(base);
    expect(a.find((x) => x.key === "whatsapp")?.href).toBe("https://wa.me/15551234567");
    expect(a.find((x) => x.key === "call")?.href).toBe("tel:+15551234567");
  });
});

describe("invoice WhatsApp for an old invoice without a saved country", () => {
  it("reads the customer's country from the customer list", () => {
    const inv = { customer_id: "c1" };
    expect(invoiceCustomerCountry(inv, [{ id: "c1", country: "United States" }])).toBe("United States");
    expect(invoiceCustomerCountry({ customer_id: null }, [{ id: "c1", country: "United States" }])).toBeNull();
  });
  it("opens wa.me with the US code", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const ok = openInvoiceWhatsApp({ id: "INV-1", customer_id: "c1", amount: 100 }, "5551234567", null, vi.fn(), "United States");
    expect(ok).toBe(true);
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/wa\.me\/15551234567\?/);
    vi.unstubAllGlobals();
  });
});

describe("no second copy of the +91 rule", () => {
  const root = join(__dirname, "..");
  const files = [
    "app/(app)/customers/page.tsx",
    "app/(app)/referrals/page.tsx",
    "app/(app)/online-orders/drawer-actions.ts",
    "components/features/customers/customer-insights.tsx",
    "components/features/leads/lead-row-actions.tsx",
    "components/features/leads/swipe-lead-card.tsx",
  ];
  it.each(files)("%s builds wa.me numbers only through lib/phone", (f) => {
    const src = readFileSync(join(root, f), "utf8");
    expect(src).not.toMatch(/["'`]91["'`]\s*\+|`91\$\{/);
    expect(src).not.toMatch(/wa\.me\/\$\{[^}]*replace\(/);
  });
  it("invoice pages pass the customer's country", () => {
    const list = readFileSync(join(root, "app/(app)/invoices/page.tsx"), "utf8");
    const detail = readFileSync(join(root, "app/(app)/invoices/invoice-detail.tsx"), "utf8");
    const calls = list.split("\n").filter((l) => l.includes("openInvoiceWhatsApp(") && !l.includes("import"));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const l of calls) expect(l).toMatch(/invoiceCustomerCountry\(/);
    const detailCall = detail.split("\n").find((l) => l.includes("openInvoiceWhatsApp(") && !l.includes("import"));
    expect(detailCall).toMatch(/customer\?\.country\)/);
  });
});
