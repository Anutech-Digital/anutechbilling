// @vitest-environment jsdom
/**
 * R-830 — images in the Ask tab: attach several, limits with clear errors, the images go to
 * the help AI, and the AI's bug draft carries them into the filed report's screenshots.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";

const h = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => ({ id: "fb1", uploaded: 0, failedUploads: [] as string[], triaged: true })),
  toastError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/subscriptions", useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));
vi.mock("@/lib/hooks/useCurrentUser", () => ({ useCurrentUser: () => ({ data: { tenantId: "t1", fullName: "Abhishek", userId: "u1", authEmail: null } }) }));
vi.mock("@/lib/queries/feedback", () => ({ useSubmitFeedback: () => ({ mutateAsync: h.mutateAsync }) }));
vi.mock("@/lib/ai/page-test-runs", async (orig) => ({ ...(await orig<typeof import("@/lib/ai/page-test-runs")>()), loadLastPageTestRun: async () => null }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: h.toastError, warning: vi.fn() } }));
/* jsdom has no canvas: a file "shrinks" to a JPEG named after it. */
vi.mock("@/components/shared/help-shot", async (orig) => ({
  ...(await orig<typeof import("./help-shot")>()),
  toShot: async (f: File) => ({ dataUrl: `data:image/jpeg;base64,${btoa(f.name)}`, mimeType: "image/jpeg", base64: btoa(f.name) }),
}));

import { AiHelp, AiHelpButton } from "./ai-help";

const png = (name: string, size = 1000, type = "image/png") => {
  const f = new File(["x"], name, { type });
  Object.defineProperty(f, "size", { value: size });
  return f;
};

let posted: Record<string, unknown>[] = [];
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  posted = [];
  h.mutateAsync.mockClear();
  h.toastError.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    posted.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(JSON.stringify({
      reply: "Draft taiyaar hai.",
      bugDraft: { title: "Renew does nothing", type: "bug", severity: "high", actual: "No quote", expected: "Quote opens", steps: ["Open /subscriptions", "Click Renew"], chatSummary: "x" },
      checklist: [], followUps: [], ai: true,
    }), { status: 200, headers: { "content-type": "application/json" } });
  }));
});
afterEach(() => {
  const btn = screen.queryByRole("button", { name: /^Help —/ });
  if (btn?.getAttribute("aria-pressed") === "true") fireEvent.click(btn);
  cleanup();
  vi.unstubAllGlobals();
});

async function openPanel() {
  render(<><AiHelpButton /><AiHelp /></>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /^Help —/ })); });
}
async function attach(files: File[]) {
  const input = screen.getByTestId("ai-help-file-input") as HTMLInputElement;
  await act(async () => { fireEvent.change(input, { target: { files } }); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("R-830 Ask tab images", () => {
  it("has an attach button and takes several images at once, each removable", async () => {
    await openPanel();
    expect(screen.getByRole("button", { name: "Attach images" })).toBeTruthy();
    await attach([png("a.png"), png("b.png"), png("c.png")]);
    expect(screen.getAllByAltText(/^Image \d to send$/)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove image 2" }));
    expect(screen.getAllByAltText(/^Image \d to send$/)).toHaveLength(2);
  });

  it("stops at 5 with 'Max 5 images' and refuses a file over 5 MB", async () => {
    await openPanel();
    await attach([png("big.png", 6 * 1024 * 1024)]);
    expect(h.toastError).toHaveBeenCalledWith("Image too large — max 5 MB");
    await attach(Array.from({ length: 6 }, (_, i) => png(`${i}.png`)));
    expect(h.toastError).toHaveBeenCalledWith("Max 5 images");
    expect(screen.getAllByAltText(/^Image \d to send$/)).toHaveLength(5);
    expect((screen.getByRole("button", { name: "Attach images" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("takes images dropped on the Ask tab", async () => {
    await openPanel();
    const panel = screen.getByRole("tabpanel");
    await act(async () => { fireEvent.drop(panel, { dataTransfer: { types: ["Files"], files: [png("d1.png"), png("d2.webp", 10, "image/webp")] } }); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.getAllByAltText(/^Image \d to send$/)).toHaveLength(2);
  });

  it("sends the images to the help AI, the draft carries them, and filing stores them as screenshots", async () => {
    await openPanel();
    await attach([png("one.png"), png("two.png"), png("three.png")]);
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Renew button kaam nahi karta" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(posted).toHaveLength(1);
    const sent = posted[0].images as { mimeType: string; base64: string }[];
    expect(sent.map((i) => atob(i.base64))).toEqual(["one.png", "two.png", "three.png"]);
    expect(sent.every((i) => i.mimeType === "image/jpeg")).toBe(true);

    const onDraft = screen.getByTestId("ai-help-draft-images");
    expect(onDraft.querySelectorAll("img")).toHaveLength(3);
    expect(onDraft.textContent).toContain("3 images from this chat go with the report");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "File this report" })); });
    expect(h.mutateAsync).toHaveBeenCalledTimes(1);
    const payload = (h.mutateAsync.mock.calls[0] as unknown as [{ screenshots: { name: string; dataUrl: string }[]; filedVia: string; text: string }])[0];
    expect(payload.filedVia).toBe("ai-chat");
    expect(payload.screenshots.map((s) => s.name)).toEqual(["ai_help_screen_1.jpg", "ai_help_screen_2.jpg", "ai_help_screen_3.jpg"]);
    expect(payload.screenshots.map((s) => atob(s.dataUrl.split(",")[1]))).toEqual(["one.png", "two.png", "three.png"]);
  });

  it("an image removed from the draft is not filed", async () => {
    await openPanel();
    await attach([png("one.png"), png("two.png")]);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send" })); });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fireEvent.click(screen.getByRole("button", { name: "Remove image 1 from the report" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "File this report" })); });
    const payload = (h.mutateAsync.mock.calls[0] as unknown as [{ screenshots: { dataUrl: string }[] }])[0];
    expect(payload.screenshots.map((s) => atob(s.dataUrl.split(",")[1]))).toEqual(["two.png"]);
  });
});
