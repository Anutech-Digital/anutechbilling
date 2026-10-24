/**
 * Settings ke Google Contacts card ka faisla — ek pure function me.
 *
 * ─── YE FILE EK FAIL HUE TEST SE BANI ───────────────────────────────────────
 * 28 Aug 2026. Fix likhne ke baad maine mutation chalayi: card ki `needsReconsent`
 * ko `false` kar diya — yaani poora feature mar gaya — aur **test green raha**.
 *
 * Wajah: us waqt card ka test source par grep kar raha tha (`can_sync`,
 * `needsReconsent`, `Reconnect` shabd maujood hain ya nahi). Wo shabd mutation ke baad
 * bhi maujood the. Grep-test source ko pin karta hai, VYAVHAAR ko nahi.
 *
 * To faisla page se nikaal kar yahan laaya gaya, jahan use asli input dekar naapa ja
 * sakta hai. Ab wo mutation ke liye jagah hi nahi bachi: branch is function se aati hai
 * aur is function ke test asli payload par baithe hain.
 */
import { hasContactsScope } from "@/lib/google/scope-union";

/** Jo `GET /api/integrations/google-contacts` lautata hai. */
export interface ContactsStatus {
  configured?: boolean;
  connected?: boolean;
  can_sync?: boolean;
  email?: string | null;
  last_synced_at?: string | null;
  last_error?: string | null;
}

export type ContactsCardState =
  /** OAuth keys hi nahi — koi button dabane ka matlab nahi. */
  | { kind: "unconfigured" }
  /** Kabhi juda nahi, ya disconnect kar diya. */
  | { kind: "disconnected" }
  /**
   * Token hai aur authenticate bhi hota hai, par contacts padhne ki permission nahi.
   * Yahi 28 Aug ki haalat thi, aur yahi wo haalat hai jo pehle "Connected" dikhti thi.
   */
  | { kind: "needs_reconsent"; reason: string }
  | { kind: "ready"; email: string | null; lastSyncedAt: string | null };

/** Fallback tab jab server ne wajah nahi bheji (purani row, ya sync se pehle ka token). */
export const RECONSENT_FALLBACK_REASON =
  "Permission to read contacts was not granted — click Reconnect and keep all the checkboxes ticked on Google's screen.";

export function contactsCardState(status: ContactsStatus | null | undefined): ContactsCardState {
  if (!status?.configured) return { kind: "unconfigured" };
  if (!status.connected) return { kind: "disconnected" };
  if (!status.can_sync) {
    return { kind: "needs_reconsent", reason: status.last_error ?? RECONSENT_FALLBACK_REASON };
  }
  return {
    kind: "ready",
    email: status.email ?? null,
    lastSyncedAt: status.last_synced_at ?? null,
  };
}

/**
 * Wahi faisla scope string se, jab payload me `can_sync` na ho.
 *
 * Ye server ke liye hai (callback/cron), aur deliberately usi predicate par baitha hai jo
 * status route use karta hai — do jagah do tarah se ye tay karna wahi drift hai jisse
 * "Connected" ka jhoot paida hua tha.
 */
export function canSyncWithScopes(
  refreshToken: string | null | undefined,
  scopes: string | null | undefined,
): boolean {
  return Boolean(refreshToken) && hasContactsScope(scopes);
}
