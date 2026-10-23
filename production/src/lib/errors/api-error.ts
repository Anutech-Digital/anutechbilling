/**
 * R-1137: an API route's failure body — a stable `code` the screen can branch on and one
 * sentence a person can act on. The raw database / storage text is logged on the server,
 * never sent to the browser (it can carry table, column or bucket names).
 */
export interface ApiFailure {
  error: string;
  code: string;
}

export function apiFailure(code: string, message: string, detail: unknown, where: string): ApiFailure {
  const raw = (detail as { message?: unknown } | null)?.message;
  // eslint-disable-next-line no-console
  console.error(`[${where}] ${code}:`, typeof raw === "string" ? raw : detail);
  return { error: message, code };
}
