import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replySubject, MAX_SUBJECT } from "./reply-subject";

/* ─────────────────────────────────────────────────────────────────────────────
   31 Aug 2026, asli enquiry — poori maang subject me thi:

     "mujhe 32 email id ke liye quote chahiye google business starter"

   App ne sab theek kiya: lead bana, product mila, 32 seats ka quote
   Q-ADPL-2026-27-0055 draft hua, aur bhejа NAHI gaya kyunki mail me monthly/annual likha hi
   nahi tha. 13 second me jawab bhi chala gaya — `email_log`: provider gmail, status sent.

   Pardeep ko wo jawab MILA HI NAHI. Agent ne apna subject bana liya tha —
   "Re: Google Workspace Business Starter quotation - Omega Co" — to Gmail ne
   use us thread me joda hi nahi. Jawab inbox me ek alag baat-cheet ban kar padi thi.

   Jo insaan intezaar kar raha hai, uske liye "galat thread me jawab" aur "koi jawab nahi" —
   dono ek hi cheez hai.
   ───────────────────────────────────────────────────────────────────────────── */

const AI = "Re: Google Workspace Business Starter quotation - Omega Co";
const REAL = "mujhe 32 email id ke liye quote chahiye google business starter";

describe("customer ka subject jeetta hai, model ka nahi", () => {
  it("ASLI MAAMLA — grahak ka subject, Re: ke saath", () => {
    expect(replySubject(REAL, AI)).toBe(`Re: ${REAL}`);
  });

  it("model ka subject use hi nahi hota jab grahak ka maujood hai", () => {
    /* Model body likhta hai; baat-cheet ka naam wo nahi rakhta. */
    expect(replySubject(REAL, AI)).not.toContain("Omega Co");
  });
});

describe("Re: ek hi baar lagta hai", () => {
  it("pehle se Re: hai to dobara nahi", () => {
    expect(replySubject("Re: google workspace ka price kya hai", AI))
      .toBe("Re: google workspace ka price kya hai");
  });

  it("kai baar juda hua Re: ek me sikud jata hai", () => {
    /* Ek paanch-message thread me har client apna prefix jodta hai. */
    expect(replySubject("RE: Re: re: 32 seats", AI)).toBe("Re: 32 seats");
  });

  it("Re[2]: aur Re(3): bhi", () => {
    expect(replySubject("Re[2]: quote", AI)).toBe("Re: quote");
    expect(replySubject("Re(3): quote", AI)).toBe("Re: quote");
  });

  it("Fwd: ko HAATH NAHI lagaya jata", () => {
    /* Forward kiya hua enquiry sach me forward hai, aur har mail client use "Re: Fwd: …"
       hi kehta hai. Use hatana subject ko grahak ke apne se alag kar dega. */
    expect(replySubject("Fwd: enquiry from client", AI)).toBe("Re: Fwd: enquiry from client");
  });
});

describe("subject na ho to model ka chalta hai", () => {
  it("khaali, null, undefined, sirf space — chaaron par fallback", () => {
    for (const empty of ["", "   ", null, undefined]) {
      expect(replySubject(empty, AI), String(empty)).toBe(AI);
    }
  });

  it("sirf 'Re:' likha ho to bhi fallback — usme jodne layak kuch nahi", () => {
    expect(replySubject("Re:", AI)).toBe(AI);
  });

  it("WhatsApp par koi subject hota hi nahi", () => {
    /* Wahi wajah jisse ye parameter optional hai — channel ke paas subject nahi hai. */
    expect(replySubject(undefined, "Aapke 32 seats ka quote")).toBe("Aapke 32 seats ka quote");
  });
});

describe("lamba subject", () => {
  it("kaata jata hai, par Re: bacha rehta hai — wahi thread jodta hai", () => {
    const long = "a".repeat(400);
    const out = replySubject(long, AI);
    expect(out.startsWith("Re: ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(MAX_SUBJECT);
  });

  it("fallback bhi kaata jata hai", () => {
    expect(replySubject("", "b".repeat(400)).length).toBe(MAX_SUBJECT);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   AUR YE NIYAM WAPAS NA TOOTE.

   Do dispatcher hain — sales aur support — aur dono seedha `sendEmail` bulate hain. Ek par
   theek karke doosre ko bhool jana theek wahi shakl hai jo is session me teen baar dikhi:
   nayi cheez do jagah haath se jodni padti hai. Isliye ginti source se hoti hai.
   ───────────────────────────────────────────────────────────────────────────── */
describe("dono dispatcher grahak ka subject use karte hain", () => {
  const read = (f: string): string =>
    readFileSync(join(process.cwd(), "src", "lib", "ai", "actions", f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

  for (const f of ["quote-dispatcher.ts", "support-dispatcher.ts"]) {
    it(`${f} — sendEmail ko replySubject se subject deta hai`, () => {
      const code = read(f);
      expect(code, `${f} me replySubject nahi hai`).toMatch(
        /subject:\s*replySubject\(args\.incomingSubject,/);
    });

    it(`${f} — model ka subject SEEDHA nahi bhejta`, () => {
      /* Yahi wo line thi jisne 31 Aug ko ek sahi jawab ko "koi jawab nahi" bana diya. */
      const code = read(f);
      expect(code).not.toMatch(/subject:\s*decision\.generated_response\.email_subject,/);
    });
  }
});
