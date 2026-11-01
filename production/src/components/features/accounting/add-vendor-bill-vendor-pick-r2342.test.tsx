// @vitest-environment jsdom
//
// R-2342 (Bills → Add Bill): the vendor suggestion list closed 130 ms AFTER the vendor box lost
// focus, and it is drawn over the fields below — so the owner's first click on Category landed on
// a list that was still on screen. The list now closes on a pick, on a pointer-down anywhere outside
// it, and as soon as focus leaves the vendor box — never on a timer.
//
// The clicks below follow a real mouse click's event order (pointerdown → mousedown → focus moves →
// pointerup → mouseup → click); user-event is not installed in this repo.
import { describe, it, expect, vi, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const VENDORS = [
  { id: "v-g", name: "Google Cloud India", gstin: "29AAACG2342A1Z5", default_category: "COGS-Workspace" },
  { id: "v-z", name: "Zoho Corporation", gstin: null, default_category: "COGS-Zoho" },
];
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: VENDORS }), ensureVendor: vi.fn(async () => null) }));
vi.mock("@/lib/queries/vendor-bills", () => ({
  uploadBillAttachment: vi.fn(async () => null),
  useCreateVendorBill: () => ({ mutateAsync: vi.fn() }),
  useOwnStateCode: () => ({ data: "07" }),
  VENDOR_BILL_CATEGORIES: ["COGS-Workspace", "COGS-M365", "COGS-Zoho", "COGS-Other"],
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn(async () => true) }));

import { AddVendorBillDialog } from "@/components/features/accounting/add-vendor-bill-dialog";

Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const vendorBox = () => document.getElementById("vendor_name") as HTMLInputElement;
const categoryTrigger = () => document.getElementById("category") as HTMLElement;
// hidden: true — an open Select marks the rest of the page aria-hidden, the list must still be GONE.
const suggestion = (name: string) => screen.queryByRole("button", { name: new RegExp(name), hidden: true });

/** One real mouse click on `target` while focus sits in `from`. */
function mouseClick(target: HTMLElement, from: HTMLElement) {
  fireEvent.pointerDown(target, { button: 0 });
  fireEvent.mouseDown(target, { button: 0 });
  act(() => { from.blur(); target.focus(); });
  fireEvent.pointerUp(target, { button: 0 });
  fireEvent.mouseUp(target, { button: 0 });
  fireEvent.click(target, { button: 0 });
}

function typeVendor(text: string) {
  const box = vendorBox();
  act(() => { box.focus(); });
  fireEvent.change(box, { target: { value: text } });
}

describe("R-2342 Add Bill — one click on Category after the vendor suggestions", () => {
  it("type vendor → pick a suggestion → ONE click on Category opens it", () => {
    render(<AddVendorBillDialog onClose={() => {}} />);
    typeVendor("Goo");
    const pick = suggestion("Google Cloud India")!;
    expect(pick).toBeTruthy();
    fireEvent.mouseDown(pick);
    fireEvent.click(pick);
    expect(vendorBox().value).toBe("Google Cloud India");
    expect(suggestion("Google Cloud India")).toBeNull();

    mouseClick(categoryTrigger(), vendorBox());
    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(suggestion("Google Cloud India")).toBeNull();
  });

  it("type vendor → click Category straight away (list open) → Category opens AND the list is gone at once", () => {
    render(<AddVendorBillDialog onClose={() => {}} />);
    typeVendor("o");
    expect(suggestion("Zoho Corporation")).toBeTruthy();

    mouseClick(categoryTrigger(), vendorBox());
    // No timer to wait for: the list is gone in the same click, so nothing covers Category.
    expect(suggestion("Zoho Corporation")).toBeNull();
    expect(suggestion("Google Cloud India")).toBeNull();
    expect(screen.getByRole("listbox")).toBeTruthy();
    // The typed name is kept as a new vendor; nothing was picked by the click.
    expect(vendorBox().value).toBe("o");
  });

  it("Tab out of the vendor box closes the list at once (no 130 ms timer)", () => {
    render(<AddVendorBillDialog onClose={() => {}} />);
    typeVendor("Zo");
    expect(suggestion("Zoho Corporation")).toBeTruthy();
    const gstin = document.getElementById("vendor_gstin") as HTMLInputElement;
    act(() => { gstin.focus(); });
    expect(suggestion("Zoho Corporation")).toBeNull();
  });

  it("a click on a suggestion still picks it (focus stays in the box, GSTIN fills)", () => {
    render(<AddVendorBillDialog onClose={() => {}} />);
    typeVendor("Goo");
    const pick = suggestion("Google Cloud India")!;
    fireEvent.pointerDown(pick, { button: 0 });
    fireEvent.mouseDown(pick, { button: 0 });
    fireEvent.click(pick);
    expect(vendorBox().value).toBe("Google Cloud India");
    expect((document.getElementById("vendor_gstin") as HTMLInputElement).value).toBe("29AAACG2342A1Z5");
  });

  it("focus back in the vendor box opens the list again", () => {
    render(<AddVendorBillDialog onClose={() => {}} />);
    typeVendor("Zo");
    mouseClick(categoryTrigger(), vendorBox());
    expect(suggestion("Zoho Corporation")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    act(() => { vendorBox().focus(); });
    expect(suggestion("Zoho Corporation")).toBeTruthy();
  });
});
