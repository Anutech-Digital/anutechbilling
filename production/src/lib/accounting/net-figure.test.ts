/**
 * R-1486 (17 Oct 2026, Pawan on staging): October was a LOSS of ₹68,100, but the P&L page
 * showed it as "What's left → Net profit ₹68,100" — no minus, and the word "profit". The
 * step chart's last bar said the same. A loss must read "Net loss" with a minus sign, in
 * every place, from one helper. The computed number itself never changes.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { netFigure, signedRupee } from "./net-figure";
import { pnlWaterfall } from "./waterfall";
import { MoneyFlow } from "@/components/features/accounting/money-flow";
import { PnlWaterfall } from "@/components/features/accounting/pnl-waterfall";
import { PnlHeadline } from "@/components/features/accounting/pnl-headline";
import type { PnlPeriod } from "./pnl";

describe("netFigure", () => {
  it("a loss reads 'Net loss' with a minus sign", () => {
    expect(netFigure(-68_100)).toEqual({ label: "Net loss", text: "−₹68,100", isLoss: true });
  });

  it("a profit is unchanged", () => {
    expect(netFigure(68_100)).toEqual({ label: "Net profit", text: "₹68,100", isLoss: false });
    expect(netFigure(0)).toEqual({ label: "Net profit", text: "₹0", isLoss: false });
  });

  it("compact keeps the sign in front of the rupee", () => {
    expect(netFigure(-68_100, { compact: true }).text).toBe("−₹68.1K");
  });

  it("signedRupee never prints '₹-'", () => {
    expect(signedRupee(-500)).toBe("−₹500");
    expect(signedRupee(500)).toBe("₹500");
    expect(signedRupee(-0.4)).toBe("₹0");
  });
});

describe("pnlWaterfall net step label", () => {
  const base = { revenue: 100_000, cogs: 60_000, cogsBasis: "billed" as const, grossMargin: 40_000, expenses: 108_100 };
  it("names the last step 'Net loss' when the month lost money", () => {
    const steps = pnlWaterfall({ ...base, netProfit: -68_100 });
    expect(steps?.at(-1)?.label).toBe("Net loss");
  });
  it("keeps 'Net profit' for a profit", () => {
    const steps = pnlWaterfall({ ...base, expenses: 10_000, netProfit: 30_000 });
    expect(steps?.at(-1)?.label).toBe("Net profit");
  });
});

describe("every P&L place shows a loss with a minus", () => {
  it("MoneyFlow 'What's left' row", () => {
    const html = renderToStaticMarkup(createElement(MoneyFlow, {
      scale: 100_000,
      rows: [
        { key: "revenue", group: "in", label: "Revenue", amount: 100_000 },
        { key: "net", group: "left", label: netFigure(-68_100).label, amount: -68_100 },
      ],
    }));
    expect(html).toContain("Net loss");
    expect(html).toContain("−₹68,100");
    expect(html).not.toContain("Net profit");
    expect(html).not.toContain("₹-");
  });

  it("MoneyFlow profit row is unchanged", () => {
    const html = renderToStaticMarkup(createElement(MoneyFlow, {
      scale: 100_000,
      rows: [{ key: "net", group: "left", label: netFigure(68_100).label, amount: 68_100 }],
    }));
    expect(html).toContain("Net profit");
    expect(html).toContain("₹68,100");
    expect(html).not.toContain("−₹68,100");
  });

  it("step chart's last bar", () => {
    const steps = pnlWaterfall({ revenue: 100_000, cogs: 60_000, cogsBasis: "billed", grossMargin: 40_000, expenses: 108_100, netProfit: -68_100 });
    const html = renderToStaticMarkup(createElement(PnlWaterfall, { steps: steps ?? [] }));
    expect(html).toContain("Net loss");
    expect(html).toContain("−₹68.1K");
  });

  it("headline tile", () => {
    const model: PnlPeriod = {
      revenue: 100_000, cogs: 60_000, cogsBasis: "billed", licenceCogs: 60_000, projectCost: 0,
      projectRevenue: 0, expenses: 108_100, grossMargin: 40_000, grossMarginPct: 40, netProfit: -68_100, byVendor: [],
    };
    const html = renderToStaticMarkup(createElement(PnlHeadline, {
      model, revenueCount: 3, expensesCount: 5, outputGst: 18_000, onOpen: () => {},
    }));
    expect(html).toContain("Net loss");
    expect(html).toContain("−₹68,100");
  });
});
