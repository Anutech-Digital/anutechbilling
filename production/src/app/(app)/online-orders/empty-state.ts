/**
 * R-350 (7 Oct 2026) — every Online Orders tab gets its own empty message.
 *
 * Before: the Trials tab with 0 trials said "No orders yet — Orders from your website … appear
 * here" while 8 orders sat on the All tab. The message must describe the VIEW that is empty
 * (this tab / this search / this KPI filter), and "No orders yet" is only true on All.
 */

export type OrdersTab = "all" | "paid" | "trial" | "issues";

export interface EmptyStateInput {
  tab: string;
  search: string;
  /** Label of the active KPI focus filter (e.g. "Provisioning"), or "" when none. */
  focusLabel: string;
  /** Orders loaded in total, before any tab/search/focus filter. */
  totalOrders: number;
}

export interface EmptyStateCopy {
  title: string;
  body: string;
}

export function ordersEmptyState({ tab, search, focusLabel, totalOrders }: EmptyStateInput): EmptyStateCopy {
  if (search.trim()) {
    return { title: "No orders match your search", body: "Try a different search term or clear filters." };
  }
  if (focusLabel) {
    return {
      title: `Nothing in "${focusLabel}"`,
      body: "No order matches this filter right now. Clear the filter to see every order.",
    };
  }
  switch (tab) {
    case "paid":
      return {
        title: "No paid orders yet",
        body: "Orders show here once the customer's payment is received.",
      };
    case "trial":
      return {
        title: "No trials running",
        body: "A trial starts when a customer picks \"Start free trial\" on your website.",
      };
    case "issues":
      return { title: "No issues — all clear!", body: "Every order is provisioning smoothly." };
    default:
      return totalOrders > 0
        ? { title: "No orders to show", body: "Clear filters to see every order." }
        : {
            title: "No orders yet",
            body: "Orders from your website — cart, trials, DMS — appear here as they come in.",
          };
  }
}
