/**
 * R-1979: the Meta Pixel / Conversions API rules — payload, hashing, event_id, fbc.
 */
import { describe, it, expect } from "vitest";
import { buildCapiBody, cleanPixelId, contentIdForPlan, fbcFromFbclid, normEmail, normPhone, purchaseEventId, sha256 } from "./pixel";

describe("R-1979 Meta rules", () => {
  it("pixel id: digits only", () => {
    expect(cleanPixelId(" 1234567890123456 ")).toBe("1234567890123456");
    expect(cleanPixelId("12345<script>")).toBeNull();
    expect(cleanPixelId("")).toBeNull();
  });

  it("Purchase event_id is the same for browser and server: purchase-<quote>", () => {
    expect(purchaseEventId("Q-ADPL-27-0042")).toBe("purchase-Q-ADPL-27-0042");
  });

  it("email and phone are normalised then SHA-256 hashed — never sent in the clear", () => {
    expect(normEmail("  Ravi@Example.IN ")).toBe("ravi@example.in");
    expect(normPhone("+91 98111 22233")).toBe("919811122233");
    expect(normPhone("09811122233")).toBe("919811122233");
    expect(normPhone("9811122233")).toBe("919811122233");
    const body = buildCapiBody({ eventName: "Purchase", eventId: "purchase-Q1", eventTimeMs: 1_761_480_000_000, email: "Ravi@Example.IN", phone: "98111 22233", value: 3240, contentIds: ["google-workspace-starter"] });
    const u = body.data[0].user_data as Record<string, string[]>;
    expect(u.em).toEqual([sha256("ravi@example.in")]);
    expect(u.ph).toEqual([sha256("919811122233")]);
    expect(JSON.stringify(body)).not.toMatch(/ravi|98111/i);
  });

  it("Purchase payload: event_time in seconds, action_source website, value before GST in INR, content_ids", () => {
    const body = buildCapiBody({ eventName: "Purchase", eventId: "purchase-Q1", eventTimeMs: 1_761_480_000_123, value: 3240, contentIds: ["google-workspace-starter"], sourceUrl: "https://example.in/buy/workspace/thanks" }, "TEST123");
    expect(body).toEqual({
      data: [{
        event_name: "Purchase", event_time: 1_761_480_000, event_id: "purchase-Q1", action_source: "website",
        event_source_url: "https://example.in/buy/workspace/thanks", user_data: {},
        custom_data: { value: 3240, currency: "INR", content_ids: ["google-workspace-starter"], content_type: "product" },
      }],
      test_event_code: "TEST123",
    });
  });

  it("fbc from a click id: fb.1.<ms>.<fbclid>", () => {
    expect(fbcFromFbclid("AbC", 1_761_480_000_123)).toBe("fb.1.1761480000123.AbC");
    expect(fbcFromFbclid(null, 1)).toBeNull();
  });

  it("content id from the buy page's plan label", () => {
    expect(contentIdForPlan("google-workspace-standard")).toEqual(["google-workspace-standard"]);
    expect(contentIdForPlan(null)).toEqual([]);
  });
});
