/**
 * R-1970: the coloured "Google Workspace" wordmark (Google's own palette) and the hero's chai
 * glass. Both are decoration; the wordmark keeps the words readable for a screen reader.
 */
const GOOGLE = { blue: "#4285F4", red: "#EA4335", yellow: "#FBBC04", green: "#34A853", grey: "#5F6368" } as const;

export function GoogleWorkspaceWordmark({ workspaceWeight }: { workspaceWeight?: number }) {
  return (
    <span className="whitespace-nowrap">
      <span style={{ color: GOOGLE.blue }}>G</span>
      <span style={{ color: GOOGLE.red }}>o</span>
      <span style={{ color: GOOGLE.yellow }}>o</span>
      <span style={{ color: GOOGLE.blue }}>g</span>
      <span style={{ color: GOOGLE.green }}>l</span>
      <span style={{ color: GOOGLE.red }}>e</span>{" "}
      <span style={{ color: GOOGLE.grey, fontWeight: workspaceWeight }}>Workspace</span>
    </span>
  );
}

const steam = (d: string, delay: number) => (
  <path
    d={d}
    fill="none"
    stroke="#ABA290"
    strokeWidth={2.4}
    strokeLinecap="round"
    className="motion-safe:animate-[chaiSteam_2.4s_ease-in-out_infinite]"
    style={{ animationDelay: `${delay}s`, opacity: 0 }}
  />
);

/** A glass of chai with rising steam — sits after "cold." in the hero headline. */
export function ChaiCup() {
  return (
    <span aria-hidden="true" className="inline-block align-[-0.08em] ml-[0.12em] rotate-6 pointer-events-none leading-none">
      <style>{"@keyframes chaiSteam{0%{opacity:0;transform:translateY(5px)}35%{opacity:.85}100%{opacity:0;transform:translateY(-12px)}}"}</style>
      <svg viewBox="0 0 48 58" width="0.82em" height="1em" style={{ overflow: "visible" }}>
        {steam("M17 22 C13 17, 21 13, 17 5", 0)}
        {steam("M24 22 C20 16, 28 12, 24 3", 0.8)}
        {steam("M31 22 C27 17, 35 13, 31 5", 1.6)}
        <path d="M10.3 32 H37.7 L35.2 53 Q34.8 56 32 56 H16 Q13.2 56 12.8 53 Z" fill="#B5651D" />
        <path d="M10.3 32 H37.7 L37.3 35 H10.7 Z" fill="#D9A066" />
        <path d="M9 26 H39 L35.2 53 Q34.8 56 32 56 H16 Q13.2 56 12.8 53 Z" fill="rgba(255,255,255,0.35)" stroke="#4F4A40" strokeWidth={2} strokeLinejoin="round" />
        <path d="M17 28 L18.5 54 M24 28 V54.5 M31 28 L29.5 54" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} />
      </svg>
    </span>
  );
}

/** Scroll a section into view under the sticky header. */
export function goTo(id: string): void {
  if (typeof window === "undefined") return;
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: reduce ? "auto" : "smooth" });
}
