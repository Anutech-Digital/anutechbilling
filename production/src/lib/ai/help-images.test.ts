/** R-830: image limits and which images a bug draft carries. */
import { describe, it, expect } from "vitest";
import { pickHelpImages, draftImages, draftScreenshots, HELP_MAX_IMAGES, HELP_MAX_IMAGE_BYTES, HELP_IMAGE_ERRORS } from "./help-images";

const img = (name: string, size = 100_000, type = "image/png") => ({ name, size, type });

describe("pickHelpImages", () => {
  it("accepts png, jpg and webp", () => {
    const r = pickHelpImages(0, [img("a.png"), img("b.jpg", 1, "image/jpeg"), img("c.webp", 1, "image/webp")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.png", "b.jpg", "c.webp"]);
    expect(r.errors).toEqual([]);
  });

  it("takes up to 5 and says 'Max 5 images' for the rest", () => {
    const r = pickHelpImages(0, Array.from({ length: 7 }, (_, i) => img(`${i}.png`)));
    expect(r.accepted).toHaveLength(HELP_MAX_IMAGES);
    expect(r.errors).toEqual([HELP_IMAGE_ERRORS.tooMany]);
    expect(HELP_IMAGE_ERRORS.tooMany).toBe("Max 5 images");
  });

  it("counts the images already waiting", () => {
    const r = pickHelpImages(4, [img("a.png"), img("b.png")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(r.errors).toEqual(["Max 5 images"]);
    expect(pickHelpImages(5, [img("a.png")]).accepted).toEqual([]);
  });

  it("refuses an image over 5 MB with a clear message, keeps the others", () => {
    const r = pickHelpImages(0, [img("big.png", HELP_MAX_IMAGE_BYTES + 1), img("ok.png", HELP_MAX_IMAGE_BYTES)]);
    expect(r.accepted.map((f) => f.name)).toEqual(["ok.png"]);
    expect(r.errors).toEqual(["Image too large — max 5 MB"]);
  });

  it("refuses other file types (gif, pdf) without using up a slot", () => {
    const r = pickHelpImages(0, [img("a.gif", 1, "image/gif"), img("b.pdf", 1, "application/pdf"), img("c.png")]);
    expect(r.accepted.map((f) => f.name)).toEqual(["c.png"]);
    expect(r.errors).toEqual([HELP_IMAGE_ERRORS.wrongType]);
  });

  it("lists each error once", () => {
    const r = pickHelpImages(0, [img("1", HELP_MAX_IMAGE_BYTES + 1), img("2", HELP_MAX_IMAGE_BYTES + 1)]);
    expect(r.errors).toEqual([HELP_IMAGE_ERRORS.tooLarge]);
  });
});

describe("draftImages — what a bug draft carries", () => {
  it("every user image in the chat, oldest first, no duplicates, assistant items ignored", () => {
    const got = draftImages([
      { role: "user", images: ["a", "b"] },
      { role: "assistant", images: ["x"] },
      { role: "user" },
      { role: "user", images: ["b", "c"] },
    ]);
    expect(got).toEqual(["a", "b", "c"]);
  });

  it("at most 5 — the newest win", () => {
    const got = draftImages([{ role: "user", images: ["1", "2", "3"] }, { role: "user", images: ["4", "5", "6"] }]);
    expect(got).toEqual(["2", "3", "4", "5", "6"]);
  });

  it("draftScreenshots gives the useSubmitFeedback shape", () => {
    expect(draftScreenshots(["data:a", "data:b"])).toEqual([
      { name: "ai_help_screen_1.jpg", dataUrl: "data:a" },
      { name: "ai_help_screen_2.jpg", dataUrl: "data:b" },
    ]);
  });
});
