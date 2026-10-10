/**
 * Gemini config resolver — single source of truth for "which API key + model
 * does this tenant's AI use?".
 *
 * Precedence:
 *   1. tenant_secrets.gemini_api_key  (set in Settings → Integrations → AI)
 *   2. process.env.GEMINI_API_KEY     (global Cloud Run fallback)
 *   3. null                           → callers use their deterministic stub
 *
 * Model: tenant_secrets.gemini_model → GEMINI_MODEL env → DEFAULT_MODEL below.
 *   (This line said "gemini-1.5-flash" until 23 Aug 2026 — a model retired in 2025-26 and
 *    not the constant it was describing. A doc-comment naming a value is a second copy of
 *    that value, and this one had been wrong for a year.)
 *
 * The raw key never leaves the server — callers use it to call the Gemini REST
 * API directly and only ever surface a masked preview in the integration UI.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { decryptTenantSecrets } from "@/lib/crypto/tenant-secrets";

export interface GeminiConfig {
  /** Usable API key, or null when neither tenant nor env has a valid one. */
  apiKey: string | null;
  model: string;
}

/**
 * MEASURED, not assumed — 23 Aug 2026, against the live API with a working key:
 *
 *   gemini-3.6-flash   200  "OK"
 *   gemini-2.5-flash   404  "This model models/gemini-2.5-flash is no longer available to
 *                            new users. Please update your code to use models/gemini-3.6-flash"
 *
 * gemini-1.5-* went the same way in 2025-26, and 2.5 has now followed for NEW keys. Note the
 * wording: "no longer available to NEW USERS". An existing key can keep working on a retired
 * model while a freshly created one 404s, so this line ages silently — nothing breaks until
 * somebody rotates a key, and then AI stops for a reason that has nothing to do with the
 * rotation. That is exactly how it was found: a 403 was fixed by a new key and became a 404.
 *
 * If AI drafting dies again, curl one model name before touching any code.
 *
 * ─── AND `ListModels` LIES, WHICH IS WORSE THAN BEING OUT OF DATE ───────────
 * Measured in the same sitting, with the same key:
 *
 *   ListModels reports  gemini-2.5-flash   →  calling it returns 404
 *   ListModels omits    gemini-3.6-flash   →  calling it returns 200
 *
 * So the discovery endpoint is not a source of truth for what will work, in either
 * direction. The old comment here already half-knew this ("the gemini-2.0-flash alias 404s
 * on some keys even when ListModels reports it") and still pinned a version.
 *
 * ─── WHY AN ALIAS, AND WHAT IT COSTS ───────────────────────────────────────
 * `gemini-flash-latest` is a ROLLING alias — verified 200 alongside 3.6-flash,
 * 3-flash-preview and 3.1-flash-lite. Pinning a version is what caused this outage: the
 * pin aged, silently, and nothing broke until a key was rotated.
 *
 * The cost is real and worth naming: the model behind this can change without a deploy, so
 * generated prose may shift. That is acceptable HERE and would not be everywhere, because
 * nothing downstream trusts the model with money or with facts — `verifyDraftMoney` allows
 * only figures already on the deal, `findPromises` refuses any price, date, discount or
 * guarantee before an unattended send, and `responseMimeType: application/json` pins the
 * response CONTRACT rather than the model. A model swap can make a reply read differently;
 * it cannot make it promise something.
 */
const DEFAULT_MODEL = "gemini-flash-latest";

function valid(key: string | null | undefined): string | null {
  const k = key?.trim();
  if (!k || k === "..." || k.length < 10) return null;
  return k;
}

/**
 * Resolve the Gemini config for a tenant. Pass any Supabase client that can read
 * `tenant_secrets` for this tenant (an admin client, or a session client whose
 * RLS already scopes to the tenant). `tenantId` may be omitted/null to use the
 * env fallback only.
 */
export async function resolveGeminiConfig(
  client: SupabaseClient<Database>,
  tenantId?: string | null,
): Promise<GeminiConfig> {
  let key = valid(process.env.GEMINI_API_KEY);
  let model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;

  if (tenantId) {
    try {
      const { data } = await client
        .from("tenant_secrets")
        .select("gemini_api_key, gemini_model")
        .eq("tenant_id", tenantId)
        .maybeSingle();
      // Stored encrypted since the vault landed; plaintext rows pass through.
      const tenantKey = valid(decryptTenantSecrets(data)?.gemini_api_key);
      if (tenantKey) key = tenantKey;           // tenant key wins over env
      if (data?.gemini_model?.trim()) model = data.gemini_model.trim();
    } catch {
      // fall back to env on any read error
    }
  }

  return { apiKey: key, model };
}

// ─────────────────────────────────────────────────────────────────────────────
// Calling Gemini: timeout + circuit breaker
//
// Every AI route awaited a bare `fetch` with no timeout. Gemini is a third party
// on the far side of the internet; when it stalls rather than fails, the request
// stalls with it, and the operator watches a spinner until the platform kills the
// function. The AI here is always an enhancement over a deterministic stub, so
// waiting indefinitely for it is never the right trade.
// ─────────────────────────────────────────────────────────────────────────────

/** A slow draft is a failed draft — the stub is already good enough to send. */
const DEFAULT_TIMEOUT_MS = 15_000;

/** Consecutive failures before we stop calling, and how long we stay shut. */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 60_000;

/**
 * Circuit breaker state, module-scoped.
 *
 * Honest about what this is: on a serverless platform each warm instance keeps
 * its own copy, so this is not a cluster-wide breaker. It still does the thing
 * that matters — when Gemini is down, the instance stops paying the full timeout
 * on every single request and falls straight through to the deterministic stub.
 * A shared breaker would need Redis or a table, which is not worth it for a
 * feature whose failure mode is "slightly less personalised text".
 */
const breaker = { failures: 0, openedAt: 0 };

function breakerOpen(now: number): boolean {
  if (breaker.failures < BREAKER_THRESHOLD) return false;
  if (now - breaker.openedAt < BREAKER_COOLDOWN_MS) return true;
  // Cooldown elapsed — let one request through to test the water.
  breaker.failures = 0;
  return false;
}

function recordFailure(now: number) {
  breaker.failures += 1;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.openedAt = now;
}

/**
 * Turn a Gemini failure into a sentence somebody can act on.
 *
 * ─── WHY THIS EXISTS, MEASURED IN WASTED HOURS ──────────────────────────────
 * Every failure path in geminiJson returned bare `null`, so every caller reported the same
 * thing: "the AI did not return a reply". On 23-24 Aug 2026 that one sentence stood for FOUR
 * completely different problems, and it sent me to the wrong place three times:
 *
 *   403 PERMISSION_DENIED   the GCP project had billing disabled
 *   404 NOT_FOUND           gemini-2.5-flash retired for new keys
 *   503 UNAVAILABLE         Google momentarily overloaded
 *   429 RESOURCE_EXHAUSTED  free tier, 20 requests/day/model, exhausted
 *
 * Google said all four plainly in the response body. We threw the body away and wrote a
 * guess. The first is fixed in a billing console, the second in a config field, the third by
 * waiting a second, the fourth by waiting a day or paying — and "the AI did not return a
 * reply" points at none of them.
 */
/**
 * Google ke 429 me `retryDelay` hota hai — "Please retry in 29.43s".
 *
 * Ye batata hai ki quota kab khulega, aur isi se tay hota hai ki retry ka koi matlab hai
 * ya nahi. `null` jab body me kuch na ho.
 */
function retryDelaySeconds(body: string): number | null {
  try {
    const j = JSON.parse(body) as { error?: { details?: Array<Record<string, unknown>> } };
    for (const d of j.error?.details ?? []) {
      /* "29s" ya "29.43s" — dono. Sirf seconds aata hai is API me. */
      if (typeof d.retryDelay === "string") {
        const n = Number.parseFloat(d.retryDelay);
        if (Number.isFinite(n)) return n;
      }
    }
  } catch { /* non-JSON body: kuch nahi keh sakte */ }
  return null;
}

function failureReason(status: number, body: string): string {
  let msg = "";
  let retryDelay: string | null = null;
  try {
    const j = JSON.parse(body) as { error?: { message?: string; details?: Array<Record<string, unknown>> } };
    /* First line only. Google's 429 message runs to several lines including a full URL and
       a usage-dashboard link; the first line is the part a person needs. */
    msg = (j.error?.message ?? "").split(/\r?\n/)[0].trim();
    for (const d of j.error?.details ?? []) {
      if (typeof d.retryDelay === "string") retryDelay = d.retryDelay;
    }
  } catch { /* a non-JSON body is still worth reporting by status */ }

  const tail = retryDelay ? ` Google says retry in ${retryDelay}.` : "";
  if (status === 429) {
    return `Gemini quota or rate limit reached — ${msg || "too many requests"}.${tail} ` +
      "A free-tier key allows only a few requests per day per model; a paid key removes this.";
  }
  if (status === 403) {
    return `Gemini refused the project — ${msg || "permission denied"}. Check that billing is ` +
      "enabled on the Google Cloud project the key belongs to.";
  }
  if (status === 404) {
    return `Gemini does not have that model — ${msg || "not found"}. Change the model in ` +
      "Settings → Integrations → Gemini.";
  }
  if (status === 400) {
    return `Gemini rejected the request — ${msg || "bad request"}. Usually the API key is wrong.`;
  }
  if (status >= 500) {
    return `Gemini is temporarily unavailable — ${msg || "upstream error"}.${tail} Nothing is ` +
      "misconfigured; it clears on its own.";
  }
  return `Gemini returned HTTP ${status}${msg ? ` — ${msg}` : ""}.`;
}

/**
 * Call Gemini and parse a JSON response.
 *
 * Returns null on EVERY failure path — timeout, HTTP error, unparseable body,
 * open breaker. Callers already treat null as "use the deterministic stub", so
 * no AI failure can break a core flow. This never throws.
 */
export async function geminiJson<T>(args: {
  apiKey: string;
  model: string;
  /**
   * OPTIONAL, aur jaan-boojhkar.
   *
   * Teen callers (read-bill, scan-visiting-card, ai/extract-statement) apna poora prompt
   * `user` part me bhejte the aur `systemInstruction` bhejte hi nahi the. Prompt ko user se
   * system me sarka dena model ke output ko badal sakta hai — aur unme se do PAISE ka data
   * padhte hain (vendor bill, bank statement). Unhe geminiJson par laate waqt shakl bilkul
   * waisi hi rakhi gayi jaisi thi; isliye ye field optional hai, aur khaali hone par
   * `systemInstruction` request me jata hi nahi.
   */
  system?: string;
  user: string;
  /**
   * Image ya PDF, `user` text ke saath.
   *
   * Iske bina ye teen callers geminiJson par nahi aa sakte the — aur unke paas timeout,
   * circuit breaker aur retry me se kuch bhi nahi tha.
   */
  attachment?: { mimeType: string; base64: string };
  /** R-830: more images after `attachment` (AI Help sends up to 5 screenshots with one message). */
  attachments?: readonly { mimeType: string; base64: string }[];
  temperature?: number;
  timeoutMs?: number;
  /** Prefix for server logs, e.g. "ai/draft-followup". */
  label: string;
  /**
   * Called with a human-readable reason on every failure path. Optional so existing callers
   * are unchanged — but any caller that shows a failure to a person should pass it, because
   * `null` alone is what made four different faults read identically.
   */
  onFailure?: (reason: string) => void;
  /**
   * OPT-IN second model for when Google says the main one is overloaded (503 "high
   * demand") on both tries. Asked once, with no retry of its own. Only for callers where a
   * person is waiting on an answer (the website sales chat); webhooks keep the old
   * two-call ceiling. Added 4 Oct 2026 after the chat answered "could not reply" during a
   * 503 spike (7 times in two days).
   */
  fallbackModel?: string;
  /** Internal. Set on the single retry so it cannot recurse — see the 5xx branch below. */
  __isRetry?: boolean;
}): Promise<T | null> {
  const now = Date.now();
  if (breakerOpen(now)) {
    console.warn(`[${args.label}] Gemini circuit breaker open — using stub`);
    args.onFailure?.("Gemini failed repeatedly just now, so calls are paused for a minute. It retries on its own.");
    return null;
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${args.apiKey}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          /* system khaali ho to bhejte hi nahi — dekho `system` field ka comment. */
          ...(args.system ? { systemInstruction: { parts: [{ text: args.system }] } } : {}),
          contents: [{
            role: "user",
            parts: [
              { text: args.user },
              ...[...(args.attachment ? [args.attachment] : []), ...(args.attachments ?? [])]
                .map((a) => ({ inlineData: { mimeType: a.mimeType, data: a.base64 } })),
            ],
          }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: args.temperature ?? 0.7,
          },
        }),
        signal: AbortSignal.timeout(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[${args.label}] Gemini HTTP ${res.status}:`, body);
      /* RETRYABLE vs NOT, and the distinction was missing entirely until 23 Aug 2026.
         Measured on the live run: a customer's reply went undrafted because Google answered
         503 once. No retry existed — one transient upstream blip and the reply was gone,
         reported as "the AI did not return a reply", which reads like a model problem.

         The three failures traced that day were 403 (project denied), 404 (retired model)
         and 503 (busy). The first two are permanent and retrying them is a waste; the third
         clears in a second. Treating them alike is what made a transient loss look
         identical to a misconfiguration.

         Retried ONCE, not in a loop: this runs inside a webhook a provider is waiting on,
         and the drafter is not so valuable that it should hold a request open through a
         second-long backoff twice. 429 is included — a rate limit is by definition
         temporary — and the breaker still counted the first failure, so a genuine outage
         still trips it rather than being papered over by retries. */
      /* ── 429 par retry SIRF tab jab Google kehta hai ki jaldi khul jayega ─────
         28 Aug 2026 ko log me poora 429 payload padha gaya:

             quotaId    GenerateRequestsPerMinutePerProjectPerModel-FreeTier
             quotaValue 5
             retryDelay 29s

         Yaani retry 900ms baad hota tha jabki quota 29 SECOND me khulta hai. Wo retry
         fail hona hi tha — aur usse do nuksaan the: ek bekaar request, aur us request ne
         ek quota slot kha liya jo kisi doosri asli call ko mil sakta tha. Rate limit par
         hathauda maarna use theek nahi karta.

         Isliye ab Google ka apna `retryDelay` padha jata hai. Chhota (≤2s) ho to retry —
         wo asli transient blip hai. Bada ho to seedha stub par, kyunki 29 second rukna is
         raaste ke liye behtar nahi: `geminiJson` ko webhook bhi bulate hain, aur stub
         pehle se kaafi accha hai (`extracted` ka fallback lead banata hi hai).

         5xx par ye shart nahi lagti — wo quota nahi, upstream ki hichki hai. */
      const delay = retryDelaySeconds(body);
      const quotaShutForAWhile = res.status === 429 && delay !== null && delay > 2;
      const retryable = (res.status === 429 && !quotaShutForAWhile) || res.status >= 500;
      if (retryable && !args.__isRetry) {
        /* NOT counted as a breaker failure here — the retry records the final outcome.
           The first version of this recorded one on the way past AND one on the retry, so a
           single logical call cost TWO failures and the threshold of 3 tripped after one and
           a half calls. Caught by the existing "a success resets the failure count" test,
           which then got null where it expected a draft: the breaker had already opened.

           A retry is one attempt at one thing. Counting its stages separately would make the
           breaker fire on transient noise, which is the opposite of what it is for. */
        console.warn(`[${args.label}] retrying once after HTTP ${res.status}`);
        await new Promise((r) => setTimeout(r, 900));
        return geminiJson<T>({ ...args, __isRetry: true });
      }
      /* Overloaded twice → ask the opt-in fallback model once. Its call records the outcome,
         so this logical call still counts as ONE breaker failure at most. */
      if (res.status === 503 && args.__isRetry && args.fallbackModel && args.fallbackModel !== args.model) {
        console.warn(`[${args.label}] ${args.model} overloaded twice — asking ${args.fallbackModel}`);
        return geminiJson<T>({ ...args, model: args.fallbackModel, fallbackModel: undefined, __isRetry: true });
      }
      recordFailure(now);
      args.onFailure?.(failureReason(res.status, body));
      return null;
    }

    const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) {
      recordFailure(now);
      args.onFailure?.("Gemini answered but the reply was empty.");
      return null;
    }

    // Models still fence JSON in ```json blocks despite responseMimeType.
    const cleaned = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(cleaned) as T;
    breaker.failures = 0;          // a success clears the count
    return parsed;
  } catch (err) {
    // AbortError (timeout), network failure, or malformed JSON all land here.
    const name = (err as Error)?.name;
    const isTimeout = name === "TimeoutError" || name === "AbortError";
    /* SyntaxError = JSON.parse ne model ka jawab reject kiya. Wo transport ki galti NAHI
       hai, aur usme dobara poora model call karna mehnga bhi hai aur bekaar bhi. */
    const isTransport = isTimeout || name === "TypeError" || name === "FetchError";
    const why = isTimeout
      ? `timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
      : (err as Error)?.message;

    /* ── TIMEOUT BHI RETRY HOTA HAI — 28 Aug 2026 ────────────────────────────
       Upar 429/5xx par retry lagi hai, aur uski wajah wahin likhi hai: "one transient
       upstream blip and the reply was gone." Timeout usi jaati ka blip hai, par wo is
       catch me girta tha jahan koi retry nahi thi.

       Us din prod me: 14:09:34 par `ai/sales-agent` ka call 15s par timeout hua, aur
       14:09:40 par `ai_action_log` me `reply.send failed` likha gaya. Ek asli lead ka
       jawab nahi gaya.

       Keemat imaandari se: retry sabse bure haal me 15s aur jodti hai. Ye theek hai kyunki
       inbound-email webhook agent ko `void` karke chhodta hai (koi intezaar nahi kar raha),
       aur ek hi caller ise await karta hai — WhatsApp webhook — jahan Cloud Run ki apni
       request limit 300s hai. Ek retry, loop nahi. */
    if (isTransport && !args.__isRetry) {
      /* recordFailure yahan NAHI — bilkul 5xx wali shakh ki tarah. Ek logical call ek hi
         failure ginni chahiye, warna 3 ka threshold do call me hi trip kar jata hai. */
      console.warn(`[${args.label}] retrying once after ${why}`);
      await new Promise((r) => setTimeout(r, 900));
      return geminiJson<T>({ ...args, __isRetry: true });
    }

    console.error(`[${args.label}] Gemini call failed — ${why}`);
    recordFailure(now);
    /* ── AUR WAJAH BATAO ─────────────────────────────────────────────────────
       Is function ka apna docstring kehta hai ki `onFailure` "every failure path" par
       bulaya jata hai. Ye shakh use nahi bulati thi, aur yahi wo shakh hai jo prod me
       chali. Nateeja lead ke log me chhap gaya, apne hi shabdon me:

           "The AI did not answer, and gave no reason."

       Upar hi likha hai ki `null` akela hi wo cheez thi "that made four different faults
       read identically" — aur ye path abhi tak theek wahi kar raha tha. */
    args.onFailure?.(
      isTimeout
        ? `Gemini ne ${Math.round((args.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000)} second me jawab nahi diya, ` +
          "dobara koshish ke baad bhi. Thodi der baad phir se try kariye."
        : `Gemini se baat nahi ho payi — ${why || "wajah nahi mili"}.`,
    );
    return null;
  }
}


/**
 * Gemini WITH Google Search grounding, plain-text answer. The grounded tool and JSON
 * response mode do not combine on every model, so callers parse JSON out of the text
 * (lib/leads/lead-finder.ts `parseDiscovery`). Throws with a human reason — the one caller
 * (AI Lead Finder) records it on the run, where the owner reads it. Same breaker as geminiJson.
 */
export async function geminiGroundedText(args: { apiKey: string; model: string; system: string; user: string; temperature?: number; timeoutMs?: number; label: string }): Promise<string | null> {
  const now = Date.now();
  if (breakerOpen(now)) throw new Error("Gemini abhi baar-baar fail ho raha hai, ek minute ke liye calls ruki hain — thodi der baad try karo.");
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:generateContent?key=${args.apiKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: "user", parts: [{ text: args.user }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: args.temperature ?? 0.4 },
    }),
    signal: AbortSignal.timeout(args.timeoutMs ?? 60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    recordFailure(now);
    if (res.status === 429) throw new Error("Gemini ka quota khatam hai (free tier) — Settings → Integrations → AI mein billing wali Gemini key daalo; Google Search grounding paid key par hi chalta hai.");
    if (res.status === 400 && /google_search|tool/i.test(body)) throw new Error(`Is Gemini model (${args.model}) par Google Search grounding nahi chalta — env GEMINI_MODEL mein gemini-flash-latest rakho.`);
    throw new Error(failureReason(res.status, body));
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  breaker.failures = 0;
  return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("\n") || null;
}

/** Test-only: reset breaker state between cases. */
export function __resetGeminiBreaker() {
  breaker.failures = 0;
  breaker.openedAt = 0;
}
