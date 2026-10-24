// @vitest-environment jsdom
//
// R-1418 (Pawan, staging 12 Oct): "/documents: page freezes after previewing an uploaded image".
//
// The row's ⋯ menu → "View / download" opened the preview dialog FROM a modal Radix menu. Both
// the menu and the dialog trap focus and set `pointer-events: none` on <body>; the two focus traps
// bounced focus between each other until "Maximum call stack size exceeded" — the page froze
// (same family as R-457 on the leads bulk bar). Before the fix the "row menu" case below never
// finishes (the worker hits the stack overflow); after it, both cases pass in under a second.
// Each case opens the image preview, closes it, and checks the page is usable again and the
// preview's object URL was released.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";

import type { DocumentRow } from "@/lib/queries/documents";

const row = {
  id: "doc-1",
  title: "GST certificate",
  category: "gst",
  file_name: "gst.png",
  file_path: "tenant-1/gst.png",
  mime_type: "image/png",
  notes: null,
  expiry_date: null,
} as unknown as DocumentRow;

vi.mock("@/lib/queries/documents", () => ({
  useDocuments: () => ({ data: [row], isLoading: false, error: null, refetch: () => {} }),
  useDeleteDocument: () => ({ mutate: vi.fn(), isPending: false }),
  getDocumentSignedUrl: vi.fn(async () => "https://storage.test/signed/gst.png"),
  DOCUMENT_CATEGORIES: [{ key: "gst", label: "GST" }],
  categoryLabel: () => "GST",
  expiryState: () => "none",
}));
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn().mockResolvedValue(false),
}));
vi.mock("@/components/features/documents/upload-document-dialog", () => ({
  UploadDocumentDialog: () => null,
}));

import DocumentsPage from "./page";

const createObjectURL = vi.fn(() => "blob:preview-1");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })));
  if (typeof globalThis.ResizeObserver === "undefined") {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  document.body.removeAttribute("style");
});

function openRowMenu() {
  const trigger = screen.getByRole("button", { name: "Actions" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

describe("R-1418 — /documents image preview releases the page when closed", () => {
  it("opened from the row menu: after closing, the page takes clicks again and the object URL is revoked", async () => {
    render(<DocumentsPage />);

    openRowMenu();
    const item = await screen.findByRole("menuitem", { name: /View \/ download/ });
    await act(async () => { fireEvent.click(item); });

    // The image preview is showing.
    const img = await screen.findByRole("img", { name: "GST certificate" });
    expect(img.getAttribute("src")).toBe("blob:preview-1");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The page is usable again: nothing left blocking clicks or scrolling.
    await waitFor(() => expect(document.body.style.pointerEvents).not.toBe("none"));
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toContain("blob:preview-1");
  });

  it("opened from the row title: closing releases the page the same way", async () => {
    render(<DocumentsPage />);

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /GST certificate/ })); });
    await screen.findByRole("img", { name: "GST certificate" });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Close" })); });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.body.style.pointerEvents).not.toBe("none");
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(revokeObjectURL.mock.calls.map((c) => c[0])).toContain("blob:preview-1");
  });
});
