/**
 * Staging must never be indexed by search engines. NOINDEX=true (set on the staging Cloud Run
 * service only) adds `X-Robots-Tag: noindex, nofollow` to every response (middleware.ts) and
 * turns /robots.txt into "Disallow: /" (app/robots.ts). Unset or anything else → production
 * behaviour, unchanged. Read at request time, so no rebuild is needed to switch it.
 */
export function noindexEnabled(): boolean {
  return (process.env.NOINDEX ?? "").trim().toLowerCase() === "true";
}

export const NOINDEX_HEADER_VALUE = "noindex, nofollow";

/** Sets the header on a response when NOINDEX=true; returns the same response. */
export function withNoindex<R extends { headers: Headers }>(res: R): R {
  if (noindexEnabled()) res.headers.set("X-Robots-Tag", NOINDEX_HEADER_VALUE);
  return res;
}
