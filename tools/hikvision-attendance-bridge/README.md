# Hikvision → ResellerOS attendance bridge

Reads punches from a Hikvision LAN fingerprint machine and sends them to the app,
so attendance shows up (near real-time) under **Payroll → Attendance Register**.

## What you need
- A Windows/Mac/Linux computer in the office, on the **same network** as the machine
  (it does NOT need to stay on 24×7 — when it's on, it catches up all missed punches).
- **Node.js 18+** installed on that computer (https://nodejs.org).
- The machine's **IP address** and **admin password** (from whoever installed it).
- From the app: **Payroll → Attendance Register → Biometric machine** → the
  **Punch URL** + **Ingest key**, and each employee's **machine user number** mapped.

## One-time setup
1. Copy this whole `hikvision-attendance-bridge` folder to the office computer.
2. In the app, open **Attendance Register → Biometric machine**:
   - Map every employee to their machine user-number (the number they punch as).
   - Copy the **Punch URL** and **Ingest key**.
3. In this folder, copy `config.example.json` → `config.json` and fill it:
   - `device_ip` / `device_pass` — the fingerprint machine's IP + admin password.
   - `ingest_url` — the Punch URL from the app.
   - `ingest_key` — the Ingest key from the app.
4. Open a terminal in this folder and run:
   ```
   node bridge.mjs
   ```
   You'll see `sent N punches` lines. Attendance appears in the app within ~1 minute.

## Keep it running
- Leave that terminal open during office hours, OR set it to auto-start:
  - **Windows:** Task Scheduler → new task → "At log on" → run
    `node C:\path\to\bridge.mjs` (start-in = this folder).
  - It's safe to close/reopen — `last-sync.txt` remembers where it left off and
    the machine keeps its own log, so nothing is missed.

## Notes / troubleshooting
- **unmatched: 5,9** in the log → those machine user-numbers aren't mapped to any
  employee yet. Map them in the app's Biometric machine panel.
- **Device responded 401** → wrong `device_user`/`device_pass`.
- **connect ECONNREFUSED / timeout** → wrong `device_ip`, or the PC isn't on the
  same network as the machine.
- First punch of a day = check-in, last punch = check-out. Re-running never creates
  duplicates (it only widens the in/out window).
- Uses the device's ISAPI `AcsEvent` API over HTTP digest auth — no extra software
  on the machine. If your model uses a different port, set `device_port`.
