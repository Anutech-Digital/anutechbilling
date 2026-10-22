import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  unionScopes, scopesLost, scopeLossMessage, CONTACTS_SCOPE, GMAIL_SEND_SCOPE,
  hasContactsScope, hasGmailSendScope, CONTACTS_SCOPE_MISSING_MESSAGE,
} from "./scope-union";

/* ─────────────────────────────────────────────────────────────────────────────
   26 Aug 2026. Pardeep ka Google Contacts sync 11 din chup-chaap band tha, aur wo screen
   par kahin nahi dikha — pakda tab gaya jab `user_google_tokens.last_error` padhi gayi
   aur usme People API ka 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT nikla.

   Wajah: Contacts aur Gmail ek hi row likhte hain, aur Gmail consent ne contacts grant
   dhak diya. `include_granted_scopes: "true"` guard PEHLE SE maujood tha (08 Aug), Gmail
   flow uske baad bana (13 Aug) — phir bhi hua, kyunki wo flag Google se UMEED hai, aur
   consent screen par checkbox untick ho sakta hai.

   Neeche ke test asli naap par baithe hain — 15 Aug ko sync chal raha tha, aur ab jo
   scopes DB me hain wo bilkul ye hain.
   ───────────────────────────────────────────────────────────────────────────── */

/** Jo aaj Pardeep ke row me hai — send-only. */
const SEND_ONLY = `openid email ${GMAIL_SEND_SCOPE}`;
/** Jo 08–15 Aug ke beech tha, jab sync chal raha tha. */
const CONTACTS_ONLY = `openid email ${CONTACTS_SCOPE}`;

describe("unionScopes — jo mila hua hai wo maango bhi", () => {
  it("Gmail connect karte waqt contacts bhi maangta hai — ASLI MAAMLA", () => {
    const asked = unionScopes(SEND_ONLY, CONTACTS_ONLY);
    expect(asked).toContain(GMAIL_SEND_SCOPE);
    expect(asked).toContain(CONTACTS_SCOPE);
  });

  it("ulti disha me bhi — Contacts dobara connect karna bhejna na tode", () => {
    const asked = unionScopes(CONTACTS_ONLY, SEND_ONLY);
    expect(asked).toContain(CONTACTS_SCOPE);
    expect(asked).toContain(GMAIL_SEND_SCOPE);
  });

  it("dohrata nahi", () => {
    const asked = unionScopes(SEND_ONLY, SEND_ONLY);
    expect(asked.split(/\s+/).filter((s) => s === GMAIL_SEND_SCOPE)).toHaveLength(1);
    expect(asked.split(/\s+/).length).toBe(3);
  });

  it("pehli baar connect — kuch pehle se nahi, to jo maanga wahi", () => {
    expect(unionScopes(SEND_ONLY, null)).toBe(SEND_ONLY);
    expect(unionScopes(SEND_ONLY, "")).toBe(SEND_ONLY);
    expect(unionScopes(SEND_ONLY, undefined)).toBe(SEND_ONLY);
  });

  it("kram sthir rakhta hai", () => {
    /* Ye value DB me likhi jaati hai. Badalta kram har reconnect par ek jhootha "badal
       gaya" dikhata, aur diff padhne wale ka waqt khata. */
    expect(unionScopes(SEND_ONLY, CONTACTS_ONLY)).toBe(unionScopes(SEND_ONLY, CONTACTS_ONLY));
    expect(unionScopes(SEND_ONLY, CONTACTS_ONLY).startsWith("openid email")).toBe(true);
  });

  it("bikhri hui whitespace par bhi tootta nahi", () => {
    expect(unionScopes("  a   b ", " b  c ")).toBe("a b c");
  });
});

describe("scopesLost — chup-chaap gaya hua grant pakdo", () => {
  it("contacts ka gir jana pakadta hai — YAHI 11 din chhupa raha", () => {
    expect(scopesLost(CONTACTS_ONLY, SEND_ONLY)).toEqual([CONTACTS_SCOPE]);
  });

  it("ulta nuksaan bhi pakadta hai", () => {
    expect(scopesLost(SEND_ONLY, CONTACTS_ONLY)).toEqual([GMAIL_SEND_SCOPE]);
  });

  it("union bacha ho to kuch nahi khoya", () => {
    const both = unionScopes(SEND_ONLY, CONTACTS_ONLY);
    expect(scopesLost(CONTACTS_ONLY, both)).toEqual([]);
    expect(scopesLost(both, both)).toEqual([]);
  });

  it("pehli baar connect par kuch khoya hua nahi hai", () => {
    expect(scopesLost(null, SEND_ONLY)).toEqual([]);
    expect(scopesLost("", SEND_ONLY)).toEqual([]);
  });

  it("openid/email ke aane-jaane par shor nahi machata", () => {
    /* Sirf wo do scope dekhi jaati hain jinse feature chalta hai. `openid` gir jane par
       koi integration nahi tootta, aur us par chetavni dena ek asli chetavni ko shor me
       dabana hota. */
    expect(scopesLost(`openid email ${GMAIL_SEND_SCOPE}`, GMAIL_SEND_SCOPE)).toEqual([]);
  });

  it("naya token khaali aaye to bhi nuksaan bata deta hai", () => {
    expect(scopesLost(CONTACTS_ONLY, null)).toEqual([CONTACTS_SCOPE]);
  });
});

describe("scopeLossMessage — §24: kya hua, kyun, ab kya", () => {
  it("kuch nahi khoya to null — koi jhoothi chetavni nahi", () => {
    expect(scopeLossMessage([])).toBeNull();
  });

  it("naam leta hai, wajah deta hai, aur agla kadam batata hai", () => {
    const m = scopeLossMessage([CONTACTS_SCOPE]) ?? "";
    expect(m).toMatch(/Contacts/);
    expect(m).toMatch(/untick/i);          // kyun hua
    expect(m).toMatch(/[Cc]onnect again/); // ab kya karein
  });

  it("dono khoye ho to dono ka naam", () => {
    const m = scopeLossMessage([CONTACTS_SCOPE, GMAIL_SEND_SCOPE]) ?? "";
    expect(m).toMatch(/Contacts/);
    expect(m).toMatch(/Gmail/);
  });
});

/* ══ Routes is bachaav se jude rahein ════════════════════════════════════════ */
describe("connect aur callback isi function se guzarte hain", () => {
  const read = (p: readonly string[]) =>
    readFileSync(join(process.cwd(), ...p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("dono connect route union maangte hain", () => {
    /* Ek taraf lagana aadha kaam hai: phir Contacts dobara connect karna Gmail ko tod
       dega — wahi bug, doosri disha me. */
    for (const p of [
      ["src", "app", "api", "integrations", "google-gmail", "connect", "route.ts"],
      ["src", "app", "api", "integrations", "google-contacts", "connect", "route.ts"],
    ]) {
      expect(read(p), p.join("/")).toContain("unionScopes(");
    }
  });

  it("purani scopes ADMIN client se padhi jaati hain — user client se nahi", () => {
    /* Ye test pehli koshish ke fail hone ke baad juda, aur wo fail chup-chaap thi.
       Maine ye query pehle user client (`supabase`) se likhi thi. Naapa gaya 26 Aug 2026:

           user_google_tokens → RLS ON, policies 0

       Zero policy ke saath user client us table se KUCH nahi padh sakta, aur khaali lautata
       hai — error nahi. To `prior.scopes` hamesha khaali, union hamesha no-op, aur route
       "chalta hua" dikhta rahega jabki wo apne hi maqsad ke ulat kaam karega: consent grant
       sankuchit kar dega.

       Browser me pakda gaya, test se nahi — contacts connect ka scope param me `contacts`
       tha aur `gmail.send` nadarad. Isliye ab ye source par pinned hai.

       `.eq("user_id", user.id)` hi suraksha hai (admin ke saath RLS nahi hota), aur wo
       neeche wale assert me shamil hai. */
    for (const p of [
      ["src", "app", "api", "integrations", "google-gmail", "connect", "route.ts"],
      ["src", "app", "api", "integrations", "google-contacts", "connect", "route.ts"],
    ]) {
      const src = read(p);
      expect(src, p.join("/")).toMatch(
        /createAdminClient\(\)\s*\n?\s*\.from\("user_google_tokens"\)/,
      );
      /* Bina is filter ke admin read kisi bhi user ki row de sakta hai. */
      expect(src, p.join("/")).toContain('.eq("user_id", user.id)');
    }
  });

  it("gmail callback nuksaan ko DB me likhta hai, chup nahi rehta", () => {
    const cb = read(["src", "app", "api", "integrations", "google-gmail", "callback", "route.ts"]);
    expect(cb).toContain("scopesLost(");
    /* `last_error: null` wapas aana matlab nuksaan phir chup ho gaya — 11 din wala haal. */
    expect(cb).toContain("last_error: lossNote");
    expect(cb).not.toContain("last_error: null");
  });
});

/* ══ 28 Aug 2026 — wahi bug, teesri shakl ════════════════════════════════════
   Pardeep ne Contacts dobara connect kiya (token 13:03 par likha gaya) aur "Sync now"
   dabaya. Toast me Google ka kaccha JSON aaya: 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT.

   DB me us waqt:
       scopes      gmail.send userinfo.email openid     ← contacts phir bhi nadarad
       updated_at  28 Aug 13:03                          ← flow poora hua tha

   Upar ke saare test paas the, aur ek bhi is haalat ko nahi dekh raha tha — kyunki wo sab
   "kuch KHOYA?" poochhte hain. Yahan khoya kuch nahi (purane token me bhi contacts nahi
   thi). MILA kuch nahi, aur wo ek alag sawaal hai jo koi nahi poochh raha tha.

   Isliye card ne hara "Connected" dikhaya, "Sync now" ne 403 laaya, aur wajah sirf DB me
   padi rahi — theek wahi jagah jahan 26 Aug ko padi thi.
   ═════════════════════════════════════════════════════════════════════════════ */

/** Jo 28 Aug 13:03 par asli row me tha — reconnect ke BAAD. */
const AFTER_RECONNECT_28AUG = "https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email openid";

describe("hasContactsScope — 'jo chahiye tha wo mila?'", () => {
  it("28 Aug ka asli token sync nahi kar sakta — ASLI MAAMLA", () => {
    expect(hasContactsScope(AFTER_RECONNECT_28AUG)).toBe(false);
  });

  it("aur scopesLost is haalat me chup rehta hai — isliye doosri jaanch chahiye thi", () => {
    /* Ye assert is poore fix ki wajah hai: purani scopes me bhi contacts nahi thi, to
       "nuksaan" shunya hai aur scopeLossMessage null deta hai. Sirf uske bharose card
       hara "Connected" dikhata raha. */
    expect(scopesLost(AFTER_RECONNECT_28AUG, AFTER_RECONNECT_28AUG)).toEqual([]);
    expect(scopeLossMessage(scopesLost(AFTER_RECONNECT_28AUG, AFTER_RECONNECT_28AUG))).toBeNull();
  });

  it("contacts mili ho to haan", () => {
    expect(hasContactsScope(CONTACTS_ONLY)).toBe(true);
    expect(hasContactsScope(unionScopes(CONTACTS_ONLY, AFTER_RECONNECT_28AUG))).toBe(true);
  });

  it("khaali/null par jhoothi haan nahi", () => {
    expect(hasContactsScope(null)).toBe(false);
    expect(hasContactsScope(undefined)).toBe(false);
    expect(hasContactsScope("")).toBe(false);
  });

  it("contacts.readonly ko contacts nahi maanta", () => {
    /* App `auth/contacts` (read+write) maangti hai kyunki sync do-tarfa hai — push bhi
       karta hai. readonly aa jaye to pull chalega aur push 403 dega, jo aadha-toota
       integration hai. Aadhe ko "connected" kehna wahi jhoot hai jo ye fix hata raha hai. */
    expect(hasContactsScope(`openid email ${CONTACTS_SCOPE}.readonly`)).toBe(false);
  });

  it("gmail send ka jodidar bhi wahi jawab deta hai", () => {
    expect(hasGmailSendScope(AFTER_RECONNECT_28AUG)).toBe(true);
    expect(hasGmailSendScope(CONTACTS_ONLY)).toBe(false);
  });
});

describe("CONTACTS_SCOPE_MISSING_MESSAGE — §24, aur Google ki bhasha me nahi", () => {
  it("kya hua, kyun, ab kya — teenon", () => {
    const m = CONTACTS_SCOPE_MISSING_MESSAGE;
    expect(m).toMatch(/Contacts/);                    // kya
    expect(m).toMatch(/checkbox|tick/i);              // kyun
    expect(m).toMatch(/[Rr]econnect|dobara connect/); // ab kya
  });

  it("na JSON, na scope ka URL, na Google ka error code", () => {
    /* Yahi string card par dikhti hai. Pardeep ko ACCESS_TOKEN_SCOPE_INSUFFICIENT
       padhwana koi jawab nahi hai — 28 Aug ko toast me theek wahi aaya tha. */
    for (const leak of ["ACCESS_TOKEN_SCOPE_INSUFFICIENT", "PERMISSION_DENIED", "403", "googleapis.com", "{"]) {
      expect(CONTACTS_SCOPE_MISSING_MESSAGE, leak).not.toContain(leak);
    }
  });
});

describe("contacts flow ke chaar chokepoint is jaanch se jude rahein", () => {
  const read2 = (p: readonly string[]) =>
    readFileSync(join(process.cwd(), ...p), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("contacts callback 'mila?' bhi naapta hai, sirf 'khoya?' nahi", () => {
    const cb = read2(["src", "app", "api", "integrations", "google-contacts", "callback", "route.ts"]);
    expect(cb).toContain("hasContactsScope(");
    expect(cb).toContain("scopesLost(");
    /* `last_error: null` wapas aana matlab wajah phir chup ho gayi. */
    expect(cb).not.toContain("last_error: null");
    /* Aur "connected" bolna band ho jab contacts na aayi ho. */
    expect(cb).toContain("noscope");
  });

  it("sync ka chokepoint People API se PEHLE rok deta hai", () => {
    /* getFreshAccessToken se manual sync aur nightly cron dono guzarte hain — ek hi
       jagah par jaanch dono ko dhakti hai. */
    const c = read2(["src", "lib", "google", "contacts.ts"]);
    expect(c).toContain("hasContactsScope(tok.scopes)");
    expect(c).toContain("CONTACTS_SCOPE_MISSING_MESSAGE");
    /* Jaanch ke liye scope column select hona zaroori hai, warna hamesha undefined. */
    expect(c).toMatch(/select\("access_token, refresh_token, token_expiry, scopes"\)/);
  });

  it("status route 'row hai' aur 'kaam hoga' ko alag rakhta hai", () => {
    const r = read2(["src", "app", "api", "integrations", "google-contacts", "route.ts"]);
    expect(r).toContain("can_sync");
    /* Derivation SHARED helper se — server aur card do jagah do tarah se ye tay karein,
       wahi drift hai jisse "Connected" ka jhoot paida hua tha. */
    expect(r).toContain("canSyncWithScopes(");
    /* Scope string browser ko nahi bhejte — jawab bhejte hain, saboot nahi. */
    expect(r).not.toMatch(/scopes:\s*data/);
  });

  it("card us haalat me Sync ki jagah Reconnect deta hai", () => {
    /* "Sync now" dena ek 403 laane wala button dena hai — §24 kehta hai wahi jagah
       dikhao jahan cheez theek hoti hai.

       Card ka BAAKI vyavhaar yahan grep se nahi naapa jata — dekho
       contacts-card-state.test.ts. Wo file isliye bani ki is jagah ki ek grep-test ek
       feature-marne wali mutation par bhi green rah gayi thi. */
    const s = read2(["src", "app", "(app)", "settings", "page.tsx"]);
    expect(s).toContain("contactsCardState(status)");
    expect(s).toContain("google-contacts/connect");
    expect(s).toMatch(/needsReconsent\s*\?[\s\S]{0,400}Reconnect/);
  });
});
