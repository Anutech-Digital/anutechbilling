// @vitest-environment jsdom
/* R-1853 — the s.185 step before a loan to a director is saved: Give stays off until a reason is
   picked; MD/WTD reasons are closed for an ordinary director; s.186 rough limit shows. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { S185Footer, S185Step } from "./s185-step";
import type { S185Basis } from "@/lib/accounting/director-loans";

afterEach(cleanup);

function Harness({ designation, onGive }: { designation: "director" | "managing_director"; onGive: () => void }) {
  const [basis, setBasis] = React.useState<S185Basis | null>(null);
  return (
    <>
      <S185Step directorName="Asha Verma" designation={designation} amount={200000} interestRate={0}
        s186={{ limit: 60000, total: 260000, over: true }} basis={basis} onBasis={setBasis} />
      <S185Footer amount={200000} directorName="Asha Verma" basis={basis} pending={false} onBack={vi.fn()} onGive={onGive} />
    </>
  );
}

describe("S185Step", () => {
  it("Give is off until a reason is picked", () => {
    const onGive = vi.fn();
    render(<Harness designation="managing_director" onGive={onGive} />);
    const give = screen.getByRole("button", { name: /Give .* to Asha Verma/ }) as HTMLButtonElement;
    expect(give.disabled).toBe(true);
    fireEvent.click(give);
    expect(onGive).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/part of the service terms/));
    expect(give.disabled).toBe(false);
    fireEvent.click(give);
    expect(onGive).toHaveBeenCalledTimes(1);
  });

  it("an ordinary director cannot use the MD / WTD reasons, and is told why", () => {
    render(<Harness designation="director" onGive={vi.fn()} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.disabled)).toEqual([true, true, false]);
    expect(screen.getAllByText(/Only for a managing or whole-time director/).length).toBe(2);
  });

  it("shows s.185 in plain words, the s.186 rough limit when over, and the interest-free note", () => {
    const { container } = render(<Harness designation="director" onGive={vi.fn()} />);
    expect(container.textContent).toMatch(/bars most loans to a director/);
    expect(container.textContent).toMatch(/special resolution may be needed first/);
    expect(container.textContent).toMatch(/s\.186\(7\)/);
    expect(screen.getByRole("link", { name: /Read the Act/ }).getAttribute("href")).toMatch(/indiacode\.nic\.in/);
  });
});
