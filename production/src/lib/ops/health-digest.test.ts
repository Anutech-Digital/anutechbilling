import { describe, it, expect } from "vitest";
import { buildDigest, digestText, scrub, worthReading, shorten, ist } from "./health-digest";

/* ─────────────────────────────────────────────────────────────────────────────
   Neeche ka har test 28 Aug 2026 ke asli logon par baitha hai — us din production ke logs
   pehli baar khule aur ek ghante me teen bug nikle jo hafton se chal rahe the:

     [ai/sales-agent] Gemini call failed — timed out after 15000ms
         → 14:09:40 par `reply.send failed`, ek asli lead ka jawab nahi gaya

     /api/webhooks/inbound-purchase   401 × 7, 24–27 Aug
         → 7 vendor invoice Purchase Inbox me kabhi nahi pahunche

     /api/webhooks/inbound-email?key=<secret>   500 × 5
         → secret har request ke saath log me cleartext

   Teeno isliye mile ki kisi ne jaakar dekha. Ye file us "jaakar dekhne" ko code me
   badalti hai, aur ye test us din ke aankdon se hi likhe gaye hain.
   ───────────────────────────────────────────────────────────────────────────── */

const t = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 7, 28, h, m, 0)).toISOString();

describe("scrub — report khud leak na kare", () => {
  it("query wala secret hata deta hai — ASLI MAAMLA", () => {
    const out = scrub("https://x.a.run.app/api/webhooks/inbound-email?key=t81t_qX9kALmgqmESEdpWGI0ml");
    expect(out).toBe("/api/webhooks/inbound-email?key=***");
    expect(out).not.toContain("t81t");
  });

  it("token aur secret bhi", () => {
    expect(scrub("https://h/a?token=abc123")).toBe("/a?token=***");
    expect(scrub("https://h/a?secret=abc123")).toBe("/a?secret=***");
  });

  it("host hata deta hai, path rakhta hai", () => {
    expect(scrub("https://resellersos-njvk4nxhdq-el.a.run.app/login")).toBe("/login");
  });

  it("bina query wale URL ko nahi bigadta", () => {
    expect(scrub("/api/cron/renewals")).toBe("/api/cron/renewals");
  });
});

describe("worthReading — report ko log banne se roko", () => {
  it("stack aur JSON ke tukde chhod deta hai", () => {
    /* Pehle chalaye gaye 7-din wale run me top par `}` (36 baar) aur `{` (12 baar) aa gaye
       the — report padhne layak hi nahi bachi thi. */
    for (const junk of ["}", "{", "]", '"status": "UNAVAILABLE"', "code: 'x'", "  },"]) {
      expect(worthReading(junk), junk).toBe(false);
    }
  });

  it("hamare apne [label] wale log hamesha rakhta hai", () => {
    expect(worthReading("[ai/sales-agent] Gemini call failed")).toBe(true);
    expect(worthReading("[cron/backup] retried 1x")).toBe(true);
  });

  it("poora vaakya rakhta hai chahe [label] na ho", () => {
    /* Gemini ka apna message — sabse kaam ki line thi us din, aur uspar koi label nahi. */
    expect(worthReading('"message": "This model is currently experiencing high demand. Spikes in"')).toBe(true);
  });
});

describe("shorten — label poora, baaki kata hua", () => {
  it("[label] kabhi nahi kaatta", () => {
    const s = shorten("[inbound-purchase/extract] " + "x".repeat(200));
    expect(s.startsWith("[inbound-purchase/extract]")).toBe(true);
    expect(s.length).toBeLessThan(120);
  });
});

describe("buildDigest — us din ke asli logon par", () => {
  const purchase401 = [23, 26, 29, 31, 33, 35, 37].map((h, i) => ({
    timestamp: t(h % 24, i), status: 401,
    url: "https://x.a.run.app/api/webhooks/inbound-purchase?key=b051320e1080",
  }));

  it("ek hi path par lagatar 401 ek line me aata hai, ginti aur aakhri waqt ke saath", () => {
    const d = buildDigest(24, { http: purchase401, stderr: [] });
    expect(d.refused).toHaveLength(1);
    expect(d.refused[0].count).toBe(7);
    expect(d.refused[0].what).toBe("/api/webhooks/inbound-purchase");
  });

  it("401 ki line me secret nahi hota", () => {
    const d = buildDigest(24, { http: purchase401, stderr: [] });
    expect(JSON.stringify(d)).not.toContain("b051320e");
  });

  it("5xx me secret masked hota hai, aur status dikhta hai", () => {
    const d = buildDigest(24, {
      http: [{ timestamp: t(3), status: 500, url: "https://x/api/webhooks/inbound-email?key=t81t_secret" }],
      stderr: [],
    });
    expect(d.serverErrors[0].what).toBe("500 /api/webhooks/inbound-email?key=***");
    expect(JSON.stringify(d)).not.toContain("t81t_secret");
  });

  it("Gemini timeout wali line pakadta hai — ASLI MAAMLA", () => {
    const d = buildDigest(24, {
      http: [],
      stderr: [{ timestamp: t(14, 9), text: "[ai/sales-agent] Gemini call failed — timed out after 15000ms" }],
    });
    expect(d.appErrors).toHaveLength(1);
    expect(d.appErrors[0].what).toContain("[ai/sales-agent]");
    expect(d.clean).toBe(false);
  });

  it("kachra gina jata hai, chhupaya nahi", () => {
    /* "kuch chhupa liya" aur "kuch nahi tha" ek jaise nahi dikhne chahiye. */
    const d = buildDigest(24, {
      http: [],
      stderr: [{ timestamp: t(1), text: "}" }, { timestamp: t(1), text: "{" }, { timestamp: t(1), text: "]" }],
    });
    expect(d.appErrors).toHaveLength(0);
    expect(d.noise).toBe(3);
  });

  it("secret URL me aane ki chetavni alag ginti hai, app-error me nahi", () => {
    const d = buildDigest(24, {
      http: [],
      stderr: [{ timestamp: t(17), text: "[webhooks/inbound-email] shared secret URL me aaya … INBOUND_REQUIRE_HEADER=1 set karo" }],
    });
    expect(d.secretInUrl).toBe(1);
    expect(d.appErrors).toHaveLength(0);
    expect(d.clean).toBe(false);
  });

  it("aakhri waqt sabse NAYA hota hai, pehla nahi", () => {
    /* Ye poore digest ka sabse zaroori column hai: 28 Aug ko maine ginti dekh kar
       "abhi ho raha hai" samajh liya tha, jabki sab kuch key badalne se pehle ka tha. */
    const d = buildDigest(24, {
      http: [
        { timestamp: t(3), status: 500, url: "https://x/a" },
        { timestamp: t(19), status: 500, url: "https://x/a" },
        { timestamp: t(11), status: 500, url: "https://x/a" },
      ],
      stderr: [],
    });
    expect(d.serverErrors[0].last).toBe(t(19));
  });

  it("kuch na mile to clean — aur tabhi", () => {
    expect(buildDigest(24, { http: [], stderr: [] }).clean).toBe(true);
    expect(buildDigest(24, { http: [{ timestamp: t(2), status: 500, url: "/a" }], stderr: [] }).clean).toBe(false);
  });

  it("200 aur 404 ko error nahi maanta", () => {
    const d = buildDigest(24, {
      http: [
        { timestamp: t(2), status: 200, url: "/a" },
        { timestamp: t(2), status: 404, url: "/b" },
      ],
      stderr: [],
    });
    expect(d.clean).toBe(true);
  });

  it("zyada wali baat pehle aati hai", () => {
    const d = buildDigest(24, {
      http: [
        { timestamp: t(2), status: 500, url: "/kam" },
        ...[1, 2, 3].map((i) => ({ timestamp: t(3, i), status: 500, url: "/zyada" })),
      ],
      stderr: [],
    });
    expect(d.serverErrors[0].what).toContain("/zyada");
  });
});

describe("ist — sab kuch IST me, kyunki baaki har tareekh IST me hai", () => {
  it("UTC se saade paanch ghante aage", () => {
    expect(ist("2026-08-28T14:09:34Z")).toBe("28 Aug 19:39");
  });
  it("din badalna sambhalta hai", () => {
    expect(ist("2026-08-27T19:49:30Z")).toBe("28 Aug 01:19");
  });
  it("kachre par crash nahi karta", () => {
    expect(ist("kuch bhi")).toBe("?");
  });
});

describe("digestText — email me kya jata hai", () => {
  const d = buildDigest(24, {
    http: [{ timestamp: t(3), status: 500, url: "https://x/api/webhooks/inbound-email?key=t81t_secret" }],
    stderr: [{ timestamp: t(14, 9), text: "[ai/sales-agent] Gemini call failed — timed out after 15000ms" }],
  });

  it("secret email me kabhi nahi jata", () => {
    /* Email log se aage jata hai — usme secret daalna us leak ko badhana hoga jise band
       karne ke liye aaj kaam hua. */
    expect(digestText(d, "https://app")).not.toContain("t81t_secret");
    expect(digestText(d, "https://app")).toContain("key=***");
  });

  it("ginti aur aakhri waqt dono dikhata hai", () => {
    const txt = digestText(d, "https://app");
    expect(txt).toContain("28 Aug");
    expect(txt).toMatch(/1 ×/);
  });

  it("khaali section chhod deta hai, khaali heading nahi chhodta", () => {
    const only5xx = buildDigest(24, { http: [{ timestamp: t(3), status: 500, url: "/a" }], stderr: [] });
    const txt = digestText(only5xx, "https://app");
    expect(txt).toContain("Server error");
    expect(txt).not.toContain("What the app logged itself");
  });

  it("kachre ki ginti likhta hai jab ho", () => {
    const noisy = buildDigest(24, {
      http: [{ timestamp: t(3), status: 500, url: "/a" }],
      stderr: [{ timestamp: t(1), text: "}" }],
    });
    expect(digestText(noisy, "https://app")).toContain("1 more line —");
  });
});
