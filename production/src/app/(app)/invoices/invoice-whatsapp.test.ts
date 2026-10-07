// R-245: invoice WhatsApp reminders went out with no recipient (list) or blind (no phone).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }));

import { invoiceCustomerPhone, openInvoiceWhatsApp } from "./invoice-whatsapp";

const inv = { id: "INV-ADPL-2026-27-0001", amount: 11_800, due_date: "2026-08-25", customer_id: "c1" };

describe("invoiceCustomerPhone", () => {
  it("finds the invoice's customer phone in the cached list", () => {
    expect(invoiceCustomerPhone(inv, [{ id: "c2", contact_phone: "1" }, { id: "c1", contact_phone: "9876543210" }])).toBe("9876543210");
  });
  it("is null with no customer, no list, or no phone", () => {
    expect(invoiceCustomerPhone({ customer_id: null }, [{ id: "c1", contact_phone: "9876543210" }])).toBeNull();
    expect(invoiceCustomerPhone(inv, undefined)).toBeNull();
    expect(invoiceCustomerPhone(inv, [{ id: "c1", contact_phone: null }])).toBeNull();
  });
});

describe("openInvoiceWhatsApp", () => {
  const open = vi.fn();
  beforeEach(() => {
    toastError.mockReset();
    open.mockReset();
    vi.stubGlobal("window", { open });
  });

  it("opens the chat with the customer's number", () => {
    expect(openInvoiceWhatsApp(inv, "98765 43210", null, vi.fn())).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
  });

  it("does NOT open WhatsApp without a phone — toast with 'Add phone' to the customer edit page", () => {
    const goTo = vi.fn();
    expect(openInvoiceWhatsApp(inv, null, null, goTo)).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledOnce();
    const opts = toastError.mock.calls[0][1] as { action?: { label: string; onClick: () => void } };
    expect(opts.action?.label).toBe("Add phone");
    opts.action?.onClick();
    expect(goTo).toHaveBeenCalledWith("/customers/c1/edit");
  });
});

describe("no invoice screen builds a reminder link without the customer's phone", () => {
  for (const f of ["page.tsx", "invoice-detail.tsx"]) {
    it(f, () => {
      const src = readFileSync(join(process.cwd(), "src/app/(app)/invoices", f), "utf8");
      expect(src).not.toMatch(/getInvoiceWhatsAppUrl\(/);
      expect(src).not.toMatch(/openInvoiceWhatsApp\([^,]+,\s*null/);
      expect(src).toMatch(/openInvoiceWhatsApp\(/);
    });
  }
});
