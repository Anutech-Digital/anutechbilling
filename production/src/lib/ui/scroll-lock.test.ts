/**
 * The counted page-scroll lock (3 Oct 2026): /done arrived unscrollable after a payment because two
 * "save and restore" locks (our progress card, then Razorpay) restored each other's "hidden".
 */
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lockPageScroll, settlePageScroll, pageScrollHolders } from "./scroll-lock";

beforeEach(() => {
  expect(pageScrollHolders()).toBe(0); // every test releases what it takes
  document.body.style.overflow = "";
});

describe("lockPageScroll", () => {
  it("locks while any holder is open and unlocks when the last one closes, in any order", () => {
    const a = lockPageScroll();
    const b = lockPageScroll();
    expect(document.body.style.overflow).toBe("hidden");
    a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });

  it("a release called twice counts once", () => {
    const a = lockPageScroll();
    const b = lockPageScroll();
    a(); a();
    expect(document.body.style.overflow).toBe("hidden");
    b();
    expect(document.body.style.overflow).toBe("");
  });

  it("THE BUG: something outside (Razorpay) restores 'hidden' after we let go — settle puts it right", () => {
    const card = lockPageScroll();
    const razorpaySaved = document.body.style.overflow; // Razorpay opens: saves "hidden"
    card();                                              // our card closes
    document.body.style.overflow = razorpaySaved;        // Razorpay closes: restores "hidden"
    expect(document.body.style.overflow).toBe("hidden");
    settlePageScroll();
    expect(document.body.style.overflow).toBe("");
  });

  it("settle keeps the page locked while one of our pop-ups is still open", () => {
    const notice = lockPageScroll();
    document.body.style.overflow = "";
    settlePageScroll();
    expect(document.body.style.overflow).toBe("hidden");
    notice();
  });
});

describe("the callers", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("no pop-up saves and restores body overflow itself any more", () => {
    for (const p of ["src/components/ui/busy-panel.tsx", "src/site/components/cart/CheckoutNotice.tsx"]) {
      expect(read(p), p).toContain("lockPageScroll");
      expect(read(p), p).not.toMatch(/const overflow = document\.body\.style\.overflow/);
    }
  });
  it("the checkout settles after Razorpay closes, and /done settles on arrival", () => {
    expect(read("src/app/(marketing)/checkout/page.tsx")).toMatch(/ondismiss:[^\n]*afterRazorpay\(\)/);
    expect(read("src/app/(marketing)/done/page.tsx")).toContain("settlePageScroll()");
  });
});
