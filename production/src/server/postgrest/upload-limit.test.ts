import { describe, expect, it } from "vitest";
import { BodyTooLargeError } from "./body-limit";
import { STORAGE_UPLOAD_MAX_BYTES, readUploadCapped, uploadLimit, uploadTooLargeMessage } from "./upload-limit";

function streamReq(chunks: number, chunkSize: number, headers: Record<string, string> = {}) {
  let sent = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctl) {
      pulled++;
      if (sent >= chunks) return ctl.close();
      sent++;
      ctl.enqueue(new Uint8Array(chunkSize).fill(97));
    },
  });
  const req = new Request("http://x/api/sb/storage/v1/object/documents/t/a.png", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { req, pulled: () => pulled };
}

function multipartReq(bytes: number, type = "image/jpeg") {
  const form = new FormData();
  form.append("cacheControl", "3600");
  form.append("", new Blob([new Uint8Array(bytes).fill(1)], { type }), "shot.jpg");
  return new Request("http://x/api/sb/storage/v1/object/documents/t/shot.jpg", { method: "POST", body: form });
}

describe("storage upload cap (R-1411)", () => {
  it("never allows more than the global cap, even for a bucket with no limit", () => {
    expect(uploadLimit(null)).toBe(STORAGE_UPLOAD_MAX_BYTES);
    expect(uploadLimit(5_242_880)).toBe(5_242_880);
    expect(uploadLimit(500_000_000)).toBe(STORAGE_UPLOAD_MAX_BYTES);
  });

  it("refuses by Content-Length before reading the body", async () => {
    const { req, pulled } = streamReq(5, 10, { "content-type": "image/png", "content-length": "50000000" });
    await expect(readUploadCapped(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("stops reading a raw upload once the cap is passed (no Content-Length)", async () => {
    const { req, pulled } = streamReq(10_000, 1000, { "content-type": "image/png" });
    await expect(readUploadCapped(req, 5000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled()).toBeLessThan(20); // did not drain 10 MB into memory
  });

  it("reads a raw upload under the cap", async () => {
    const { req } = streamReq(3, 1000, { "content-type": "image/png", "cache-control": "max-age=60" });
    const up = await readUploadCapped(req, 5000);
    expect(up.body.length).toBe(3000);
    expect(up.contentType).toBe("image/png");
    expect(up.cacheControl).toBe("max-age=60");
  });

  it("reads a multipart (storage-js) screenshot under the cap", async () => {
    const up = await readUploadCapped(multipartReq(4000), 10_000);
    expect(up.body.length).toBe(4000);
    expect(up.contentType).toBe("image/jpeg");
    expect(up.cacheControl).toBe("max-age=3600");
  });

  it("refuses a multipart file over the cap", async () => {
    await expect(readUploadCapped(multipartReq(20_000), 10_000)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("says what to do, with the limit in MB", () => {
    const m = uploadTooLargeMessage(20 * 1024 * 1024);
    expect(m).toContain("20 MB");
    expect(m).toMatch(/smaller|compress/i);
  });
});
