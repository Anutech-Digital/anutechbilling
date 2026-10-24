/**
 * Pure parts of the night IST check (R-1826) — tested in tests/ops/night-ist-check.test.ts.
 * The script itself is scripts/ops/night-ist-check.mjs.
 */

/** The ONLY tenant the night check may write in: E2E Test Co. */
export const E2E_TENANT_ID = "f588b89d-6ba2-4abe-b8b3-e4821a65e7b4";

/** Where the check may write: this machine, or a host whose name says staging. Live never. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const IST_OFFSET_MS = 330 * 60_000;
const pad2 = (n) => String(n).padStart(2, "0");

/** IST calendar day (YYYY-MM-DD) of an instant. */
export function istDateOf(at) {
  const s = new Date(new Date(at).getTime() + IST_OFFSET_MS);
  return `${s.getUTCFullYear()}-${pad2(s.getUTCMonth() + 1)}-${pad2(s.getUTCDate())}`;
}

/** UTC calendar day of an instant — what CURRENT_DATE gives on Cloud SQL. */
export function utcDateOf(at) {
  return new Date(at).toISOString().slice(0, 10);
}

/** True between 00:00 and 05:30 IST, when the UTC day is still yesterday. */
export function inNightWindow(at) {
  return istDateOf(at) !== utcDateOf(at);
}

/** The marker written in the draft's notes, so a left-over row is obvious. */
export function nightMarker(at) {
  return `NIGHT-IST-CHECK ${istDateOf(at)} (${new Date(at).toISOString()})`;
}

/** A quote id that never takes a number from the real quote series. */
export function nightQuoteId(at) {
  return `NIGHT-IST-${new Date(at).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
}

/** Allow-list, not a block-list: localhost, or a host with "staging" in its name. Null = allowed. */
export function refuseBase(base) {
  let u;
  try { u = new URL(base); } catch { return `not a URL: ${base}`; }
  if (!/^https?:$/.test(u.protocol)) return `not http(s): ${base}`;
  if (LOCAL_HOSTS.has(u.hostname) || /(^|[.-])staging([.-]|$)/.test(u.hostname)) return null;
  return `host refused: ${u.hostname} — the night check runs on staging or localhost only, never live`;
}

export function isLocal(base) {
  try { return LOCAL_HOSTS.has(new URL(base).hostname); } catch { return false; }
}

/** Refuses any tenant but E2E Test Co. Returns null when allowed. */
export function refuseTenant(tenantId) {
  if (!tenantId) return "could not read the logged-in user's tenant";
  if (tenantId !== E2E_TENANT_ID) return `tenant ${tenantId} is not E2E Test Co (${E2E_TENANT_ID}) — refusing to write`;
  return null;
}

/**
 * The verdict. `before`/`after` are the instants around the insert: if IST midnight fell
 * between them, either IST day is right. Returns { ok, expected, got, utcDay, night }.
 */
export function judge(createdDate, before, after) {
  const got = String(createdDate ?? "").slice(0, 10);
  const allowed = new Set([istDateOf(before), istDateOf(after)]);
  return {
    ok: allowed.has(got),
    expected: [...allowed].join(" or "),
    got: got || "(empty)",
    utcDay: utcDateOf(after),
    night: inNightWindow(before) || inNightWindow(after),
  };
}

/** PostgREST base + headers, taken from a request the app itself made. */
export function restFromRequest(url, headers) {
  const i = url.indexOf("/rest/v1/");
  if (i < 0) return null;
  const out = { base: url.slice(0, i + "/rest/v1/".length), headers: {} };
  for (const k of ["authorization", "apikey"]) if (headers[k]) out.headers[k] = headers[k];
  return out;
}
