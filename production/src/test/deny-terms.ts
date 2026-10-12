/**
 * R-1432: client-specific terms (company names, tenant ids) are never written in this public
 * repo. Guard tests that must prove such a term is gone load the terms from
 * SECRET_SCAN_DENY_TERMS (comma/newline separated; a CI secret, or set locally). Unset → a
 * regex that never matches, so the guard is a no-op rather than a leak.
 */
export function denyTermsRe(): RegExp {
  const terms = (process.env.SECRET_SCAN_DENY_TERMS ?? "")
    .split(/[,\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return terms.length ? new RegExp(terms.join("|"), "i") : /(?!)/;
}
