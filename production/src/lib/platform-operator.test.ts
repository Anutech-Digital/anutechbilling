import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PLATFORM_OPERATOR } from "./platform";
import { denyTermsRe } from "@/test/deny-terms";

/* ─────────────────────────────────────────────────────────────────────────────
   ResellerOS ko chalane wali company ka naam — public pages par.

   26 Aug 2026, Pardeep: "anutech digital ka logo lagao aur reselleros ko uska product
   show karo". Dekhne par "Demo Co Pvt Ltd" 98 jagah, 55 file me mila — aur
   sabse bura wahan tha jahan sabse kam dikhta hai: **Privacy Policy aur Terms of Service
   me, SERVICE CHALANE WALI ENTITY ke roop me.**

   Ye rename ki galti nahi thi. DB me naapa gaya, GSTIN ke andar chhupe PAN ke 4th char se:

       ANUTECH DIGITAL PVT LTD   07ABDCA0298H1ZP   'C' → Company
       Demo Co        07AAAAP0000A1Z5   'P' → Person (proprietorship)

   Do alag legal entity. Privacy Policy me doosri entity ka naam hona padhne wale se kehta
   hai ki uska data kisi aur ke paas hai.

   Ye test source SCAN hai, render nahi — jo bacha raha hai wo ek naam ki GAIRHAAZRI hai,
   aur wo source me saaf padhti hai. Wahi tarika drawer-layout.test.ts leta hai.
   ───────────────────────────────────────────────────────────────────────────── */

const PUBLIC_FACING = [
  /* ⚠️ `layout.tsx` is list me 26 Aug 2026 ko DEPLOY KE BAAD juda, aur wahi is list ka
     sabak hai. Wo `authors: [{ name: ... }]` rakhta hai, jo HAR page par
     `<meta name="author">` ban kar jaata hai — landing, privacy, terms, sab. Meri pehli
     list me sirf 6 "public page" the, layout unme nahi tha, to test green raha aur purana
     naam LIVE par baith gaya. Maine use curl se live HTML me pakda, test se nahi.

     Sabak: "public-facing" ka matlab wo file nahi jise user KHOLTA hai — wo har file hai
     jiska output user tak PAHUNCHTA hai. Layout, metadata aur manifest usme aate hain. */
  ["root layout",  ["src", "app", "layout.tsx"]],
  /* The public home is now the Anutech marketing page (merge brick #5) — the old
     app landing was removed when `/` became the company's face. */
  ["landing",      ["src", "app", "(marketing)", "page.tsx"]],
  ["public shell", ["src", "app", "(public)", "_components", "public-shell.tsx"]],
  /* R-1606: "landing bits" (landing-sections.tsx) was never rendered and is deleted — the
     live ResellerOS homepage is checked in its place. */
  ["ResellerOS home", ["src", "app", "(product)", "reselleros", "page.tsx"]],
  ["privacy",      ["src", "app", "(public)", "privacy", "page.tsx"]],
  ["terms",        ["src", "app", "(public)", "terms", "page.tsx"]],
  ["about",        ["src", "app", "(public)", "about", "page.tsx"]],
] as const;

const read = (parts: readonly string[]) =>
  readFileSync(join(process.cwd(), ...parts), "utf8");

/* Comments HATA kar. Har file me ek comment ye BATATA hai ki purana naam kyun gaya — aur
   ek blunt scan usi samjhaawat par fail hota, jo wajah ko file se bahar dhakel deta. */
const codeOf = (parts: readonly string[]) =>
  read(parts).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

describe("PLATFORM_OPERATOR — ek jagah, jo DB se mel khati hai", () => {
  it("ANUTECH DIGITAL PVT LTD, uske asli GSTIN ke saath", () => {
    /* GSTIN hardcoded hai kyunki ye wahi hai jo 26 Aug 2026 ko live DB me tha
       (tenants.gstin, tenant fbb976f1…). Agar koi ise badle, to badalna JAAN-BOOJHKAR
       hona chahiye — chup-chaap nahi. */
    expect(PLATFORM_OPERATOR.legalName).toBe("ANUTECH DIGITAL PVT LTD");
    expect(PLATFORM_OPERATOR.gstin).toBe("07ABDCA0298H1ZP");
  });

  it("GSTIN Delhi (07) ka hai — kyunki isi se CGST/SGST ya IGST tay hota hai", () => {
    /* supplier-identity.ts ka poora comment isi par hai: state code galat ho to invoice
       par IGST 18% chapta hai jahan CGST 9% + SGST 9% chahiye tha. Wahi rupaye, galat
       tax head, aur galat sarkar ko paisa. */
    expect(PLATFORM_OPERATOR.gstin.slice(0, 2)).toBe("07");
  });

  it("company aur product do ALAG naam hain", () => {
    /* Inko mila dena wahi galti hai jo is page par pehle se thi: footer company ka naam
       leta tha aur ye kabhi nahi batata tha ki ResellerOS uska product hai. */
    expect(PLATFORM_OPERATOR.productName).toBe("ResellerOS");
    expect(PLATFORM_OPERATOR.legalName).not.toContain(PLATFORM_OPERATOR.productName);
  });

  it("logo public/ me maujood hai — warna footer me tooti tasveer aayegi", () => {
    /* Path string honeke naate ye chup-chaap galat ho sakta hai; file ka hona hi proof
       hai. `<img>` galat src par kuch nahi bolta, bas khaali dikhta hai. */
    expect(PLATFORM_OPERATOR.logo.startsWith("/")).toBe(true);
    const onDisk = join(process.cwd(), "public", PLATFORM_OPERATOR.logo.replace(/^\//, ""));
    expect(() => readFileSync(onDisk)).not.toThrow();
  });
});

describe("public pages par purani entity ka naam nahi", () => {
  for (const [label, parts] of PUBLIC_FACING) {
    it(`${label} — "Demo Co" kahin nahi`, () => {
      expect(codeOf(parts)).not.toMatch(denyTermsRe());
    });
  }

  it("grahak ko jaane wale message me kisi doosri company ka naam nahi", () => {
    /* Ye do jagah live deploy ke baad mili, aur dono UPAR wali list se bahar thin —
       isliye alag se pinned hain:

         • quotes/[id]/page.tsx — WhatsApp ka body, `me?.tenantName ?? "Demo Co"`.
           `me` load na ho to quote us company ke naam se jaata jo usne bheji hi nahi.
         • tds-detail-dialog.tsx — Form 16A maangne wala message, "Pardeep, Demo Co" se
           sign hota tha.

       Dono ek hi shreni hain jise lib/invoices/supplier-identity.ts poore comment ke saath
       likhti hai: galat company ka naam chhapne se behtar hai naam na chhapna. */
    for (const p of [["src", "app", "(app)", "quotes", "[id]", "page.tsx"],
                     ["src", "components", "features", "accounting", "tds-detail-dialog.tsx"]]) {
      expect(codeOf(p), p.join("/")).not.toMatch(denyTermsRe());
    }
  });

  it("legal pages operator ka naam CONSTANT se lete hain, type karke nahi", () => {
    /* Yahi wo cheez hai jis se ye bug 55 file me phaila: har jagah naam type kiya gaya
       tha. Ek jagah badalne par baaki 54 purani reh jati thin. */
    for (const p of [["src", "app", "(public)", "privacy", "page.tsx"],
                     ["src", "app", "(public)", "terms", "page.tsx"]]) {
      expect(read(p)).toContain("PLATFORM_OPERATOR.legalName");
    }
  });
});

describe("company ka sheher aur server ka region — do alag baatein", () => {
  it("company ka sheher Delhi hai", () => {
    expect(PLATFORM_OPERATOR.city).toMatch(/Delhi/);
    expect(PLATFORM_OPERATOR.address).toMatch(/Delhi/);
  });

  it("server ka region ek constant se aata hai (DATA_LOCATION), sheher se nahi", () => {
    /* Pehle yahan "Mumbai RAHNA chahiye" tha — par 5-6 Sep 2026 se production Singapore
       (asia-southeast1) me hai, to wo test ek purana sach pakde baitha tha (R-1600, 19 Oct).
       Ab region site/lib/config.ts DATA_LOCATION se aata hai; ye pages use hi padhein. */
    expect(codeOf(["src", "app", "(public)", "pricing", "page.tsx"]))
      .toMatch(/DATA_LOCATION\.label/);
    expect(codeOf(["src", "app", "(public)", "about", "page.tsx"]))
      .toMatch(/DATA_LOCATION\.label/);
  });
});
