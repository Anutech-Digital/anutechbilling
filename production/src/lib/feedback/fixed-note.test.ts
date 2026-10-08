import { describe, it, expect } from "vitest";
import { parseFixedNote, newlyFixedIds } from "./fixed-note";

describe("parseFixedNote (R-356)", () => {
  it("pulls card, commit and the change out of the worker's note", () => {
    const n = parseFixedNote("AI ne theek kiya: R-354 (279cb0d2) - tasks page ab sahi date dikhata. Staging par shaam 5 baje ke merge ke baad. Tab browser test.");
    expect(n.card).toBe("R-354");
    expect(n.commit).toBe("279cb0d2");
    expect(n.text).toBe("tasks page ab sahi date dikhata. Staging par shaam 5 baje ke merge ke baad. Tab browser test.");
  });

  it("shortens a full sha to 8 characters", () => {
    expect(parseFixedNote("AI ne theek kiya: R-12 (279cb0d2aa11bb22cc33dd44ee55ff6677889900) - x").commit).toBe("279cb0d2");
  });

  it("keeps a note with no card or commit word for word", () => {
    const n = parseFixedNote("Fixed by hand after a call");
    expect(n).toEqual({ card: null, commit: null, text: "Fixed by hand after a call" });
  });

  it("does not take an ordinary word or a plain number for a commit", () => {
    expect(parseFixedNote("deadline moved, 12345678 rows").commit).toBeNull();
  });

  it("empty note gives empty text", () => {
    expect(parseFixedNote(null)).toEqual({ card: null, commit: null, text: "" });
  });
});

describe("newlyFixedIds (R-356)", () => {
  it("first load announces nothing", () => {
    expect(newlyFixedIds(null, { a: "fixed" })).toEqual([]);
  });

  it("open → fixed and queued → fixed are announced; already fixed is not", () => {
    expect(
      newlyFixedIds({ a: "open", b: "agent_queued", c: "fixed", d: "open" }, { a: "fixed", b: "fixed", c: "fixed", d: "open" }),
    ).toEqual(["a", "b"]);
  });

  it("a report filed and fixed between two polls counts", () => {
    expect(newlyFixedIds({}, { z: "fixed" })).toEqual(["z"]);
  });
});
