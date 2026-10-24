/**
 * R-1411: the gateway REST route must never buffer an unbounded request body. A large POST
 * on an instance whose heap is already high crashed the whole Cloud Run container
 * ("JavaScript heap out of memory"). Rows are small JSON; files go to storage, not here.
 *
 * readBodyCapped checks Content-Length first, then counts bytes while reading the stream and
 * stops (cancels the stream) the moment the cap is passed — so a lying or missing
 * Content-Length still cannot make us hold more than the cap.
 */
export const REST_BODY_MAX_BYTES = 1_000_000;

export class BodyTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`request body is larger than ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyCapped(req: Request, limit = REST_BODY_MAX_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBytesCapped(req, limit));
}

/** The same cap as readBodyCapped, as raw bytes (storage uploads — R-1411). */
export async function readBytesCapped(req: Request, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return all;
}

/** PostgREST-shaped 413 body. */
export function bodyTooLargeJson(limit = REST_BODY_MAX_BYTES) {
  return {
    code: "PGRST413",
    details: null,
    hint: "Upload files to storage and save only the path in the row.",
    message: `Request body too large (max ${Math.round(limit / 1000)} KB).`,
  };
}
