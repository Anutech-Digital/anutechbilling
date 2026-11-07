/**
 * R-2567: where Companies puts the ONE "Try again" for failed money reads.
 *
 * The page has two error places: the generic money banner (R-1806 — any of the money reads) and
 * R-2562's Has receivables line ("Project invoices couldn't be read", the owed reads only). Both
 * used to show a Try again for the same failure. Rule:
 *  - the line is on screen and every failed read is one the line names → the line's button only;
 *  - otherwise (another read failed too, or the line is not on screen) → the banner, which retries
 *    every failed read; the line still names its part, without a second button.
 */
export function moneyErrorRetry(s: { failed: number; owedFailed: number; owedLineShown: boolean }): {
  banner: boolean;
  lineButton: boolean;
} {
  if (s.failed === 0) return { banner: false, lineButton: false };
  const lineCoversAll = s.owedLineShown && s.owedFailed > 0 && s.owedFailed === s.failed;
  return { banner: !lineCoversAll, lineButton: lineCoversAll };
}
