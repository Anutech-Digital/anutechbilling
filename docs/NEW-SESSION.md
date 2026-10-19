# Naya session shuru karne se pehle — ye file kholo

> **STALE in parts — 19 Oct 2026, R-1609.** Jahan bhi neeche "TASKS.md ka HANDOFF block" likha
> hai, uski jagah team board padho (root `CLAUDE.md` → "Session start"; board
> https://claude.ai/artifact/84m2bpzzSYoir48DrhFD5n). TASKS.md 8 Sep 2026 se update nahi hui.

> Har naye session me ye file kholo aur neeche ke steps kar lo. 2 minute lagte hain.
> Likha 18 Aug 2026, ek session ke baad jo **paanch goals** tak chala aur usi wajah se slow
> hua. Isme koi theory nahi hai — sirf wo cheezein jo aaj asli me kaam aayi.

---

## Kyo — ek line me

Ek session me jo bhi hua hai (har file, har command, har output) wo **poora** Claude ke saath
chalta rehta hai. Jagah bharne par system summary bana deta hai (**compaction**), aur us
summary me detail ghisti hai.

**Aaj ka asli nuksaan:** compaction ke baad Claude ne **do baar** apni hi purani baat galat
yaad ki — kaha *"main DDL apply nahi kar sakta"* jabki wo kabhi test hi nahi kiya gaya tha.
Test kiya to chal gaya. Do round trip ek galat yaad par gaye.

**Niyam: ek goal = ek session.**

---

## ✅ CHECKLIST

### 1. Purana session band karne se pehle — Claude se ye poochho

```
Sab commit ho gaya? TASKS.md ka handoff update kar do, aur jo cheez dobara kaat sakti hai
usko memory me daal do.
```

Uska jawab aane tak intezaar karo. Ye 30 second aapko agle session me 10 minute bachate hain.

### 2. Naya session kholo

- Claude Code app me: **naya chat / New session** shuru karo
- Terminal me ho to: `/clear`

**Folder wahi rahe:** `C:\dev\ResellerOSv3 - Copy`
Naya session usi repo, usi branch, aur usi memory ko padhega.

### 3. Pehla message — inme se ek paste karo

**(A) Pending kaam aage badhana hai:**

```
Naya session. Branch session/money-spine-hardening-jun1.
Pehle TASKS.md ka "HANDOFF" block padho, phir batao ki tumne kya samjha —
main confirm karunga, phir kaam shuru karenge.
```

**(B) Naya goal shuru karna hai:**

```
Naya session, naya goal. Pehle docs/NEW-SESSION.md aur TASKS.md ka HANDOFF block padho
taaki pata ho kya adhoora hai. Phir sirf itna batao — kya adhoora hai aur kya mere naye
goal se takra sakta hai. Uske baad main goal doonga.
```

> **Dono me "pehle batao ki kya samjha" kyo hai:** isse Claude pehle padhta hai, phir apni
> samajh dikhata hai, aur aap galti pakad sakte ho — **kaam shuru hone se pehle**. Aaj ka
> sabse mehnga bug isi wajah se hua tha ki galat samajh par kaam chalu ho gaya.

### 4. Ek session me ek goal

Goal khatam → gate green (typecheck + test + lint) → commit → **naya session**.

Do goals ek session me le gaye to doosre me Claude pehle jaisa tez nahi rahega.

---

## Kya khota hai aur kya nahi

| Cheez | Naye session me? |
|---|---|
| Code, commits, branch | ✅ repo me hai |
| `CLAUDE.md` + `AGENTS.md` ke niyam | ✅ apne aap padhe jaate hain |
| Memory files (`~/.claude/projects/.../memory/`) | ✅ apne aap aate hain |
| `TASKS.md` ka HANDOFF block | ✅ agar aap padhne ko kaho (step 3) |
| **Purani chat ki baat-cheet** | ❌ khatam — isi liye handoff likha jaata hai |

---

## Ek aadat — sabse bada faayda

Jab bhi koi cheez **doosri baar** kaate, bas ye likho:

> **"isko yaad rakho"**

Claude memory file bana dega jo **har agle session me apne aap** aa jayegi.

18 Aug 2026 ko do bani — Supabase ke teen project (naam se pehchanna khatarnak hai), aur
toota `SUPABASE_ACCESS_TOKEN`. Dono ne mil kar aadha din khaya tha.

---

## Kaam dene ka tareeka — aaj ka asli data

### Tez chala

| Aapne kaha | Kyo tez chala |
|---|---|
| "ye annual 2004 support project me kyo dikha raha jabki quote 2000 ka tha" | Screen + galat number + ummeed — teeno ek jagah. Ek round me fix. |
| "chalu kar do, jo tumhe sahi lage wo karo" | Daayra saaf, faisla Claude ka. Usne naapa, behtar design chuna, laga diya. |
| "1" | Ek shabd — kyoki options pehle likhe the. |

### Slow chala

| Aapne kaha | Kya hua |
|---|---|
| "ab kya karna hai" (3 baar) | Wahi list dohrai gayi. Ek option chun lena 3 turn bachata. |
| kuch nahi likha | Hook Claude ko wapas chalu karta rehta hai; wo "intezaar" likhta hai aur turn barbaad hote hain. **Ek shabd likh do** — "ruko" ya "chhod do". |
| Aadha error bheja | Aaj poora `Invalid access token format` dekh kar hi asli wajah mili (version nahi, env var). **Poora output bhejo.** |

---

## Related

- [docs/WORKING-ENVIRONMENT.md](WORKING-ENVIRONMENT.md) — machine ke fixes (Defender exclusion, token, permissions). Ek baar karne wale kaam.
- [TASKS.md](../TASKS.md) — HANDOFF block top par. Kya adhoora hai.
- `CLAUDE.md §25` — session hygiene ke niyam (docs stale hote hain, "green" ka matlab, verified ke teen prakaar).
