"use client";
/**
 * R-2020 (R-2019a): Compare — Starter vs Standard in two columns (the desktop's COMPARE_ROWS),
 * a plain "still unsure?" line, and Choose buttons that pick the plan and go back to Plans.
 */
import type { BuyPlan } from "../_parts/plans";
import { compareRows } from "./prices";
import type { MobileTier } from "./url-state";

const cell = (v: string) => (v === "—" ? "text-ink-3" : v === "✓" ? "text-emerald-ink" : "text-ink");

export function CompareStep({ plans, onBack, onChoose }: { plans: BuyPlan[]; onBack: () => void; onChoose: (t: MobileTier) => void }) {
  const rows = compareRows();
  const name = (id: MobileTier) => plans.find((p) => p.id === id)?.short ?? (id === "starter" ? "Starter" : "Standard");
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-2 py-2 border-b border-hairline">
        <button type="button" aria-label="Back" onClick={onBack}
          className="w-11 h-11 text-[22px] text-ink rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">←</button>
        <h1 className="font-bold text-[17px] m-0">Compare plans</h1>
      </div>
      <div className="p-4 flex flex-col gap-4">
        <p className="text-sm text-ink-2 leading-normal m-0">Both include business email, Gmail, Drive, Meet, Calendar and Docs. The difference is storage, meetings and AI.</p>
        <table className="w-full bg-white border border-hairline rounded-xl overflow-hidden border-separate border-spacing-0 text-sm">
          <thead className="bg-paper-2">
            <tr>
              <th scope="col" className="sr-only">Feature</th>
              <th scope="col" className="py-3 px-2 font-bold text-center border-b border-hairline">{name("starter")}</th>
              <th scope="col" className="py-3 px-2 font-bold text-center border-b border-l border-hairline">{name("standard")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.feature}>
                <th scope="row" className="text-left font-normal text-ink-2 py-2.5 pl-3 pr-2 border-b border-hairline align-top break-words">{r.feature}</th>
                <td className={`text-center font-semibold py-2.5 px-2 border-b border-hairline align-top ${cell(r.starter)}`}>
                  {r.starter === "—" ? <><span aria-hidden>—</span><span className="sr-only">Not included</span></> : r.starter === "✓" ? <><span aria-hidden>✓</span><span className="sr-only">Included</span></> : r.starter}
                </td>
                <td className={`text-center font-semibold py-2.5 px-2 border-b border-l border-hairline align-top ${cell(r.standard)}`}>
                  {r.standard === "—" ? <><span aria-hidden>—</span><span className="sr-only">Not included</span></> : r.standard === "✓" ? <><span aria-hidden>✓</span><span className="sr-only">Included</span></> : r.standard}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm leading-normal bg-paper-2 rounded-[10px] px-3.5 py-3 m-0">
          <b>Still unsure?</b> Need only email and video calls? Starter is enough. Want meeting recordings, more storage and AI in Docs and Sheets? Pick Standard. You can upgrade later without losing anything.
        </p>
      </div>
      <div data-m-bar className="fixed inset-x-0 bottom-0 z-30 bg-white border-t border-hairline">
        <div className="max-w-[480px] mx-auto px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => onChoose("starter")}
            className="h-[52px] rounded-xl border-[1.5px] border-hairline-strong bg-white text-[15px] font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber">Choose {name("starter")}</button>
          <button type="button" onClick={() => onChoose("standard")}
            className="h-[52px] rounded-xl bg-amber text-white text-[15px] font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2">Choose {name("standard")}</button>
        </div>
      </div>
    </div>
  );
}
