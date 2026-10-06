update public.feedback set status='fixed', resolved_at=now(), updated_at=now(), checked_at=null, checked_by_name=null,
  resolution_note = v.note
from (values
 ('22a67769-5549-473b-960d-c2a04c42c2a7'::uuid, 'AI ne theek kiya: R-199 (d17e5921) — ₹0 deal value ab rukta hai; negative pehle se band tha. Local par browser me jaancha. Staging par 7 Oct 5 PM merge ke baad — tab browser test.'),
 ('02ad6147-8cf5-4fc4-a1b8-e68eabb4f920'::uuid, 'AI ne theek kiya: R-178 (6be9d5a0) — Dashboard greeting ab IST ghante se (server UTC tha). Staging par 7 Oct 5 PM merge ke baad — tab browser test.'),
 ('8ddd555d-7b1d-492e-84e5-13f0de3e3015'::uuid, 'Same as the other #418 report — R-178 (6be9d5a0). Staging par 7 Oct 5 PM merge ke baad.'),
 ('f647b9cf-713d-4007-a1aa-f2fed2389ccf'::uuid, 'AI ne theek kiya: R-190 — staging par saanjhi Gemini key lagi (6 Oct, abhi se chalu); key na ho to saaf sandesh (9a6e8638) 7 Oct 5 PM merge ke baad. Doosri company se browser test karein.'),
 ('441a1cfe-cb9d-480a-86f7-f3d1b6310431'::uuid, 'AI ne theek kiya: R-189 — 📷 screenshot, Ctrl+V paste, hissa chunna, report me photo (edb4b806, 6731213f). Staging par aaj ke build me hai — browser test karein.'),
 ('2213de27-f72f-4e3e-890d-d26f67c446f8'::uuid, 'R-196 (4652d677): AI Help ''Run these tests in browser'' — naya LOCAL Claude session browser me tests chalata hai. Staging par 7 Oct 5 PM merge ke baad.'),
 ('885a96b2-de88-4e93-ada2-7aa12875c5de'::uuid, 'R-195 (68316a80): text chuno → Ask AI. Local par jaancha. Staging par 7 Oct 5 PM merge ke baad — tab browser test.')
) as v(id, note)
where public.feedback.id = v.id;
