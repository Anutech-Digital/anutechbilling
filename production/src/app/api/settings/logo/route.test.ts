/**
 * R-1546: the company logo lives in the PUBLIC logos bucket and is served from the app's own
 * origin, so it must be a real raster image — never SVG, and never SVG bytes under a png name.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const uploads: { path: string; contentType: string }[] = [];

vi.mock("@/lib/supabase/server", () => {
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: { tenant_id: "t1", role: "owner" } }) }) }),
      update: () => ({ eq: async () => ({ error: null }) }),
    }),
    storage: {
      from: () => ({
        upload: async (path: string, _buf: Buffer, opts: { contentType: string }) => { uploads.push({ path, contentType: opts.contentType }); return { error: null }; },
        getPublicUrl: (path: string) => ({ data: { publicUrl: `https://x/logos/${path}` } }),
      }),
    },
  };
  return { createClient: () => client, createAdminClientFor: () => client };
});

const { POST } = await import("./route");

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.domain)</script></svg>';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function req(bytes: BlobPart, type: string, name: string) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type }));
  return new Request("http://x/api/settings/logo", { method: "POST", body: form }) as never;
}

describe("logo upload is a real raster image (R-1546)", () => {
  beforeEach(() => { uploads.length = 0; });

  it("refuses an SVG logo", async () => {
    const res = await POST(req(SVG, "image/svg+xml", "logo.svg"));
    expect(res.status).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  it("refuses SVG bytes named logo.png with an image/png type", async () => {
    const res = await POST(req(SVG, "image/png", "logo.png"));
    expect(res.status).toBe(400);
    expect(uploads).toHaveLength(0);
  });

  it("accepts a real PNG and stores it as image/png", async () => {
    const res = await POST(req(PNG, "image/png", "logo.png"));
    expect(res.status).toBe(200);
    expect(uploads).toEqual([{ path: expect.stringMatching(/^t1\/\d+-logo\.png$/), contentType: "image/png" }]);
  });
});
