import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lineIsPerInvoice, annualContractValue } from "./invoice-divisor";

/* ─────────────────────────────────────────────────────────────────────────────
   FLEX PAR SAAL KA KOI AANKDA NAHI CHHAPNA CHAHIYE.

   Pehle maine sirf ganit theek ki thi: "Annual contract value" ko 12 se guna kar diya,
   kyunki flex ka stored total EK MAHINE ka hai. Wo galti se kam tha — par Pardeep ne 31 Aug
   2026 ko asli baat pakdi:

     "monthly commitment me annual billing ki to koi jarurat hi nahi hai kyoki wo to
      flexible hota hai — chahe aap ek mahina lo ya do mahina"

   Yaani samasya aankde ki nahi, DAAWE ki thi. Flex par customer ne saal ka koi vaada kiya hi
   nahi. Us saal ko zyada sahi tarike se chhapna use asli nahi bana deta.

   Aur ye becha bhi jata hai: flex tier ka daam ZYADA hai (Rs 325 vs Rs 270) kyunki usme
   bandhan nahi hai. Us daam ke bagal me ek saal chhapna wahi cheez wapas le leta hai jiske
   liye customer extra de raha hai.

   QuotePDF ka koi test PDF render nahi karta, isliye ye file SOURCE padhti hai. Us tarike ne
   mujhe is hi session me teen baar dhokha diya — jaanch mere apne COMMENT se mel kha gayi
   aur test bina kuch jaanche hara ho gaya. Isliye pehle saare comment hata kar hi dekha
   jata hai.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = readFileSync(join(process.cwd(), "src", "lib", "pdf", "QuotePDF.tsx"), "utf8");

/** Comment hata do — warna neeche ka har phrase upar likhi wajah se hi mil jayega. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");

describe("saal ka har daawa flex par band hai", () => {
  it("flag khud line ki commitment se aata hai, row ke billing_cycle se nahi", () => {
    /* Row aur line dono "monthly" kehte hain — farq sirf line ki commitment bata sakti hai.
       Yahi wo boundary hai jise commitment-rate.ts teen SQL test ke saath pakde hue hai. */
    expect(code).toMatch(/const noYearlyCommitment = lineIsPerInvoice\(firstCommitment\)/);
  });

  /* Chaaron jagah jahan document saal ka zikr karta tha. Har ek ke aas-paas flag hona
     chahiye — warna wo line flex par phir se chhapne lagegi. */
  const YEAR_CLAIMS = [
    "invoices per year",
    "Annual contract value",
    "netAnnual)}/yr",
    "Per invoice (",
  ];

  for (const claim of YEAR_CLAIMS) {
    it(`"${claim}" noYearlyCommitment ke peeche hai`, () => {
      const at = code.indexOf(claim);
      expect(at, `ye phrase QuotePDF me mila hi nahi — jaanch purani ho gayi hai`)
        .toBeGreaterThan(-1);
      /* Sirf PEECHE dekhte hain — shart hamesha us cheez se pehle aati hai jise wo rokti
         hai. Naapa gaya: chaaron me sabse door wala 347 chaaron par hai (ternary jo poore
         "Annual contract value" block ko gherti hai), baaki teen 70 ke andar. 500 ka daayra
         usse bada hai par itna bada nahi ki kisi doosri jagah ka flag ghus jaye — poori file
         me flag sirf paanch baar hai, 9,000 chaaron me phaila hua. */
      const before = code.slice(Math.max(0, at - 500), at);
      expect(before, `"${claim}" ab bina shart chhap raha hai`).toContain("noYearlyCommitment");
    });
  }

  it("saal ka figure sirf EK ternary me bacha hai — annual commitment wala", () => {
    /* Annual commitment par saal ASLI hai (saal ka sauda, 12 kishton me bill), isliye wo
       branch rehni chahiye. Ye jaanch us branch ke hataye jaane par lal hogi. */
    /* R-1570: the year is now computed once in lib/quotes/per-period-figures (the email
       prints the same figure) — the PDF prints `pp.yearTotal`, and that helper still keeps
       the annual-commitment branch through annualContractValue. */
    expect(code).toMatch(/fmtC\(pp\.yearTotal\)/);
    const helper = readFileSync(join(process.cwd(), "src", "lib", "quotes", "per-period-figures.ts"), "utf8");
    expect(helper).toMatch(/annualContractValue\(i\.total, n, i\.lineCommitment\)/);
  });
});

describe("neeche ki ganit abhi bhi sahi hai — flag ne use badla nahi", () => {
  it("annual commitment par saal aaj bhi ginta hai", () => {
    /* Ye branch document par bachi hai, isliye iska sahi hona abhi bhi maayne rakhta hai. */
    expect(annualContractValue(160_704, 12, "annual_yearly")).toBe(160_704);
  });

  it("flex ki pehchan wahi ek hai jo divisor use karta hai", () => {
    /* Do alag jagah do alag tarike se "kya ye flex hai" poochhna hi wo darar thi jisse
       12x nikla tha. Dono ab ek hi function se poochhte hain. */
    expect(lineIsPerInvoice("monthly")).toBe(true);
    expect(lineIsPerInvoice("annual_monthly")).toBe(false);
  });
});
