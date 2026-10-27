"use client";
/**
 * R-2010 (27 Oct 2026, G-DPDP): the visitor's cookie choice — ONE place for every page.
 *
 *   - "all"       = Necessary + Advertising measurement (Meta)
 *   - "essential" = Necessary only
 *   - null        = not chosen yet (the banner shows; the Pixel stays off)
 *
 * Kept in the browser (localStorage "anutech.consent.v1", the value R-1979 already reads) and
 * recorded on our server (POST /api/public/consent → consent_events) with a random anon id, so
 * we can show WHEN a visitor agreed to WHICH notice. Changing the choice fires a window event,
 * so the Meta Pixel starts or stops at once — no reload.
 */

export const CONSENT_KEY = "anutech.consent.v1";
/** Random id for this browser's consent record (no personal data in it). */
export const ANON_KEY = "anutech.consent.anon.v1";
/** Bump when the banner's wording changes — every record says which notice it answered. */
export const NOTICE_VERSION = "2026-10-27";

export type ConsentChoice = "all" | "essential";
const CHANGE_EVENT = "anutech:consent-change";
const OPEN_EVENT = "anutech:consent-open";

export function readConsent(): ConsentChoice | null {
  try {
    if (typeof window === "undefined") return null;
    const v = window.localStorage.getItem(CONSENT_KEY);
    return v === "all" || v === "essential" ? v : null;
  } catch {
    /* Storage blocked: treat as "Only necessary" and do not nag on every page. */
    return "essential";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function newUuid(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The anon id of this browser's consent record, or null when none was made (or storage is blocked). */
export function consentAnonId(): string | null {
  try {
    const v = window.localStorage.getItem(ANON_KEY);
    return v && UUID_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

function ensureAnonId(): string {
  const have = consentAnonId();
  if (have) return have;
  const id = newUuid();
  try { window.localStorage.setItem(ANON_KEY, id); } catch { /* in-memory only */ }
  return id;
}

/** Save the choice, tell the page (Pixel on/off at once) and record it on our server. */
export function saveConsent(choice: ConsentChoice): void {
  try { window.localStorage.setItem(CONSENT_KEY, choice); } catch { /* in-memory only */ }
  const anonId = ensureAnonId();
  try { window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: choice })); } catch { /* old browser */ }
  try {
    void fetch("/api/public/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anonId, choice, noticeVersion: NOTICE_VERSION, page: window.location.pathname.slice(0, 200) }),
      keepalive: true,
    }).catch(() => { /* the browser copy still holds; a lost record must never break the page */ });
  } catch { /* no fetch */ }
}

/** Run `fn` with the new choice whenever it changes. Returns the unsubscribe. */
export function onConsentChange(fn: (choice: ConsentChoice) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => fn((e as CustomEvent<ConsentChoice>).detail);
  window.addEventListener(CHANGE_EVENT, h);
  return () => window.removeEventListener(CHANGE_EVENT, h);
}

/** "Cookie settings": open the banner again so the visitor can change (or withdraw) the choice. */
export function openConsentSettings(): void {
  try { window.dispatchEvent(new Event(OPEN_EVENT)); } catch { /* old browser */ }
}

export function onConsentOpen(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(OPEN_EVENT, fn);
  return () => window.removeEventListener(OPEN_EVENT, fn);
}
