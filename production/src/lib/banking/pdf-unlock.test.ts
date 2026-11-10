/* R-2662 — a password-protected statement PDF is opened in the browser with its password and
   only its TEXT goes on to the AI reader. Real encrypted PDFs (RC4, made by the test fixture,
   dummy passwords) opened with the real pdfjs-dist. */
import { describe, expect, it, vi } from "vitest";
import { encryptedPdf } from "@/lib/banking/__fixtures__/encrypted-pdf";
import { isEncryptedPdf } from "./pdf-check";
import { pageLines, pdfTextPages, statementTextBase64, unlockMessage, type PdfjsLike } from "./pdf-unlock";

const nodePdfjs = async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfjsLike;
const DUMMY = "dummy-pass-1";
const statement = encryptedPdf([
  ["Date | Narration | Withdrawal | Deposit | Balance", "01/09/2025 | NEFT CR-DEMO CO | | 5000.00 | 15000.00"],
  ["02/09/2025 | UPI-DEMO SHOP | 250.00 | | 14750.00"],
], DUMMY);

describe("R-2662 pdfTextPages — real encrypted PDF", { timeout: 30_000 }, () => {
  it("the fixture is a locked PDF (the dialog's own check says so)", () => {
    expect(isEncryptedPdf(statement)).toBe(true);
  });

  it("no password → need-password", async () => {
    expect(await pdfTextPages(statement, "", { pdfjs: nodePdfjs })).toEqual({ ok: false, reason: "need-password" });
  });

  it("wrong password → wrong-password (retry possible: bytes are not consumed)", async () => {
    expect(await pdfTextPages(statement, "not-it", { pdfjs: nodePdfjs })).toEqual({ ok: false, reason: "wrong-password" });
    const again = await pdfTextPages(statement, DUMMY, { pdfjs: nodePdfjs });
    expect(again.ok).toBe(true);
  });

  it("right password → each page's lines; an amount stays under its own column heading", async () => {
    const r = await pdfTextPages(statement, DUMMY, { pdfjs: nodePdfjs });
    if (!r.ok) throw new Error(r.reason);
    expect(r.pages).toHaveLength(2);
    const [head, deposit] = r.pages[0].split("\n");
    expect(deposit.replace(/\s+/g, " ")).toBe("01/09/2025 NEFT CR-DEMO CO 5000.00 15000.00");
    // The deposit sits under "Deposit", not under "Withdrawal" (the empty column stays a gap).
    expect(deposit.indexOf("5000.00")).toBe(head.indexOf("Deposit"));
    expect(r.pages[1].indexOf("250.00")).toBe(head.indexOf("Withdrawal"));
  });

  it("garbage bytes → unreadable, never throws", async () => {
    expect(await pdfTextPages(new Uint8Array([1, 2, 3]), "", { pdfjs: nodePdfjs })).toEqual({ ok: false, reason: "unreadable" });
  });

  it("a PDF with no text → no-text", async () => {
    const blank = encryptedPdf([[]], DUMMY);
    expect(await pdfTextPages(blank, DUMMY, { pdfjs: nodePdfjs })).toEqual({ ok: false, reason: "no-text" });
  });

  it("the result and the messages never carry the password", async () => {
    const r = await pdfTextPages(statement, DUMMY, { pdfjs: nodePdfjs });
    expect(JSON.stringify(r)).not.toContain(DUMMY);
    for (const k of ["need-password", "wrong-password", "no-text", "unreadable"] as const) expect(unlockMessage(k)).not.toContain(DUMMY);
  });
});

describe("R-2662 review — the pdfjs loading task is destroyed on every path", () => {
  for (const [name, fail] of [["wrong password", { name: "PasswordException" }], ["unreadable", new Error("bad")]] as const) {
    it(name, async () => {
      const destroy = vi.fn();
      const fake = async () => ({ getDocument: () => ({ promise: Promise.reject(fail), destroy }) }) as unknown as PdfjsLike;
      const r = await pdfTextPages(new Uint8Array([1]), "x", { pdfjs: fake });
      expect(r.ok).toBe(false);
      await new Promise((ok) => setTimeout(ok, 0));
      expect(destroy).toHaveBeenCalledTimes(1);
    });
  }
});

describe("R-2662 pageLines / statementTextBase64", () => {
  const item = (s: string, x: number, y: number, width: number) => ({ str: s, transform: [10, 0, 0, 10, x, y], width });

  it("same baseline joined left to right, top line first; each item at its x column", () => {
    const lines = pageLines([item("B", 220, 700, 10), item("A1", 40, 700, 12), item("A2", 55, 700, 12), item("top", 40, 720, 15)]);
    // x / 4.5 pt: A1 at 9, A2 at 12, B at 49; the common margin of 9 is dropped.
    expect(lines).toEqual(["top", "A1 A2" + " ".repeat(35) + "B"]);
  });

  it("items never run together even when columns are tight", () => {
    expect(pageLines([item("LONGNARRATION", 40, 700, 80), item("100.00", 45, 700, 20)])).toEqual(["LONGNARRATION 100.00"]);
  });

  it("plain mode for the Google bill parser", () => {
    expect(pageLines([item("accesstel.in", 40, 700, 50), item(" ", 90, 700, 200), item("529.20", 300, 700, 20)], "plain")).toEqual(["accesstel.in 529.20"]);
  });

  const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  it("a chunk carries its pages plus the page before and after (row across a break, previous balance)", () => {
    const pages = ["p one", "p two", "p three", "p four"];
    expect(decode(statementTextBase64(pages, { from: 2, to: 3 }))).toBe(
      "=== Page 1 ===\np one\n\n=== Page 2 ===\np two\n\n=== Page 3 ===\np three\n\n=== Page 4 ===\np four");
    expect(decode(statementTextBase64(pages, { from: 1, to: 1 }))).toBe("=== Page 1 ===\np one\n\n=== Page 2 ===\np two");
    expect(decode(statementTextBase64(pages, { from: 4, to: 4 }))).toBe("=== Page 3 ===\np three\n\n=== Page 4 ===\np four");
  });

  it("base64 of the whole text under page markers (UTF-8 safe)", () => {
    expect(decode(statementTextBase64(["p one ₹"]))).toBe("=== Page 1 ===\np one ₹");
  });
});
