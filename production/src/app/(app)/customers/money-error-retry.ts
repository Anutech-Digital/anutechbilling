/**
 * R-2567: where Companies puts the ONE "Try again" for failed money reads.
 *
 * The page has two error places: the generic money banner (R-1806 — any of the money reads) and
 * R-2562's Has receivables line ("Project invoices couldn't be read", the owed reads only). Both
 * used to show a Try again for the same failure. Rule:
 *  - the line is on screen and every failed money read is one the line names → the line's button;
 *  - another money read failed too → the banner (it retries every failed read); the line still
 *    names its part, without a second button;
 *  - the companies list itself failed → no banner (the page's list error has its own Try again,
 *    as before), but a line on screen keeps its button — that list retry never re-reads the owed
 *    money, so the line must not be left without one.
 */
export function moneyErrorRetry(s: { failed: number; owedFailed: number; owedLineShown: boolean; listFailed: boolean }): {
  banner: boolean;
  lineButton: boolean;
} {
  const lineCoversAll = s.owedLineShown && s.owedFailed > 0 && s.owedFailed === s.failed;
  const banner = s.failed > 0 && !s.listFailed && !lineCoversAll;
  return { banner, lineButton: s.owedLineShown && !banner };
}
