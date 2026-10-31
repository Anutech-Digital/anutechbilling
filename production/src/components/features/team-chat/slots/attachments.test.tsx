// @vitest-environment jsdom
/**
 * R-2301 (G-TEAMCHAT TC-08) — attach files in the Team chat composer, through the R-2299 slot
 * API, with the real Composer: pick / drag / paste (at most 5 per message), "Uploading…" holds
 * Send, a chip can be removed before sending, a refused file says why (same words as the upload
 * route, chat-files.ts), a photo shows a small preview, and under a sent message each file shows
 * its name + size and opens through a FRESH 5-minute signed link.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ChatAttachmentInput, ChatMessage } from "@/lib/team-chat/types";
import { CHAT_FILE_MAX_BYTES, CHAT_FILE_TOO_LARGE, CHAT_FILE_TYPE_REFUSED } from "@/app/api/team-chat/upload/chat-files";

const mutate = vi.fn();
const upload = vi.fn<(v: { channelId: string; file: File }) => Promise<ChatAttachmentInput>>();
vi.mock("@/lib/queries/team-chat", () => ({
  usePostChatMessage: () => ({ mutate, isPending: false }),
  useUploadChatFile: () => ({ mutateAsync: upload }),
}));
const createSignedUrl = vi.fn(async (path: string, _sec: number) => ({ data: { signedUrl: `/signed/${path}?t=${Math.random()}` }, error: null }));
const from = vi.fn((_bucket: string) => ({ createSignedUrl }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ storage: { from } }) }));

import { Composer } from "../composer";
import { attachmentsExtension } from "./attachments";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ext = attachmentsExtension!;
const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;
const sendBtn = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

const PDF = () => new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
const PNG = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const pdf = (name = "invoice.pdf") => new File([PDF()], name, { type: "application/pdf" });
const png = (name = "photo.png") => new File([PNG()], name, { type: "image/png" });

/** Uploads that finish only when the test says so. */
function controlledUploads() {
  const done: Array<() => void> = [];
  upload.mockImplementation(({ file }) =>
    new Promise((resolve) => {
      done.push(() => resolve({ path: `t/chat/${CH}/u_${file.name}`, name: file.name, mime: file.type, size: file.size }));
    }),
  );
  return {
    finishAll: async () => {
      await act(async () => { done.splice(0).forEach((f) => f()); });
    },
  };
}

const renderComposer = () =>
  render(<Composer channelId={CH} channelLabel="#general" myUserId="me" members={[]} teammates={[]} extensions={[ext]} />);

const fileInput = () => document.querySelector('input[type="file"]') as HTMLInputElement;
const pick = (files: File[]) => fireEvent.change(fileInput(), { target: { files } });

beforeEach(() => {
  mutate.mockReset();
  upload.mockReset();
  createSignedUrl.mockClear();
  from.mockClear();
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn((b: Blob) => `blob:${(b as File).name}`);
  (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn();
});
afterEach(cleanup);

describe("R-2301 composer — attach files", () => {
  it("is a real extension with the parts the composer and message list draw", () => {
    expect(ext).not.toBeNull();
    expect(ext.id).toBe("attachments");
    expect(ext.Toolbar && ext.AboveInput && ext.MessageBelow && ext.onFiles).toBeTruthy();
  });

  it("pick 2 files: uploading holds Send, then both are sent with the message", async () => {
    const up = controlledUploads();
    renderComposer();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    pick([pdf(), png()]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls[0][0]).toMatchObject({ channelId: CH });
    expect(screen.getByText("Uploading 2 files…")).toBeTruthy();
    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    fireEvent.change(box(), { target: { value: "see these" } });
    expect(sendBtn().disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mutate).not.toHaveBeenCalled();

    await up.finishAll();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    expect(screen.queryByText("Uploading 2 files…")).toBeNull();
    expect(screen.queryAllByRole("progressbar")).toHaveLength(0);
    fireEvent.click(sendBtn());
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0].attachments).toEqual([
      { path: `t/chat/${CH}/u_invoice.pdf`, name: "invoice.pdf", mime: "application/pdf", size: PDF().length },
      { path: `t/chat/${CH}/u_photo.png`, name: "photo.png", mime: "image/png", size: PNG().length },
    ]);
    // the bar is empty again after sending
    await waitFor(() => expect(screen.queryByText("invoice.pdf")).toBeNull());
  });

  it("a file alone (no text) can be sent", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([pdf()]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await up.finishAll();
    await waitFor(() => expect(sendBtn().disabled).toBe(false));
    fireEvent.click(sendBtn());
    expect(mutate.mock.calls[0][0]).toMatchObject({ body: "", attachments: [{ name: "invoice.pdf" }] });
  });

  it("drag files onto the box uploads them", async () => {
    controlledUploads();
    renderComposer();
    fireEvent.drop(box(), { dataTransfer: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    expect(upload.mock.calls.map((c) => c[0].file.name)).toEqual(["a.pdf", "b.pdf"]);
  });

  it("paste a screenshot into the box uploads it", async () => {
    controlledUploads();
    renderComposer();
    fireEvent.paste(box(), { clipboardData: { files: [png("Screenshot.png")] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0].file.name).toBe("Screenshot.png");
  });

  it("at most 5 files per message — the 6th says why and is not uploaded", async () => {
    controlledUploads();
    renderComposer();
    pick([1, 2, 3, 4, 5, 6].map((n) => pdf(`f${n}.pdf`)));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
    expect(upload.mock.calls.map((c) => c[0].file.name)).not.toContain("f6.pdf");
    const chip = screen.getByText("f6.pdf").closest("li")!;
    expect(within(chip).getByText(/up to 5 files/i)).toBeTruthy();
  });

  it("the 5-file cap counts files already attached", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([1, 2, 3, 4].map((n) => pdf(`f${n}.pdf`)));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(4));
    await up.finishAll();
    fireEvent.drop(box(), { dataTransfer: { files: [pdf("f5.pdf"), pdf("f6.pdf")] } });
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
    expect(within(screen.getByText("f6.pdf").closest("li")!).getByText(/up to 5 files/i)).toBeTruthy();
  });

  it("remove a chip before sending — that file is not sent", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([pdf("keep.pdf"), pdf("drop.pdf")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await up.finishAll();
    fireEvent.click(screen.getByRole("button", { name: "Remove drop.pdf" }));
    expect(screen.queryByText("drop.pdf")).toBeNull();
    fireEvent.click(sendBtn());
    expect(mutate.mock.calls[0][0].attachments.map((a: ChatAttachmentInput) => a.name)).toEqual(["keep.pdf"]);
  });

  it("removing a file still uploading releases Send and drops it when it lands", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([pdf("slow.pdf")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Remove slow.pdf" }));
    expect(screen.queryByText(/Uploading/)).toBeNull();
    await up.finishAll();
    fireEvent.change(box(), { target: { value: "hi" } });
    fireEvent.click(sendBtn());
    expect(mutate.mock.calls[0][0].attachments).toEqual([]);
  });

  it("a file over 10 MB and a refused type each say why, per file; the good one still uploads", async () => {
    controlledUploads();
    renderComposer();
    const big = new File([new Uint8Array(CHAT_FILE_MAX_BYTES + 1)], "huge.pdf", { type: "application/pdf" });
    const exe = new File([new Uint8Array([0x4d, 0x5a, 1, 2])], "setup.exe", { type: "application/x-msdownload" });
    pick([big, exe, pdf("ok.pdf")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    expect(upload.mock.calls[0][0].file.name).toBe("ok.pdf");
    await waitFor(() => expect(within(screen.getByText("huge.pdf").closest("li")!).getByText(CHAT_FILE_TOO_LARGE)).toBeTruthy());
    expect(within(screen.getByText("setup.exe").closest("li")!).getByText(CHAT_FILE_TYPE_REFUSED)).toBeTruthy();
  });

  it("a file whose bytes are not its type is refused before upload", async () => {
    controlledUploads();
    renderComposer();
    pick([new File([new TextEncoder().encode("hello")], "fake.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(screen.getByText(/not really a PDF/)).toBeTruthy());
    expect(upload).not.toHaveBeenCalled();
  });

  it("an upload the server refuses shows on that file and does not hold Send", async () => {
    upload.mockRejectedValue(new Error("You are not a member of this conversation."));
    renderComposer();
    pick([pdf("x.pdf")]);
    await waitFor(() => expect(within(screen.getByText("x.pdf").closest("li")!).getByText(/not a member/)).toBeTruthy());
    fireEvent.change(box(), { target: { value: "hi" } });
    expect(sendBtn().disabled).toBe(false);
    fireEvent.click(sendBtn());
    expect(mutate.mock.calls[0][0].attachments).toEqual([]);
  });

  it("a photo shows a small preview; a PDF shows a file icon", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([png("shop.png"), pdf("bill.pdf")]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
    await up.finishAll();
    const img = screen.getByRole("img", { name: "shop.png" }) as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("blob:shop.png");
    expect(screen.queryByRole("img", { name: "bill.pdf" })).toBeNull();
  });

  it("each chip shows the file size", async () => {
    const up = controlledUploads();
    renderComposer();
    pick([new File([PDF(), new Uint8Array(2048)], "two-kb.pdf", { type: "application/pdf" })]);
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    await up.finishAll();
    expect(within(screen.getByText("two-kb.pdf").closest("li")!).getByText("2.0 KB")).toBeTruthy();
  });
});

describe("R-2301 files under a message", () => {
  const row = (over: Partial<ChatMessage["attachments"][number]>) => ({
    id: Math.random().toString(),
    tenant_id: "t",
    message_id: "m1",
    channel_id: CH,
    file_path: `t/chat/${CH}/u_a.pdf`,
    file_name: "a.pdf",
    mime: "application/pdf",
    size_bytes: 1536,
    uploaded_by: "me",
    created_at: "2026-10-31T10:00:00Z",
    ...over,
  });
  const message = (attachments: ChatMessage["attachments"]) =>
    ({ id: "m1", channel_id: CH, body: "", attachments } as unknown as ChatMessage);
  const Below = ext.MessageBelow!;

  it("lists each file with its name and size; nothing when the message has no files", () => {
    const { container, rerender } = render(<Below message={message([])} channelId={CH} myUserId="me" teammates={[]} />);
    expect(container.textContent).toBe("");
    rerender(
      <Below
        message={message([row({}), row({ file_name: "report.xlsx", size_bytes: 3 * 1024 * 1024, mime: "application/vnd.ms-excel" })])}
        channelId={CH}
        myUserId="me"
        teammates={[]}
      />,
    );
    expect(screen.getByRole("button", { name: /Open a\.pdf/ })).toBeTruthy();
    expect(screen.getByText("1.5 KB")).toBeTruthy();
    expect(screen.getByText("report.xlsx")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
  });

  it("opening a PDF asks for a FRESH 5-minute signed link each time", async () => {
    const win = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation(() => win as unknown as Window);
    render(<Below message={message([row({})])} channelId={CH} myUserId="me" teammates={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Open a\.pdf/ }));
    await waitFor(() => expect(win.location.href).toMatch(/^\/signed\/t\/chat\//));
    expect(from).toHaveBeenCalledWith("documents");
    expect(createSignedUrl).toHaveBeenCalledWith(`t/chat/${CH}/u_a.pdf`, 300);
    expect(win.opener).toBeNull();
    const first = win.location.href;
    fireEvent.click(screen.getByRole("button", { name: /Open a\.pdf/ }));
    await waitFor(() => expect(createSignedUrl).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(win.location.href).not.toBe(first));
    open.mockRestore();
  });

  it("a photo shows a thumbnail from a signed link", async () => {
    render(<Below message={message([row({ file_name: "shop.jpg", mime: "image/jpeg", file_path: `t/chat/${CH}/u_shop.jpg` })])} channelId={CH} myUserId="me" teammates={[]} />);
    const img = (await screen.findByRole("img", { name: "shop.jpg" })) as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/^\/signed\/t\/chat\/.*u_shop\.jpg/);
    expect(createSignedUrl).toHaveBeenCalledWith(`t/chat/${CH}/u_shop.jpg`, 300);
  });

  it("a link that cannot be made says so and closes the blank tab", async () => {
    createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: "denied" } } as never);
    const win = { location: { href: "" }, opener: {} as unknown, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockImplementation(() => win as unknown as Window);
    render(<Below message={message([row({})])} channelId={CH} myUserId="me" teammates={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /Open a\.pdf/ }));
    await waitFor(() => expect(win.close).toHaveBeenCalled());
    expect(screen.getByText(/could not open/i)).toBeTruthy();
    open.mockRestore();
  });
});
