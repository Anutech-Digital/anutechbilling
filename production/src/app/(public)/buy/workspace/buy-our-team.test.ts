// R-1116: the Workspace buy page speaks as the company. A visitor was told "Pardeep will
// WhatsApp you" — a person they do not know, on a number that may not be live yet — and the
// Razorpay window wore orange #C2410C while the storefront (and /checkout's Razorpay) is blue.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(process.cwd(), "src/app/(public)/buy/workspace/buy-workspace-client.tsx"), "utf8");
/** Visible text and code only — comments may still tell the history. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

describe("R-1116: buy page — our team, storefront blue", () => {
  it("no customer-visible 'Pardeep will' / 'Pardeep WhatsApps'", () => {
    expect(code).not.toMatch(/Pardeep (will|WhatsApps)/);
  });

  it("the trial promise only says WhatsApp when WHATSAPP_READY", () => {
    expect(code).toMatch(/Our team will \$\{WHATSAPP_READY \? "WhatsApp" : "call or email"\} you/);
    expect(code).toMatch(/Our team \{WHATSAPP_READY \? "WhatsApps" : "calls or emails"\} you/);
  });

  it("the Razorpay window wears site.css --primary, like /checkout", () => {
    const primary = /--primary:\s*(#[0-9A-Fa-f]{6})/.exec(readFileSync(join(process.cwd(), "src/site/site.css"), "utf8"))?.[1];
    expect(primary).toBeTruthy();
    expect(code).toMatch(new RegExp(`theme:\\s*\\{\\s*color:\\s*"${primary}"`));
    expect(code).not.toMatch(/theme:\s*\{\s*color:\s*"#C2410C"/i);
  });
});
