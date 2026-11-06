/**
 * R-2524 — remember a per-line answer across saves.
 *
 * After every reconcile save the bank page gets a refreshed line list. TanStack Query keeps the
 * SAME object for every line that did not change (structural sharing), and the delta refetch
 * (parallel-pages / bank.ts) reuses the old objects too — so an answer stored per line object
 * stays right until either the line changes (new object → asked again) or one of the inputs the
 * answer depends on changes (customers, invoices, vendors, rules … → everything asked again).
 *
 *   const memo = useRef(createLineMemo<boolean>()).current;
 *   memo.reset([customers, invoices]);          // once per pass; a changed input clears it
 *   lines.filter((t) => memo.get(t, () => slowRule(t)));
 */
export interface LineMemo<R> {
  /** Start a pass. Any input not identical (Object.is) to the last pass clears every answer. */
  reset(inputs: readonly unknown[]): void;
  /** The answer for this line object — worked out once, then remembered. */
  get(line: object, compute: () => R): R;
}

export function createLineMemo<R>(): LineMemo<R> {
  let last: readonly unknown[] | null = null;
  let answers = new WeakMap<object, { v: R }>();
  return {
    reset(inputs) {
      const same = last !== null && last.length === inputs.length && inputs.every((x, i) => Object.is(x, last![i]));
      if (!same) answers = new WeakMap();
      last = [...inputs];
    },
    get(line, compute) {
      const hit = answers.get(line);
      if (hit) return hit.v;
      const v = compute();
      answers.set(line, { v });
      return v;
    },
  };
}
