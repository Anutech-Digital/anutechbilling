/**
 * R-1546: the storage gateway serves files from the app's OWN origin. A file whose bytes
 * are SVG/HTML must never render there (its script would run as the app and could read
 * /api/auth/supabase-token), whatever content type the uploader claimed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, { body: Buffer; contentType: string }>();
const buckets: Record<string, { id: string; public: boolean; file_size_limit: number | null; allowed_mime_types: string[] | null }> = {
  logos: { id: "logos", public: true, file_size_limit: 5_242_880, allowed_mime_types: ["image/png", "image/jpeg", "image/webp"] },
  "employee-docs": { id: "employee-docs", public: false, file_size_limit: null, allowed_mime_types: null },
};

vi.mock("@/server/db/gateway", () => ({
  withIdentity: async (_id: unknown, fn: (tx: unknown) => unknown) => fn({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => {
      if (sql.includes("from storage.buckets")) return buckets[args[0] as string] ? [buckets[args[0] as string]] : [];
      if (sql.includes("from storage.objects")) return (args[1] as string[]).map((name) => ({ name }));
      return [];
    },
    $executeRawUnsafe: async () => 1,
  }),
}));
vi.mock("@/server/storage/backend", () => ({
  objectBackend: () => ({
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, body: Buffer, contentType: string) => { store.set(key, { body, contentType }); },
    remove: async () => undefined,
  }),
}));

const { handleStorage } = await import("./storage");
const { sniff, uploadProblem, safeServeHeaders } = await import("./storage-safety");

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/auth/supabase-token")</script></svg>');
const HTML = Buffer.from("<!doctype html><html><script>alert(document.domain)</script></html>");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from("%PDF-1.7\n%\xe2\xe3\n1 0 obj<<>>endobj\n");

const user = { mode: "user" as const, userId: "00000000-0000-0000-0000-000000000001", claims: {} };
const anon = { mode: "anon" as const };

async function upload(bucket: string, name: string, body: Buffer, type: string) {
  const req = new Request(`http://x/api/sb/storage/v1/object/${bucket}/${name}`, { method: "POST", body: new Uint8Array(body), headers: { "content-type": type } });
  return handleStorage(req, `object/${bucket}/${name}`, user as never);
}
async function get(path: string, identity: unknown = anon) {
  return handleStorage(new Request(`http://x/api/sb/storage/v1/${path}`), path, identity as never);
}

function expectLockedDown(res: Response) {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const csp = res.headers.get("content-security-policy") ?? "";
  expect(csp).toMatch(/(^|;\s*)sandbox(;|$)/);
  expect(csp).toContain("default-src 'none'");
}

describe("storage gateway never renders markup on the app origin (R-1546)", () => {
  beforeEach(() => {
    store.clear();
    process.env.SUPABASE_JWT_SECRET = "test-secret-for-r1546-storage-headers-000000";
  });

  it("an SVG with <script> already in the public logos bucket is served as an attachment in a sandbox", async () => {
    store.set("logos/t1/evil.svg", { body: SVG, contentType: "image/svg+xml" });
    const res = await get("object/public/logos/t1/evil.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-type")).not.toMatch(/svg|html|xml/);
    expectLockedDown(res);
  });

  it("SVG bytes stored under a png content type are still served as an attachment", async () => {
    store.set("logos/t1/fake.png", { body: SVG, contentType: "image/png" });
    const res = await get("object/public/logos/t1/fake.png");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expectLockedDown(res);
  });

  it("a real PNG logo is still served inline (logos keep showing)", async () => {
    store.set("logos/t1/logo.png", { body: PNG, contentType: "image/png" });
    const res = await get("object/public/logos/t1/logo.png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("content-type")).toBe("image/png");
    expectLockedDown(res);
  });

  it("text/html cannot be uploaded to a bucket with no mime list", async () => {
    const res = await upload("employee-docs", "t1/page.html", HTML, "text/html");
    expect(res.status).toBe(415);
    expect(store.has("employee-docs/t1/page.html")).toBe(false);
  });

  it("HTML bytes claimed as image/png are refused on upload", async () => {
    const res = await upload("employee-docs", "t1/x.png", HTML, "image/png");
    expect(res.status).toBe(415);
  });

  it("an image/svg+xml upload is refused even where the bucket has no mime list", async () => {
    const res = await upload("employee-docs", "t1/x.svg", SVG, "image/svg+xml");
    expect(res.status).toBe(415);
  });

  it("PDFs and photos still upload to employee-docs", async () => {
    expect((await upload("employee-docs", "t1/a.pdf", PDF, "application/pdf")).status).toBe(200);
    expect((await upload("employee-docs", "t1/a.png", PNG, "image/png")).status).toBe(200);
  });

  it("an HTML file already stored is served through a signed URL as an attachment in a sandbox", async () => {
    store.set("employee-docs/t1/old.html", { body: HTML, contentType: "text/html" });
    const signRes = await handleStorage(new Request("http://x/api/sb/storage/v1/object/sign/employee-docs/t1/old.html", { method: "POST", body: JSON.stringify({ expiresIn: 60 }) }),
      "object/sign/employee-docs/t1/old.html", user as never);
    const { signedURL } = (await signRes.json()) as { signedURL: string };
    const [p, q] = signedURL.slice(1).split("?");
    const res = await handleStorage(new Request(`http://x/api/sb/storage/v1/${p}?${q}`), p, anon as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-type")).not.toMatch(/html/);
    expectLockedDown(res);
  });

  it("a signed-in download of a stored PDF is an attachment with the sandbox headers", async () => {
    store.set("employee-docs/t1/a.pdf", { body: PDF, contentType: "application/pdf" });
    const res = await get("object/employee-docs/t1/a.pdf", user);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expectLockedDown(res);
  });
});

describe("storage-safety sniffing (R-1546)", () => {
  const utf16 = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);

  it("recognises real images and PDFs by their bytes", () => {
    expect(sniff(PNG)).toBe("png");
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("jpeg");
    expect(sniff(Buffer.from("GIF89a....."))).toBe("gif");
    expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniff(PDF)).toBe("pdf");
    expect(sniff(Buffer.from("PK\x03\x04docx bytes"))).toBe("other");
  });

  it("finds markup behind a BOM, whitespace, comments or UTF-16", () => {
    expect(sniff(Buffer.from("﻿  \n<svg onload=alert(1)>"))).toBe("markup");
    expect(sniff(Buffer.from("<!-- hi --><html>"))).toBe("markup");
    expect(sniff(Buffer.from('<?xml version="1.0"?><x/>'))).toBe("markup");
    expect(sniff(utf16("<svg><script>alert(1)</script></svg>"))).toBe("markup");
    expect(sniff(Buffer.from("some text then <script>x</script>"))).toBe("markup");
  });

  it("upload rules: markup types never, markup bytes under any other claim never, plain text may hold '<'", () => {
    expect(uploadProblem("image/svg+xml", PNG)).not.toBeNull();
    expect(uploadProblem("Text/HTML; charset=utf-8", Buffer.from("hi"))).not.toBeNull();
    expect(uploadProblem("application/pdf", HTML)).not.toBeNull();
    expect(uploadProblem("image/jpeg", PNG)).toBeNull(); // a png renamed .jpg is still an image
    expect(uploadProblem("image/jpeg", Buffer.from("\0\0\0\x18ftypheic"))).toBeNull(); // iPhone photo: stored, never inline
    expect(safeServeHeaders("image/jpeg", Buffer.from("\0\0\0\x18ftypheic"), null).get("content-disposition")).toBe("attachment");
    expect(uploadProblem("application/pdf", PDF)).toBeNull();
    expect(uploadProblem("text/plain", Buffer.from("a < b and <b>bold</b>"))).toBeNull();
    expect(uploadProblem("application/octet-stream", SVG)).not.toBeNull();
  });

  it("?download on a real image still forces an attachment", () => {
    expect(safeServeHeaders("image/png", PNG, "logo.png").get("content-disposition")).toBe('attachment; filename="logo.png"');
    expect(safeServeHeaders("image/png", PNG, null).get("content-disposition")).toBeNull();
  });
});
