import { describe, expect, it } from "vitest";
import { BodyTooLargeError, bodyTooLargeJson, readBodyCapped } from "./body-limit";

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
  const req = new Request("http://x/api/sb/rest/v1/t", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  return { req, pulled: () => pulled };
}

describe("readBodyCapped (R-1411)", () => {
  it("returns a normal JSON body", async () => {
    const req = new Request("http://x/", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(await readBodyCapped(req)).toBe('{"a":1}');
  });

  it("refuses by Content-Length before reading anything", async () => {
    const { req, pulled } = streamReq(5, 10, { "content-length": "5000000" });
    await expect(readBodyCapped(req, 1000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled()).toBeLessThanOrEqual(1);
  });

  it("stops reading once the cap is passed when Content-Length is missing", async () => {
    const { req, pulled } = streamReq(10_000, 1000);
    await expect(readBodyCapped(req, 5000)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(pulled()).toBeLessThan(20); // did not drain 10 MB
  });

  it("accepts a body exactly at the cap", async () => {
    const { req } = streamReq(5, 1000);
    expect((await readBodyCapped(req, 5000)).length).toBe(5000);
  });

  it("413 body is PostgREST-shaped", () => {
    expect(bodyTooLargeJson(1_000_000)).toMatchObject({ code: "PGRST413", message: expect.stringContaining("1000 KB") });
  });
});
