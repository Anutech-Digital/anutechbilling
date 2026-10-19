/**
 * PLATFORM_OPERATOR — ResellerOS ko chalane wali company, ek hi jagah.
 *
 * ─── YE CONSTANT KYUN BANA ──────────────────────────────────────────────────
 * 26 Aug 2026. "Demo Co" 98 jagah, 55 file me likha hua tha — landing page ke
 * footer se lekar Privacy Policy aur Terms of Service tak, jahan wo SERVICE CHALANE WALI
 * ENTITY ke roop me naamzad thi. Wo galat hai: ResellerOS ANUTECH DIGITAL PVT LTD
 * chalati hai (CLAUDE.md §1).
 *
 * Aur ye do naam ek company ke do naam NAHI hain — DB me naapa gaya:
 *
 *     ANUTECH DIGITAL PVT LTD   07ABDCA0298H1ZP   PAN ka 4th char 'C' → Company
 *     Demo Co        07AAAAP0000A1Z5   PAN ka 4th char 'P' → Person
 *
 * Yaani ek Pvt Ltd hai aur doosri proprietorship. Privacy Policy me galat entity ka naam
 * hona rename ki galti nahi hai — wo kehta hai ki aapka data kisi aur ke paas hai.
 *
 * Isliye ab ye ek constant hai. Agli baar badalna pade to EK jagah badlegi — 55 nahi.
 * Naya public page banate waqt naam TYPE mat karo, yahan se lo.
 *
 * ⚠️ Ye PLATFORM ki pehchan hai — kisi tenant ki nahi. Invoice par chhapne wali supplier
 * identity tenant ki row se aati hai, `lib/invoices/supplier-identity.ts` se; usko yahan
 * se kabhi na bharo, warna har tenant ke invoice par ANUTECH ka naam chala jayega.
 */
export const PLATFORM_OPERATOR = {
  /** Poora legal naam — Privacy/Terms jaise legal text me yahi chahiye. */
  legalName: "ANUTECH DIGITAL PVT LTD",
  /** Chhota naam, chalte-firte text ke liye ("an ANUTECH DIGITAL product"). */
  shortName: "ANUTECH DIGITAL",
  /** Bika jane wala product. Company nahi — do alag cheezein. */
  productName: "ResellerOS",
  gstin: "07ABDCA0298H1ZP",
  /** DB ki `tenants.address` se, jaisa hai waisa (26 Aug 2026). */
  address: "Plot no. B-9/54 Sector 5, Rohini, Delhi, 110085, India",
  /** Sirf sheher — footer jaisi jagah ke liye jahan poora address bahut lamba hai. */
  city: "Rohini, Delhi",
  logo: "/anutech-digital-logo.png",
  /** Directors — CLAUDE.md §1. */
  directors: ["Pardeep Sharma", "Deepak Sharma"],
  contactEmail: "pardeep@anutech.in",
} as const;

/**
 * Platform (super-admin) allowlist — the ResellerOS FOUNDER accounts that may
 * see cross-tenant signup data. This is the ONLY thing that grants god-mode;
 * a tenant can never flip a flag to get in. The real gate is the server API
 * (which re-checks the caller's authenticated email against this list before
 * touching the service-role client).
 *
 * Override with the SERVER-ONLY env PLATFORM_ADMIN_EMAILS="a@x.com,b@y.com".
 *
 * R-730 (19 Oct 2026): this used to read NEXT_PUBLIC_PLATFORM_ADMIN_EMAILS first. A
 * NEXT_PUBLIC_ variable is copied into the browser bundle at build time, so the list of
 * god-mode addresses was readable by anyone who opened the app's JS. The browser no longer
 * needs the list — useCurrentUser asks GET /api/platform/whoami — so it lives only on the
 * server. The old name is still honoured ON THE SERVER until the deploy env is renamed
 * (stagingStep on R-730); it is read through a computed key on purpose, because Next.js
 * inlines only literal `process.env.NEXT_PUBLIC_*` accesses into the bundle.
 * Guard: src/lib/security/no-public-admin-env.test.ts.
 */
// R-1432: only the operator's own address is a default; any other admin comes from env.
const DEFAULT_PLATFORM_ADMINS = ["pardeep@anutech.in"];
/** Pre-R-730 name — server-side fallback only. Never write it as a literal env access. */
const LEGACY_ADMIN_ENV = ["NEXT", "PUBLIC", "PLATFORM", "ADMIN", "EMAILS"].join("_");

export function platformAdminEmails(): string[] {
  const env =
    process.env.PLATFORM_ADMIN_EMAILS ||
    (typeof window === "undefined" ? process.env[LEGACY_ADMIN_ENV] : undefined);
  const list = (env ? env.split(",") : DEFAULT_PLATFORM_ADMINS).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list;
}

/** SERVER ONLY — the browser gets the answer from GET /api/platform/whoami. */
export function isPlatformAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  return platformAdminEmails().includes(email.trim().toLowerCase());
}
