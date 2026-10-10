/**
 * Ek Google connection doosre ko na tode.
 *
 * ─── YE KYUN BANA ───────────────────────────────────────────────────────────
 * 26 Aug 2026. Pardeep ka Google Contacts sync chup-chaap band tha —
 * `user_google_tokens.last_error` me People API ka
 * `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` pada tha. Naapa gaya:
 *
 *     token bana          08 Aug 20:10   (contacts grant)
 *     Gmail send flow     13 Aug 23:41
 *     aakhri safal sync   15 Aug 18:00
 *     ab scopes           gmail.send userinfo.email openid   ← contacts gayab
 *
 * Contacts aur Gmail EK HI row likhte hain (`user_google_tokens`, ek per user).
 * `buildAuthUrl` me `include_granted_scopes: "true"` pehle se tha — theek isi trap ke
 * liye, aur uska comment usi 403 ka naam leta hai. Guard Gmail flow SE PEHLE se maujood
 * tha, aur phir bhi ye hua.
 *
 * Wajah usi repo me likhi hui thi, doosri file me — gmail callback ka comment:
 *
 *     "Google can return a token for FEWER scopes than were asked for: the consent
 *      screen lets a user untick individual permissions."
 *
 * Yaani `include_granted_scopes` ek UMEED hai, guarantee nahi. Us par poora bharosa karke
 * hum ek aisa token store kar rahe the jo perfectly authenticate hota hai aur doosre
 * integration ko mar deta hai — bina kisi error ke, kisi screen par.
 *
 * ─── HAL: union MAANGO, umeed mat karo ──────────────────────────────────────
 * Naya connect karte waqt jo scope pehle se granted hain unhe REQUEST me hi jod dete hain.
 * Tab consent screen dono cheezein dikhata hai, user dono dekh kar haan kehta hai, aur
 * Google ko union khud karna hi nahi padta.
 *
 * Aur callback me naapte hain ki kuch KHOYA to nahi — kyunki user ab bhi untick kar sakta
 * hai, aur us haalat me chup rehna wahi bug hai jise ye file theek karne aayi hai.
 */

/** `contacts` ke bina sync 403 deta hai — People API isi ko maangti hai. */
export const CONTACTS_SCOPE = "https://www.googleapis.com/auth/contacts";
/** Iske bina bhejna 403 deta hai. */
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
/** Business Profile — iske bina listing sync 403 deta hai. */
export const GBP_SCOPE = "https://www.googleapis.com/auth/business.manage";
/** Google Ads — iske bina spend sync 403 deta hai. */
export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
/** Google Workspace Reseller (R-824) — iske bina subscriptions.list 403 deta hai. */
export const RESELLER_SCOPE = "https://www.googleapis.com/auth/apps.order";
/** Read-only variant — older tokens may carry it; enough for subscriptions.list. */
export const RESELLER_READONLY_SCOPE = "https://www.googleapis.com/auth/apps.order.readonly";

const split = (s: string | null | undefined): string[] =>
  (s ?? "").split(/\s+/).map((x) => x.trim()).filter(Boolean);

/**
 * Jo maang rahe hain + jo pehle se mila hua hai, ek space-separated string me.
 *
 * Kram sthir rakha gaya hai (pehle `wanted`, phir naye purane) — badalta kram ek diff ko
 * bina wajah shor bana deta hai, aur ye value DB me likhi jaati hai.
 */
export function unionScopes(
  wanted: string,
  existing: string | null | undefined,
): string {
  const out = split(wanted);
  for (const s of split(existing)) if (!out.includes(s)) out.push(s);
  return out.join(" ");
}

/**
 * Naye token ne kaun si PEHLE SE MAUJOOD scope kho di?
 *
 * Khaali array = kuch nahi khoya. Ye sirf un scopes ko dekhta hai jo asli me kaam karti
 * hain (`contacts`, `gmail.send`) — `openid`/`email` ke aane-jaane par shor machana
 * bekaar hai, unse koi feature nahi tootta.
 */
export function scopesLost(
  before: string | null | undefined,
  after: string | null | undefined,
): string[] {
  const had = split(before);
  const has = split(after);
  return [CONTACTS_SCOPE, GMAIL_SEND_SCOPE, GBP_SCOPE, GOOGLE_ADS_SCOPE, RESELLER_SCOPE].filter(
    (s) => had.includes(s) && !has.includes(s),
  );
}

/**
 * Us nuksaan ko aadmi ki bhasha me — CLAUDE.md §24: kya hua, kyun, ab kya karein.
 * `null` jab kuch nahi khoya.
 */
export function scopeLossMessage(lost: readonly string[]): string | null {
  if (lost.length === 0) return null;
  const names = lost.map((s) =>
    s === CONTACTS_SCOPE ? "Google Contacts sync" : s === RESELLER_SCOPE ? "Google Reseller sync" : s === GBP_SCOPE ? "Google Business Profile sync" : s === GOOGLE_ADS_SCOPE ? "Google Ads spend sync" : "Gmail se bhejna",
  );
  return (
    `Ye connection ne ${names.join(" aur ")} ki permission hata di. ` +
    `Google ke consent screen par wo permission untick reh gayi thi. ` +
    `Dobara connect kariye aur SAARE checkbox tick rehne dijiye — warna ye feature ` +
    `403 deta rahega aur screen par kuch nahi dikhega.`
  );
}

/**
 * Kya is token se Contacts sync ho sakta hai?
 *
 * `scopesLost` se ALAG sawaal hai, aur 28 Aug 2026 ko yahi farak mehnga pada. Us din
 * Pardeep ne Contacts dobara connect kiya; Google ne `contacts` NAHI di (sirf pehle se
 * granted `gmail.send` wapas ki). `scopesLost` chup raha — theek raha, kyunki purane
 * token me bhi contacts nahi thi, to KHOYA kuch nahi. Par MILA bhi kuch nahi, aur uska
 * poochne wala koi nahi tha: card ne hara "Connected" dikhaya aur "Sync now" ne Google ka
 * kaccha 403 JSON toast me ugal diya.
 *
 * Do jaanch chahiye, ek nahi: "kuch khoya?" AUR "jo chahiye tha wo mila?".
 */
export function hasContactsScope(scopes: string | null | undefined): boolean {
  return split(scopes).includes(CONTACTS_SCOPE);
}

/** Wahi sawaal bhejne ke liye. `lib/email/provider` ka `canSendWithScopes` isi ka jodidar hai. */
export function hasGoogleAdsScope(scopes: string | null | undefined): boolean {
  return split(scopes).includes(GOOGLE_ADS_SCOPE);
}

/** R-824: either Reseller scope lets us read subscriptions. */
export function hasResellerScope(scopes: string | null | undefined): boolean {
  const have = split(scopes);
  return have.includes(RESELLER_SCOPE) || have.includes(RESELLER_READONLY_SCOPE);
}

export function hasGbpScope(scopes: string | null | undefined): boolean {
  return split(scopes).includes(GBP_SCOPE);
}

export function hasGmailSendScope(scopes: string | null | undefined): boolean {
  return split(scopes).includes(GMAIL_SEND_SCOPE);
}

/**
 * §24 ki shakl me — kya hua, kyun, ab kya karein. Ye string DB ki `last_error` me jaati
 * hai aur seedha Settings card par dikhti hai, to isme JSON ya scope ka URL nahi hai:
 * Pardeep ko `ACCESS_TOKEN_SCOPE_INSUFFICIENT` padhwana koi jawab nahi hai.
 */
export const CONTACTS_SCOPE_MISSING_MESSAGE =
  "Google ne Contacts padhne ki permission nahi di, isliye sync nahi ho sakta. " +
  "Consent screen par contacts wala checkbox tick nahi hua tha. " +
  "Reconnect kariye aur Google ki screen par SAARE checkbox tick rehne dijiye.";
