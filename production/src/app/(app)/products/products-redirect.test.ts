import { describe, it, expect, vi } from "vitest";

const redirect = vi.fn((to: string) => { throw new Error(`REDIRECT ${to}`); });
vi.mock("next/navigation", () => ({ redirect: (to: string) => redirect(to) }));

import ProductsRedirect from "./page";

describe("/products (R-490 / R-472)", () => {
  it("sends people to /items instead of a 404", () => {
    expect(() => ProductsRedirect()).toThrow("REDIRECT /items");
    expect(redirect).toHaveBeenCalledWith("/items");
  });
});
