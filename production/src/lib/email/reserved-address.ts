/**
 * Never-deliverable addresses (R-361, 7 Oct 2026).
 *
 * Demo data (lib/demo/demo-data.ts) gives every pretend customer, deal and vendor an address
 * on `example.invalid`. RFC 2606 / RFC 6761 reserve the `.invalid` TLD so it can never belong
 * to anybody. The cron jobs that chase money — dunning, renewals — do not know a row is demo;
 * they find an overdue invoice and write to its customer. sendEmail asks this before the
 * provider is called, so such a send is recorded as refused and nothing leaves the building.
 *
 * Only `.invalid`, on purpose: `example.com` and friends are used as ordinary test recipients
 * across the suite, and widening this would change what those tests see.
 */

/** True when the address — or any address in a list / comma-separated string — is on `.invalid`. */
export function isUndeliverableAddress(to: string | readonly string[] | null | undefined): boolean {
  const list = (typeof to === "string" ? to.split(",") : [...(to ?? [])])
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean);
  return list.some((addr) => {
    const m = addr.match(/<([^>]+)>/); // "Name <a@b.c>" → a@b.c
    const email = (m ? m[1] : addr).trim();
    const at = email.lastIndexOf("@");
    if (at < 0) return false;
    const domain = email.slice(at + 1).replace(/\.+$/, "");
    return domain === "invalid" || domain.endsWith(".invalid");
  });
}
