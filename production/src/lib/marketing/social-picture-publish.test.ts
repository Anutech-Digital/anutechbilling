/**
 * R-2697: an AI picture kept as a hidden Page photo — at post time the fresh image link is read
 * and given to Facebook / Instagram; a picture that is gone stops the post with a clear sentence.
 * fetch is mocked; nothing reaches Meta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/db", () => ({ withTenant: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/integrations/facebook-page", () => ({ readFacebookPage: vi.fn() }));

import { pagePhotoLinks, publishWithPage, uploadPagePhoto } from "./social-content";
import { pagePhotoRef } from "./social-autopilot";

const PAGE = { pageId: "111222333", pageToken: "page-token-x" };
const REF = pagePhotoRef("987654321012");
const FRESH = "https://scontent.example.fbcdn.net/v/big.jpg?oe=ABC";
const json = (body: unknown, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body }) as unknown as Response;
const fetchMock = vi.fn();

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("R-2697 AI picture on the Page", () => {
  it("upload keeps the picture unpublished and returns the https reference", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "987654321012" }));
    const ref = await uploadPagePhoto(PAGE.pageId, PAGE.pageToken, Buffer.from("png"), "image/png");
    expect(ref).toBe(REF);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/111222333\/photos$/);
    expect((init.body as FormData).get("published")).toBe("false");
  });

  it("reads the biggest image link of each photo, one call per photo", async () => {
    fetchMock.mockResolvedValueOnce(json({ images: [{ source: "https://small", width: 130 }, { source: FRESH, width: 1024 }] }));
    const links = await pagePhotoLinks([REF, REF, "https://example.com/a.jpg", null], PAGE.pageToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/987654321012?");
    expect(links.get(REF)).toBe(FRESH);
  });

  it("Facebook post: the fresh link is given to Meta, not the stored reference", async () => {
    fetchMock.mockResolvedValueOnce(json({ images: [{ source: FRESH, width: 1024 }] }));
    fetchMock.mockResolvedValueOnce(json({ id: "post-1" }));
    const id = await publishWithPage({ platform: "facebook", format: "post", caption: "Hi", media_url: REF }, PAGE);
    expect(id).toBe("post-1");
    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toMatch(/\/111222333\/photos$/);
    expect((init.body as URLSearchParams).get("url")).toBe(FRESH);
  });

  it("Instagram post: the container gets the fresh public link", async () => {
    fetchMock.mockResolvedValueOnce(json({ images: [{ source: FRESH, width: 1024 }] }));
    fetchMock.mockResolvedValueOnce(json({ instagram_business_account: { id: "ig-1" } }));
    fetchMock.mockResolvedValueOnce(json({ id: "container-1" }));
    fetchMock.mockResolvedValueOnce(json({ id: "media-1" }));
    await publishWithPage({ platform: "instagram", format: "post", caption: "Hi", media_url: REF }, PAGE);
    expect((fetchMock.mock.calls[2][1].body as URLSearchParams).get("image_url")).toBe(FRESH);
  });

  it("a picture no longer on the Page stops the post with a clear next step", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: "Unsupported get request" } }, false));
    await expect(publishWithPage({ platform: "facebook", format: "post", caption: "Hi", media_url: REF }, PAGE))
      .rejects.toThrow(/no longer in your Facebook Page's photos.*make a new picture/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
