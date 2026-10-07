-- Regression test: export_snapshots_for_offsite() sirf service_role ke liye hai.
--
-- WHY THIS FILE EXISTS
--   Is repo ka har doosra RPC ek tenant ka data deta hai. Ye ek HAR tenant ka poora data ek
--   hi call me deta hai — teeno tenants ka har snapshot, ek jsonb me. Wo zaroori hai, kyunki
--   raat wale cron ko sab kuch ek saath Cloud Storage par rakhna hota hai.
--
--   Aur isi wajah se ye is schema ka sabse khatarnak function hai. Agar iski pahunch kabhi
--   khul gayi, to ek hi request me poora platform bahar chala jayega — koi loop nahi, koi
--   ginti nahi, ek call.
--
--   Supabase har naye function par `execute` PUBLIC ko deta hai. Yaani surakshit hona DEFAULT
--   NAHI hai — migration me revoke likhna padta hai, aur wo likhna kabhi bhi chhoot sakta
--   hai: ek `create or replace` jo revoke ke bina aaye, aur darwaza chup-chaap khul jaye.
--   Us din koi error nahi aayega. Sirf ye file laal hogi.
--
-- SAFETY: kuch banata nahi, kuch badalta nahi, aur rollback par khatam.

begin;

-- ── 1. GRANT: browser wale role ise chhoo bhi nahi sakte ────────────────────
do $$
begin
  if has_function_privilege('authenticated',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: `authenticated` is function ko chala sakta hai — ek hi call me har tenant ka data bahar ja sakta hai';
  end if;

  if has_function_privilege('anon',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: `anon` is function ko chala sakta hai — bina login ke poora platform';
  end if;

  /* Control. Upar ke dono `false` wo bhi de dega jo function maujood hi na ho — us soorat me
     ye file "surakshit hai" keh kar pass ho jaati aur backup chup-chaap band pada rehta. */
  if not has_function_privilege('service_role',
       'public.export_snapshots_for_offsite(timestamptz)', 'execute') then
    raise exception 'FAIL 1: service_role bhi nahi chala sakta — to raat ka off-site backup kabhi chala hi nahi hoga';
  end if;
end $$;

-- ── 2. BODY: grant khul bhi jaye to browser session phir bhi ruke ───────────
do $$
declare v_blocked boolean := false; v_msg text;
begin
  /* Ye doosra pehra hai, aur ise alag se naapna zaroori hai: case 1 grant jaanchta hai,
     ye body jaanchta hai. Ek din koi migration `grant execute ... to authenticated` likh
     de, to case 1 laal hoga aur ye hara — dono milkar batayenge ki kya toota. */
  perform set_config('request.jwt.claims',
    json_build_object('sub', '3caa0f07-44d1-42ee-91b3-2123e04853b1',
                      'role', 'authenticated')::text, true);
  begin
    perform public.export_snapshots_for_offsite(now() - interval '1 day');
  exception when others then
    v_blocked := true; v_msg := sqlerrm;
  end;

  if not v_blocked then
    raise exception 'FAIL 2: auth.uid() maujood hone par bhi function chal gaya — body ka pehra kaam nahi kar raha';
  end if;
  if v_msg not like '%service_role only%' then
    raise exception 'FAIL 2: ruka to sahi, par galat wajah se: %', v_msg;
  end if;

  /* Khaali string par chhoda jata hai, jaan-boojhkar. Ye wahi haalat hai jisme pehli baar
     ye test 22P02 se mara: `set_config(..., null, ...)` NULL nahi, KHAALI STRING set karta
     hai, aur function usi ko jsonb me badal raha tha. Ab wo `nullif` se sambhala hua hai,
     aur ye line us fix ki gawah hai — hataoge to fix ka koi saboot nahi bachega. */
  perform set_config('request.jwt.claims', '', true);
end $$;

/* R-380: cases 1-2 (grant + body guard) run everywhere. Cases 3-4 need backup.snapshots,
   which the baseline does not create (Cloud SQL gets it from cloudsql/06) — on a database
   without it (local, CI) the file stops here as NOT APPLICABLE, like backup_per_tenant. */
do $$
begin
  if to_regclass('backup.snapshots') is null then
    raise exception 'NOT APPLICABLE HERE: backup.snapshots is database par nahi hai (baseline defect; Cloud SQL par cloudsql/06 se aata hai) - cases 1-2 passed';
  end if;
end $$;

/* Case 3 ke liye apna data, kyunki pehle ye raat wale cron par nirbhar tha.
   Jis bhi database par sweep abhi chala na ho — naya restore, dev box, ya is file
   ka mahine baad ka pehla run — ye "ek saal me ek bhi snapshot nahi" par marta tha,
   jo ek toote function jaisa padha jata hai aur hai nahi.

   Aur jiski jagah ye khada tha — raat ke backup ka alarm — wo bhi nahi de raha tha:
   ye file na CI me hai na Stop hook me (§9). Jo alarm koi chalata hi nahi, wo alarm
   nahi hai (L38).

   Do nateeje, chhupe nahi, likhe hue: neeche ka contract ab HAR database par pakka
   sabit hota hai — "sirf sabse naya" wala niyam bhi, jo pehle tabhi sach nikalta jab
   production ke paas sanyog se kisi tenant ke do snapshot hon — aur "kya sach me har
   tenant ka backup ja raha hai" ab is file ka sawal nahi raha. Wo monitoring ka kaam
   hai: asli rows par, schedule par. */
insert into backup.snapshots (tenant_id, created_at, label, table_count, payload, kind)
  select t.id, now(), 'offsite-probe newest', 3, jsonb_build_object('probe', true), 'automated'
  from public.tenants t;
-- Ek purana, sirf ek tenant ke liye, taaki "sirf sabse naya" naapa jaye, maana na jaye.
insert into backup.snapshots (tenant_id, created_at, label, table_count, payload, kind)
  select t.id, now() - interval '9 days', 'offsite-probe STALE', 3,
         jsonb_build_object('probe', 'stale'), 'automated'
  from public.tenants t order by t.id limit 1;

-- ── 3. Jo lautata hai wo sach me kaam ka ho ─────────────────────────────────
do $$
declare
  v_out      jsonb;
  v_tenants  int;
  v_distinct int;
  v_empty    int;
begin
  /* Poore itihaas ki khidki, taaki test us raat bhi chale jab cron abhi chala na ho. */
  v_out := public.export_snapshots_for_offsite(now() - interval '365 days');

  if jsonb_typeof(v_out) <> 'array' then
    raise exception 'FAIL 3: array nahi, % mila', jsonb_typeof(v_out);
  end if;
  if jsonb_array_length(v_out) = 0 then
    raise exception 'FAIL 3: ek saal me ek bhi snapshot nahi — ya sweep chala hi nahi, ya ye function galat jagah dekh raha hai';
  end if;

  /* Har tenant ka SIRF EK (sabse naya). Poora itihaas bhejna har raat pichhli raaton ki
     nakal dobara upload karta — off-site copy roz badhti, bina kisi naye saboot ke. */
  select count(distinct x->>'tenant_id') into v_distinct
    from jsonb_array_elements(v_out) x;
  if v_distinct <> jsonb_array_length(v_out) then
    raise exception 'FAIL 3: % row par sirf % tenant — kisi tenant ke ek se zyada snapshot ja rahe hain',
      jsonb_array_length(v_out), v_distinct;
  end if;

  /* Khaali payload wala snapshot ek backup jaisa dikhta hai aur backup hai nahi. Ye wahi
     shakl hai jisme 19 Aug tak laptop wala dump chup-chaap tootA pada tha. */
  select count(*) into v_empty from jsonb_array_elements(v_out) x
   where x->'payload' is null or jsonb_typeof(x->'payload') = 'null'
      or x->>'tenant_name' is null;
  if v_empty > 0 then
    raise exception 'FAIL 3: % snapshot bina payload/naam ke — upload to hoga, restore nahi', v_empty;
  end if;

  select count(*) into v_tenants from public.tenants;
  if v_distinct <> v_tenants then
    raise exception 'FAIL 3: % tenant hain par sirf % ka backup ja raha hai', v_tenants, v_distinct;
  end if;

  /* Upar wali jaanch sirf itna kehti hai ki kisi tenant ke do snapshot nahi aaye.
     Ye kehti hai ki jo aaya wo SAHI wala hai: purani nakal kabhi na jaye. Iske bina
     function ulta sort karke bhi paas ho jata. */
  select count(*) into v_empty from jsonb_array_elements(v_out) x
   where x->>'label' = 'offsite-probe STALE';
  if v_empty > 0 then
    raise exception 'FAIL 3: purana snapshot bheja gaya — "sirf sabse naya" toota hua hai';
  end if;
end $$;

-- ── 4. p_since sach me chhaanti karta hai ───────────────────────────────────
do $$
declare v_out jsonb;
begin
  /* Bina is jaanch ke case 3 tab bhi pass hota jab p_since ko poori tarah anadekha kiya ja
     raha ho — aur tab har raat poora itihaas upload hota rehta. */
  v_out := public.export_snapshots_for_offsite(now() + interval '1 day');
  if jsonb_array_length(v_out) <> 0 then
    raise exception 'FAIL 4: bhavishya ki tareekh par bhi % snapshot mile — p_since padha hi nahi ja raha',
      jsonb_array_length(v_out);
  end if;
end $$;

select 'PASS' as offsite_export_service_role_only;

rollback;
