import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { geminiJson, __resetGeminiBreaker } from "./gemini";

const ARGS = { apiKey: "k".repeat(20), model: "gemini-2.5-flash", system: "s", user: "u", label: "test" };

/** Shape a successful Gemini generateContent response. */
function ok(text: string) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
    text: async () => "",
  } as unknown as Response;
}

beforeEach(() => {
  __resetGeminiBreaker();
  // Silence the route's deliberate console noise; assertions cover behaviour.
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("geminiJson — an AI failure must never break the caller", () => {
  it("parses a good response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok('{"message":"hi"}')));
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
  });

  it("strips a ```json fence the model added anyway", async () => {
    // Models still fence JSON despite responseMimeType: application/json.
    vi.stubGlobal("fetch", vi.fn(async () => ok('```json\n{"message":"hi"}\n```')));
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
  });

  it("returns null, not a throw, on an HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false, status: 429, text: async () => "rate limited", json: async () => ({}),
    } as unknown as Response)));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("returns null on a timeout", async () => {
    // What AbortSignal.timeout produces when the deadline passes.
    vi.stubGlobal("fetch", vi.fn(async () => {
      const e = new Error("The operation was aborted due to timeout");
      e.name = "TimeoutError";
      throw e;
    }));
    await expect(geminiJson({ ...ARGS, timeoutMs: 10 })).resolves.toBeNull();
  });

  it("returns null on unparseable JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok("not json at all")));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("returns null when the response has no candidates", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({}), text: async () => "",
    } as unknown as Response)));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });

  it("passes an abort signal, so a stalled Gemini cannot hang the request", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => ok('{"message":"hi"}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson(ARGS);
    expect(spy.mock.calls[0][1]?.signal).toBeDefined();
  });
});

/* ── ONE LOGICAL CALL IS NOW TWO FETCHES ON A RETRYABLE STATUS ──────────────
   A 429 or 5xx is retried once (added 23 Aug 2026, after a live 503 lost a customer reply
   outright). So the fetch counts below are DOUBLED against a 500-returning stub, while the
   breaker counts are unchanged: a retry is one attempt at one thing, and recording each of
   its stages separately made the threshold of 3 trip after one and a half calls. That
   regression is what the "resets the failure count" test caught — it received null where it
   expected a draft, because the breaker had already opened. */
describe("circuit breaker", () => {
  it("stops calling after three consecutive failures", async () => {
    const spy = vi.fn(async () => ({
      ok: false, status: 500, text: async () => "boom", json: async () => ({}),
    } as unknown as Response));
    vi.stubGlobal("fetch", spy);

    for (let i = 0; i < 3; i++) await geminiJson(ARGS);
    /* 3 logical calls x (attempt + one retry) = 6 fetches, and 3 breaker failures. */
    expect(spy).toHaveBeenCalledTimes(6);

    // Fourth call short-circuits: when Gemini is down, the caller should not pay
    // the full timeout on every request just to reach the same stub.
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it("a success resets the failure count", async () => {
    let mode: "fail" | "pass" = "fail";
    const spy = vi.fn(async () =>
      mode === "fail"
        ? ({ ok: false, status: 500, text: async () => "", json: async () => ({}) } as unknown as Response)
        : ok('{"message":"hi"}'));
    vi.stubGlobal("fetch", spy);

    await geminiJson(ARGS);
    await geminiJson(ARGS);           // 2 failures — breaker still closed
    mode = "pass";
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });

    mode = "fail";
    await geminiJson(ARGS);
    await geminiJson(ARGS);           // only 2 since the reset
    /* 4 failing logical calls x 2 fetches + 1 successful call x 1 = 9. None skipped. */
    expect(spy).toHaveBeenCalledTimes(9);
  });

  it("stays closed while failures are below the threshold", async () => {
    const spy = vi.fn(async () => ({
      ok: false, status: 500, text: async () => "", json: async () => ({}),
    } as unknown as Response));
    vi.stubGlobal("fetch", spy);
    await geminiJson(ARGS);
    await geminiJson(ARGS);
    /* 2 logical calls x (attempt + retry). Two breaker failures, so still closed. */
    expect(spy).toHaveBeenCalledTimes(4);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Retrying a transient failure, added 23 Aug 2026 after a live one cost a customer.

   The reply drafter went undrafted because Google answered 503 once. There was no retry at
   all, so a single upstream blip lost the reply permanently and reported it as "the AI did
   not return a reply" — which reads like a model problem and sent me looking at the model.

   Three real failures were traced that day: 403 (project denied), 404 (retired model) and
   503 (busy). The first two are permanent and retrying them is waste; the third clears in a
   second. Treating them alike is what made a transient loss indistinguishable from a
   misconfiguration.
   ───────────────────────────────────────────────────────────────────────────── */
describe("retrying a transient failure", () => {
  const fail = (status: number) => ({
    ok: false, status, text: async () => "boom", json: async () => ({}),
  } as unknown as Response);

  it.each([429, 500, 502, 503])("retries once on HTTP %i and can then succeed", async (status) => {
    let first = true;
    const spy = vi.fn(async () => {
      if (first) { first = false; return fail(status); }
      return ok('{"message":"hi"}');
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404])("does NOT retry HTTP %i", async (status) => {
    /* Permanent. A retired model or a denied project answers the same way twice, and the
       retry would only add a second of latency to a webhook a provider is waiting on. */
    const spy = vi.fn(async () => fail(status));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("retries at most ONCE, never in a loop", async () => {
    const spy = vi.fn(async () => fail(503));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("asks the opt-in fallback model once when the main one is overloaded twice", async () => {
    const urls: string[] = [];
    const spy = vi.fn(async (url: string) => {
      urls.push(url);
      return url.includes("lite") ? ok('{"message":"from lite"}') : fail(503);
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson({ ...ARGS, fallbackModel: "gemini-lite-x" })).resolves.toEqual({ message: "from lite" });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(urls[2]).toContain("models/gemini-lite-x:");
  });

  it("does not use the fallback for a non-overload failure, nor retry the fallback itself", async () => {
    const spy500 = vi.fn(async () => fail(500));
    vi.stubGlobal("fetch", spy500);
    await expect(geminiJson({ ...ARGS, fallbackModel: "gemini-lite-x" })).resolves.toBeNull();
    expect(spy500).toHaveBeenCalledTimes(2);

    const spy503 = vi.fn(async () => fail(503));
    vi.stubGlobal("fetch", spy503);
    await expect(geminiJson({ ...ARGS, fallbackModel: "gemini-lite-x" })).resolves.toBeNull();
    expect(spy503).toHaveBeenCalledTimes(3);           // main, retry, fallback — never a loop
  });

  it("counts a retried call as ONE breaker failure, not two", async () => {
    /* THE BUG MY OWN CHANGE INTRODUCED, caught by the existing "resets the failure count"
       test before it shipped. Recording a failure on the way past AND on the retry made a
       single logical call cost two, so the threshold of 3 tripped after one and a half calls
       and the breaker opened on transient noise — the opposite of what it is for.

       Two failing calls must leave the breaker CLOSED, so the third still reaches Gemini. */
    let mode: "fail" | "pass" = "fail";
    const spy = vi.fn(async () => (mode === "fail" ? fail(503) : ok('{"message":"hi"}')));
    vi.stubGlobal("fetch", spy);

    await geminiJson(ARGS);                       // 2 fetches, 1 failure
    await geminiJson(ARGS);                       // 2 fetches, 2 failures
    mode = "pass";
    /* If a retry had counted twice, failures would be 4 here and this would be null. */
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(5);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Saying WHY, added 24 Aug 2026 after the cost of not saying it.

   Every failure path returned bare null, so every caller reported the same sentence: "the AI
   did not return a reply". In a single day that one sentence stood for FOUR different faults
   and sent me to the wrong place three times:

     403  the GCP project had billing disabled
     404  gemini-2.5-flash retired for new keys
     503  Google momentarily overloaded
     429  free tier, 20 requests/day/model, exhausted

   Google stated all four plainly in the response body. We threw the body away and wrote a
   guess. Each has a different fix — a billing console, a config field, one second, or a day —
   and "the AI did not return a reply" points at none of them.
   ───────────────────────────────────────────────────────────────────────────── */
describe("the failure reason reaches the caller", () => {
  const failWith = (status: number, body: string) => ({
    ok: false, status, text: async () => body, json: async () => ({}),
  } as unknown as Response);

  /** The real 429 body Google returned on 24 Aug 2026, trimmed. */
  const QUOTA_BODY = JSON.stringify({
    error: {
      code: 429,
      status: "RESOURCE_EXHAUSTED",
      message:
        "You exceeded your current quota, please check your plan and billing details.\n" +
        "* Quota exceeded for metric: generate_content_free_tier_requests, limit: 20",
      details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "16s" }],
    },
  });

  it("names a quota problem AND quotes Google's retry delay", async () => {
    let why = "";
    vi.stubGlobal("fetch", vi.fn(async () => failWith(429, QUOTA_BODY)));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/quota or rate limit/i);
    expect(why).toContain("retry in 16s");
    /* The actionable half: a free key is the cause, and a paid one is the fix. */
    expect(why).toMatch(/free-tier/i);
  });

  it("points a 403 at billing, which is where it actually was", async () => {
    let why = "";
    const body = JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "Your project has been denied access. Please contact support." } });
    vi.stubGlobal("fetch", vi.fn(async () => failWith(403, body)));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/billing/i);
  });

  it("points a 404 at the model setting", async () => {
    let why = "";
    const body = JSON.stringify({ error: { code: 404, message: "This model models/gemini-2.5-flash is no longer available to new users." } });
    vi.stubGlobal("fetch", vi.fn(async () => failWith(404, body)));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/model/i);
    expect(why).toMatch(/Settings/);
  });

  it("says a 5xx is nobody's misconfiguration", async () => {
    /* This one matters because it is the failure most likely to be chased. It clears on its
       own, and an hour spent checking keys and models is an hour wasted. */
    let why = "";
    const body = JSON.stringify({ error: { code: 503, message: "This model is currently experiencing high demand." } });
    vi.stubGlobal("fetch", vi.fn(async () => failWith(503, body)));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/temporarily unavailable/i);
    expect(why).toMatch(/Nothing is misconfigured/i);
  });

  it("survives a body that is not JSON at all", async () => {
    /* An HTML error page from a proxy, for instance. Still reports the status rather than
       throwing inside the error handler. */
    let why = "";
    vi.stubGlobal("fetch", vi.fn(async () => failWith(502, "<html>Bad Gateway</html>")));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/temporarily unavailable/i);
  });

  it("reports an empty answer differently from an HTTP failure", async () => {
    let why = "";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200, text: async () => "", json: async () => ({ candidates: [] }),
    } as unknown as Response)));
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/answered but the reply was empty/i);
  });

  it("reports the open breaker as self-healing, not as a fault to chase", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failWith(403, "{}")));
    for (let i = 0; i < 3; i++) await geminiJson(ARGS);
    let why = "";
    await geminiJson({ ...ARGS, onFailure: (r) => { why = r; } });
    expect(why).toMatch(/paused for a minute/i);
    expect(why).toMatch(/retries on its own/i);
  });

  it("stays optional, so existing callers are untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => failWith(500, "{}")));
    await expect(geminiJson(ARGS)).resolves.toBeNull();
  });
});

/* ══ 28 Aug 2026 — timeout wahi blip hai, par uska koi retry nahi tha ═══════════
   Prod me naapa gaya, us din:

     14:09:34   [ai/sales-agent] Gemini call failed — timed out after 15000ms
     14:09:40   ai_action_log → reply.send | failed | L-MTCMLH
                reason: "The AI did not answer, and gave no reason."

   Ek asli lead ka jawab nahi gaya. Do alag defect ek saath chale:

     1. 429/5xx retry hote the, timeout NAHI — jabki wo usi jaati ka transient blip hai.
        Upar wale retry ka apna comment yahi kehta hai: "one transient upstream blip and
        the reply was gone."
     2. `onFailure` is catch shakh me bulaya hi nahi jata tha, jabki docstring kehta hai
        "every failure path". Isliye caller ke paas `null` tha aur koi wajah nahi — aur
        wahi "gave no reason" ban kar lead ke log me chhap gaya.

   Jad (root cause) alag hai aur infra me hai: agent `void` karke response ke BAAD chalta
   hai, aur Cloud Run par CPU throttling default ON hai — dono timeout tab hue jab instance
   par koi request open nahi thi. Ye test us jad ko theek nahi karte; ye ye pakka karte
   hain ki jab bhi wo blip aaye, ek retry mile aur wajah kabhi gaayab na ho.
   ═══════════════════════════════════════════════════════════════════════════════ */
describe("timeout — 28 Aug ka prod maamla", () => {
  /** Wahi cheez jo AbortSignal.timeout deadline par phenkti hai. */
  const timeoutErr = () => {
    const e = new Error("The operation was aborted due to timeout");
    e.name = "TimeoutError";
    return e;
  };

  it("timeout par ek baar retry karta hai, aur phir kaamyab ho sakta hai — ASLI MAAMLA", async () => {
    let first = true;
    const spy = vi.fn(async () => {
      if (first) { first = false; throw timeoutErr(); }
      return ok('{"message":"hi"}');
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson({ ...ARGS, timeoutMs: 10 })).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retry ke baad bhi timeout ho to null — par LOOP nahi", async () => {
    const spy = vi.fn(async () => { throw timeoutErr(); });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson({ ...ARGS, timeoutMs: 10 })).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("do baar timeout = EK breaker failure, do nahi", async () => {
    /* Wahi jaal jo 5xx retry me pehle phans chuka hai: ek logical call do failure ginne
       lage to 3 ka threshold dedh call me trip kar jata hai. */
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr(); }));
    await geminiJson({ ...ARGS, timeoutMs: 10 });   // 1
    await geminiJson({ ...ARGS, timeoutMs: 10 });   // 2 — abhi khula rehna chahiye

    const spy = vi.fn(async () => ok('{"message":"still calling"}'));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson({ ...ARGS, timeoutMs: 10 })).resolves.toEqual({ message: "still calling" });
    expect(spy).toHaveBeenCalled();
  });

  it("network error bhi retry hota hai — wo bhi transport ki galti hai", async () => {
    let first = true;
    const spy = vi.fn(async () => {
      if (first) { first = false; const e = new Error("fetch failed"); e.name = "TypeError"; throw e; }
      return ok('{"message":"hi"}');
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("khraab JSON par retry NAHI — wo transport ki galti nahi hai", async () => {
    /* Model ne jawab diya, bas wo JSON nahi tha. Dobara poora model call karna mehnga hai
       aur usi jawab ke dobara aane ki poori umeed hai. */
    const spy = vi.fn(async () => ok("this is not json"));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("WAJAH deta hai — 'gave no reason' dobara na chhape", async () => {
    /* Yahi wo line thi jo lead ke log me gayi thi. */
    vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr(); }));
    let reason = "";
    await geminiJson({ ...ARGS, timeoutMs: 15_000, onFailure: (r) => { reason = r; } });
    expect(reason).not.toBe("");
    expect(reason).toMatch(/15 second|jawab nahi/i);
    expect(reason).toMatch(/dobara koshish|phir se/i);   // §24: ab kya karein
  });

  it("network error par bhi wajah deta hai", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { const e = new Error("socket hang up"); e.name = "TypeError"; throw e; }));
    let reason = "";
    await geminiJson({ ...ARGS, onFailure: (r) => { reason = r; } });
    expect(reason).toContain("socket hang up");
  });

  it("har failure path wajah deta hai — docstring ka dava, ab naapa hua", async () => {
    /* Docstring kehta hai "every failure path". Pehle catch shakh chhoot gayi thi, aur
       theek wahi shakh prod me chali. */
    const paths: Array<[string, () => void]> = [
      ["timeout",  () => vi.stubGlobal("fetch", vi.fn(async () => { throw timeoutErr(); }))],
      ["http 403", () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 403, text: async () => "{}", json: async () => ({}) } as unknown as Response)))],
      ["bad json", () => vi.stubGlobal("fetch", vi.fn(async () => ok("nope")))],
      ["khaali",   () => vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ candidates: [] }), text: async () => "" } as unknown as Response)))],
    ];
    for (const [name, setup] of paths) {
      __resetGeminiBreaker();
      setup();
      let reason = "";
      await geminiJson({ ...ARGS, timeoutMs: 10, onFailure: (r) => { reason = r; } });
      expect(reason, `${name} ne wajah nahi di`).not.toBe("");
    }
  });
});

/* ══ 28 Aug 2026 — free-tier quota, aur ek retry jo fail hona hi tha ══════════
   Prod log se poora 429 payload (23 Aug 16:11, 7 second me 8 baar):

       quotaId    GenerateRequestsPerMinutePerProjectPerModel-FreeTier
       quotaValue 5
       model      gemini-3.7-flash
       retryDelay 29s

   Retry 900ms baad hota tha. 29 second wale quota ke saamne wo fail hona hi tha — aur
   fail hone se pehle wo ek quota slot kha leta tha, jo kisi doosri asli call ko mil sakta
   tha. Rate limit par hathauda maarna use theek nahi karta.
   ══════════════════════════════════════════════════════════════════════════════ */
describe("429 — Google ka retryDelay maano", () => {
  /** Asli payload ki shakl, chhota karke. */
  const quota429 = (retryDelay: string | null) => ({
    ok: false, status: 429,
    text: async () => JSON.stringify({
      error: {
        code: 429,
        message: "You exceeded your current quota, please check your plan and billing details.",
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
            violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }] },
          ...(retryDelay ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }] : []),
        ],
      },
    }),
    json: async () => ({}),
  });

  it("29s wala 429 retry NAHI hota — ASLI MAAMLA", async () => {
    const spy = vi.fn(async () => quota429("29s"));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy, "29 second ke quota par dobara maarna ek slot barbaad karta hai")
      .toHaveBeenCalledTimes(1);
  });

  it("dashamlav wala delay bhi padhta hai — Google '29.430997524s' bhejta hai", async () => {
    const spy = vi.fn(async () => quota429("29.430997524s"));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("chhota delay (1s) par retry HOTA hai — wo asli transient blip hai", async () => {
    let first = true;
    const spy = vi.fn(async () => {
      if (first) { first = false; return quota429("1s"); }
      return ok('{"message":"hi"}');
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("retryDelay bilkul na ho to purana vyavhaar — retry", async () => {
    /* Har 429 me RetryInfo nahi hota. Us haalat me "pata nahi" ka jawab "koshish kar lo"
       hai, kyunki pehle bhi wahi hota tha aur wo ek transient 429 ko bachata hai. */
    const spy = vi.fn(async () => quota429(null));
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toBeNull();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("5xx par ye shart NAHI lagti — wo quota nahi, upstream ki hichki hai", async () => {
    /* Ek 503 jiske saath bada retryDelay bhi ho, tab bhi retry hona chahiye. */
    let first = true;
    const spy = vi.fn(async () => {
      if (first) {
        first = false;
        return { ok: false, status: 503,
          text: async () => JSON.stringify({ error: { details: [{ "@type": "x", retryDelay: "60s" }] } }),
          json: async () => ({}) };
      }
      return ok('{"message":"hi"}');
    });
    vi.stubGlobal("fetch", spy);
    await expect(geminiJson(ARGS)).resolves.toEqual({ message: "hi" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("quota ka jawab paise ki baat karta hai, aur wajah caller tak jaati hai", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => quota429("29s")));
    let reason = "";
    await geminiJson({ ...ARGS, onFailure: (r) => { reason = r; } });
    expect(reason).toMatch(/quota|rate limit/i);
    expect(reason).toMatch(/paid key|free-tier/i);   // ab kya karein
  });
});

/* ══ Hot path apna khud ka fetch na kare ════════════════════════════════════ */
describe("inbound-email ka extract geminiJson se guzre", () => {
  it("apna fetch nahi karta — breaker aur timeout usi se milte hain", () => {
    /* 23 Aug ko yahi jagah 7 second me 8 baar 429 kha gayi thi, kyunki iske paas breaker
       hi nahi tha. Aur timeout na hone ka matlab tha: Gemini atke to ye request atke, aur
       forwarder POST ke baad thread label kar deta hai — yaani enquiry gayi. */
    const src = readFileSync(
      join(process.cwd(), "src", "lib", "inbound", "ingest.ts"), "utf8");
    expect(src).toContain("geminiJson<Partial<ExtractedLead>>");
    expect(src).not.toContain("generativelanguage.googleapis.com");
  });
});

/* ══ 28 Aug 2026 — Gemini ka ek hi darwaza ═══════════════════════════════════
   Us din tak AATH jagah apna `fetch` karke Gemini bulati thi. Har ek geminiJson ki
   lagbhag hu-ba-hu copy thi — wahi request shape, wahi ```json fence ka safai — bas uski
   suraksha ke bina: **na timeout, na circuit breaker, na retry**.

   Keemat log me naapi gayi: 23 Aug ko `[inbound-email] Gemini failed: 429` SAAT SECOND ME
   AATH BAAR. Free-tier ka quota 5-per-minute tha; geminiJson ka breaker 3 lagatar failure
   ke baad ruk jata hai, par us jagah breaker hi nahi tha.

   Aur timeout ka na hona isse bura tha: read-bill aur ai/extract-statement ke paas KOI
   timeout nahi tha, aur wo dono paise ka data padhte hain (vendor bill, bank statement).

   Meri apni ginti bhi pehle GALAT thi — maine `Gemini failed:` message se grep kiya tha,
   URL se nahi, aur teen jagah chhoot gayi thi. Isliye ye test message par nahi, **URL par**
   baitha hai.
   ══════════════════════════════════════════════════════════════════════════════ */
describe("Gemini ka ek hi darwaza", () => {
  const SRC = join(process.cwd(), "src");

  /** Har .ts/.tsx file, test files chhod kar. */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
    }
    return out;
  }

  /**
   * Ek chhoot, aur uski wajah us file me likhi hai: key-test route ko apna fetch chahiye,
   * kyunki breaker module-scoped hai — doosre feature ke teen failure ke baad ye page
   * "aapki key kaam nahi karti" keh deta, jabki key theek hai.
   */
  const ALLOWED = [
    join("src", "lib", "ai", "gemini.ts"),
    join("src", "app", "api", "integrations", "gemini", "test", "route.ts"),
  ];

  it("gemini.ts aur key-test ke ALAWA koi seedha Gemini API nahi bulata", () => {
    const offenders = walk(SRC)
      .filter((p) => readFileSync(p, "utf8").includes("generativelanguage.googleapis.com"))
      .filter((p) => !ALLOWED.some((a) => p.endsWith(a)));
    expect(offenders.map((p) => p.slice(p.indexOf("src")))).toEqual([]);
  });

  it("chhoot wali dono file asli me maujood hain", () => {
    /* Warna ek rename is test ko chup-chaap khokhla kar deta: allow-list kisi cheez se
       mel nahi khati, aur offenders hamesha khaali. */
    for (const a of ALLOWED) {
      expect(existsSync(join(process.cwd(), a)), a).toBe(true);
    }
  });
});

/* ══ attachment aur optional system — request ka BODY naapo ══════════════════
   Ye block ek bache hue mutation se bana. Maine `args.attachment` ko band kar diya (parts
   me se inlineData nikal gaya) aur 45 me se 45 test green rahe — kyunki koi test request
   ke ANDAR nahi dekh raha tha.

   Chup-chaap yahi tootta: read-bill aur ai/extract-statement sirf prompt bhejne lagte,
   bina image/PDF, aur model kuch bhi bana kar de deta. Dono paise ka data padhte hain
   (vendor bill, bank statement), to "chup-chaap galat" sabse bura nateeja hai.
   ══════════════════════════════════════════════════════════════════════════════ */
describe("request ka body — attachment aur system", () => {
  /** Jo body Gemini ko bheji gayi, parse karke. */
  function sentBody(spy: ReturnType<typeof vi.fn>) {
    const init = spy.mock.calls[0][1] as { body: string };
    return JSON.parse(init.body) as {
      systemInstruction?: { parts: Array<{ text: string }> };
      contents: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    };
  }

  it("attachment inlineData part ban kar jata hai — ASLI MAAMLA", async () => {
    const spy = vi.fn(async () => ok('{"ok":true}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson({
      ...ARGS,
      attachment: { mimeType: "application/pdf", base64: "JVBERi0xLjQK" },
    });
    const parts = sentBody(spy).contents[0].parts;
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ text: ARGS.user });
    expect(parts[1]).toEqual({ inlineData: { mimeType: "application/pdf", data: "JVBERi0xLjQK" } });
  });

  it("attachment na ho to sirf text — koi khaali part nahi", async () => {
    /* Ek khaali/undefined part Gemini ko 400 deta hai, to purane callers ka shape bilkul
       waisa hi rehna chahiye. */
    const spy = vi.fn(async () => ok('{"ok":true}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson(ARGS);
    expect(sentBody(spy).contents[0].parts).toEqual([{ text: ARGS.user }]);
  });

  it("system diya ho to systemInstruction jata hai", async () => {
    const spy = vi.fn(async () => ok('{"ok":true}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson({ ...ARGS, system: "be brief" });
    expect(sentBody(spy).systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
  });

  it("system NA diya ho to systemInstruction bhejta hi nahi", async () => {
    /* Teen callers apna poora prompt `user` me rakhte hain. Unhe khaali systemInstruction
       bhejna prompt ki jagah badal dene jaisa hai, aur do me se ek bank statement padhta
       hai — output badalne ka khatra bina wajah nahi lena. */
    const spy = vi.fn(async () => ok('{"ok":true}'));
    vi.stubGlobal("fetch", spy);
    const { system: _drop, ...noSystem } = { ...ARGS, system: undefined };
    await geminiJson(noSystem);
    expect(sentBody(spy)).not.toHaveProperty("systemInstruction");
  });

  it("retry par bhi attachment saath jata hai", async () => {
    /* Retry `{...args}` se banta hai, par ek aisa retry jo attachment gira de wo pehli
       koshish se ALAG cheez bhej raha hoga — aur uska nateeja "kabhi-kabhi galat" hota,
       jo pakadna sabse mushkil hai. */
    let first = true;
    const spy = vi.fn(async () => {
      if (first) { first = false; return { ok: false, status: 503, text: async () => "{}", json: async () => ({}) } as unknown as Response; }
      return ok('{"ok":true}');
    });
    vi.stubGlobal("fetch", spy);
    await geminiJson({ ...ARGS, attachment: { mimeType: "image/png", base64: "iVBORw0K" } });
    expect(spy).toHaveBeenCalledTimes(2);
    /* `vi.fn(async () => ...)` ke params khaali hain, to TS uske call tuple ko `[]` samajhta
       hai aur index 1 par error deta hai. `unknown` se guzar kar cast karna hi tarika hai. */
    const calls = spy.mock.calls as unknown as Array<[string, { body: string }]>;
    const second = JSON.parse(calls[1][1].body) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(second.contents[0].parts[1]).toEqual({ inlineData: { mimeType: "image/png", data: "iVBORw0K" } });
  });

  it("R-830: attachments — several images go after the text, in order", async () => {
    const spy = vi.fn(async () => ok('{"ok":true}'));
    vi.stubGlobal("fetch", spy);
    await geminiJson({ ...ARGS, attachments: [{ mimeType: "image/jpeg", base64: "QQ==" }, { mimeType: "image/png", base64: "Qg==" }] });
    const parts = (sentBody(spy) as { contents: Array<{ parts: Array<Record<string, unknown>> }> }).contents[0].parts;
    expect(parts).toHaveLength(3);
    expect(parts[1]).toEqual({ inlineData: { mimeType: "image/jpeg", data: "QQ==" } });
    expect(parts[2]).toEqual({ inlineData: { mimeType: "image/png", data: "Qg==" } });
  });
});
