import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* R-069 — Add Lead: the stepper says "1 Contact › 2 Enquiry › 3 Review", but "Next" on step 2
   CREATED the lead; the Review step never showed.

   Why: the footer is `step < 3 ? <Button type="button">Next</Button> : <Button type="submit">`.
   Same component, same slot, no key — so React reuses the ONE <button> DOM node and only
   flips its `type`. Next's onClick awaits `trigger()`, which resolves in the microtask
   checkpoint that runs right after the click listener returns; setStep(3) is a discrete
   update and commits there too. By the time the browser runs the click's activation
   behaviour, the button it is activating is already type="submit" — the form submits.
   (jsdom runs microtasks after the whole dispatch, so a render test would not reproduce it;
   this is a source contract, in the style of url-query-preserved.test.ts.) */

const SRC = readFileSync(
  join(process.cwd(), "src", "components", "features", "leads", "add-lead-form.tsx"),
  "utf8",
);

describe("R-069: Add Lead reaches the Review step before saving", () => {
  it("still has a Review step with the summary", () => {
    expect(SRC).toMatch(/const STEP_LABELS = \["Contact", "Enquiry", "Review"\] as const;/);
    expect(SRC).toMatch(/<Step show=\{useSteps && step === 3\}>/);
  });

  it("the Next and Save buttons are different DOM nodes (distinct keys)", () => {
    const footer = SRC.slice(SRC.indexOf("<SheetFooter"), SRC.indexOf("</SheetFooter>")); // the footer may carry a className (pb-16, 2 Nov)
    expect(footer).toMatch(/key="step-next"/);
    expect(footer).toMatch(/key="step-save"/);
  });

  it("a submit before the last step is refused (Enter key, or any other stray submit)", () => {
    expect(SRC).toMatch(/if \(useSteps && step < STEP_LABELS\.length\) \{\s*e\.preventDefault\(\);\s*return;/);
  });

  it("an empty Seats field reads 'not set' on Review, not 'NaN'", () => {
    /* Seen in the browser once Review was reachable: an empty number input gives NaN. */
    expect(SRC).toMatch(/<Review label="Seats"\s+value=\{watchedSeats == null \|\| Number\.isNaN\(watchedSeats\) \? ""/);
  });

  it("the final button says Save lead, not Add lead", () => {
    expect(SRC).toMatch(/isEditing \? "Save changes" : dealMode \? "Save deal" : "Save lead"/);
  });
});
