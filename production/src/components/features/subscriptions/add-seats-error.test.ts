import { describe, it, expect } from "vitest";
import { addSeatsErrorMessage } from "./add-seats-error";

describe("R-450: add-seats failure message", () => {
  it("uses the server's sentence when it sends one", () => {
    expect(addSeatsErrorMessage(503, { error: "Seats not added — the server could not save this change." }))
      .toBe("Seats not added — the server could not save this change.");
  });

  it("still says nothing happened when the body is empty or not JSON", () => {
    for (const body of [null, {}, { error: "" }, "Bad gateway"]) {
      const msg = addSeatsErrorMessage(502, body);
      expect(msg).toMatch(/^Seats not added \(error 502\)/);
      expect(msg).toMatch(/no quote was made/);
    }
  });
});
