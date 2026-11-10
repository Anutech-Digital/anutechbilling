import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pdfRupee, pdfSafeMoney, PDF_RUPEE_PREFIX } from "./pdf-money";
import { rupee } from "@/lib/utils";
import { readSource } from "@/lib/testing/source-cache"; // R-2564: shared, always-fresh read cache

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026 — Q-ADPL-2026-27-0058, jaisa customer ke inbox me pahuncha:

     RATE  ¹325/mo      AMOUNT  ¹12,675/mo      PER INVOICE  ¹14,957/mo

   Har rupee ke nishaan ki jagah ek chhota superscript 1. Wo koi fazool akshar nahi tha — ULTA
   tha: `₹` font me maujood hi nahi, to viewer ne jo tha wahi bana diya.

   `@react-pdf/renderer` bina `Font.register` ke PDF ke built-in font (Helvetica/Courier/Times)
   use karta hai, WinAnsi encoding par. WinAnsi me em dash hai, curly quotes hain, euro bhi hai
   — par rupee ka nishaan NAHI, kyunki wo Unicode me 2010 me aaya, in encodings ke jam jaane ke
   बरसों baad.

   Yaani app ke har quote, invoice, receipt aur payslip par currency ki jagah tooti hui shakl
   chhapti rahi — GST document par — aur screen bilkul theek dikhta raha, kyunki browser ke paas
   ₹ wale font hain aur `rupee()` dono ke beech saanjha hai.
   ───────────────────────────────────────────────────────────────────────────── */

/**
 * Only the code that RUNS — block comments, whole-line comments, AND trailing comments.
 *
 * The trailing kind matters. `InvoicePDF.tsx` ends a line with a comment naming the rupee
 * sign, and the first version of the literal-sign check below flagged it. That was the CHECK
 * being wrong, not the file. Matching whitespace-then-slashes leaves `https://` alone, because
 * there the slashes follow a colon.
 */
function runnable(file: string): string {
  return readSource(file)
    /* CRLF FIRST, and this one is subtle enough to have cost a run. These files are checked
       out with `\r\n`, and in JavaScript `.` does not match `\r` — it is a line terminator,
       like `\n`. So `\s\/\/.*$` could not reach the end of a trailing comment and stripped
       nothing, and the check reported a literal rupee sign in a comment. */
    .replace(/\r\n?/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("rupee ka nishaan PDF me nahi jata", () => {
  it("ASLI AANKDE — 325, 12,675, 14,957", () => {
    expect(pdfRupee(325)).toBe("Rs 325");
    expect(pdfRupee(12_675)).toBe("Rs 12,675");
    expect(pdfRupee(14_957)).toBe("Rs 14,957");
  });

  it("nateeje me ₹ kahin nahi bachta", () => {
    for (const n of [0, 1, 325, 12_675, 1_00_000, 1_75_500, 4_90_644, -500]) {
      expect(pdfRupee(n), String(n)).not.toContain("₹");
    }
  });

  it("Indian grouping WAISI KI WAISI rehti hai — ginti dobara nahi likhi gayi", () => {
    /* Yahi wo hissa hai jise dobara likhna asli khatra hota: do function ek hi raqam ke liye
       "12,675" aur "12675" dein, to document apni hi row se ulta bolne lagta hai. */
    for (const n of [325, 12_675, 4_90_644, 1_75_500]) {
      expect(pdfRupee(n)).toBe(rupee(n).replace("₹", PDF_RUPEE_PREFIX));
    }
  });

  it("null / undefined par wahi em dash jo screen par aata hai", () => {
    expect(pdfRupee(null)).toBe("—");
    expect(pdfRupee(undefined)).toBe("—");
  });

  it("compact roop bhi safe hai", () => {
    expect(pdfRupee(1_75_500, { compact: true })).not.toContain("₹");
    expect(pdfRupee(1_75_500, { compact: true })).toContain("Rs ");
  });

  it("pehle se lagi space se 'Rs  325' nahi banta", () => {
    expect(pdfSafeMoney("₹ 325")).toBe("Rs 325");
    expect(pdfSafeMoney("₹325")).toBe("Rs 325");
  });

  it("ek hi sentence me kai figure — sab badalte hain", () => {
    /* Notes wali line me ek se zyada raqam ho sakti hai. */
    expect(pdfSafeMoney("₹325/seat vs ₹270/seat")).toBe("Rs 325/seat vs Rs 270/seat");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   AUR AB WO PEHRA.

   `PayslipPDF.tsx` me ye galti PEHLE SE pakdi gayi thi, sahi wajah ke saath likhi thi, aur
   sirf USI file par lagi thi. Teen customer-facing document mahino tak tooti shakl chhaapte
   rahe. Jaankari code me maujood thi — bas us jagah nahi thi jahan baaki teen pahunch sakte.

   Isliye ginti hoti hai, bharose par nahi chhoda jata.
   ───────────────────────────────────────────────────────────────────────────── */
describe("koi bhi PDF component seedha rupee() nahi bulata", () => {
  const DIR = join(process.cwd(), "src", "lib", "pdf");

  const components = readdirSync(DIR).filter(
    (f) => /PDF\.tsx$/.test(f) && !/\.test\./.test(f),
  );

  it("component mile bhi — warna neeche ka loop zero baar chalega", () => {
    /* Bina iske ye ek khaali loop hoti: zero file, zero assertion, hara test. */
    expect(components.length, "koi *PDF.tsx nahi mila").toBeGreaterThanOrEqual(4);
  });

  for (const f of components) {
    it(`${f} — pdfRupee use karta hai, rupee() nahi`, () => {
      const code = runnable(join(DIR, f));
      /* `pdfRupee(` khud me "rupee(" rakhta hai, isliye pehle use hata kar dekha jata hai —
         warna ye jaanch apne hi fix par lal ho jati. */
      const withoutSafe = code.split("pdfRupee(").join("__SAFE__(");
      expect(withoutSafe, `${f} seedha rupee() bula raha hai — us document par tooti shakl aayegi`)
        .not.toMatch(/\brupee\(/);
      expect(code, `${f} me pdfRupee kahin nahi hai`).toContain("pdfRupee");
      /* Aur wo pdfRupee ASLI wala ho. Bina is line ke ek mutation nikal gaya tha:
         `import { rupee as pdfRupee } from "@/lib/utils"` — source me "pdfRupee" maujood, koi
         bare `rupee(` nahi, aur document phir bhi tooti shakl chhapta. Naam se nahi, JAGAH se
         pakadna padta hai. */
      const importLine = code.split(String.fromCharCode(10))
        .find((l) => l.includes("import") && l.includes("pdfRupee"));
      expect(importLine, `${f} me pdfRupee ka import hi nahi mila`).toBeTruthy();
      expect(importLine, `${f} ka pdfRupee ./pdf-money se nahi aa raha`)
        .toContain('from "./pdf-money"');
    });

    it(`${f} — koi literal ₹ nahi bacha`, () => {
      /* Receipt voucher ka table header "Amount (₹)" tha — figures ke saath wahi font, wahi
         tooti shakl. Comment me ₹ likhna theek hai; JSX me nahi. */
      const code = runnable(join(DIR, f));
      expect(code, `${f} me literal ₹ hai`).not.toContain("₹");
    });
  }
});
