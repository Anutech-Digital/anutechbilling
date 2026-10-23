/**
 * R-1110 (23 Oct 2026) — a POST from the Workspace Trial / Quote / Buy dialogs that never throws.
 *
 * Each dialog did `await fetch(...)` then `await res.json()` with no catch. On flaky mobile data
 * the fetch rejects; behind a proxy a 502 comes back as an HTML page and `.json()` throws. Either
 * way the submit handler threw, react-hook-form swallowed it and the buyer saw nothing happen.
 * This returns one of two shapes, so every caller has to say something:
 *   - { reached: false }        → our server was not reached (offline, timeout, HTML error page)
 *   - { reached: true, ok, json } → the server answered; `json` is {} when the body was not JSON
 */
export type PostResult<T> =
  | { reached: false }
  | { reached: true; ok: boolean; status: number; json: T };

export async function postJson<T extends object>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<PostResult<Partial<T>>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch {
    return { reached: false };
  }
  let json: Partial<T> | null = null;
  try {
    json = (await res.json()) as Partial<T>;
  } catch {
    json = null;
  }
  // A non-JSON answer with a failure status is a gateway / proxy page, not our API.
  if (json === null && !res.ok) return { reached: false };
  return { reached: true, ok: res.ok, status: res.status, json: json ?? {} };
}

/** The sentence when our server was not reached — what happened and that nothing was done. */
export const NOT_REACHED = "We couldn't reach our server.";
