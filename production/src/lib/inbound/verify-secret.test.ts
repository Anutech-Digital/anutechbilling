import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptedSecrets, secretMatches,
  readInboundSecret, querySecretAllowed, querySecretWarning,
} from "./verify-secret";

describe("acceptedSecrets", () => {
  it("reads a single secret", () => {
    expect(acceptedSecrets("abc123")).toEqual(["abc123"]);
  });

  it("reads two, for a rotation window", () => {
    /* The whole point: "old,new" makes both valid so neither side of the rotation has a
       moment where it is wrong. */
    expect(acceptedSecrets("old-one,new-one")).toEqual(["old-one", "new-one"]);
  });

  it("trims whitespace around each", () => {
    expect(acceptedSecrets(" old , new ")).toEqual(["old", "new"]);
  });

  it("drops blanks instead of treating them as valid", () => {
    /* "old," is a typo. Keeping the empty tail would make a request with NO key at all
       authorised — the exact opposite of what a trailing comma looks like it means. */
    expect(acceptedSecrets("old,")).toEqual(["old"]);
    expect(acceptedSecrets(",,old,,")).toEqual(["old"]);
  });

  it.each([null, undefined, "", "   ", ",", ",,"])("yields nothing for %j", (raw) => {
    expect(acceptedSecrets(raw)).toEqual([]);
  });
});

describe("secretMatches", () => {
  const both = ["old-secret-value", "new-secret-value"];

  it("accepts either secret during a rotation", () => {
    expect(secretMatches("old-secret-value", both)).toBe(true);
    expect(secretMatches("new-secret-value", both)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(secretMatches("wrong", both)).toBe(false);
    expect(secretMatches("old-secret-valu", both)).toBe(false);
    expect(secretMatches("old-secret-value-x", both)).toBe(false);
  });

  it("FAILS CLOSED with no configured secret", () => {
    /* A webhook with nothing configured must not be an open one. This is the posture the
       route already had and the list must not quietly relax it. */
    expect(secretMatches("anything", [])).toBe(false);
    expect(secretMatches("", [])).toBe(false);
  });

  it.each([null, undefined, "", "   "])("rejects %j even when secrets exist", (given) => {
    expect(secretMatches(given, both)).toBe(false);
  });

  it("trims the provided value, because a query string can carry a stray space", () => {
    expect(secretMatches(" old-secret-value ", both)).toBe(true);
  });

  it("is case-sensitive", () => {
    /* These are random strings, not words. Folding case would throw away entropy. */
    expect(secretMatches("OLD-SECRET-VALUE", both)).toBe(false);
  });

  it("does not throw on a length mismatch", () => {
    /* timingSafeEqual throws when the buffers differ in length, which is why length is
       checked first. A guard that throws is a 500, and a 500 on this route makes the
       provider retry a message the idempotency claim will then skip. */
    expect(() => secretMatches("x", both)).not.toThrow();
    expect(secretMatches("x", both)).toBe(false);
  });

  it("handles non-ASCII without crashing", () => {
    expect(secretMatches("पासवर्ड", ["पासवर्ड"])).toBe(true);
    expect(secretMatches("पासवर्ड", ["password"])).toBe(false);
  });
});

/* ══ 28 Aug 2026 — URL me secret = LOG me secret ══════════════════════════════
   gcloud ka access khula aur pehli hi log query me ye dikha (secret yahan kaata hua):

       GET /api/webhooks/inbound-email?key=t81t_…       500
       GET /api/webhooks/inbound-purchase?key=b051…     500

   Cloud Run har request ka poora URL `httpRequest.requestUrl` me likhta hai, to jab tak
   secret query me jata hai wo cleartext me log me baitha rehta hai.

   Query turant band karna galat hota: forwarder POST ke baad thread ko `erp-sent` label
   kar deta hai bina response code dekhe, yaani ek 401 = ek enquiry hamesha ke liye gayi.
   Isliye header ko tarjeeh, query chalti rahe, aur query aane par log me chetavni.
   ══════════════════════════════════════════════════════════════════════════════ */
describe("readInboundSecret — header pehle, aur query ka hisaab rakho", () => {
  const req = (url: string, headers: Record<string, string> = {}) =>
    ({ url, headers: new Headers(headers) });

  it("header se aaye to fromQuery false", () => {
    const r = readInboundSecret(req("https://x.in/api/webhooks/inbound-email", { "x-inbound-secret": "s3cr3t" }));
    expect(r).toEqual({ value: "s3cr3t", fromQuery: false });
  });

  it("query se aaye to pakadta hai — ASLI MAAMLA", () => {
    const r = readInboundSecret(req("https://x.in/api/webhooks/inbound-email?key=s3cr3t"));
    expect(r).toEqual({ value: "s3cr3t", fromQuery: true });
  });

  it("dono ho to HEADER jeetta hai, aur query ka daag nahi lagta", () => {
    /* Ulta kram — jo pehle tha — ka matlab hota ki forwarder migrate karne ke baad bhi,
       agar purana query param URL me reh gaya, to secret log me jata rehta. */
    const r = readInboundSecret(req("https://x.in/a?key=purana", { "x-inbound-secret": "naya" }));
    expect(r).toEqual({ value: "naya", fromQuery: false });
  });

  it("kuch na ho to khaali, aur fromQuery false", () => {
    expect(readInboundSecret(req("https://x.in/a"))).toEqual({ value: "", fromQuery: false });
  });

  it("khaali key= ko 'query se aaya' nahi maanta", () => {
    /* `?key=` par chetavni likhna shor hai — usme secret hai hi nahi. */
    expect(readInboundSecret(req("https://x.in/a?key="))).toEqual({ value: "", fromQuery: false });
  });

  it("aas-paas ka space hata deta hai, dono taraf", () => {
    expect(readInboundSecret(req("https://x.in/a", { "x-inbound-secret": "  s  " })).value).toBe("s");
    expect(readInboundSecret(req("https://x.in/a?key=%20s%20")).value).toBe("s");
  });
});

describe("querySecretAllowed — R-1554: header hi default, ?key= sirf legacy flag se", () => {
  it("default BAND hai — env na ho tab bhi ?key= mana (secret URL = secret log me)", () => {
    expect(querySecretAllowed({})).toBe(false);
    expect(querySecretAllowed({ INBOUND_REQUIRE_HEADER: "" })).toBe(false);
    expect(querySecretAllowed({ INBOUND_REQUIRE_HEADER: "0" })).toBe(false);
    expect(querySecretAllowed({ INBOUND_ALLOW_QUERY_SECRET: "0" })).toBe(false);
    expect(querySecretAllowed({ INBOUND_ALLOW_QUERY_SECRET: "true" })).toBe(false);
  });

  it("sirf INBOUND_ALLOW_QUERY_SECRET=1 (purana forwarder) par khulta hai", () => {
    expect(querySecretAllowed({ INBOUND_ALLOW_QUERY_SECRET: "1" })).toBe(true);
    expect(querySecretAllowed({ INBOUND_ALLOW_QUERY_SECRET: " 1 " })).toBe(true);
  });

  it("INBOUND_REQUIRE_HEADER=1 legacy flag ko bhi hara deta hai", () => {
    expect(querySecretAllowed({ INBOUND_ALLOW_QUERY_SECRET: "1", INBOUND_REQUIRE_HEADER: "1" })).toBe(false);
  });

  it("process.env padhta hai jab kuch na diya ho", () => {
    const keep = { a: process.env.INBOUND_ALLOW_QUERY_SECRET, r: process.env.INBOUND_REQUIRE_HEADER };
    try {
      delete process.env.INBOUND_ALLOW_QUERY_SECRET; delete process.env.INBOUND_REQUIRE_HEADER;
      expect(querySecretAllowed()).toBe(false);
      process.env.INBOUND_ALLOW_QUERY_SECRET = "1";
      expect(querySecretAllowed()).toBe(true);
    } finally {
      if (keep.a === undefined) delete process.env.INBOUND_ALLOW_QUERY_SECRET; else process.env.INBOUND_ALLOW_QUERY_SECRET = keep.a;
      if (keep.r === undefined) delete process.env.INBOUND_REQUIRE_HEADER; else process.env.INBOUND_REQUIRE_HEADER = keep.r;
    }
  });
});

describe("querySecretWarning — chetavni me secret nahi jata", () => {
  it("secret ko log me nahi likhta — warna wahi galti doosre darwaze se", () => {
    const w = querySecretWarning("webhooks/inbound-email");
    expect(w).toContain("webhooks/inbound-email");
    expect(w).not.toMatch(/key=/);
    expect(w).toMatch(/x-inbound-secret/);          // ab kya karein
    expect(w).toMatch(/INBOUND_ALLOW_QUERY_SECRET/); // aur uske baad kya hatana hai
    /* health-digest / health-prod is shabd se is chetavni ko log me dhoondhte hain. */
    expect(w).toMatch(/INBOUND_REQUIRE_HEADER/);
  });
});

/* ══ Teeno route ek hi faisla use karein ═════════════════════════════════════ */
describe("teeno inbound route ek hi jagah se secret padhein", () => {
  const read = (p: string) =>
    readFileSync(join(process.cwd(), ...p.split("/")), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const ROUTES = [
    "src/app/api/webhooks/inbound-email/route.ts",
    "src/app/api/webhooks/inbound-purchase/route.ts",
    "src/app/api/v1/integrations/support-email-inbound/route.ts",
  ];

  it("koi bhi route khud searchParams se key nahi nikalta", () => {
    for (const p of ROUTES) {
      expect(read(p), p).not.toMatch(/searchParams\.get\(["']key["']\)/);
      expect(read(p), p).toContain("readInboundSecret(request)");
    }
  });

  it("teeno rotation-wali list se compare karte hain — purchase yahi chhod gaya tha", () => {
    /* inbound-purchase `provided !== INBOUND_SECRET` kar raha tha. Do nateeje: env var
       "old,new" hone par wo route poori string maangta (yaani rotation chup-chaap tootta),
       aur compare constant-time nahi tha. Teen ek jaisi copy me ek ka alag hona aankh se
       nahi pakda jata — isliye ye assert source par pinned hai. */
    for (const p of ROUTES) {
      expect(read(p), p).toContain("secretMatches(secret.value, acceptedSecrets(INBOUND_SECRET))");
      expect(read(p), p).not.toMatch(/provided\s*!==\s*INBOUND_SECRET/);
    }
  });

  it("teeno INBOUND_REQUIRE_HEADER ko maante hain", () => {
    for (const p of ROUTES) expect(read(p), p).toContain("querySecretAllowed()");
  });

  it("chetavni sahi secret ke BAAD likhi jaati hai", () => {
    /* Warna koi bhi galat key thok kar log bhar sakta hai. */
    for (const p of ROUTES) {
      const src = read(p);
      const guard = src.indexOf("secretMatches(secret.value");
      const warn = src.indexOf("querySecretWarning(");
      expect(guard, p).toBeGreaterThan(-1);
      expect(warn, `${p}: chetavni guard se pehle hai`).toBeGreaterThan(guard);
    }
  });
});
