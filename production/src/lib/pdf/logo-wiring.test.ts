import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPrismaGenerated } from "@/lib/testing/prisma-generated";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

/* ─────────────────────────────────────────────────────────────────────────────
   HAR QUOTE PDF PAR LOGO JAANA CHAHIYE — ek bhi call site chhoota to wo document
   monogram ke saath jayega aur kisi ko pata nahi chalega.

   Ye khaali saavdhaani nahi hai. Theek isi tarah `quotes.billing_cycle` ek insert me naam
   se likha hi nahi gaya tha, column ka default lag gaya, aur ek GST document par daam ka
   BAARAHVAAN hissa chhap gaya. Wo cheez chhoot sakti thi kyunki use TypeScript ne kabhi
   maanga hi nahi.

   `tenantLogo` bhi optional hai — aur optional hona zaroori hai, kyunki logo na hona ek
   aam aur theek surat hai. To type system yahan madad nahi kar sakta. Isliye ginti yahan
   hoti hai: har jagah jahan quote ka PDF banta hai, use logo dena hi hoga.

   Logo NA hone ka faisla ek jagah hota hai — `logoDataUri()` ke andar, jo har galti par
   null deta hai. Faisla call site par chhod dena hi bhoolne ka raasta hai.
   ───────────────────────────────────────────────────────────────────────────── */

const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { if (!isPrismaGenerated(p)) walk(p, out); continue; } // R-2564: not the generated Prisma client
    if (/\.tsx?$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
}

/** Call ke aage se shuru karke uska apna object literal kaato — bina brace gine galat block milega. */
function objectAt(code: string, openBraceIndex: number): string {
  let depth = 0;
  for (let i = openBraceIndex; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}") { depth--; if (depth === 0) return code.slice(openBraceIndex, i + 1); }
  }
  return code.slice(openBraceIndex);
}

/** Har wo jagah jo koi bhi document ka PDF banati hai, object literal ke saath. */
const RENDERERS = [
  "renderQuotePDF", "downloadQuotePDF", "previewQuotePDF", "buildQuotePdfProps",
  "renderInvoicePDF", "downloadInvoicePDF", "previewInvoicePDF", "buildInvoicePdfProps",
  "renderReceiptVoucherPDF", "downloadReceiptVoucherPDF",
];

interface Site { file: string; fn: string; body: string }

function quotePdfCallSites(): Site[] {
  const sites: Site[] = [];
  for (const file of walk(SRC)) {
    const raw = readSource(file);
    /* Comment pehle hata do. Is session me teen baar meri apni jaanch mere apne COMMENT se
       mel kha gayi aur test bina kuch jaanche hara ho gaya. */
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const fn of RENDERERS) {
      const re = new RegExp(`\\b${fn}\\(\\s*\\{`, "g");
      for (const m of code.matchAll(re)) {
        const brace = code.indexOf("{", m.index!);
        sites.push({ file: file.slice(SRC.length + 1).replace(/\\/g, "/"), fn, body: objectAt(code, brace) });
      }
    }
  }
  return sites;
}

describe("har quote PDF ko logo diya jata hai", () => {
  const sites = quotePdfCallSites();

  it("call site mile bhi — warna neeche ka har loop zero baar chalega", () => {
    /* Bina iske ye poori file ek khaali loop hoti: zero call site, zero assertion, hara
       test. Wahi trap `public.users` wale RLS loop me phans chuka hai. */
    expect(sites.length, "quote PDF ka koi call site nahi mila — jaanch tooti hai")
      .toBeGreaterThanOrEqual(10);
  });

  for (const site of quotePdfCallSites()) {
    it(`${site.file} · ${site.fn}`, () => {
      /* `buildQuotePdfProps` args me naam `logoDataUri` hai (wo khud resolve nahi karta),
         baaki sab PDF ko seedha `tenantLogo` dete hain. */
      const key = site.fn.startsWith("build") ? "logoDataUri" : "tenantLogo";
      expect(site.body, `${site.file} me ${site.fn} bina ${key} ke hai — us document par logo nahi aayega`)
        .toContain(`${key}:`);
    });
  }
});

describe("wo rail jo URL ko renderer tak nahi jaane deti, source par pin hai", () => {
  /* render.test.tsx ise nahi pakad sakti: wahan test ka URL pahunch se bahar hai, to guard
     hata dene par bhi renderer chup-chaap image chhod deta hai aur test hara reh jata hai
     (naapa gaya, 31 Aug 2026). Jo cheez asli me nuksaan karti — ek POHUNCHNE WALA URL, jo
     bina deadline ke fetch ho jaye — use test me banaya nahi ja sakta bina network ke.

     Isliye niyam yahan pin hai. Comment pehle hata diye jate hain. */
  const code = readSource(join(SRC, "lib", "pdf", "QuotePDF.tsx"))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  it("QuotePDF sirf isRenderableLogo se poochhta hai — truthiness se nahi", () => {
    expect(code).toMatch(/const hasLogo = isRenderableLogo\(tenantLogo\)/);
  });

  it("Image sirf us jawab ke peeche hai", () => {
    expect(code).toMatch(/hasLogo\s*\?\s*<Image src=\{tenantLogo\}/);
  });

  it("Invoice aur Receipt bhi wahi ek sawaal poochhte hain", () => {
    /* Teeno document ek hi jagah se poochhte hain. Do alag tarike se "kya ye logo hai"
       poochhna theek wahi darar hai jisse 12x wali galti nikli thi. */
    for (const doc of ["InvoicePDF.tsx", "ReceiptVoucherPDF.tsx"]) {
      const c = readSource(join(SRC, "lib", "pdf", doc))
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(c, doc).toMatch(/isRenderableLogo\(tenantLogo\) && <Image src=\{tenantLogo\}/);
    }
  });
});
