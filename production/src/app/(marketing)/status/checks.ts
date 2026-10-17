/**
 * R-1503 — turns the live probes into what /status shows.
 *
 * Every probe runs in parallel with its own timeout (3 s): no answer → Down, an answer slower
 * than 1.5 s → Degraded, a missing setting → Not configured. The whole snapshot is kept for
 * 60 s per server instance (one in-flight run shared by concurrent visitors), so reloading the
 * public page cannot be used to hammer the database or a partner API.
 *
 * Nothing here records history. Uptime over time needs a table + a scheduled check — that is
 * an owner decision (card R-1503 needsDecision), not something this page may invent.
 */
import "server-only";
import { STATUS_PROBES, type ProbeKey, type ProbeResult } from "./probes";

export type ServiceState = "operational" | "degraded" | "down" | "not-configured";
export type OverallState = "operational" | "degraded" | "down";

export interface ServiceStatus {
  key: "app" | ProbeKey;
  name: string;
  note: string;
  state: ServiceState;
  /** One plain sentence for the visitor. Never an error message or a setting value. */
  explain: string;
}

export interface StatusSnapshot {
  checkedAt: Date;
  overall: OverallState;
  services: ServiceStatus[];
}

interface ServiceDef {
  key: ProbeKey;
  name: string;
  note: string;
  explain: Record<ServiceState, string>;
}

const SERVICES: readonly ServiceDef[] = [
  {
    key: "database", name: "Database", note: "Accounts, orders and invoices",
    explain: {
      operational: "Answering normally.",
      degraded: "Answering, but slower than usual.",
      down: "Not answering right now. Sign-in and orders may fail until it is back.",
      "not-configured": "Not set up on this server.",
    },
  },
  {
    key: "payments", name: "Payment gateway", note: "Razorpay — cards, UPI, net banking",
    explain: {
      operational: "Razorpay is reachable. Online payments go through.",
      degraded: "Razorpay is reachable but slow. Payments may take longer.",
      down: "Razorpay is not reachable from our servers. Online payments may fail — please try again shortly.",
      "not-configured": "Online payment is not switched on on this server.",
    },
  },
  {
    key: "registrar", name: "Domain registry API", note: "Search, register, renew, transfer",
    explain: {
      operational: "The registrar is reachable. Domain search and orders work.",
      degraded: "The registrar is reachable but slow. Domain search may take longer.",
      down: "The registrar is not reachable from our servers. Domain search and orders may fail.",
      "not-configured": "Direct registrar access is not set up on this server.",
    },
  },
  {
    key: "email", name: "Email sending", note: "Invoices, reminders, sign-in mails",
    explain: {
      operational: "Our mail server is reachable. Invoices and reminders go out.",
      degraded: "Our mail server is reachable but slow. Emails may arrive late.",
      down: "Our mail server is not reachable. Emails from us may be delayed.",
      "not-configured": "Outgoing email is not set up on this server.",
    },
  },
];

export const CHECK_TIMEOUT_MS = 3_000;
export const SLOW_MS = 1_500;
export const CACHE_MS = 60_000;

const TIMED_OUT = Symbol("timeout");

async function runOne(
  probe: () => Promise<ProbeResult>,
  timeoutMs: number,
  slowMs: number,
): Promise<ServiceState> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      probe(),
      new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); }),
    ]);
    if (result === TIMED_OUT) return "down";
    if (result.state === "not-configured") return "not-configured";
    if (result.state === "error") return "down";
    return Date.now() - t0 > slowMs ? "degraded" : "operational";
  } catch {
    return "down";
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function checkServices(
  opts: { timeoutMs?: number; slowMs?: number } = {},
): Promise<StatusSnapshot> {
  const timeoutMs = opts.timeoutMs ?? CHECK_TIMEOUT_MS;
  const slowMs = opts.slowMs ?? SLOW_MS;
  const states = await Promise.all(SERVICES.map((s) => runOne(STATUS_PROBES[s.key], timeoutMs, slowMs)));

  const services: ServiceStatus[] = [
    {
      // The page itself is being served by the app — if it were down, nobody would read this.
      key: "app", name: "Website & client area", note: "This site, sign-in, ordering",
      state: "operational", explain: "Serving pages normally.",
    },
    ...SERVICES.map((s, i) => ({ key: s.key, name: s.name, note: s.note, state: states[i], explain: s.explain[states[i]] })),
  ];

  // "Not configured" is a fact about this server, not an outage — it does not turn the banner red.
  const overall: OverallState = services.some((s) => s.state === "down")
    ? "down"
    : services.some((s) => s.state === "degraded") ? "degraded" : "operational";

  return { checkedAt: new Date(), overall, services };
}

let cache: { at: number; snapshot: Promise<StatusSnapshot> } | null = null;

/** The snapshot the page shows — at most one live run per CACHE_MS per server instance. */
export function getStatusSnapshot(): Promise<StatusSnapshot> {
  const now = Date.now();
  if (!cache || now - cache.at >= CACHE_MS) {
    cache = { at: now, snapshot: checkServices() };
  }
  return cache.snapshot;
}

/** Tests only. */
export function resetStatusCache(): void {
  cache = null;
}
