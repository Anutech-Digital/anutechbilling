// @vitest-environment jsdom
/**
 * "Open the website" on the Website theme card. Only a signed-in owner sees the card, and "/"
 * sends every signed-in user to /dashboard unless the visit is a website preview (R-1508) —
 * so a bare "/" link always landed the owner back in the app (Pawan, 16 Nov 2026).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/lib/queries/website-theme", () => ({
  useWebsiteTheme: () => ({ data: { visible: true, ready: true, theme: "classic" }, isLoading: false }),
  useSetWebsiteTheme: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/components/providers/confirm-provider", () => ({ useConfirm: () => vi.fn() }));

import WebsiteThemeCard from "./website-theme-card";

afterEach(cleanup);

describe("WebsiteThemeCard — Open the website", () => {
  it("opens the website as a preview, so a signed-in owner is not sent to /dashboard", () => {
    render(<WebsiteThemeCard />);
    const link = screen.getByRole("link", { name: /open the website/i });
    expect(link.getAttribute("href")).toBe("/?preview=1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
