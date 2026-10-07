"use client";

/**
 * R-215: the payment ids the table is painting right now, in screen order — for the
 * j / k / Enter keys. Watches the DOM under `ref`, because a header sort or "Load more"
 * re-renders only DataTable, not this page. State changes only when the order does, so
 * this cannot loop.
 */
import * as React from "react";
import { readRowIds, sameIds } from "./payment-table";

export function useRowOrder(ref: React.RefObject<HTMLElement | null>, enabled = true): string[] {
  const [ids, setIds] = React.useState<string[]>([]);

  React.useEffect(() => {
    const root = ref.current;
    if (!enabled || !root) { setIds((prev) => (prev.length ? [] : prev)); return; }
    const sync = () => {
      const next = readRowIds(root);
      setIds((prev) => (sameIds(prev, next) ? prev : next));
    };
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, [ref, enabled]);

  return ids;
}
