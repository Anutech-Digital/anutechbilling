// @vitest-environment jsdom
//
// R-209 — on a phone the folders were hidden inside an "Inbox ▾" <select>, so a new user
// never saw Starred / Snoozed / Converted / Sent / Done / Spam exist. They are now a row
// of chips that scrolls sideways INSIDE itself (the page must not). And in an empty Inbox
// the main job — add a lead — is the primary button; "Set up email" is the quiet one.
import { describe, it, expect, afterEach, vi } from "vitest";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";
import { MAIL_FOLDERS, type MailFolder } from "@/lib/inbound/folders";
import { FolderChips, AddLeadButton, SetUpEmailButton } from "./mobile-folders";

afterEach(cleanup);

// jsdom gives import.meta.url a non-file scheme, so the page source is found from the package root.
const PAGE = resolve(process.cwd(), "src/app/(app)/enquiries/page.tsx");

const counts = Object.fromEntries(MAIL_FOLDERS.map((f) => [f.id, 0])) as Record<MailFolder, number>;
counts.inbox = 3;

describe("Enquiries phone folder chips (R-209)", () => {
  it("shows every folder as a chip, marks the open one, and switches on tap", () => {
    const onPick = vi.fn();
    render(<FolderChips folder="inbox" counts={counts} unread={1} onPick={onPick} />);
    const chips = screen.getAllByRole("button");
    expect(chips).toHaveLength(MAIL_FOLDERS.length);
    for (const f of MAIL_FOLDERS) expect(screen.getByText(f.label)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Inbox/ }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: /^Starred/ }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Sent/ }));
    expect(onPick).toHaveBeenCalledWith("sent");
  });

  it("scrolls inside its own row, so the page never scrolls sideways at 375px", () => {
    render(<FolderChips folder="inbox" counts={counts} unread={0} onPick={() => {}} />);
    const nav = screen.getByRole("navigation", { name: "Mail folders" });
    expect(nav.className).toContain("md:hidden");          // desktop keeps its rail
    expect(nav.className).toContain("overflow-x-auto");    // the row scrolls…
    expect(nav.className).toContain("min-w-0");            // …without widening its parent
    const row = nav.querySelector("ul")!;
    expect(row.className).toContain("w-max");
  });

  it("the page uses the chips, not the old hidden dropdown", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("<FolderChips");
    expect(src).not.toContain('aria-label="Mail folder"');
  });
});

describe("Empty Inbox buttons (R-209)", () => {
  it("'Add a lead manually' is the primary (amber) button and 'Set up email' is secondary", () => {
    render(<div><AddLeadButton /><SetUpEmailButton /></div>);
    const add = screen.getByRole("link", { name: "Add a lead manually" });
    const email = screen.getByRole("link", { name: /Set up email/ });
    expect(add.getAttribute("href")).toBe("/leads");
    expect(email.getAttribute("href")).toBe("/settings?tab=integrations");
    expect(add.className).toContain("bg-amber");
    expect(email.className).not.toContain("bg-amber");
    expect(email.className).toContain("border-hairline");
  });

  it("the page's empty Inbox uses those two buttons", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("<AddLeadButton");
    expect(src).toContain("<SetUpEmailButton");
  });
});
