// @vitest-environment jsdom
/* R-2662 — a password-protected statement PDF: the dialog asks for its password, opens the PDF
   in the browser, and sends only the TEXT to the AI reader. The password never appears in any
   request body, in storage or in the console. Real RC4-locked PDF from the test fixture; the
   password is a made-up dummy; pdfjs is the real one (Node build), the AI route is a mock fetch. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { encryptedPdf } from "@/lib/banking/__fixtures__/encrypted-pdf";

const DUMMY = "dummy-r2662-pass";

vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { role: "owner" } }) }));
vi.mock("@/lib/queries/txn-category-rules", async (orig) => ({
  ...(await orig<object>()),
  useTxnCategoryRules: () => ({ data: [] }),
  useCreateTxnCategoryRule: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/bank", async (orig) => ({
  ...(await orig<object>()),
  useBankAccount: () => ({ data: { id: "acc-1", opening_balance: 0, opening_balance_date: "2025-04-01", account_type: "current" } }),
  useExistingTxnKeys: () => ({ data: { bal: new Map(), prefix: new Map(), prefixNoBal: new Map() } }),
  useHasBankLinesFrom: () => ({ data: false }),
  useBankLinesBetween: () => ({ data: [] }),
  useImportBankTransactions: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateBankAccount: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
/* The real unlock code, with pdfjs's Node build in place of the browser worker set-up. */
vi.mock("@/lib/banking/pdf-unlock", async (orig) => {
  const real = await orig<typeof import("@/lib/banking/pdf-unlock")>();
  const nodePdfjs = async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as import("@/lib/banking/pdf-unlock").PdfjsLike;
  return { ...real, pdfTextPages: (b: Uint8Array, pw = "", o = {}) => real.pdfTextPages(b, pw, { ...o, pdfjs: nodePdfjs }) };
});

import { ImportStatementDialog } from "./import-statement-dialog";

const fetchSpy = vi.fn();
const consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

function pdfFile(bytes: Uint8Array, name = "hdfc-sep.pdf") {
  const f = new File([bytes.slice()], name, { type: "application/pdf" });
  // jsdom's File may lack arrayBuffer — give it the bytes the dialog reads.
  Object.defineProperty(f, "arrayBuffer", { value: async () => bytes.slice().buffer });
  return f;
}
async function upload(file: File) {
  render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
}
const box = () => screen.findByTestId("statement-password-box", {}, { timeout: 5000 });
const pwInput = () => document.getElementById("statement-pdf-password") as HTMLInputElement;
async function typeAndOpen(pw: string) {
  await act(async () => { fireEvent.change(pwInput(), { target: { value: pw } }); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Open PDF" })); });
}
const everythingSent = () => fetchSpy.mock.calls.map((c) => JSON.stringify(c)).join("\n");

const STATEMENT = encryptedPdf([[
  "Date | Narration | Withdrawal | Deposit | Balance",
  "01/09/2025 | NEFT CR-DEMO CO | | 5000.00 | 15000.00",
  "02/09/2025 | UPI-DEMO SHOP | 250.00 | | 14750.00",
]], DUMMY);

beforeEach(() => {
  fetchSpy.mockReset().mockImplementation(async () => new Response(JSON.stringify({
    rows: [
      { txn_date: "2025-09-01", description: "NEFT CR-DEMO CO", debit: 0, credit: 5000, balance_after: 15000, reference: null },
      { txn_date: "2025-09-02", description: "UPI-DEMO SHOP", debit: 250, credit: 0, balance_after: 14750, reference: null },
    ],
    skipped: 0, rowCount: 2, rowsReturned: 2,
  }), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchSpy);
  for (const m of ["log", "warn", "error", "info", "debug"] as const) consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => {}));
  // Any write to local/session storage is caught here (jsdom on this Node has no window.localStorage of its own).
  if (typeof Storage !== "undefined") consoleSpies.push(vi.spyOn(Storage.prototype, "setItem"));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  consoleSpies.splice(0).forEach((s) => s.mockRestore());
});

function expectPasswordNowhere() {
  expect(everythingSent()).not.toContain(DUMMY);
  // console.* and Storage.setItem: no call ever carried it.
  for (const s of consoleSpies) expect(JSON.stringify(s.mock.calls)).not.toContain(DUMMY);
  expect(document.body.innerHTML).not.toContain(DUMMY);
}

describe("R-2662 import dialog — password-protected statement PDF", { timeout: 30_000 }, () => {
  it("asks for the password instead of refusing; nothing is sent before it is opened", async () => {
    await upload(pdfFile(STATEMENT));
    expect((await box()).textContent).toMatch(/locked with a password/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wrong password → plain message, box stays, input cleared, nothing sent", async () => {
    await upload(pdfFile(STATEMENT));
    await box();
    await typeAndOpen("not-the-password");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/did not open the PDF/), { timeout: 5000 });
    expect(pwInput().value).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("right password → the TEXT goes to the AI reader (never the password), preview fills", async () => {
    await upload(pdfFile(STATEMENT));
    await box();
    await typeAndOpen(DUMMY);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled(), { timeout: 5000 });
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/extract-statement");
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["fileBase64", "mimeType"]);
    expect(body.mimeType).toBe("text/plain");
    const text = Buffer.from(body.fileBase64, "base64").toString("utf8");
    expect(text).toContain("=== Page 1 ===");
    expect(text.replace(/\s+/g, " ")).toContain("01/09/2025 NEFT CR-DEMO CO 5000.00 15000.00");
    await waitFor(() => expect(screen.getByText(/Parse summary/)).toBeTruthy(), { timeout: 5000 });
    expect(screen.queryByTestId("statement-password-box")).toBeNull();
    expectPasswordNowhere();
  });

  it("wrong then right: retry works, and neither password is in any request or log", async () => {
    await upload(pdfFile(STATEMENT));
    await box();
    await typeAndOpen("dummy-wrong-first");
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy(), { timeout: 5000 });
    await typeAndOpen(DUMMY);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled(), { timeout: 5000 });
    expectPasswordNowhere();
    expect(everythingSent()).not.toContain("dummy-wrong-first");
  });

  it("review: a locked file clears the last preview — it can never be imported under the locked file's name", async () => {
    render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
    const paste = document.getElementById("import-statement-or-paste-csv-text") as HTMLTextAreaElement;
    await act(async () => { fireEvent.change(paste, { target: { value: "Date,Narration,Withdrawal Amt.,Deposit Amt.\n09/09/2025,OLD CSV LINE,,5000.00" } }); });
    expect(screen.getByText(/Parse summary/)).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [pdfFile(STATEMENT)] } }); });
    await box();
    expect(screen.queryByText(/Parse summary/)).toBeNull();
  });

  it("review: closing the dialog while the PDF opens — its text is never sent", async () => {
    const view = render(<ImportStatementDialog open onOpenChange={() => {}} accountId="acc-1" />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { files: [pdfFile(STATEMENT)] } }); });
    await box();
    await act(async () => { fireEvent.change(pwInput(), { target: { value: DUMMY } }); });
    act(() => { fireEvent.click(screen.getByRole("button", { name: "Open PDF" })); });
    view.rerender(<ImportStatementDialog open={false} onOpenChange={() => {}} accountId="acc-1" />);
    await new Promise((ok) => setTimeout(ok, 1500));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Cancel closes the box and the file picker is back", async () => {
    await upload(pdfFile(STATEMENT));
    await box();
    const cancel = (await box()).querySelector("button[type=button]:last-of-type") as HTMLButtonElement;
    expect(cancel.textContent).toBe("Cancel");
    await act(async () => { fireEvent.click(cancel); });
    expect(screen.queryByTestId("statement-password-box")).toBeNull();
    expect(screen.getByText(/Choose file/)).toBeTruthy();
  });
});
