/**
 * The caller's IP for attendance network checks — the same reader /mark, /network, /self and
 * device registration use, so an IP the owner "locked" always matches the IP a mark sees.
 *
 * S20 (28 Sep 2026): never the FIRST X-Forwarded-For entry — a browser can send that itself
 * (`X-Forwarded-For: <office-ip>` from home). lib/security/rate-limit `clientIp` reads from
 * the right, only the hop our own infrastructure added. "" = could not read it, which can
 * never match an allowlist entry.
 */
import { clientIp } from "@/lib/security/rate-limit";

export function requestIp(req: { headers: Headers }): string {
  const ip = clientIp(req.headers);
  return ip === "unknown" ? "" : ip;
}
