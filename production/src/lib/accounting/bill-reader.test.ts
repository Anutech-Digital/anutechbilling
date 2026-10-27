// @vitest-environment jsdom
/* R-2005 — the one bill reader behind every "Upload bill" (Add COGS Bill, Add expense, and the
   bank Reconcile "bill not in the books yet"). Same route, same 8 MB / type check, same error
   words with a "fill by hand" way out, same buyer check. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BILL_MAX_BYTES, checkBillFile, readBillFile } from "./bill-reader";

const file = (type = "application/pdf", size = 1000, name = "bill.pdf") => {
  const f = new File(["%PDF-1.4 bill"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};
const answer = (status: number, body: unknown) =>
  vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response);

afterEach(() => vi.restoreAllMocks());

describe("R-2005 checkBillFile", () => {
  it("refuses a file over 8 MB, with a way out by hand", () => {
    expect(BILL_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(checkBillFile(file("application/pdf", BILL_MAX_BYTES + 1))).toBe("File is too big (max 8 MB) — try a smaller photo, or fill the fields by hand.");
    expect(checkBillFile(file("application/pdf", BILL_MAX_BYTES))).toBeNull();
  });
  it("refuses what the reader cannot read; takes PDF and photos", () => {
    expect(checkBillFile(file("text/plain"))).toBe("Drop a PDF or a photo (JPG/PNG) of the bill.");
    expect(checkBillFile(file("image/gif"))).toBe("Drop a PDF or a photo (JPG/PNG) of the bill.");
    for (const t of ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic"]) expect(checkBillFile(file(t))).toBeNull();
  });
});

describe("R-2005 readBillFile", () => {
  it("posts the file to /api/ai/extract-bill and returns the fields, the buyer check and the resale product", async () => {
    const buyer = { buyer_name: "Other Pvt Ltd", buyer_gstin: null, own_name: "Our Company" };
    const f = answer(200, { fields: { vendor_name: "Bansal Print House", bill_no: "BPH-77", category_guess: "COGS-Workspace", buyer_mismatch: buyer } });
    const out = await readBillFile(file(), f);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/ai/extract-bill");
    const body = JSON.parse(String(init?.body));
    expect(body.mimeType).toBe("application/pdf");
    expect(body.fileBase64).toBe(btoa("%PDF-1.4 bill"));
    expect(out).toEqual({
      ok: true,
      read: {
        fields: expect.objectContaining({ vendor_name: "Bansal Print House", bill_no: "BPH-77" }),
        buyer,
        resale: "Google Workspace",
      },
    });
  });

  it("a bill for our own company has no buyer warning; a non-resale bill has no resale product", async () => {
    const out = await readBillFile(file(), answer(200, { fields: { bill_no: "X1", category_guess: "COGS-Other", buyer_mismatch: null } }));
    expect(out).toMatchObject({ ok: true, read: { buyer: null, resale: null } });
  });

  it("too big / wrong type → the error, and the reader is never called", async () => {
    const f = answer(200, {});
    expect(await readBillFile(file("application/pdf", BILL_MAX_BYTES + 1), f)).toEqual({ ok: false, error: expect.stringMatching(/max 8 MB.*by hand/) });
    expect(await readBillFile(file("text/plain"), f)).toEqual({ ok: false, error: "Drop a PDF or a photo (JPG/PNG) of the bill." });
    expect(f).not.toHaveBeenCalled();
  });

  it("no AI key for the company → says so plainly; the bill can still be filled by hand", async () => {
    const out = await readBillFile(file(), answer(400, { error: "x", code: "ai_not_configured" }));
    expect(out).toEqual({ ok: false, error: expect.stringMatching(/^AI bill reading is not set up for your company .*Fill the form by hand/) });
  });

  it("the route's own error is shown; with none, a plain 'fill by hand' line", async () => {
    expect(await readBillFile(file(), answer(422, { error: "This PDF has no pages." }))).toEqual({ ok: false, error: "This PDF has no pages." });
    expect(await readBillFile(file(), answer(500, {}))).toEqual({ ok: false, error: "Couldn't read the bill — fill the fields by hand. The bill will still be attached." });
  });

  it("network failure → 'try again, or fill the fields by hand'", async () => {
    const f = vi.fn(async () => { throw new Error("offline"); });
    expect(await readBillFile(file(), f as unknown as typeof fetch)).toEqual({ ok: false, error: "Upload failed — try again, or fill the fields by hand." });
  });
});
