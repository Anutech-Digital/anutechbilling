import { describe, it, expect } from "vitest";
import {
  offsiteObjectName,
  offsiteMonthlyName,
  offsiteWindowStart,
  offsiteEnvelope,
  offsiteRefusal,
  offsiteTenantObjectName,
  offsiteTenantMonthlyName,
  offsiteManifestName,
  OFFSITE_WINDOW_HOURS,
  type OffsiteSnapshot,
} from "./offsite";

/* ─────────────────────────────────────────────────────────────────────────────
   29 Aug 2026. Raat wala backup chal raha tha aur teeno tenant ke snapshot maujood the —
   par sab `backup.snapshots` me, yaani usi database ke andar jiska wo backup hain. Bahar ki
   ekmatra copy laptop par thi, haath se banti thi, aur teen din purani nikli.

   26 Aug ko data reset ho chuka hai. Ab jo banega wo asli hai.
   ───────────────────────────────────────────────────────────────────────────── */

const snap = (id: string, name: string | null, payload: unknown = { leads: [] }): OffsiteSnapshot => ({
  tenant_id: id, tenant_name: name, snapshot_id: `s-${id}`,
  created_at: "2026-08-29T00:00:00Z", payload,
});

describe("offsiteObjectName — IST, kyunki cron IST me chalta hai", () => {
  it("00:00 IST par AAJ ki tareekh deta hai, kal ki nahi — ASLI JAAL", () => {
    /* Cron 00:00 IST par chalta hai = 18:30 UTC, PICHHLE din ka. UTC se naam banate to
       29 tareekh ka backup `daily/2026-08-28.json` par chadhta, har raat, chup-chaap. */
    expect(offsiteObjectName(new Date("2026-08-28T18:30:00Z"))).toBe("daily/2026-08-29.json");
  });

  it("18:30 UTC se ek minute PEHLE abhi pichhla din hai", () => {
    expect(offsiteObjectName(new Date("2026-08-28T18:29:00Z"))).toBe("daily/2026-08-28.json");
  });

  it("mahina badalna sambhalta hai", () => {
    expect(offsiteObjectName(new Date("2026-08-31T18:30:00Z"))).toBe("daily/2026-09-01.json");
  });

  it("saal badalna sambhalta hai", () => {
    expect(offsiteObjectName(new Date("2026-12-31T18:30:00Z"))).toBe("daily/2027-01-01.json");
  });

  it("ek din me ek hi naam — dobara chalane par overwrite, naya object nahi", () => {
    /* Versioning bucket par on hai, to overwrite se purani copy khoti nahi. Par har run par
       naya naam banate to 400 din me hazaaron object hote, aur "aaj ka backup hai ya nahi"
       ek listing padhne ka kaam ban jata. */
    const a = offsiteObjectName(new Date("2026-08-28T18:30:00Z"));
    const b = offsiteObjectName(new Date("2026-08-29T11:47:13Z"));
    expect(a).toBe(b);
  });
});

describe("offsiteMonthlyName — GST ke liye mahine ki ek lambi copy (S4)", () => {
  it("1 tareekh 00:00 IST (pichhle din 18:30 UTC) par us mahine ka naam", () => {
    expect(offsiteMonthlyName(new Date("2026-09-30T18:30:00Z"))).toBe("monthly/2026-10.json");
  });

  it("UTC me 1 tareekh par, IST me 1 nahi — to null (ASLI JAAL)", () => {
    /* 1 Oct 18:30 UTC = 2 Oct 00:00 IST. UTC se dekhte to 2 Oct ka backup monthly ban jaata. */
    expect(offsiteMonthlyName(new Date("2026-10-01T18:30:00Z"))).toBeNull();
  });

  it("baaki har din null", () => {
    expect(offsiteMonthlyName(new Date("2026-10-14T18:30:00Z"))).toBeNull();
  });

  it("saal badalna sambhalta hai", () => {
    expect(offsiteMonthlyName(new Date("2026-12-31T18:30:00Z"))).toBe("monthly/2027-01.json");
  });

  it("daily/ se alag prefix — bucket ka 400-din niyam ise bahar rakh sake", () => {
    const now = new Date("2026-09-30T18:30:00Z");
    expect(offsiteMonthlyName(now)!.startsWith("monthly/")).toBe(true);
    expect(offsiteObjectName(now).startsWith("daily/")).toBe(true);
  });
});

describe("offsiteWindowStart", () => {
  it("default se peechhe jaata hai, aage nahi", () => {
    const now = new Date("2026-08-28T18:30:00Z");
    const start = offsiteWindowStart(now);
    expect(start.getTime()).toBeLessThan(now.getTime());
    expect(now.getTime() - start.getTime()).toBe(OFFSITE_WINDOW_HOURS * 3600_000);
  });

  it("khidki itni chaudi ho ki ek dheema sweep bhi andar aa jaye", () => {
    /* Cron ke turant baad chalta hai, par ek ghante ki khidki retry ya late scheduler par
       khaali reh jaati, aur us raat kuch upload hi na hota. */
    expect(OFFSITE_WINDOW_HOURS).toBeGreaterThanOrEqual(12);
  });
});

describe("offsiteEnvelope", () => {
  const now = new Date("2026-08-28T18:30:00Z");

  it("IST ki tareekh andar bhi likhta hai, sirf naam me nahi", () => {
    const env = offsiteEnvelope(now, "ontpnqjoysjgrlsukecm", [snap("t1", "ANUTECH")]);
    expect(env.ist_date).toBe("2026-08-29");
    expect(env.taken_at_utc).toBe("2026-08-28T18:30:00.000Z");
  });

  it("project ref rakhta hai — do project hain, aur naam se pehchan nahi hoti", () => {
    const env = offsiteEnvelope(now, "ontpnqjoysjgrlsukecm", []);
    expect(env.project_ref).toBe("ontpnqjoysjgrlsukecm");
  });

  it("tenant ki ginti payload se aati hai, kahin se maani nahi jaati", () => {
    const env = offsiteEnvelope(now, "x", [snap("t1", "A"), snap("t2", "B"), snap("t3", "C")]);
    expect(env.tenant_count).toBe(3);
    expect(env.snapshots).toHaveLength(3);
  });
});

describe("offsiteRefusal — khaali backup bhejne se behtar hai kuch na bhejna", () => {
  const now = new Date("2026-08-28T18:30:00Z");

  it("kuch na mile to mana kar deta hai", () => {
    /* Khaali object bucket me sabse bura nateeja hai: tareekh sahi, naam sahi, andar kuch
       nahi. Pata us din chalega jis din restore karna pade. */
    const why = offsiteRefusal(offsiteEnvelope(now, "x", []), 3);
    expect(why).toContain("no snapshot found");
  });

  it("aadhe tenant par mana karta hai — ASLI FAISLA", () => {
    /* Sweep per-tenant fail hone deta hai (ek kharab tenant baaki sabka backup na roke).
       To aadha nateeja aa sakta hai, aur wo poore jaisa dikhta hai. */
    const why = offsiteRefusal(offsiteEnvelope(now, "x", [snap("t1", "A")]), 3);
    expect(why).toContain("3 tenant");
    expect(why).toContain("1");
  });

  it("payload null ho to mana karta hai", () => {
    const why = offsiteRefusal(offsiteEnvelope(now, "x", [snap("t1", "A", null)]), 1);
    expect(why).toContain("payload");
  });

  it("sab theek ho to raasta deta hai", () => {
    const env = offsiteEnvelope(now, "x", [snap("t1", "A"), snap("t2", "B"), snap("t3", "C")]);
    expect(offsiteRefusal(env, 3)).toBeNull();
  });

  it("zyada snapshot par NAHI rokta", () => {
    /* Naya tenant beech me ban sakta hai. Us raat rok dena ek nakli emergency banata. */
    const env = offsiteEnvelope(now, "x", [snap("t1", "A"), snap("t2", "B")]);
    expect(offsiteRefusal(env, 1)).toBeNull();
  });

  it("expected 0 ho to ginti par nahi rokta, par khaali par phir bhi rokta hai", () => {
    /* tenants ki ginti na mil paye (query fail) to us wajah se backup rokna galat hoga —
       par khaali payload phir bhi khaali hai. */
    expect(offsiteRefusal(offsiteEnvelope(now, "x", [snap("t1", "A")]), 0)).toBeNull();
    expect(offsiteRefusal(offsiteEnvelope(now, "x", []), 0)).toContain("no snapshot found");
  });
});

describe("per-tenant naam (S15) — ek tenant, ek object", () => {
  const T = "fbb976f1-9090-4f10-9726-0901bd144e42";

  it("daily/<IST tareekh>/<tenant_id>.json — tareekh wahi jo offsiteObjectName deta hai", () => {
    const now = new Date("2026-08-28T18:30:00Z"); // 29 Aug 00:00 IST
    expect(offsiteTenantObjectName(now, T)).toBe("daily/2026-08-29/fbb976f1-9090-4f10-9726-0901bd144e42.json");
    expect(offsiteTenantObjectName(now, T).startsWith(offsiteObjectName(now).replace(".json", "/"))).toBe(true);
  });

  it("alag tenant alag naam, ek din me ek hi (dobara chalane par overwrite)", () => {
    const a = new Date("2026-08-28T18:30:00Z"), b = new Date("2026-08-29T11:47:13Z");
    expect(offsiteTenantObjectName(a, T)).toBe(offsiteTenantObjectName(b, T));
    expect(offsiteTenantObjectName(a, T)).not.toBe(offsiteTenantObjectName(a, "3caa0f07-44d1-42ee-91b3-2123e04853b1"));
  });

  it("monthly sirf 1 tareekh (IST) ko, us mahine ke folder me", () => {
    expect(offsiteTenantMonthlyName(new Date("2026-09-30T18:30:00Z"), T)).toBe(`monthly/2026-10/${T}.json`);
    expect(offsiteTenantMonthlyName(new Date("2026-10-01T18:30:00Z"), T)).toBeNull();
  });

  it("daily/ aur monthly/ prefix wahi — bucket ka 400-din / 3000-din niyam bina badle lagta hai", () => {
    const now = new Date("2026-09-30T18:30:00Z");
    expect(offsiteTenantObjectName(now, T).startsWith("daily/")).toBe(true);
    expect(offsiteTenantMonthlyName(now, T)!.startsWith("monthly/")).toBe(true);
  });

  it("tenant id uuid na ho to phatta hai — '../' se doosre din ki file par likhna mana (ASLI JAAL)", () => {
    const now = new Date("2026-08-28T18:30:00Z");
    expect(() => offsiteTenantObjectName(now, "../2026-08-01/x")).toThrow(/uuid/);
    expect(() => offsiteTenantObjectName(now, "")).toThrow(/uuid/);
  });

  it("manifest usi folder me, uuid se na takraane wale naam par", () => {
    expect(offsiteManifestName(new Date("2026-08-28T18:30:00Z"))).toBe("daily/2026-08-29/_manifest.json");
  });
});
