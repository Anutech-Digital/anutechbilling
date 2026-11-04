// @vitest-environment jsdom
/**
 * R-2299 (G-TEAMCHAT TC-06) — the composer's SLOT API works for the cards that plug in later
 * (R-2301 files, R-2302 record links, R-2303 mentions, R-2304 post type), without editing the
 * composer: a slot fills its draft field and it is sent; a slot can hold Send with a reason;
 * a slot's key handler takes Enter before the composer does.
 */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatExtension, ComposerSlotProps } from "./composer-slots";

const mutate = vi.fn();
vi.mock("@/lib/queries/team-chat", () => ({ usePostChatMessage: () => ({ mutate, isPending: false }) }));

import { Composer } from "./composer";

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLTextAreaElement;

function PostType({ setDraft, draft }: ComposerSlotProps) {
  return (
    <button type="button" aria-pressed={draft.kind === "problem"} onClick={() => setDraft((d) => ({ ...d, kind: "problem", links: [{ type: "quote", id: "q1" }] }))}>
      Problem
    </button>
  );
}
function Uploading({ setBlocking }: ComposerSlotProps) {
  React.useEffect(() => { setBlocking("Uploading 1 file…"); return () => setBlocking(null); }, [setBlocking]);
  return null;
}
function MentionPopover({ registerKeyHandler }: ComposerSlotProps) {
  React.useEffect(() => registerKeyHandler((e) => e.key === "Enter"), [registerKeyHandler]);
  return <div role="listbox" aria-label="Mention a teammate" />;
}

const renderWith = (extensions: ChatExtension[]) =>
  render(<Composer channelId={CH} channelLabel="#general" myUserId="me" members={[]} teammates={[]} extensions={extensions} />);

beforeEach(() => { mutate.mockReset(); });
afterEach(cleanup);

describe("R-2299 composer slots", () => {
  it("a Toolbar slot changes the draft and the whole draft is sent", () => {
    renderWith([{ id: "post-type", Toolbar: PostType }]);
    fireEvent.click(screen.getByRole("button", { name: "Problem" }));
    fireEvent.change(box(), { target: { value: "Client X DNS down" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0][0]).toMatchObject({
      channelId: CH, body: "Client X DNS down", kind: "problem", links: [{ type: "quote", id: "q1" }], authorId: "me",
    });
  });

  it("a slot can hold Send with a reason", () => {
    renderWith([{ id: "attachments", AboveInput: Uploading }]);
    fireEvent.change(box(), { target: { value: "file attached" } });
    expect(screen.getByText("Uploading 1 file…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("a Popover slot's key handler takes Enter before the composer sends", () => {
    renderWith([{ id: "mentions", Popover: MentionPopover }]);
    expect(screen.getByRole("listbox", { name: "Mention a teammate" })).toBeTruthy();
    fireEvent.change(box(), { target: { value: "@Hit" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("a failed send gives the draft back (the hook already toasted)", () => {
    mutate.mockImplementation((_input: unknown, opts?: { onError?: () => void }) => opts?.onError?.());
    renderWith([]);
    fireEvent.change(box(), { target: { value: "Hello" } });
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(box().value).toBe("Hello");
  });
});
