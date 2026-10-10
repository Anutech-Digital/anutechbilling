import { describe, it, expect } from "vitest";
import { GET } from "./route";
import { APP_THEME } from "@/lib/theme/tokens";

describe("GET /api/public/theme", () => {
  it("serves the app theme, briefly cacheable", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(APP_THEME);
    expect(res.headers.get("cache-control")).toMatch(/s-maxage=300/);
  });
});
