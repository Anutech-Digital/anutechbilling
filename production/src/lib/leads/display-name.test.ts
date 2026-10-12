import { describe, it, expect } from "vitest";
import { leadDisplayName, leadContactLines, leadCompanyCell } from "./display-name";

/* ─────────────────────────────────────────────────────────────────────────────
   Pardeep, 29 Aug 2026: "bina company ke lead ban sakti hai, par bina contact ke lead
   nahi ban sakti." Isliye row ki PEHCHAN aadmi hai, company nahi.

   Aur ye sirf pasand nahi thi — app khud ise sabit karti thi. Enquiry form wala inbound
   raasta likhta hai:

       inbound-email/route.ts:130  →  company: (p.company ?? "").toString().trim()

   `leads.company` NOT NULL hai, par NOT NULL khaali string nahi rokta. Yaani app ek taraf
   kehti thi "company ke bina lead nahi banegi" (dono form `company` min(2) maangte the aur
   `contact_name` optional rakhte the), aur doosri taraf khud waisi lead banati thi.

   Aaj DB me aisi ek bhi row nahi hai (30 me se 0) kyunki wo demo data hai — Pardeep ne khud
   yahi kaha. Isliye ye test us data se NAHI likhe gaye jo aaj maujood hai; wo sab hara kar
   deta aur kuch sabit na karta.
   ───────────────────────────────────────────────────────────────────────────── */

describe("leadDisplayName — contact pehle", () => {
  it("contact ka naam ho to wahi, chahe company bhi ho — ASLI FAISLA", () => {
    const d = leadDisplayName({ company: "Omega Co", contact_name: "Raj Kumar" });
    expect(d).toEqual({ label: "Raj Kumar", source: "contact", hint: null });
  });

  it("contact na ho to company, aur us par WAJAH likhi hoti hai", () => {
    /* Company ko chup-chaap contact ki jagah dikhana jhooth hota — padhne wala use aadmi
       ka naam samajh kar "Hello Omega Co" likh dega. */
    const d = leadDisplayName({ company: "Omega Co", contact_name: "" });
    expect(d.label).toBe("Omega Co");
    expect(d.source).toBe("company");
    expect(d.hint).toBeTruthy();
  });

  it("sirf space wala contact khaali hi hai", () => {
    expect(leadDisplayName({ company: "Acme", contact_name: "   " }).source).toBe("company");
  });

  it("null/undefined contact par bhi wahi", () => {
    expect(leadDisplayName({ company: "Acme", contact_name: null }).source).toBe("company");
    expect(leadDisplayName({ company: "Acme" }).source).toBe("company");
  });

  it("dono na hon to POORA email — sirf uska pehla hissa nahi", () => {
    /* "raj@a.com" aur "raj@b.com" do alag log hain. Sirf "raj" dikhane par wo farq mit
       jata hai aur do lead ek jaisi dikhne lagti hain. */
    const d = leadDisplayName({ company: "", contact_name: "", contact_email: "raj@123gmail.com" });
    expect(d.label).toBe("raj@123gmail.com");
    expect(d.source).toBe("email");
  });

  it("kuch bhi na ho to bhi cell khaali nahi rehta", () => {
    /* Khaali cell aur "data hai par dikha nahi" grid me ek jaise lagte hain. */
    const d = leadDisplayName({ company: "", contact_name: "", contact_email: "" });
    expect(d.label).toBe("(no name)");
    expect(d.source).toBe("none");
  });

  it("null lead par crash nahi", () => {
    expect(leadDisplayName(null).source).toBe("none");
    expect(leadDisplayName(undefined).label).toBe("(no name)");
  });

  it("sirf contact ke saath hint NAHI aati, baaki teeno ke saath aati hai", () => {
    /* Hint ka matlab hai "ye wo naam nahi hai jo hona chahiye tha". Contact ab wahi naam
       hai jo hona chahiye, isliye wahan chup rehna hi sahi hai. */
    expect(leadDisplayName({ contact_name: "Raj" }).hint).toBeNull();
    for (const l of [
      { company: "Acme", contact_name: "" },
      { company: "", contact_name: "", contact_email: "raj@x.com" },
      { company: "", contact_name: "", contact_email: "" },
    ]) {
      expect(leadDisplayName(l).hint, JSON.stringify(l)).toBeTruthy();
    }
  });

  it("aage-peeche ka space kaat deta hai", () => {
    expect(leadDisplayName({ contact_name: "  Raj  " }).label).toBe("Raj");
  });
});

describe("leadContactLines — ek naam do baar na chhape", () => {
  it("naam pehchan ban chuka ho to email hi bachta hai", () => {
    const out = leadContactLines({ company: "Acme", contact_name: "Raj", contact_email: "raj@x.com" }, "contact");
    expect(out.name).toBeNull();
    expect(out.email).toBe("raj@x.com");
  });

  it("email pehchan ban chuka ho to wo dobara nahi", () => {
    const out = leadContactLines({ company: "", contact_name: "", contact_email: "raj@x.com" }, "email");
    expect(out).toEqual({ name: null, email: null });
  });

  it("company pehchan bani ho to contact ka email phir bhi dikhta hai", () => {
    /* Contact ka naam nahi tha, par email ho sakta hai — aur wahi ek zariya hai us aadmi
       tak pahunchne ka. */
    const out = leadContactLines({ company: "Acme", contact_name: "", contact_email: "info@acme.in" }, "company");
    expect(out.email).toBe("info@acme.in");
    expect(out.name).toBeNull();
  });

  it("khaali value null banti hai, khaali string nahi", () => {
    /* Khaali string sach lagti hai aur ek khaali line chhap deti hai. */
    const out = leadContactLines({ company: "Acme", contact_name: "  ", contact_email: "" }, "contact");
    expect(out).toEqual({ name: null, email: null });
  });
});

describe("leadCompanyCell", () => {
  it("company apni jagah dikhti hai", () => {
    expect(leadCompanyCell({ company: "Acme", contact_name: "Raj" }, "contact")).toBe("Acme");
  });

  it("company pehchan ban kar upar ja chuki ho to yahan NAHI — ASLI MAAMLA", () => {
    /* Warna ek hi naam ek row me do baar dikhta, aur padhne wala rukkar sochta hai ki kya
       do alag cheezein sanyog se ek jaisi hain. */
    expect(leadCompanyCell({ company: "Acme", contact_name: "" }, "company")).toBeNull();
  });

  it("company na ho to null — call site '—' chhapta hai", () => {
    expect(leadCompanyCell({ company: "", contact_name: "Raj" }, "contact")).toBeNull();
    expect(leadCompanyCell({ contact_name: "Raj" }, "contact")).toBeNull();
    expect(leadCompanyCell({ company: "   " }, "contact")).toBeNull();
  });

  it("null lead par crash nahi", () => {
    expect(leadCompanyCell(null, "contact")).toBeNull();
  });
});
