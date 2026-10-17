// @vitest-environment jsdom
/**
 * R-1439 — "Login / Switch Account" did nothing. It was a plain link to /login, and the
 * middleware sends a signed-in person straight back off /login (AUTH_PREFIXES), so the
 * click landed on the same screen. Switching account has to sign out first.
 */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AccountMenuItems } from "./account-menu-items";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderMenu() {
  return render(
    <DropdownMenu defaultOpen modal={false}>
      <DropdownMenuTrigger>Account</DropdownMenuTrigger>
      <DropdownMenuContent>
        <AccountMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>,
  );
}

/** Capture the form the item posts instead of letting jsdom try to navigate. */
function spyOnSubmit() {
  const submitted: HTMLFormElement[] = [];
  vi.spyOn(HTMLFormElement.prototype, "submit").mockImplementation(function (this: HTMLFormElement) {
    submitted.push(this);
  });
  return submitted;
}

describe("AccountMenuItems (R-1439)", () => {
  it("Switch account signs out (POST /auth/sign-out, which lands on /login) — not a bare /login link", () => {
    const submitted = spyOnSubmit();
    renderMenu();
    const item = screen.getByRole("menuitem", { name: /switch account/i });
    // A bare link to /login is the bug: a signed-in user is bounced back home.
    expect(item.closest("a")?.getAttribute("href") ?? null).not.toBe("/login");
    fireEvent.click(item);
    expect(submitted).toHaveLength(1);
    expect(submitted[0].method.toLowerCase()).toBe("post");
    expect(new URL(submitted[0].action, "http://x").pathname).toBe("/auth/sign-out");
  });

  it("says that switching signs you out, so the click is not a surprise", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /switch account/i }).textContent).toMatch(/sign/i);
  });

  it("Sign out posts to the same route", () => {
    const submitted = spyOnSubmit();
    renderMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /^sign out$/i }));
    expect(submitted).toHaveLength(1);
    expect(new URL(submitted[0].action, "http://x").pathname).toBe("/auth/sign-out");
  });

  /* R-1453 — Pawan (staging, 15 Oct): no way to open the public homepage from inside the
     app without signing out. "/" in the app is the company page on staging, so the link goes to
     the product homepage route, which the live hosts 301 to https://reselleros.anutech.in/. */
  it("Website opens the public product homepage in a new tab (R-1453)", () => {
    renderMenu();
    const link = screen.getByRole("menuitem", { name: /website/i }).closest("a");
    expect(link).not.toBeNull();
    expect(link?.getAttribute("href")).toBe("/reselleros");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("Website says it opens a new tab, for screen readers too (R-1453)", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /website/i }).textContent).toMatch(/new tab/i);
  });

  it("no dead items: Settings and Team are real links", () => {
    renderMenu();
    expect(screen.getByRole("menuitem", { name: /settings/i }).closest("a")?.getAttribute("href")).toBe("/settings");
    expect(screen.getByRole("menuitem", { name: /team/i }).closest("a")?.getAttribute("href")).toBe("/team");
  });
});
