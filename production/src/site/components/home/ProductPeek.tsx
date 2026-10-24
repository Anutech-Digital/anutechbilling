/**
 * ProductPeek — the home hero's picture (R-1454, Pawan: "page too text-heavy, needs visuals").
 *
 * A drawing of ResellerOS's real "Today" screen, built from HTML/CSS (no image file, so it costs
 * the LCP nothing). Honest by construction:
 *  - the menu and row labels are ResellerOS's own screen names (src/lib/nav.ts) and the jobs the
 *    home page already says it does — no invented features;
 *  - there are NO customer names, amounts, counts or percentages: where the real screen shows a
 *    name or a number, the drawing shows a grey bar;
 *  - the visible caption says it is an illustration of the software we run on.
 * The drawing itself is aria-hidden; the caption is the text alternative.
 */
import { C, MONO } from "@/site/components/home/HomeV2";

/** ResellerOS menu entries, exactly as the app labels them (src/lib/nav.ts). */
export const PEEK_MENU = ["Today", "Sales & Pipeline", "Quotes", "Invoices", "Renewals", "Banking", "AI Entry"] as const;

/** Today's work rows — the jobs the home page already lists (no names, no amounts). */
export const PEEK_ROWS: readonly { tag: string; text: string; tone: "blue" | "green" }[] = [
  { tag: "Lead", text: "Follow up website enquiry", tone: "blue" },
  { tag: "Quote", text: "Send quote", tone: "blue" },
  { tag: "Invoice", text: "GST invoice ready", tone: "green" },
  { tag: "Renewal", text: "Renewal due this week", tone: "blue" },
  { tag: "Banking", text: "Match bank entry", tone: "green" },
];

export const PEEK_CAPTION = "ResellerOS — the software Anutech Digital runs on every day. An illustration of its Today screen.";

export function ProductPeek() {
  return (
    <figure className="pk" data-hero-visual="">
      <style>{CSS}</style>
      <div className="pk-win" aria-hidden="true">
        <div className="pk-bar">
          <i /><i /><i />
          <span className="pk-url">ResellerOS · Today</span>
        </div>
        <div className="pk-body">
          <ul className="pk-menu">
            {PEEK_MENU.map((m, i) => (
              <li key={m} className={i === 0 ? "on" : undefined}>{m}</li>
            ))}
          </ul>
          <div className="pk-main">
            <div className="pk-head">
              <b>Today</b>
              <span className="pk-live"><span className="pk-dot" />Every queue, one list</span>
            </div>
            <ul className="pk-rows">
              {PEEK_ROWS.map((r, i) => (
                <li key={r.tag} style={{ animationDelay: `${120 + i * 90}ms` }}>
                  <span className={`pk-tag pk-${r.tone}`}>{r.tag}</span>
                  <span className="pk-text">{r.text}</span>
                  <span className="pk-skel" />
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="pk-float">
          <span className="pk-float-ico">✓</span>
          <span><b>Quote → GST invoice</b><span className="pk-skel pk-skel-s" /></span>
        </div>
      </div>
      <figcaption className="pk-cap">{PEEK_CAPTION}</figcaption>
    </figure>
  );
}

const CSS = `
.pk{margin:0;position:relative}
.pk-win{position:relative;background:#fff;border:1px solid ${C.borderL};border-radius:14px;box-shadow:0 30px 60px -40px rgba(12,17,22,.5);overflow:visible}
.pk-bar{display:flex;align-items:center;gap:6px;padding:9px 12px;background:${C.strip};border-bottom:1px solid ${C.stripBd};border-radius:14px 14px 0 0}
.pk-bar i{width:9px;height:9px;border-radius:50%;background:${C.strong}}
.pk-url{margin-left:10px;font-family:${MONO};font-size:10.5px;letter-spacing:.06em;color:${C.sec};background:#fff;border:1px solid ${C.hair};border-radius:6px;padding:3px 10px}
.pk-body{display:grid;grid-template-columns:150px minmax(0,1fr);min-height:220px}
.pk-menu{list-style:none;margin:0;padding:12px 8px;border-right:1px solid ${C.hair};background:${C.surfT};display:flex;flex-direction:column;gap:2px;border-radius:0 0 0 14px}
.pk-menu li{font-size:12px;color:${C.body};padding:6px 10px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pk-menu li.on{background:#E8F0FD;color:${C.blueDk};font-weight:600}
.pk-main{padding:14px 16px;min-width:0}
.pk-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}
.pk-head b{font-size:15px;color:${C.ink}}
.pk-live{display:inline-flex;align-items:center;gap:6px;font-family:${MONO};font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:${C.sec}}
.pk-dot{width:7px;height:7px;border-radius:50%;background:${C.green}}
.pk-rows{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:7px}
.pk-rows li{display:grid;grid-template-columns:64px minmax(0,auto) minmax(24px,1fr);align-items:center;gap:10px;padding:8px 10px;border:1px solid ${C.hair};border-radius:9px;background:#fff}
.pk-tag{font-family:${MONO};font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;text-align:center;border-radius:5px;padding:3px 0;font-weight:500}
.pk-blue{background:#E8F0FD;color:${C.blueDk}}
.pk-green{background:${C.greenT2};color:${C.green}}
.pk-text{font-size:12.5px;color:${C.ink2};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pk-skel{display:block;height:7px;border-radius:4px;background:${C.hair}}
.pk-skel-s{width:70px;margin-top:5px}
.pk-float{position:absolute;right:-14px;bottom:-18px;display:flex;align-items:center;gap:10px;background:#fff;border:1px solid ${C.borderL};border-radius:11px;padding:10px 14px;box-shadow:0 18px 36px -22px rgba(12,17,22,.45)}
.pk-float b{display:block;font-size:12.5px;color:${C.ink}}
.pk-float-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:${C.greenT2};color:${C.green};font-weight:700;font-size:13px}
.pk-cap{margin-top:26px;font-size:12.5px;line-height:1.5;color:${C.sec}}

@media (prefers-reduced-motion: no-preference){
  .pk-rows li{animation:pkRise .5s ease both}
  .pk-dot{animation:pkPulse 2.4s ease-in-out infinite}
  .pk-float{animation:pkFloat 5s ease-in-out infinite}
}
@keyframes pkRise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
@keyframes pkPulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pkFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}

@media (max-width:560px){
  .pk-body{grid-template-columns:minmax(0,1fr)}
  .pk-menu{flex-direction:row;overflow:hidden;border-right:0;border-bottom:1px solid ${C.hair};border-radius:0;padding:8px}
  .pk-menu li:nth-child(n+4){display:none}
  .pk-rows li{grid-template-columns:58px minmax(0,1fr)}
  .pk-rows li .pk-skel{display:none}
  .pk-float{position:relative;right:auto;bottom:auto;width:max-content;max-width:calc(100% - 20px);box-sizing:border-box;margin:0 10px 10px auto}
  .pk-cap{margin-top:12px}
}
`;
