/**
 * R-710 (+ R-702..R-709, R-711): the fetch every server-side Supabase client uses.
 *
 * ─── WHY ─────────────────────────────────────────────────────────────────────
 * Live logs, 9–10 Oct 2026: the crons, the website catalog and the middleware all failed
 * the same way — `ConnectTimeoutError api.anutech.in:443` (undici's 10 s connect timeout)
 * or `TypeError: fetch failed`. api.anutech.in is the self-hosted data plane (GoTrue +
 * PostgREST on the `supabase-gateway` VM). The server clients handed supabase-js a bare
 * `fetch`: one dropped connection = one failed request = one 5xx, with no second try.
 *
 * This wrapper retries a request that FAILED TO REACH the server:
 *   · connect errors (timeout, refused, DNS, unreachable) → the request never left, so a
 *     retry is safe for every method, writes included;
 *   · socket resets and our own per-attempt timeout → retried only for GET/HEAD, because a
 *     write may already have landed and must not run twice.
 * An HTTP answer (4xx/5xx from PostgREST) is never retried here — the server spoke.
 * A caller's own abort is never retried either. PostgREST READS (GET/HEAD/OPTIONS on
 * /rest/v1/) are left alone: postgrest-js 2.106 already retries those 3 times itself, and a
 * second layer would turn one dead host into 8 × 10 s waits.
 *
 * It cannot fix a gateway that stays down; it removes the blips and makes the logs say
 * which kind of failure it was (`[supabase-fetch]` lines).
 */

export interface ResilientFetchOptions {
  /** Extra attempts after the first (default 1). */
  retries?: number;
  /** Per-attempt timeout in ms; 0/undefined = none (undici's own connect timeout applies). */
  timeoutMs?: number;
  /** Wait before retry n is backoffMs * n (default 300). */
  backoffMs?: number;
  /** For tests. */
  baseFetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Name in the log line. */
  label?: string;
}

const CONNECT_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
]);
const SOCKET_CODES = new Set(["ECONNRESET", "UND_ERR_SOCKET", "EPIPE", "UND_ERR_CLOSED"]);

export type NetworkErrorKind = "connect" | "socket" | "timeout";

/** Our own per-attempt timeout marks its error with this name. */
const ATTEMPT_TIMEOUT = "SupabaseFetchTimeout";

function codeOf(e: unknown): string | null {
  let cur: unknown = e;
  for (let depth = 0; cur && typeof cur === "object" && depth < 5; depth++) {
    const c = (cur as { code?: unknown }).code;
    if (typeof c === "string") return c;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * What kind of network failure this is, or null if it is not one we may retry
 * (a caller abort, a programming error, anything else).
 */
export function networkErrorKind(e: unknown): NetworkErrorKind | null {
  if (!e || typeof e !== "object") return null;
  const name = (e as { name?: unknown }).name;
  if (name === ATTEMPT_TIMEOUT) return "timeout";
  if (name === "AbortError") return null; // the caller aborted — respect it
  const code = codeOf(e);
  if (code && CONNECT_CODES.has(code)) return "connect";
  if (code && SOCKET_CODES.has(code)) return "socket";
  // undici: `TypeError: fetch failed` with no recognisable cause — treat as a connection
  // failure only for idempotent requests (see below), never for writes.
  if (e instanceof TypeError && /fetch failed/i.test(e.message)) return "socket";
  return null;
}

function methodOf(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== "undefined" && input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

/** A body we can send twice (supabase-js always sends strings). */
function replayable(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (typeof Request !== "undefined" && input instanceof Request) return false;
  const b = init?.body;
  return b == null || typeof b === "string" || b instanceof URLSearchParams;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function resilientFetch(opts: ResilientFetchOptions = {}): typeof fetch {
  const retries = Math.max(0, opts.retries ?? 1);
  const backoff = opts.backoffMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;
  const label = opts.label ?? "supabase-fetch";

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const base = opts.baseFetch ?? fetch;
    const method = methodOf(input, init);
    const idempotent = method === "GET" || method === "HEAD" || method === "OPTIONS";
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const where = url.replace(/\?.*$/, ""); // never log the query (filters may name people)
    // postgrest-js retries its own reads (see header) — don't stack a second layer on them.
    const ownRetry = idempotent && /\/rest\/v1\//.test(where);
    const canReplay = !ownRetry && replayable(input, init);
    const callerSignal = init?.signal ?? undefined;

    for (let attempt = 0; ; attempt++) {
      const ctl = opts.timeoutMs ? new AbortController() : null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let onCallerAbort: (() => void) | null = null;
      if (ctl) {
        timer = setTimeout(() => {
          const err = new Error(`no answer in ${opts.timeoutMs} ms`);
          err.name = ATTEMPT_TIMEOUT;
          ctl.abort(err);
        }, opts.timeoutMs);
        if (callerSignal) {
          if (callerSignal.aborted) ctl.abort(callerSignal.reason);
          onCallerAbort = () => ctl.abort(callerSignal.reason);
          callerSignal.addEventListener("abort", onCallerAbort, { once: true });
        }
      }
      try {
        return await base(input, ctl ? { ...init, signal: ctl.signal } : init);
      } catch (e) {
        // Our own timeout surfaces as the abort reason (or a DOMException wrapping it).
        const reason = ctl?.signal.aborted ? ctl.signal.reason : null;
        const err =
          reason && (reason as { name?: unknown }).name === ATTEMPT_TIMEOUT && !callerSignal?.aborted
            ? reason
            : e;
        const kind = callerSignal?.aborted ? null : networkErrorKind(err);
        const retryable =
          kind !== null &&
          canReplay &&
          (kind === "connect" || idempotent);
        if (!retryable || attempt >= retries) {
          if (kind) {
            console.error(
              `[${label}] ${method} ${where} failed (${kind}${codeOf(err) ? ` ${codeOf(err)}` : ""}) after ${attempt + 1} attempt(s)`,
            );
          }
          throw err;
        }
        console.warn(`[${label}] ${method} ${where} ${kind} error — retry ${attempt + 1}/${retries}`);
        await sleep(backoff * (attempt + 1));
      } finally {
        if (timer) clearTimeout(timer);
        if (onCallerAbort && callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
      }
    }
  };
  return wrapped as typeof fetch;
}

/**
 * True when a supabase-js / postgrest error object (not a thrown error) says the request
 * never got an answer — postgrest-js turns a thrown fetch into
 * `{ message: "TypeError: fetch failed", code: "" }`, auth-js into AuthRetryableFetchError.
 */
export function isUnreachableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const name = (err as { name?: unknown }).name;
  if (name === "AuthRetryableFetchError") return true;
  if (networkErrorKind(err)) return true;
  const msg = (err as { message?: unknown }).message;
  const details = (err as { details?: unknown }).details;
  const text = `${typeof msg === "string" ? msg : ""} ${typeof details === "string" ? details : ""}`;
  return /fetch failed|ConnectTimeoutError|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|SupabaseFetchTimeout/i.test(text);
}
