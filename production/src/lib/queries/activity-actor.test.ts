import { describe, expect, it } from "vitest";
import { activityActorInitials, activityActorName, activityViaLabel } from "./activity-actor";

const staff = { actor: { full_name: "Pawan Kumar", initials: "PK", color: "#123456" }, actor_label: null };
const customer = { actor: null, actor_label: "Customer Acme Pvt Ltd" };

describe("activity actor", () => {
  it("staff row shows the user's name and initials", () => {
    expect(activityActorName(staff)).toBe("Pawan Kumar");
    expect(activityActorInitials(staff)).toBe("PK");
  });

  it("portal customer row shows 'Customer <name>' from actor_label", () => {
    expect(activityActorName(customer)).toBe("Customer Acme Pvt Ltd");
    expect(activityActorInitials(customer)).toBe("C");
  });

  it("neither → Someone / ?", () => {
    expect(activityActorName({ actor: null, actor_label: null })).toBe("Someone");
    expect(activityActorInitials({ actor: null })).toBe("?");
  });

  it("R-2778: a row the Help AI changed says 'AI on behalf of <name>'; the person's own click does not", () => {
    expect(activityViaLabel({ ...staff, via: "ai" })).toBe("AI on behalf of Pawan Kumar");
    expect(activityViaLabel({ ...staff, via: null })).toBeNull();
    expect(activityViaLabel(staff)).toBeNull();
    expect(activityViaLabel({ actor: null, actor_label: null, via: "ai" })).toBe("AI on behalf of a team member");
    expect(activityViaLabel({ ...staff, via: "robot" })).toBeNull(); // only 'ai' is a marker
    expect(activityActorName({ ...staff, via: "ai" })).toBe("Pawan Kumar"); // the row is still the person's own
  });
});
