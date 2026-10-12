import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* ─────────────────────────────────────────────────────────────────────────────
   30 Aug 2026, production, pipeline theek hone ke minute baad.

   Pardeep ne sales@ ko mail kiya jisme poori baat SUBJECT me thi aur body me kuch nahi:

     Subject: mujhe 60 email ke liye quote chahiye google workspace business starter
     Body:    "--  Regards, Pardeep Sharma | Sales Co-ordinator | sales@omegaco.test"

   Mail 63 second me app me aa gaya, lead ban gayi — aur phir kuch nahi. `ai_action_log`:

     reply.send / held — "Qualifier requested a colleague to take over the lead"

   Agent ko `incoming: fresh.text || text` diya jata tha — sirf BODY. To use sirf ek
   signature dikha jisme "Sales Co-ordinator" likha tha, aur usne samajh liya ki koi
   sahyogi lead aage badha raha hai. Us input par uska faisla theek tha; INPUT galat tha.

   Poori baat subject me likhna aur body khaali chhodna bilkul aam hai — Pardeep ne bina
   soche kiya. `extractEntities` hamesha se subject AUR body dono padhta hai (isiliye 60
   seats phir bhi sahi nikle). Sirf agent aadha email padh raha tha.
   ───────────────────────────────────────────────────────────────────────────── */

const INGEST = readFileSync(
  join(process.cwd(), "src", "lib", "inbound", "ingest.ts"), "utf8");

/**
 * Sirf CHALNE WALA code — comment nikaal kar.
 *
 * Pehli koshish me ye test laal hua tha, aur galti test ki thi: is file ke comment me
 * purana roop `incoming: fresh.text || text` udahran ke taur par likha hai, aur regex use
 * ek asli call site samajh baithi. Aaj ye doosri baar hua — subah ek jaanch ne `addLabel`
 * ko "bacha hua" bataya tha jabki wo bhi mere hi comment ka shabd tha.
 *
 * Jo file khud ko padhti hai, use pehle apni tippaniyan hatani chahiye.
 */
const CODE = INGEST
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("sales agent ko poora email milta hai", () => {
  it("dono call site subject ke saath bulate hain", () => {
    /* ⚠️ 31 Aug 2026 ko ye laal hua, aur galti mere refactor ki thi — niyam ki nahi.
       Dono branch ab ek hi `afterLeadWritten` se guzarte hain, to `incoming:` ab TEEN shakl
       me milta hai: type ka khaana, closure ka aage badhana, aur do ASLI feed. Pehle regex
       teeno ko ek jaisa maan rahi thi aur type ke khaane par lal ho gayi.

       Niyam waise ka waisa hai: jo bhi jagah matn BANATI hai, wo subject ke saath banaye.
       Ek par lagana aur doosri par bhool jana theek wahi 23 Aug wala auto-quote bug hai. */
    const lines = CODE.match(/incoming:\s*[^\n]*/g) ?? [];
    expect(lines.length, "koi `incoming:` mila hi nahi — jaanch tooti hai")
      .toBeGreaterThanOrEqual(3);

    /* Type ka khaana aur closure ka forward — ye matn banate nahi, aage bhejte hain. */
    const feeds = lines.filter((l) =>
      !/incoming:\s*string;/.test(l) && !/incoming:\s*args\.incoming,/.test(l));

    expect(feeds.length, `matn banane wali jagahen ${feeds.length} mili, 2 honi chahiye`)
      .toBe(2);
    for (const f of feeds) {
      expect(f, "ye call site subject ke bina bula raha hai").toMatch(/withSubject\(/);
    }
  });

  it("closure sirf aage bhejta hai — apna matn nahi banata", () => {
    /* Agar `afterLeadWritten` khud `withSubject` lagane lage to do jagah subject judega:
       ek baar caller par, ek baar yahan — aur "Subject: x" do baar chhap jayega. */
    expect(CODE).toMatch(/incoming:\s*args\.incoming,/);
  });

  it("kaccha body ab kisi call site par nahi jata", () => {
    /* Purana roop, hu-ba-hu — wapas aaya to ye laal hoga. */
    expect(CODE).not.toMatch(/incoming:\s*fresh\.text \|\| text,/);
    expect(CODE).not.toMatch(/incoming:\s*freshForFacts,/);
  });

  it("subject alag se naam le kar jodta hai, chipka kar nahi", () => {
    /* "Subject: ..." likha hona chahiye taaki model dono ko alag pehchan sake — waise hi
       jaise insaan inbox me padhta hai. Bina label ke wo signature ka hissa lagta. */
    expect(INGEST).toMatch(/`Subject: \$\{subject\.trim\(\)\}/);
  });

  it("subject khaali ho to kuch nahi jodta", () => {
    /* Khaali subject par "Subject:" ka khaali sirlekh bhejna model ko ek aur bekaar
       tukda dena hai. */
    expect(INGEST).toMatch(/subject\.trim\(\)\s*\?/);
  });
});

describe("extractEntities pehle se poora email padhta tha", () => {
  it("subject aur body dono uske paas jate hain", () => {
    /* Yahi wajah hai ki 60 seats sahi nikle jabki agent ne handover kar diya — do alag
       raaste ek hi email ko alag-alag dekh rahe the. */
    const extract = readFileSync(
      join(process.cwd(), "src", "lib", "inbound", "extract.ts"), "utf8");
    expect(extract).toMatch(/subject/);
    expect(extract).toMatch(/body/);
  });
});
