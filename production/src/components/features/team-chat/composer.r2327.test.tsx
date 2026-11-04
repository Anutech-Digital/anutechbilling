// @vitest-environment jsdom
/**
 * R-2327 (2) — localhost check: at ~800–1100 px the composer's bottom row crowded — the
 * "Enter to send · Shift+Enter for a new line" hint wrapped to 4 lines and Send was cut at the
 * right edge. UI rule "fit 1280": the hint shows only from 1280 px (Tailwind xl), the row may
 * wrap, the hint line truncates instead of growing, and Send never shrinks. A hold reason
 * ("Uploading 2 files…") still shows at every width — it says why Send is off.
 * jsdom has no layout, so the widths are proven by the classes that decide them
 * (xl = 1280 px in Tailwind; 1024 px is below it, 1280 px is at it).
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/queries/team-chat", () => ({ usePostChatMessage: () => ({ mutate: vi.fn(), isPending: false }) }));

import { Composer } from "./composer";
import type { ChatExtension, ComposerSlotProps } from "./composer-slots";

afterEach(cleanup);

const CH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HINT = "Enter to send · Shift+Enter for a new line";

function Holder({ setBlocking }: ComposerSlotProps) {
  React.useEffect(() => { setBlocking("Uploading 2 files…"); }, [setBlocking]);
  return null;
}

const renderComposer = (extensions: ChatExtension[] = []) =>
  render(<Composer channelId={CH} channelLabel="#general" myUserId="me" members={[]} teammates={[]} extensions={extensions} />);

/** The classes of an element and all its ancestors up to the form. */
function classesUp(el: HTMLElement): string[] {
  const out: string[] = [];
  for (let n: HTMLElement | null = el; n && n.tagName !== "FORM"; n = n.parentElement) out.push(n.className);
  return out;
}

describe("R-2327 (2) composer bottom row fits below 1280 px", () => {
  it("the keyboard hint is hidden below 1280 px (xl) — at 1024 px it takes no room", () => {
    renderComposer();
    const hint = screen.getByText(HINT);
    const up = classesUp(hint).join(" ");
    expect(up).toMatch(/(^|\s)hidden(\s|$)/);
    expect(up).toMatch(/(^|\s)xl:(inline|block)(\s|$)/);
    expect(up).not.toMatch(/(^|\s)(sm|md|lg):(inline|block)(\s|$)/);
  });

  it("Send never shrinks and the row may wrap, so Send is never clipped", () => {
    renderComposer();
    const send = screen.getByRole("button", { name: "Send" });
    expect(send.className).toMatch(/(^|\s)shrink-0(\s|$)/);
    const rowEl = send.parentElement as HTMLElement;
    expect(rowEl.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
  });

  it("a hold reason shows at every width and truncates instead of wrapping", () => {
    renderComposer([{ id: "holder", Toolbar: Holder }]);
    const reason = screen.getByText("Uploading 2 files…");
    const up = classesUp(reason);
    expect(up.join(" ")).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(up[0]).toMatch(/(^|\s)truncate(\s|$)/);
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
