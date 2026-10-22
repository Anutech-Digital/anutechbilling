import type { FeedbackWithShots } from "@/lib/queries/feedback";

/* R-1733 (decision R-1728): the app UI is English, but these two texts are PROMPTS pasted into a
   new Claude Code session, not screen copy, so they live in this *-prompts file, which the
   Hinglish UI guard treats as AI prompt text by design. */

/**
 * Fixed reports (Pardeep, 6 Oct 2026: "copy directive ke jagah check in browser AI instruction
 * do, saath me problem ko thik karne ka instruction bhi"). One prompt to paste into a new
 * Claude Code session: re-run the report in a browser first, and only if it still fails, fix
 * it from the original directive. Nothing is stored — it is built from the row on screen.
 */
export function buildCheckPrompt(row: FeedbackWithShots, appUrl: string): string {
  const page = row.route_pattern ?? row.page_path ?? "(page not recorded)";
  const lines = [
    'Ye bug report app me "fixed" mark hai. Pehle browser me jaancho ki sach me theek hua ya nahi; theek na ho to theek karo. (Ye prompt ek NAYE Claude Code session me chalana hai.)',
    "",
    "CLOUD CHECK: ye kaam sirf Pardeep ke computer par chalne wale LOCAL session me ho sakta hai (localhost:3001 aur browser pane wahin hain). Agar tum cloud container me ho (path /home/user/..., localhost:3001 nahi khulta, ya browser pane nahi hai) to kuch mat karo — turant bolo: \"Ye cloud session hai — Claude app me naya session LOCAL chun kar chalaiye.\" Aur ruk jao.",
    "0. FOLDER: agar ye session kisi folder me nahi hai (\"No folder\" / scratch workspace), to sabse pehle change_directory tool se C:\\Users\\mso50\\new-reselleros par jao (owner Allow dabayega), phir aage badho.",
    "Repo: C:\\Users\\mso50\\new-reselleros (app production/ me). AGENTS.md aur production/CLAUDE.md ke niyam maano.",
    "Asli repo SIRF Anutech-Digital/anutechbilling hai (`git remote -v` me jo remote wahan point kare — Pardeep ke computer par `anutech`). Branch manager-pardeep. Abhicode0to1/new-reselleros PUBLIC purana repo hai — wahan kabhi push mat karo; cloud session usi ko clone kiye ho to ruko aur owner ko batao. staging/deploy mat chhuo (staging shaam 5 baje owner ka session karta hai).",
    `App: ${appUrl}${appUrl.includes("localhost") ? "" : " (ya local http://localhost:3001)"}. Jaanch browser pane me dikha kar karo.`,
    "",
    `Report: ${row.title}`,
    `Page: ${page}`,
    `Kya hua tha: ${row.problem_summary || row.title}`,
  ];
  if (row.body) lines.push(`Reporter ne likha:\n${row.body}`);
  lines.push(
    "",
    "1. JAANCH: report ke kadam browser me chalao. Screenshot ke saath batao ki ab kya hota hai.",
    '2. Theek hai → bas batao "✓ browser me theek hai" aur kya dekha. Kuch mat badlo. Phir app me report par "✓ Checked" lagao (token kabhi print mat karo):',
    `   curl -s -X POST -H "Authorization: Bearer $(cat ~/.claude/secrets/agent-queue-token)" -H "content-type: application/json" -d '{"id":"${row.id}"}' ${appUrl}/api/agent/feedback-checked`,
    "   (200 = lag gaya. 401/404/503 = nahi laga — bas nateeja me likh do, owner haath se \"Mark checked\" daba dega.)",
    "3. Bug abhi bhi hai → pehle board par card banao, phir neeche ki directive se theek karo: ek test jo pehle fail ho, fix, poori test suite, local par browser me dikhao, commit me card ka number.",
    "",
    '4. NATEEJA BOARD PAR: kaam ke ant me nateeja "Kaam ki list" board (https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n, collection cards) par likho — theek tha to ek card status "done" aur title "Jaanch: <report>", fix kiya to wahi card review me. Taaki session band hone ke baad bhi nateeja dikhe.',
    '5. SESSION ARCHIVE: board par likhne ke baad ye session archive kar do (mcp__ccd_session_mgmt__archive_session, session_id "self"). Archive, delete nahi. SIRF tab jab ye session ISI prompt se shuru hua ho — agar is session me pehle se koi aur baatcheet/kaam hai (galti se purane session me paste hua), to archive MAT karo, bas nateeja batao.',
    "",
    "Directive (fix ke liye):",
    row.directive || "(directive nahi hai — problem dekh kar khud tay karo)",
  );
  return lines.join("\n");
}

/** R-200: the last step of a copied directive tells the fixing session to mark THIS report fixed
    in this app. The note lead-in "AI ne theek kiya" is parsed by lib/feedback/fixed-note.ts. */
export function buildFixFooter(rowId: string, origin: string): string {
  return [
    "",
    "## When the fix is committed — mark this report fixed (do this last)",
    "",
    `Report id: ${rowId} — it lives in ${origin}. Never print the token.`,
    "```bash",
    `curl -s -X POST -H "Authorization: Bearer $(cat ~/.claude/secrets/agent-queue-token)" -H "content-type: application/json" -d '{"id":"${rowId}","note":"AI ne theek kiya: <card> (<commit>) - <kya badla>. (Note me sirf seedhe ASCII akshar) ${origin.includes("localhost") ? "Local par hai." : "Is app par agle merge/deploy ke baad (staging: shaam 5 baje)."} Tab browser test."}' ${origin}/api/agent/feedback-fixed`,
    "```",
    "200 = marked. 401/404/503 = not marked — say so in your reply; the owner can press Mark fixed.",
  ].join("\n");
}
