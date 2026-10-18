/**
 * The inbound webhook's only guard — and how to rotate it without losing mail.
 *
 * ─── WHY MORE THAN ONE SECRET AT A TIME ─────────────────────────────────────
 * Rotating a single shared secret has a window: whichever side you change first, the other
 * is wrong until you finish. For most systems that means a few failed requests and a retry.
 * Not here.
 *
 * The Apps Script forwarder labels a Gmail thread `erp-sent` AFTER the POST, unconditionally
 * — it never looks at the response code (docs/ENQUIRY-EMAIL-SETUP.md, and the live script
 * Pardeep showed on 23 Aug 2026). So a 401 during the rotation window does not retry: the
 * thread is marked done and that enquiry is gone from the pipeline for good. A five-minute
 * window is five minutes of silently dropped customers.
 *
 * So `INBOUND_EMAIL_SECRET` accepts a COMMA-SEPARATED list, and rotation becomes:
 *   1. set it to "old,new"      → both work, no window
 *   2. update the Apps Script to new
 *   3. set it to "new"          → old is dead
 *
 * ─── AND IT COMPARES IN CONSTANT TIME ───────────────────────────────────────
 * `provided !== SECRET` leaks length and prefix through timing. That is a small
 * consideration for a shared secret in a query string, but this is a PUBLIC endpoint whose
 * only guard is this string, and `timingSafeEqual` costs one import.
 */
import { timingSafeEqual } from "node:crypto";

/**
 * Parses the env var into the list of secrets that are currently valid.
 *
 * An empty or missing value yields an EMPTY list, and `secretMatches` then refuses
 * everything — the same fail-closed posture the route had before. A webhook with no
 * configured secret must not be an open one.
 */
export function acceptedSecrets(raw: string | null | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    /* Blanks dropped rather than kept: "old," is a typo, and treating the empty tail as a
       valid secret would make every request with no key at all authorised. */
    .filter((s) => s.length > 0);
}

export function secretMatches(provided: string | null | undefined, accepted: readonly string[]): boolean {
  const given = (provided ?? "").trim();
  if (!given || accepted.length === 0) return false;

  const a = Buffer.from(given);
  let ok = false;
  for (const candidate of accepted) {
    const b = Buffer.from(candidate);
    /* Length is checked first because timingSafeEqual throws on a mismatch. That does leak
       length, which is unavoidable with this API and not the part worth protecting.

       Every candidate is compared even after a match, so the work does not depend on WHICH
       secret matched — during a rotation that would otherwise reveal whether a caller is on
       the old key or the new one. */
    if (a.length === b.length && timingSafeEqual(a, b)) ok = true;
  }
  return ok;
}

/**
 * Secret kahan se aaya — aur yahi is file ka doosra kaam hai.
 *
 * ─── URL ME SECRET = LOG ME SECRET ──────────────────────────────────────────
 * 28 Aug 2026 ko gcloud ka access khula aur pehli hi log query me ye dikha (yahan secret
 * jaan-boojhkar kaat diya gaya hai):
 *
 *     GET /api/webhooks/inbound-email?key=t81t_…      500
 *     GET /api/webhooks/inbound-purchase?key=b051…    500
 *
 * Cloud Run har request ka POORA URL `httpRequest.requestUrl` me likhta hai. Yaani jab tak
 * secret query me jata hai, wo **cleartext me Cloud Logging me** baitha rehta hai, retention
 * period tak, aur jiske paas log ka access ho use dikh jata hai. Ye is file ke apne comment
 * ko jhootha kar deta tha — usme likha tha "a small consideration for a shared secret in a
 * query string", jabki asli baat ye hai ki query string hi wo jagah hai jahan se leak hota
 * hai.
 *
 * ─── HEADER PEHLE, PAR QUERY ABHI BAND NAHI ─────────────────────────────────
 * Query ko turant mana karna aasan tha aur galat hota: Pardeep ki Apps Script abhi query
 * bhejti hai, aur wo forwarder POST ke baad thread ko `erp-sent` label kar deta hai BINA
 * response code dekhe. Yaani ek 401 retry nahi hota — wo enquiry hamesha ke liye chali
 * jaati hai. Isliye kram ulta hai: pehle header ko tarjeeh, query chalti rahe, aur jab query
 * aaye tab LOG me chetavni — taaki naapa ja sake ki forwarder migrate hua ya nahi.
 *
 * Jab log me chetavni aana band ho jaye, `INBOUND_REQUIRE_HEADER=1` set kar dena — us din
 * se query wala raasta 401 dega, bina naye deploy ke.
 *
 * R-1554 (19 Oct 2026): ye kram ab ulta — query DEFAULT BAND, aur sirf
 * `INBOUND_ALLOW_QUERY_SECRET=1` se (purane forwarder ke liye, chetavni ke saath) khulta hai.
 * Neeche `querySecretAllowed` dekho.
 */
export interface ProvidedSecret {
  /** Jo mila (ho sakta hai khaali). */
  value: string;
  /**
   * `true` jab secret URL se aaya — yaani wo abhi request log me cleartext likha ja chuka
   * hai. Ye jaankari route ko chetavni likhne ke liye chahiye.
   */
  fromQuery: boolean;
}

/**
 * Teeno inbound route ke liye ek hi jagah.
 *
 * Pehle ye faisla teen file me copy tha, aur teesri (`inbound-purchase`) usi copy-paste me
 * `secretMatches` chhod kar raw string compare kar rahi thi — jisse rotation wahan chup-chaap
 * toot jata. Ek jagah rakhne se wo shakl dobara nahi ban sakti.
 */
export function readInboundSecret(request: { url: string; headers: Headers }): ProvidedSecret {
  const header = (request.headers.get("x-inbound-secret") ?? "").trim();
  if (header) return { value: header, fromQuery: false };
  const query = (new URL(request.url).searchParams.get("key") ?? "").trim();
  return { value: query, fromQuery: query.length > 0 };
}

/**
 * R-1554 (19 Oct 2026): ab DEFAULT BAND hai — `?key=` sirf tab maana jaata hai jab
 * `INBOUND_ALLOW_QUERY_SECRET=1` jaan-boojhkar set ho (koi purana forwarder jo abhi header nahi
 * bhej sakta). Pehle default khula tha aur sirf `INBOUND_REQUIRE_HEADER=1` band karta tha — yaani
 * jis deploy par wo env bhool gaya, wahan secret URL me chalta aur Cloud Run log me cleartext
 * baithta. `INBOUND_REQUIRE_HEADER=1` ab bhi maana jaata hai (live par 28 Aug se laga hai) aur
 * legacy flag ko bhi hara deta hai.
 *
 * Jab legacy flag se query maani jaati hai, route `querySecretWarning` log karta hai — wahi
 * chetavni batati hai ki forwarder abhi migrate nahi hua.
 */
export function querySecretAllowed(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if ((env.INBOUND_REQUIRE_HEADER ?? "").trim() === "1") return false;
  return (env.INBOUND_ALLOW_QUERY_SECRET ?? "").trim() === "1";
}

/**
 * Log ke liye ek line — aur isme secret NAHI hota.
 *
 * Poora point hi secret ko log se bahar rakhna hai; use chetavni me likh dena wahi galti
 * doosre darwaze se karna hoga.
 */
export function querySecretWarning(label: string): string {
  /* "INBOUND_REQUIRE_HEADER" shabd rehna chahiye — lib/ops/health-digest.ts aur
     scripts/health-prod.mjs isi se is chetavni ko log me dhoondhte hain. */
  return `[${label}] shared secret URL me aaya (INBOUND_ALLOW_QUERY_SECRET=1 ki wajah se maana), isliye wo is request ke log me cleartext hai. ` +
    `Bhejne wale ko \`x-inbound-secret\` header par le jaao, phir INBOUND_ALLOW_QUERY_SECRET hatao (default = INBOUND_REQUIRE_HEADER jaisa, sirf header).`;
}
